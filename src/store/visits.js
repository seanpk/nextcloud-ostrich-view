import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * "When did this viewer last look?" -- the whole state this app keeps.
 *
 * One flat JSON file, `<dataDir>/state.json`:
 *
 *   { "mom": { "currentVisitStartedAt": "...", "previousVisitStartedAt": "...",
 *              "lastSeenAt": "..." } }
 *
 * WHAT IT IS FOR, NOW. The stream (src/routes/stream.js) always shows the
 * recent history of changes; these stamps decide only which rows carry a New
 * badge. That is a smaller job than the one this file was written for -- the
 * old "New since you last looked" section WAS a filter, and a stamp we got
 * wrong emptied the page. It cannot do that any more: the worst a wrong
 * rotation can do now is put the badges on the wrong rows, on a list she can
 * read either way. The mechanism below is unchanged; only the stakes are.
 *
 * TWO TIMESTAMPS, NOT ONE. The badges compare against
 * `previousVisitStartedAt`, never against `current`. If they compared against a
 * single "last seen" stamp refreshed on every load, pulling the page down to
 * refresh would clear every badge she had not read yet -- the marks that tell
 * her what she has not seen, gone by the act of looking. So a *visit* is a
 * sitting, not a page load: `current` is stamped when a sitting starts and left
 * alone while it lasts, and only when a sitting has clearly ended does it
 * rotate into `previous`.
 *
 * ...AND A THIRD, WHICH IS NOT ONE OF THEM. `lastSeenAt` is refreshed on every
 * stream load and decides only one thing: whether the sitting is over
 * (VISIT_WINDOW_MS of no page loads). Measuring that from the sitting's START
 * instead would rotate mid-read -- the badges would move while she was working
 * through them. It is never compared against, so refreshing it cannot clear
 * anything.
 *
 * FIRST-EVER VISIT. A brand-new viewer has no `previous` at all, which means
 * "there is nothing to compare against" -- so nothing is badged. It
 * deliberately does not mean "everything is new": forty New badges on a first
 * load is noise, not news. She still gets the whole stream, which is what has
 * changed since this was a section that hid itself instead.
 *
 * DECIDE NOW, PERSIST LATER. `startVisit` works out the rotation but writes
 * nothing; the caller commits once the page it needed the rotation for actually
 * rendered. A stream load that fell over on the way to Nextcloud must not
 * consume the baseline -- if it did, everything that changed between her two
 * previous sittings would lose its badge for good, and the failed load is the
 * one moment she could not see it.
 *
 * DURABILITY. Writes are temp-file + rename, so a reader (or a container that
 * dies mid-write) sees either the old file or the new one, never half of one.
 * A write that fails is logged and swallowed: losing a visit stamp costs a
 * page of badges, and is never a reason to fail the page itself.
 */

/**
 * How long a sitting lasts with no page loads before it counts as over.
 *
 * ONE HOUR. It was six, back when the section was a filter: a window shorter
 * than a person's day risked rotating between two glances and leaving her with
 * an empty page she had not finished reading. Nothing is hidden now, so the
 * only thing the window has to get right is the badges -- and for those, short
 * is accurate: a morning check and a lunchtime check are two separate sittings,
 * and each should be told what arrived since the other. An hour is long enough
 * that a cup of tea mid-read does not count as leaving.
 */
export const VISIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * How far ahead of us a stored stamp may be and still be believed.
 *
 * Phones, containers and NTP disagree by seconds, not hours. A stamp further
 * ahead than this is a clock that jumped, and is discarded rather than trusted
 * -- most importantly it is never promoted into `previous`, where a date in the
 * future would silently mean "nothing is ever new" for as long as it stayed
 * there, and the badges would stop appearing at all.
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const STATE_FILE_NAME = 'state.json';

/** In-progress writes are `.state-<uuid>.tmp`, alongside the real file. */
const TEMP_PREFIX = '.state-';

