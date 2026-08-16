import { parseMultistatus, propfind } from './webdav.js';
import { shareSignal } from './shares.js';

/**
 * "What changed since she last looked?"
 *
 * Two strategies for one question, because WebDAV SEARCH is optional and this
 * app has to work on whatever Nextcloud the Beelink is running:
 *
 *  1. `SEARCH` on the DAV endpoint with a `d:basicsearch` body -- ONE request,
 *     the whole shared tree, already ordered and limited by the server. This is
 *     the reason the home page can afford this feature at all.
 *  2. A bounded, breadth-first `Depth: 1` walk, for servers that answer SEARCH
 *     with 405 (or 400, or an HTML login page). Correct but chatty, so it is
 *     capped on both depth and folder count -- see WALK_MAX_*.
 *
 * Which one worked is remembered per process (see `findChangedSince`), so an
 * instance without SEARCH pays the failed probe once at boot rather than on
 * every home load.
 *
 * FOLDERS ARE NEVER RESULTS. A folder's mtime changes whenever anything inside
 * it does, so including them would fill the section with "Lectures" every time
 * The owner adds a file to it -- next to the file itself, which is the actual news.
 */

/** How many results we ask for. The page shows 20; the rest becomes "and N more". */
export const SEARCH_LIMIT = 50;

/** Walk bounds. The owner's share is a handful of course folders; these are ceilings, not targets. */
export const WALK_MAX_DEPTH = 6;
export const WALK_MAX_FOLDERS = 200;

/** PROPFINDs in flight during a walk. Enough to hide latency, few enough to be polite. */
const WALK_CONCURRENCY = 4;

/** The DAV endpoint SEARCH is addressed to (not the files home). */
const SEARCH_ROOT = '/remote.php/dav/';

/** Raised when the server won't do SEARCH. Never surfaces to a browser. */
export class SearchUnsupportedError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'SearchUnsupportedError';
    this.status = status;
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A Date as the literal Nextcloud will actually parse.
 *
 * Nextcloud casts a `{DAV:}getlastmodified` literal with
 * `DateTime::createFromFormat(DateTimeInterface::ATOM, …)`, and a value it
 * can't parse becomes timestamp 0 -- i.e. the filter silently matches every
 * file rather than failing. ATOM is `Y-m-d\TH:i:sP`, which JavaScript's
 * `toISOString()` is NOT: it emits milliseconds and a `Z` instead of `+00:00`,
 * both of which ATOM rejects. Hence this function rather than a `.toISOString()`
 * at the call site.
 *
 * @param {Date|string|number} value
 * @returns {string} e.g. `2026-08-09T14:05:00+00:00`
 */
export function toDavDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`toDavDateTime: not a usable date: ${String(value)}`);
  }
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * The search scope, as Nextcloud expects it: a path under the DAV endpoint,
 * NOT a full URL and not the `/remote.php/dav`-prefixed one.
 * @param {ReturnType<import('./client.js').createClient>} client
 */
export function searchScopeFor(client) {
  return `/files/${encodeURIComponent(client.user)}`;
}

/**
 * The `d:basicsearch` body.
 *
 * The selected properties are deliberately the same set PROPFIND asks for, so
 * the results parse into exactly the entry shape the rest of the app (and
 * `toTile`) already understands -- notably `oc:fileid` and `d:getetag`, without
 * which a result tile could show no thumbnail.
 *
 * @param {{scope: string, since: Date|string|number, limit?: number}} options
 * @returns {string}
 */
