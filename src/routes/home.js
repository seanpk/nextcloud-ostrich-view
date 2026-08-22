import { propfind, sortEntries } from '../nextcloud/webdav.js';
import { findChangedSince, SEARCH_LIMIT } from '../nextcloud/search.js';
import { selectReceivedShares, shareListingRoots } from '../nextcloud/shares.js';
import { listReceivedShareTargets } from '../nextcloud/ocs.js';
import { toTiles } from '../lib/tiles.js';
import { buildNewSince, formatVisitLabel, NEW_SINCE_CAP } from '../lib/new-since.js';

/**
 * Home.
 *
 * Two things, in one round trip each:
 *  - the top level of everything shared with the viewer account, as big buttons;
 *  - "New since you last looked" -- whatever changed since this viewer's
 *    PREVIOUS sitting (see src/store/visits.js for why "previous" and not "last
 *    page load").
 *
 * "The top level of everything SHARED with the viewer account" is both LOCATED
 * and filtered, not assumed:
 *
 *  - Located, because an instance with a `share_folder` set (Nextcloud's
 *    default is `/Shared`) mounts received shares one level down, inside a
 *    folder the account itself owns. ../nextcloud/ocs.js asks where they are.
 *  - Filtered, because the account's files home also holds whatever Nextcloud
 *    seeded it with on first login (README §1 step 2 requires that login), and
 *    the viewer must never see that. ../nextcloud/shares.js tells a received
 *    share apart from the account's own content.
 *
 * Both are needed. Filtering alone shows an empty page whenever a share_folder
 * is configured; locating alone would let skeleton files through.
 *
 * The new-since half is strictly a bonus. Working out the visit, searching, and
 * building the tiles all happen inside one try/catch: if Nextcloud won't do
 * SEARCH, if the walk hits its bounds, if state.json is unreadable -- the page
 * still renders with the folder buttons, because those are what she came for.
 * Failures are logged, never shown.
 *
 * The visit is decided before the fetches and SAVED after them. A load that
 * failed on the way to Nextcloud leaves state.json untouched, so the next one
 * that works still compares against the same baseline; consuming it on a failed
 * load would hide everything that changed between her two previous sittings,
 * permanently.
 */
