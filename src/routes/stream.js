import { findRecent, SEARCH_LIMIT } from '../nextcloud/search.js';
import { fetchTodos, listTaskCalendars } from '../nextcloud/caldav.js';
import { buildStream, buildTimeline, fileEvents, formatVisitLabel } from '../lib/stream.js';
import { sortUpcoming, taskEvents, undatedOpenCount, upcomingTasks } from '../lib/stream-tasks.js';

/**
 * The stream ("Latest") -- the page she lands on.
 *
 * One time axis. Below the Today line: what has been changing, newest first,
 * grouped by day, files and task changes interleaved, with the rows newer than
 * her previous sitting badged New. Above it: what is coming, the open tasks'
 * due dates, furthest away at the top and overdue right above the line. `/`
 * links here as `/#today`, so she opens on the line with the future above her
 * thumb and the past below it -- and that anchor is the mechanism, working with
 * scripting off. It only fails where there is no fragment to answer: a bookmark
 * or a home-screen icon opens plain `/`, and a redirect cannot add one (the
 * browser never sends it, so `Location: /#today` would loop). That case is
 * public/stream.js, which scrolls to Today on load and nothing else.
 *
 * IT IS A HIGHLIGHT, NOT A FILTER, and that is the whole design. The section
 * this replaced compared two timestamps and showed only what fell between
 * them, which meant a stamp we had misread -- a clock that jumped, a
 * hand-edited state file, a rotation spent on a load that never rendered --
 * showed her an empty page and told her nothing had happened. Now the list is
 * always the list; the stamps only decide where the badges go.
 *
 * SO FAILURES REACH THE ERROR PAGES -- the FILE half's failures, at least.
 * This page IS the app now, not a bonus section above the folder buttons, so a
 * `NextcloudError` from the search is left to propagate to the handler in
 * ../server.js: "the file server is taking a break" (503, self-retrying) or
 * "needs attention" (502), whichever fits. Rendering an empty stream instead
 * would say "nothing has changed" about a lookup that never happened --
 * exactly the lie the old section's try/catch used to tell, and the reason it
 * could get away with it (the folder buttons underneath were what she came
 * for) is gone.
 *
 * THE TASK HALF IS BEST-EFFORT, one list at a time. A page with the files and
 * three of four task lists is worth far more than an error page, so a list
 * whose REPORT fails is logged (once per list) and skipped, and a calendar home
 * that will not answer at all leaves a quiet line saying tasks could not be
 * checked. The page never fails because of tasks.
 *
 * IT COSTS MORE THAN ONE ROUND TRIP NOW, DELIBERATELY. #2 held this page to a
 * single WebDAV SEARCH. Tasks cannot be had that way: CalDAV has no
 * cross-calendar query, so it is one PROPFIND for the list of calendars plus
 * one REPORT per calendar. That is fine here and would not be anywhere else:
 * N is the number of lists the owner has shared (a handful), every REPORT
 * runs concurrently with the others AND with the SEARCH, `fetchTodos` skips the
 * REPORT entirely while a list's ctag is unchanged, and the calendar list
 * itself is remembered for the same minute the file half is -- so a
 * pull-to-refresh burst still costs nothing at all.
 *
 * A TRUNCATED WALK IS NOT A FAILURE. When SEARCH is unavailable and the
 * fallback walk hits its bounds, the page renders what was found and says so
 * at the bottom -- see `moreLabel` in ../lib/stream.js.
 *
 * VISIT STATE IS THE ONE THING THAT DEGRADES. An unreadable state.json costs
 * the badges and the "you were last here" note, logged once, because a
 * timestamp we cannot read is no reason to withhold a list that does not
 * depend on it. An unreadable tasks-seen.json costs a repeat of the Added rows.
 *
 * BOTH KINDS OF STATE ARE DECIDED BEFORE THE FETCH AND SAVED AFTER IT. A load
 * that failed on the way to Nextcloud leaves state.json untouched, so the next
 * one that works still compares against the same baseline; consuming it on a
 * failed load would drop the badges on everything that changed between her two
 * previous sittings, permanently. The seen-tasks ledger is saved at the same
 * point and for the same reason: it is the record that a task was FIRST seen,
 * and a load that never rendered has not shown anybody anything.
 */

/**
 * The stream's cache keys.
 *
 * Constants, because the questions are constants: "the newest SEARCH_LIMIT
 * files" and "which task lists are shared", the same for every viewer and
 * independent of any visit stamp. (The old section's key carried the viewer and
 * her baseline because the QUESTION carried them.) The todos themselves are
 * cached a layer down, by ctag, in ../nextcloud/caldav.js.
 */
const FILES_KEY = 'files';
const CALENDARS_KEY = 'calendars';

