import { findRecent, SEARCH_LIMIT } from '../nextcloud/search.js';
import { buildStream, fileEvents, formatVisitLabel } from '../lib/stream.js';

/**
 * The stream ("Latest") -- the page she lands on.
 *
 * What has been changing, newest first, grouped by day, with the rows newer
 * than her previous sitting badged New. One WebDAV SEARCH: the newest
 * SEARCH_LIMIT files in the whole shared tree, no paging, no date filter.
 *
 * IT IS A HIGHLIGHT, NOT A FILTER, and that is the whole design. The section
 * this replaced compared two timestamps and showed only what fell between
 * them, which meant a stamp we had misread -- a clock that jumped, a
 * hand-edited state file, a rotation spent on a load that never rendered --
 * showed her an empty page and told her nothing had happened. Now the list is
 * always the list; the stamps only decide where the badges go.
 *
 * SO FAILURES REACH THE ERROR PAGES. This page IS the app now, not a bonus
 * section above the folder buttons, so a `NextcloudError` is left to propagate
 * to the handler in ../server.js: "the file server is taking a break" (503,
 * self-retrying) or "needs attention" (502), whichever fits. Rendering an
 * empty stream instead would say "nothing has changed" about a lookup that
 * never happened -- exactly the lie the old section's try/catch used to tell,
 * and the reason it could get away with it (the folder buttons underneath were
 * what she came for) is gone.
 *
 * A TRUNCATED WALK IS NOT A FAILURE. When SEARCH is unavailable and the
 * fallback walk hits its bounds, the page renders what was found and says so
 * at the bottom -- see `moreLabel` in ../lib/stream.js.
 *
 * VISIT STATE IS THE ONE THING THAT DEGRADES. An unreadable state.json costs
 * the badges and the "you were last here" note, logged once, because a
 * timestamp we cannot read is no reason to withhold a list that does not
 * depend on it.
 *
 * The visit is decided before the fetch and SAVED after it. A load that failed
 * on the way to Nextcloud leaves state.json untouched, so the next one that
 * works still compares against the same baseline; consuming it on a failed
 * load would drop the badges on everything that changed between her two
 * previous sittings, permanently.
 */

/**
 * The stream's cache key.
 *
 * A constant, because the question is a constant: "the newest SEARCH_LIMIT
 * files", the same for every viewer and independent of any visit stamp. (The
 * old section's key carried the viewer and her baseline because the QUESTION
 * carried them.) #3 adds a second key for the task half.
 */
const FILES_KEY = 'files';

export default async function registerStreamRoutes(app) {
  // Built in server.js, one per app instance, so tests get a fresh one with the
  // server -- and can hand in one with a short TTL and a fake clock.
  const streamCache = app.streamCache;

  /**
   * Which sitting to compare against, and how to record this one.
   * Never throws: the shape it returns on failure simply has no baseline.
   */
  async function startVisit(request) {
    try {
      const visit = await app.visits.startVisit(request.viewer.name);
      return { previousVisitAt: visit.previousVisitStartedAt, commit: visit.commit };
    } catch (err) {
      request.log.error({ err }, 'could not read the visit state; the stream will show no badges');
      return { previousVisitAt: null, commit: null };
    }
  }

  /** The newest files, from Nextcloud or from the last minute's answer. */
  async function loadRecentFiles(request) {
    const remembered = streamCache.get(FILES_KEY);
    if (remembered) {
      request.log.debug({ found: remembered.entries.length }, 'stream lookup (remembered)');
      return remembered;
    }

    const found = await findRecent(app.nextcloud, {
      limit: SEARCH_LIMIT,
      log: request.log,
    });

    // A truncated answer is a degraded one -- but whether it is worth
    // remembering turns on whether a better one is coming, not on how degraded
    // it is.
    //
    // If SEARCH merely had a bad minute, the walk was a one-off: the next load
    // re-probes, and caching the half-answer would hold it for the whole window
    // and waste exactly the re-probe that could replace it.
    //
    // If the instance has SETTLED on the walk, though, this IS the answer --
    // and on a share deep or wide enough to hit the bounds, EVERY answer is
    // truncated. Refusing to cache those means the cache is never used at all
    // on precisely the instances that can least afford it: up to
    // WALK_MAX_FOLDERS PROPFINDs on every pull-to-refresh, for the page she
    // opens the app on.
    if (!found.truncated || found.settled) {
      streamCache.set(FILES_KEY, found);
    }
    request.log.debug(
      {
        strategy: found.strategy,
        settled: found.settled,
        found: found.entries.length,
        truncated: found.truncated,
      },
      'stream lookup'
    );
    return found;
  }

  app.get('/', async (request, reply) => {
    // Decided first, committed last -- see the note at the top of this file.
    const visit = await startVisit(request);

    const found = await loadRecentFiles(request);
    const now = new Date();

    const { days, newCount, moreLabel, total } = buildStream(fileEvents(found.entries), {
      previousVisitAt: visit.previousVisitAt,
      now,
      // The fetch bound is also the page bound: everything one SEARCH brings
      // back is worth showing, and there is nothing behind it to page to.
      limit: SEARCH_LIMIT,
      fetchLimit: SEARCH_LIMIT,
      truncated: found.truncated,
    });

    // The page has its data: this load counts as a visit. `commit` swallows its
    // own write failures, so this cannot fail the page either.
    await visit.commit?.();

    return reply.view('stream', {
      title: 'Latest',
      viewer: request.viewer,
      days,
      newCount,
      moreLabel,
      // Zero rows on the page, which is the one case the "Nothing has changed
      // yet" line is allowed to appear under.
      total,
      // Null on a first-ever visit, which is what leaves the note off the page:
      // "you were last here" is not a thing to say to someone who wasn't.
      lastVisitedAt: formatVisitLabel(visit.previousVisitAt, { now }),
      showToggle: true,
      section: 'latest',
      // The top of the app: there is nowhere to go back to.
      showBack: false,
      breadcrumbs: [],
    });
  });
}
