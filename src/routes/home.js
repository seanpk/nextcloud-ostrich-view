import { propfind, sortEntries } from '../nextcloud/webdav.js';
import { findChangedSince, SEARCH_LIMIT } from '../nextcloud/search.js';
import { toTiles } from '../lib/tiles.js';
import {
  buildNewSince,
  createNewSinceCache,
  formatVisitLabel,
  NEW_SINCE_CAP,
} from '../lib/new-since.js';

/**
 * Home.
 *
 * Two things, in one round trip each:
 *  - the top level of everything shared with the viewer account, as big buttons;
 *  - "New since you last looked" -- whatever changed since this viewer's
 *    PREVIOUS sitting (see src/store/visits.js for why "previous" and not "last
 *    page load").
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
  // One per app instance, so tests get a fresh one with the server.
  const changeCache = createNewSinceCache();

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

      // Mid-sitting, `since` does not move, so every refresh would otherwise ask
      // Nextcloud the same question again. Only successful answers get cached.
      let found = changeCache.get(request.viewer.name, previousVisitStartedAt);
      if (found) {
        request.log.debug({ found: found.entries.length }, 'new-since lookup (remembered)');
      } else {
        found = await findChangedSince(app.nextcloud, since, {
          limit: SEARCH_LIMIT,
          log: request.log,
        });
        changeCache.set(request.viewer.name, previousVisitStartedAt, found);
        request.log.debug(
          { strategy: found.strategy, found: found.entries.length, truncated: found.truncated },
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

  app.get('/', async (request, reply) => {
    // Concurrent on purpose: the folder listing and the search are independent,
    // and on a phone the difference between one round trip and two is felt.
    const [entries, newSince] = await Promise.all([
      propfind(app.nextcloud, ''),
      loadNewSince(request),
    ]);

    // Both halves are in hand: this load counts as a visit. `commit` swallows
    // its own write failures, so this cannot fail the page either.
    await newSince.commit?.();

    const tiles = toTiles(sortEntries(entries));

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