/**
 * A stored timestamp, normalized -- or null if it is missing or unusable.
 * Anything that isn't a parseable date is treated as absent rather than
 * repaired: a corrupt stamp must not be able to make the comparison lie.
 */
function isoOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A stored stamp we are willing to believe: absent, unparseable, or dated
 * further ahead than CLOCK_SKEW_MS all come back as null.
 */
function believableStamp(value, nowMs) {
  const iso = isoOrNull(value);
  if (iso === null) return null;
  return Date.parse(iso) > nowMs + CLOCK_SKEW_MS ? null : iso;
}

/**
 * The visit-rotation rule, as a pure function of (record, now).
 *
 * @param {{currentVisitStartedAt?: string, previousVisitStartedAt?: string,
 *          lastSeenAt?: string}|undefined} record
 * @param {number} nowMs
 * @param {number} [windowMs]
 * @returns {{record: {currentVisitStartedAt: string, previousVisitStartedAt: string|null,
 *                     lastSeenAt: string},
 *            changed: boolean}}
 *   changed: whether the file needs rewriting. `lastSeenAt` moves on every load,
 *   so this is normally true -- a few hundred bytes per stream load, which is
 *   the price of measuring the sitting from her last page rather than her first.
 */
export function rotateRecord(record, nowMs, windowMs = VISIT_WINDOW_MS) {
  const nowIso = new Date(nowMs).toISOString();
  const current = believableStamp(record?.currentVisitStartedAt, nowMs);
  const previous = isoOrNull(record?.previousVisitStartedAt);
  // Records written before lastSeenAt existed fall back to the start of the
  // sitting, which is exactly what the old rule measured from.
  const lastSeen = believableStamp(record?.lastSeenAt, nowMs) ?? current;

  // Idle time, not sitting length: the window is about how long ago she was
  // last here, so an unhurried read stays one sitting however long it takes.
  const idle = lastSeen === null ? Number.POSITIVE_INFINITY : nowMs - Date.parse(lastSeen);
  const sameSitting = current !== null && idle < windowMs;

  if (sameSitting) {
    return {
      record: {
        currentVisitStartedAt: current,
        previousVisitStartedAt: previous,
        lastSeenAt: nowIso,
      },
      changed:
        current !== record?.currentVisitStartedAt ||
        previous !== (record?.previousVisitStartedAt ?? null) ||
        nowIso !== record?.lastSeenAt,
    };
  }

  return {
    record: {
      currentVisitStartedAt: nowIso,
      // The sitting that just ended becomes the thing we compare against. Null
      // on a first-ever visit, which is what leaves everything unbadged. A
      // `current` we did not believe leaves `previous` alone rather than
      // replacing a real baseline with a bogus one.
      previousVisitStartedAt: current ?? previous,
      lastSeenAt: nowIso,
    },
    changed: true,
  };
}

/**
 * Whatever was on disk, reduced to records we are willing to act on.
 *
 * Built on a null-prototype object and copied key by key: the file is ours, but
 * it is still parsed input, and a `__proto__` or `constructor` key in it should
 * be an odd viewer name and nothing more.
 */
function sanitizeState(parsed) {
  const state = Object.create(null);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return state;

  for (const [name, record] of Object.entries(parsed)) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    state[name] = {
      currentVisitStartedAt: isoOrNull(record.currentVisitStartedAt),
      previousVisitStartedAt: isoOrNull(record.previousVisitStartedAt),
      lastSeenAt: isoOrNull(record.lastSeenAt),
    };
  }
  return state;
}

/**
 * @param {{ dir: string, now?: () => number, windowMs?: number,
 *           log?: {warn: Function} }} options
 *   now: clock, injectable so rotation can be tested across the window
 *   without waiting an hour.
 */