export function buildSearchBody({ scope, since, limit = SEARCH_LIMIT }) {
  const nresults = Math.max(1, Math.trunc(limit));

  return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select>
      <d:prop>
        <oc:fileid/>
        <d:getlastmodified/>
        <d:getcontenttype/>
        <d:resourcetype/>
        <oc:size/>
        <d:getetag/>
      </d:prop>
    </d:select>
    <d:from>
      <d:scope>
        <d:href>${xmlEscape(scope)}</d:href>
        <d:depth>infinity</d:depth>
      </d:scope>
    </d:from>
    <d:where>
      <d:gt>
        <d:prop><d:getlastmodified/></d:prop>
        <d:literal>${xmlEscape(toDavDateTime(since))}</d:literal>
      </d:gt>
    </d:where>
    <d:orderby>
      <d:order>
        <d:prop><d:getlastmodified/></d:prop>
        <d:descending/>
      </d:order>
    </d:orderby>
    <d:limit>
      <d:nresults>${nresults}</d:nresults>
    </d:limit>
  </d:basicsearch>
</d:searchrequest>`;
}

/** Strictly newer than `since`, and dated at all. */
function isNewer(entry, sinceMs) {
  return entry.lastModified instanceof Date && entry.lastModified.getTime() > sinceMs;
}

function newestFirst(entries) {
  return [...entries].sort(
    (a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0)
  );
}

/**
 * A SEARCH multistatus as file entries, newest first.
 *
 * `parseMultistatus` does the security-relevant half: every href is checked to
 * fall inside this account's DAV home (base path included) and anything else is
 * dropped, so a server that answered with somebody else's files could not put
 * them on the page.
 *
 * The `since` filter is re-applied here rather than trusted: it costs nothing,
 * and a server that mis-parsed our literal would otherwise return the entire
 * tree as "new".
 *
 * Deliberately UNFILTERED with respect to shares: Nextcloud's SEARCH matches
 * anything under the scope regardless of who owns it, so a result here can be
 * the viewer account's own (skeleton) content just as easily as a real share.
 * `searchChangedSince` is where that gets filtered out, because that is the
 * one place both routes into this data (SEARCH and, separately, the walk in
 * `walkChangedSince`) can be held to the same rule with the `client` in hand.
 *
 * @param {string} xml raw 207 body
 * @param {{davRoot: string, since: Date|number, limit?: number}} options
 * @returns {Array<object>} parseMultistatus entry shape, files only
 */
export function parseSearchResults(xml, { davRoot, since, limit = SEARCH_LIMIT }) {
  const { entries } = parseMultistatus(xml, { davRoot, requestPath: '' });
  const sinceMs = since instanceof Date ? since.getTime() : Number(since);

  return newestFirst(entries.filter((entry) => !entry.isFolder && isNewer(entry, sinceMs))).slice(
    0,
    limit
  );
}

/**
 * One SEARCH. Throws `SearchUnsupportedError` for anything that isn't a 207,
 * which is `findChangedSince`'s cue to switch strategies for good.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {Date} since
 * @param {{limit?: number}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function searchChangedSince(client, since, { limit = SEARCH_LIMIT } = {}) {
  const body = buildSearchBody({ scope: searchScopeFor(client), since, limit });

  const response = await client.request('SEARCH', SEARCH_ROOT, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body,
  });

  if (response.status !== 207) {
    // 405 is the honest "we don't do SEARCH"; 400/501 and a redirect to a login
    // page mean the same thing in practice. Drain the body either way, or the
    // connection is held open.
    await response.text().catch(() => '');
    throw new SearchUnsupportedError(`SEARCH ${SEARCH_ROOT} returned ${response.status}`, {
      status: response.status,
    });
  }

  const entries = parseSearchResults(await response.text(), {
    davRoot: client.davRoot,
    since,
    limit,
  });

  // The one place SEARCH results get told apart from the viewer account's own
  // (skeleton) content -- see shareSignal's doc comment for why unknown is
  // kept. Applied after the limit slice in parseSearchResults, so in the
  // pathological case where the newest `limit` changes are mostly skeleton
  // noise, fewer than `limit` real results come back; SEARCH_LIMIT (50) vs.
  // the 20 actually shown leaves comfortable room in the ordinary case.
  return entries.filter((entry) => shareSignal(entry, { user: client.user }) !== false);
}

/**
 * The fallback: breadth-first Depth-1 PROPFINDs, bounded on both axes.
 *
 * The bounds are not tuning, they are safety. Without them one deeply-nested
 * share would turn a home page load into hundreds of upstream requests while
 * Mom watches a blank screen. Hitting either bound returns what was found so
 * far rather than failing -- a partial "new since" list is still useful, and
 * the folder buttons underneath it are the real navigation.
 *
 * Hitting a bound is reported back as `truncated`, because the page words the
 * "and more" line differently when whole subtrees went unlooked-at: "…and 5
 * more." would be a precise number we have no right to.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {Date} since
 * @param {{limit?: number, maxDepth?: number, maxFolders?: number}} [options]
 * @returns {Promise<{entries: Array<object>, truncated: boolean}>} files only, newest first
 */
export async function walkChangedSince(client, since, options = {}) {
  const {
    limit = SEARCH_LIMIT,
    maxDepth = WALK_MAX_DEPTH,
    maxFolders = WALK_MAX_FOLDERS,
  } = options;

  const sinceMs = since instanceof Date ? since.getTime() : Number(since);
  const found = [];
  let queue = [{ path: '', depth: 0 }];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0 && visited < maxFolders) {
    const batch = queue.splice(0, Math.min(WALK_CONCURRENCY, maxFolders - visited));
    visited += batch.length;

    const listings = await Promise.all(
      batch.map(async ({ path, depth }) => {
        try {
          return { depth, entries: await propfind(client, path) };
        } catch (err) {
          // A folder that was unshared or renamed between listing and visiting
          // is not a reason to lose the whole section -- unless it is the root,
          // in which case nothing works and the caller should hear about it.
          if (path === '') throw err;
          return { depth, entries: [] };
        }
      })
    );

    for (const { depth, entries } of listings) {
      for (const entry of entries) {
        // Only the root's own children can be told apart as "the viewer
        // account's own content" at all (see ./shares.js) -- anything a real
        // share carries that verdict all the way down, so this is enough to
        // never even PROPFIND a Documents/Photos/Templates subtree, not just
        // to hide it once fetched. `!== false` keeps an unknown verdict in,
        // same rule as everywhere else this signal is read.
        if (depth === 0 && shareSignal(entry, { user: client.user }) === false) continue;

        if (entry.isFolder) {
          if (depth + 1 <= maxDepth) queue.push({ path: entry.path, depth: depth + 1 });
          else truncated = true;
        } else if (isNewer(entry, sinceMs)) {
          found.push(entry);
        }
      }
    }
  }

  // Folders still queued when the folder budget ran out are unvisited too.
  if (queue.length > 0) truncated = true;

  return { entries: newestFirst(found).slice(0, limit), truncated };
}

/**
 * Does this failure mean "this server does not do SEARCH, and never will"?
 *
 * The rule is the status class, not a list of statuses. Anything below 500 is
 * the server answering us on purpose -- 405 is the honest refusal, 400 is what
 * Nextcloud without the search backend answers a `basicsearch` with, 404 means
 * the DAV endpoint has no SEARCH handler, and a 302 to (or a 200 of) an HTML
 * login page is a front-end that will never route SEARCH to Nextcloud at all.
 * A list of statuses missed those last two, and the cost of missing them is not
 * a slow request: it is a doomed probe plus a warning line on EVERY home load,
 * for the life of the process.
 *
 * 5xx and network errors stay transient: a 502 from a proxy being restarted, a
 * 500, a dropped socket say nothing about SEARCH support, and demoting on one
 * would cost the instance its fast path until the next restart. 501 is the one
 * 5xx that is a verdict rather than a bad minute -- "not implemented" is
 * precisely the thing we are asking about.
 *
 * Two sub-500 statuses are carved back out, because they are the server saying
 * "not now" rather than "not ever": 408 (it gave up waiting for our request) and
 * 429 (we are asking too often -- which a home page under a burst of refreshes
 * genuinely can, and which a proxy can answer on Nextcloud's behalf). Demoting
 * on either would trade one busy moment for a permanent walk.
 */
const SEARCH_NOT_IMPLEMENTED = 501;
const SEARCH_TRY_AGAIN = new Set([408, 429]);

function refusesSearch(err) {
  if (!(err instanceof SearchUnsupportedError)) return false;
  // No status at all means we never got an answer; that is a bad minute.
  if (!Number.isInteger(err.status)) return false;
  if (SEARCH_TRY_AGAIN.has(err.status)) return false;
  return err.status < 500 || err.status === SEARCH_NOT_IMPLEMENTED;
}

/**
 * baseUrl -> 'search' | 'walk'. Module-level: one process, one answer.
 *
 * Deliberately sticky and deliberately not persisted. Sticky, because probing
 * SEARCH on every home load would cost an extra round trip forever on an
 * instance that will never support it. Not persisted, because a restart (which
 * is how this app is deployed) is exactly when re-probing is worth it -- an
 * admin who enables the search backend gets the fast path back for free.
 *
 * Only a structural refusal is remembered. A transient failure falls back for
 * that one page load and leaves the memo alone, so a single 502 cannot cost the
 * instance its fast path until the next restart.
 */
const strategyMemo = new Map();

/** Forget which strategy worked. Exposed for tests. */
export function clearStrategyMemo(memo = strategyMemo) {
  memo.clear();
}

/**
 * Files changed since `since`, by whichever route works.
 *
 * Adds exactly ONE upstream request to the home page whenever SEARCH is
 * available -- which is the budget this feature was given.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {Date} since previous visit; results are strictly newer than this
 * @param {{limit?: number, maxDepth?: number, maxFolders?: number,
 *          memo?: Map, log?: {warn: Function}}} [options]
 * @returns {Promise<{entries: Array<object>, strategy: 'search'|'walk',
 *                    settled: boolean, truncated: boolean}>}
 *   truncated: the walk gave up at one of its bounds, so there may be more it
 *   never saw. Always false for SEARCH, which is bounded by `limit` alone.
 *
 *   settled: this strategy is the one the instance has settled on, rather than
 *   a one-off fallback. It answers "is a better answer coming?", which is not
 *   the same question as "how was this one obtained" -- a walk run because
 *   SEARCH is refused outright is the best this instance will ever do, while a
 *   walk run because SEARCH had a bad minute will be replaced by a SEARCH on the
 *   next load. Callers that cache (see routes/home.js) need the difference.
 * @throws {NextcloudError} only if the fallback walk cannot list the root
 */
export async function findChangedSince(client, since, options = {}) {
  const { memo = strategyMemo, log, ...bounds } = options;
  const key = client.baseUrl;

  if (memo.get(key) !== 'walk') {
    try {
      const entries = await searchChangedSince(client, since, bounds);
      memo.set(key, 'search');
      return { entries, strategy: 'search', settled: true, truncated: false };
    } catch (err) {
      if (refusesSearch(err)) {
        memo.set(key, 'walk');
        log?.warn?.(
          { err, status: err?.status },
          'WebDAV SEARCH unavailable; using the bounded folder walk from now on'
        );
      } else {
        // A dead socket or a 502 says nothing about whether this server does
        // SEARCH. Walk this once and ask again next time.
        log?.warn?.(
          { err, status: err?.status },
          'WebDAV SEARCH failed; using the bounded folder walk for this request'
        );
      }
    }
  }

  const { entries, truncated } = await walkChangedSince(client, since, bounds);
  // The memo is what says which of the two walks this was: it holds 'walk' only
  // once a structural refusal has been recorded, and is left alone by a
  // transient one.
  return { entries, strategy: 'walk', settled: memo.get(key) === 'walk', truncated };
}

export { SEARCH_ROOT };