export default async function registerHomeRoutes(app) {
  // Built in server.js, one per app instance, so tests get a fresh one with the
  // server -- and can hand in one with a short TTL and a fake clock.
  const changeCache = app.newSinceCache;

  // Each logged at most once per process: a page refreshed all day must not
  // repeat the same warning on every load.
  let warnedNoShareSignal = false;
  let warnedNoShareLookup = false;
  let warnedFilteredEverything = false;

  /**
   * Advance the visit and work out what to show above the folders.
   * Never throws; returns the "show nothing" shape on any failure.
   *
   * `commit` is null whenever the answer is not one we are willing to spend the
   * baseline on -- the caller only calls it once the whole page has its data.
   */
  async function loadNewSince(request) {
    const empty = { tiles: [], moreLabel: null, lastVisitedAt: null, commit: null };

    let visit;
    try {
      visit = await app.visits.startVisit(request.viewer.name);
    } catch (err) {
      request.log.error({ err }, 'could not read the visit state');
      return empty;
    }

    const { previousVisitStartedAt, commit } = visit;

    // First sitting ever: there is no "before" to compare against, and
    // "everything the owner has ever shared" is not news. Nothing to fetch, so the
    // visit is safe to record.
    if (!previousVisitStartedAt) return { ...empty, commit };

    try {
      const since = new Date(previousVisitStartedAt);

      // Mid-sitting, `since` does not move, so a burst of refreshes would
      // otherwise ask Nextcloud the same question again. The cache entry expires
      // after a minute (see NEW_SINCE_CACHE_TTL_MS) precisely because `since`
      // does NOT move: a sitting can last all day, and a file uploaded in the
      // middle of one still has to turn up on the next reload.
      let found = changeCache.get(request.viewer.name, previousVisitStartedAt);
      if (found) {
        request.log.debug({ found: found.entries.length }, 'new-since lookup (remembered)');
      } else {
        found = await findChangedSince(app.nextcloud, since, {
          limit: SEARCH_LIMIT,
          log: request.log,
        });
        // A truncated answer is a degraded one -- but whether it is worth
        // remembering turns on whether a better one is coming, not on how
        // degraded it is.
        //
        // If SEARCH merely had a bad minute, the walk was a one-off: the next
        // load re-probes, and caching the half-answer would hold it for the
        // whole window and waste exactly the re-probe that could replace it.
        //
        // If the instance has SETTLED on the walk, though, this IS the answer --
        // and on a share deep or wide enough to hit the bounds, EVERY answer is
        // truncated. Refusing to cache those means the cache is never used at
        // all on precisely the instances that can least afford it: up to
        // WALK_MAX_FOLDERS PROPFINDs on every pull-to-refresh, for a section
        // that is a bonus.
        if (!found.truncated || found.settled) {
          changeCache.set(request.viewer.name, previousVisitStartedAt, found);
        }
        request.log.debug(
          {
            strategy: found.strategy,
            settled: found.settled,
            found: found.entries.length,
            truncated: found.truncated,
          },
          'new-since lookup'
        );
      }

      const { tiles, moreLabel } = buildNewSince(found.entries, {
        limit: NEW_SINCE_CAP,
        fetchLimit: SEARCH_LIMIT,
        truncated: found.truncated,
      });

      return {
        tiles,
        moreLabel,
        lastVisitedAt: tiles.length > 0 ? formatVisitLabel(since) : null,
        commit,
      };
    } catch (err) {
      request.log.error({ err }, 'could not build the "new since you last looked" section');
      return empty;
    }
  }

  /**
   * List every folder that can hold a received share, and return their entries
   * pooled together.
   *
   * The files home is always one of them, so the common single-PROPFIND case is
   * unchanged. A share_folder instance adds exactly one more.
   *
   * A root that fails is logged and skipped rather than failing the page -- a
   * share_folder can be renamed or a share revoked between the OCS answer and
   * the listing. If they ALL fail the first error is rethrown, so a genuinely
   * unreachable Nextcloud still reaches the "taking a break" page instead of
   * rendering as an empty one.
   */
  async function listShareRoots(request, rootEntries, roots) {
    if (roots.length === 1) return rootEntries; // just the files home

    const extraRoots = roots.filter((root) => root !== '');
    const settled = await Promise.allSettled(
      extraRoots.map((root) => propfind(app.nextcloud, root))
    );

    const pooled = [...rootEntries];
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        pooled.push(...result.value);
      } else {
        request.log.warn(
          { err: result.reason, root: extraRoots[index] },
          'could not list a share-folder root; its shares will be missing from the home page'
        );
      }
    }
    return pooled;
  }

  app.get('/', async (request, reply) => {
    // Concurrent on purpose: the folder listing, the search and the share
    // lookup are independent, and on a phone the difference between one round
    // trip and three is felt. The files home is listed unconditionally because
    // it is a share root whatever the OCS answer turns out to be.
    const [rootEntries, newSince, received] = await Promise.all([
      propfind(app.nextcloud, ''),
      loadNewSince(request),
      listReceivedShareTargets(app.nextcloud, { log: request.log }),
    ]);

    if (!received.ok && !warnedNoShareLookup) {
      warnedNoShareLookup = true;
      request.log.warn(
        { reason: received.reason },
        'could not ask Nextcloud where received shares are mounted; falling back to ' +
          'the files home alone. If this instance sets share_folder, shares live one ' +
          'level down and the page will look empty.'
      );
    }

    const roots = shareListingRoots(received.targets);
    const entries = await listShareRoots(request, rootEntries, roots);

    // Both halves are in hand: this load counts as a visit. `commit` swallows
    // its own write failures, so this cannot fail the page either.
    await newSince.commit?.();

    // Only these top levels are filtered: a sub-folder is inside a share by
    // construction, so there is nothing left to tell apart once you're in one.
    // `sawSignal` false means Nextcloud sent neither oc:permissions nor
    // oc:owner-id on ANY entry -- an odd or very old server -- in which case
    // every entry survived unfiltered and the page is exactly what it was
    // before this existed, aside from the one warning below.
    const { entries: shared, sawSignal } = selectReceivedShares(entries, {
      user: app.nextcloud.user,
    });
    if (!sawSignal && entries.length > 0 && !warnedNoShareSignal) {
      warnedNoShareSignal = true;
      request.log.warn(
        'Nextcloud returned no oc:permissions or oc:owner-id for the files home; ' +
          'showing every top-level entry, skeleton content included.'
      );
    }

    // Filtering away EVERYTHING is almost always a bug rather than an empty
    // account, and it renders as "Nothing has been shared with you yet" -- a
    // sentence that reads like a fact about sharing and gives no hint that a
    // filter was involved. Worth one line in the log saying so.
    if (shared.length === 0 && entries.length > 0 && !warnedFilteredEverything) {
      warnedFilteredEverything = true;
      request.log.warn(
        { listed: entries.length, roots },
        'every top-level entry was judged to be the viewer account\'s own content, so ' +
          'the home page is empty. If this instance sets share_folder and the OCS share ' +
          'lookup failed, the shares are one level down and were never listed.'
      );
    }

    const tiles = toTiles(sortEntries(shared));

    return reply.view('home', {
      title: 'Shared files',
      viewer: request.viewer,
      tiles,
      newSince: newSince.tiles,
      newSinceMore: newSince.moreLabel,
      lastVisitedAt: newSince.lastVisitedAt,
      showToggle: true,
      section: 'files',
      showBack: false,
      breadcrumbs: [],
    });
  });
}