export function createVisitStore({ dir, now = Date.now, windowMs = VISIT_WINDOW_MS, log } = {}) {
  if (!dir) throw new Error('createVisitStore: dir is required');

  const filePath = join(dir, STATE_FILE_NAME);

  // Every read-modify-write goes through one chain, reads included. Chaining
  // the writes alone is not enough: each write rewrites the WHOLE file, so two
  // rotations that both read before either wrote would each save a snapshot
  // taken before the other existed, and the second rename would quietly delete
  // the first viewer's visit. Reads deliberately go to disk every time (the file
  // is a few hundred bytes, and page loads are rare) so that an external edit --
  // the E2E suite simulating "she came back tomorrow" -- is actually seen.
  let chain = Promise.resolve();

  /** Run `task` after everything already queued, whether or not that failed. */
  function serialize(task) {
    const result = chain.then(task, task);
    chain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  // The last unreadable file we complained about. A visit is read twice (decide,
  // then save), and a file we cannot repair -- an unwritable volume -- would
  // otherwise fill the log with the same line on every stream load forever.
  let complainedAbout = null;

  function complainOnce(about, err, message) {
    if (complainedAbout === about) return;
    complainedAbout = about;
    log?.warn?.({ err, filePath }, message);
  }

  async function readState() {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      // No file yet is the normal first-boot case, not a problem.
      if (err.code !== 'ENOENT') {
        complainOnce(`read:${err.code}`, err, 'could not read visit state; starting fresh');
      }
      return sanitizeState(null);
    }

    try {
      const state = sanitizeState(JSON.parse(raw));
      complainedAbout = null;
      return state;
    } catch (err) {
      // Truncated or hand-edited into nonsense. Starting over costs one page of
      // badges; refusing to serve the page costs the whole app.
      complainOnce(`parse:${raw}`, err, 'visit state is not valid JSON; starting fresh');
      return sanitizeState(null);
    }
  }

  async function writeState(state) {
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, filePath);
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  /**
   * Save one viewer's record onto the freshest state on disk.
   * Never rejects: a lost visit stamp costs the badges, not the page.
   */
  function persist(viewerName, record) {
    return serialize(async () => {
      // Re-read inside the chain rather than reusing the caller's snapshot:
      // another viewer may have been written since it was taken.
      const state = await readState();
      state[viewerName] = record;
      try {
        await writeState(state);
      } catch (err) {
        log?.warn?.({ err, filePath }, 'could not save visit state');
      }
    });
  }

  /**
   * Work out `viewerName`'s visit as of now, WITHOUT writing anything.
   *
   * Call this once per authenticated STREAM load, and from nowhere else.
   * Browsing files or tasks must not advance a sitting: only the page that
   * shows the badges is allowed to spend the baseline they are measured
   * against. Even here the advance only becomes real when the caller calls
   * `commit`, which it should do once the page has the data it needs. Not
   * calling it leaves the baseline exactly as it was.
   *
   * @param {string} viewerName `request.viewer.name`
   * @returns {Promise<{currentVisitStartedAt: string, previousVisitStartedAt: string|null,
   *                    lastSeenAt: string, commit: () => Promise<void>}>}
   */
  async function startVisit(viewerName) {
    const { record, changed } = await serialize(async () => {
      const state = await readState();
      return rotateRecord(state[viewerName], now(), windowMs);
    });

    return {
      ...record,
      commit: changed ? () => persist(viewerName, record) : async () => {},
    };
  }

  return {
    filePath,

    /** Every viewer's record, normalized. Mostly for tests and diagnostics. */
    read: readState,

    startVisit,

    /**
     * Advance the visit and save it in one go, for callers with nothing to wait
     * for. The stream uses `startVisit` instead, so that a load which never
     * rendered cannot spend the baseline.
     *
     * @param {string} viewerName
     * @returns {Promise<{currentVisitStartedAt: string, previousVisitStartedAt: string|null,
     *                    lastSeenAt: string}>}
     */
    async rotate(viewerName) {
      const { commit, ...record } = await startVisit(viewerName);
      await commit();
      return record;
    },
  };
}

export default createVisitStore;