export default async function registerStreamRoutes(app) {
  // Built in server.js, one per app instance, so tests get a fresh one with the
  // server -- and can hand in one with a short TTL and a fake clock.
  const streamCache = app.streamCache;

  /**
   * Task lists whose REPORT we have already complained about.
   *
   * One line per list, not one per page load: a list that has been broken since
   * Tuesday must not write the same warning into the log every time anybody
   * opens the app. Per app instance rather than per module, so a test's log is
   * its own.
   */
  const complainedLists = new Set();

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

  /**
   * Which task lists are shared, from Nextcloud or from the last minute's answer.
   *
   * The ctags come with them, which is the whole trade: a remembered ctag means
   * `fetchTodos` sees no reason to re-REPORT, so for up to a minute this page
   * can be a minute behind the tasks. `/tasks/<slug>` does its own PROPFIND and
   * so is never behind -- which means opening a task list can leave the stream
   * showing an older state than the page she just came from, for less than a
   * minute. Worth it: this is the page she pulls to refresh, and the
   * alternative is a PROPFIND per pull.
   */
  async function loadCalendars() {
    const remembered = streamCache.get(CALENDARS_KEY);
    if (remembered) return remembered;

    const calendars = await listTaskCalendars(app.nextcloud);
    // Cached WITH their ctags, which is what keeps the layer below honest: a
    // remembered ctag means a remembered REPORT, and both expire together.
    streamCache.set(CALENDARS_KEY, calendars);
    return calendars;
  }

  /**
   * Every shared list's todos, as far as they could be read.
   *
   * The REPORTs run concurrently and are settled individually: one list is
   * never allowed to take the others (or the page) down with it. A rejected
   * calendar home, on the other hand, means we know of no lists at all, which
   * is the one thing the reader has to be told about.
   */
  async function loadTasks(request) {
    let calendars;
    try {
      calendars = await loadCalendars();
    } catch (err) {
      request.log.warn({ err }, 'could not list the task lists; the stream will say so');
      return { lists: [], unavailable: true };
    }

    const settled = await Promise.allSettled(
      calendars.map((calendar) =>
        fetchTodos(app.nextcloud, calendar.slug, { calendars }).then((todos) => ({
          calendar,
          todos,
        }))
      )
    );

    const lists = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        lists.push(result.value);
        continue;
      }
      const calendar = calendars[index];
      if (!complainedLists.has(calendar.uri)) {
        complainedLists.add(calendar.uri);
        request.log.warn(
          { err: result.reason, list: calendar.uri },
          'could not read a task list; leaving it out of the stream'
        );
      }
    }

    return { lists, unavailable: false };
  }

  app.get('/', async (request, reply) => {
    // Decided first, committed last -- see the note at the top of this file.
    const visit = await startVisit(request);

    // The files, the task lists and what we remember about those tasks, all at
    // once: the two halves of the page have nothing to say to each other, and
    // waiting for one before starting the other would just be slower.
    //
    // Settled rather than all: only the FILE half is allowed to fail the page,
    // and `Promise.all` would let a broken calendar home reject first and take
    // the file rows with it.
    const [files, tasks, ledger] = await Promise.allSettled([
      loadRecentFiles(request),
      loadTasks(request),
      app.tasksSeen.read(),
    ]);

    // The one failure that reaches the error pages, deliberately unhandled from
    // here: see the note at the top of this file.
    if (files.status === 'rejected') throw files.reason;

    const found = files.value;
    const now = new Date();

    // A ledger we could not read means every task looks new; the store has
    // already logged it. Costly in Added rows, never in rows withheld.
    const seen = ledger.status === 'fulfilled' ? ledger.value : {};
    // `loadTasks` swallows its own failures, so this is belt and braces: a bug
    // in the task half must still leave her with the file rows.
    const taskHalf = tasks.status === 'fulfilled' ? tasks.value : { lists: [], unavailable: true };

    const events = fileEvents(found.entries);
    const upcoming = [];
    const updates = {};
    let undatedCount = 0;

    for (const { calendar, todos } of taskHalf.lists) {
      const { events: happened, updates: sightings } = taskEvents(todos, calendar, seen, { now });
      events.push(...happened);
      upcoming.push(...upcomingTasks(todos, calendar, { now }));
      Object.assign(updates, sightings);
      undatedCount += undatedOpenCount(todos);
    }

    const history = buildStream(events, {
      previousVisitAt: visit.previousVisitAt,
      now,
      // The fetch bound is also the page bound: everything one SEARCH brings
      // back is worth showing, and there is nothing behind it to page to.
      limit: SEARCH_LIMIT,
      fetchLimit: SEARCH_LIMIT,
      truncated: found.truncated,
    });

    const { days, newCount, moreLabel, total, future, undatedLabel, moreUpcomingLabel } =
      buildTimeline({
        // Each list's rows arrive already ordered; merged, they need one more
        // pass to become a single axis.
        upcoming: sortUpcoming(upcoming),
        history,
        undatedCount,
        now,
        limit: SEARCH_LIMIT,
      });

    // The page has its data: this load counts as a visit, and the tasks on it
    // count as seen. Both swallow their own write failures, so neither can fail
    // the page.
    await visit.commit?.();
    await app.tasksSeen.save(updates);

    return reply.view('stream', {
      title: 'Latest',
      viewer: request.viewer,
      days,
      newCount,
      moreLabel,
      // What is coming, above the Today line.
      future,
      undatedLabel,
      moreUpcomingLabel,
      // Zero rows in the HISTORY, which is the one case the "Nothing has
      // changed yet" line is allowed to appear under. Deliberately blind to
      // what is coming: a household with three tasks due next week and no
      // changes yet is a household where nothing has changed yet, and the
      // block above the line says the rest.
      total,
      // Said quietly, above the history: the file rows are all there, and the
      // task rows may not be.
      tasksUnavailable: taskHalf.unavailable,
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
