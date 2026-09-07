import { accentClassFor, formatDueLabel, isOverdue } from './tasks.js';
import { civilDay } from './dates.js';
import { ledgerKey } from '../store/tasks-seen.js';

/**
 * Tasks, as the stream's rows -- what happened to them, and what is coming.
 *
 * Pure: todos in, a ledger in, view-model out. The route does the fetching and
 * the saving (../routes/stream.js), the ledger is a file
 * (../store/tasks-seen.js), and every rule about what counts as an event and
 * how it is worded is decided here, where a unit test can ask about it without
 * a server or a browser.
 *
 * THREE THINGS CAN HAPPEN TO A TASK, as far as this app can tell: it can turn
 * up (Added), it can be ticked off (Finished), or it can be edited (Changed).
 * A task that is DELETED is deliberately not an event: the REPORT only tells us
 * what exists, so "gone" would have to be inferred from a snapshot of what used
 * to, and the ledger keeps missing UIDs precisely because we cannot tell
 * "deleted" from "unshared" or from "that list's REPORT failed today".
 *
 * WHERE THE DATES COME FROM. Finished is dated by COMPLETED, which is real
 * data. Added and Changed cannot be: the household's client writes no CREATED
 * and no LAST-MODIFIED, only a DTSTAMP it bumps on every edit. So "Added" means
 * "the first load on which this app ever saw this UID"; and "Changed" means
 * "its stamp or its ETag moved since we last looked". Both facts live in the
 * ledger, which is why the events are derived from the ledger rather than
 * emitted once and forgotten: a row that appeared on one load and vanished
 * from the next would be worse than no row -- and with two viewers, whoever
 * refreshed first would be the only one ever told.
 *
 * ...AND WHICH DATE AN "ADDED" ROW GETS depends on whether this app is meeting
 * the whole household for the first time or one task that turned up later. On
 * an empty ledger it is a BACKFILL: every task is dated by its own stamp, and
 * the page shows the household's real history once. Afterwards, a UID we have
 * never seen whose stamp is older than FRESH_STAMP_MS did not appear a month
 * ago -- it appeared to US now, because a list was shared or a task was moved
 * between lists -- so it is dated now, which puts it at the top of the history
 * with a New badge instead of months down the page with none. A task that is
 * already finished is exempt: its news is its Finished row, and "Added today"
 * would be a plain untruth about something done in July. See `sight`.
 *
 * The full rule is in `sight`; it is the one place in this module where our
 * clock is allowed to date a row, and it is deliberately narrow.
 *
 * CANCELLED TASKS SAY NOTHING. A called-off chore is not finished and is not
 * still to do; the task pages leave it out of both sections (see
 * `buildTaskTree`), and a stream row about it would be the one place in the app
 * that mentioned it.
 */

/**
 * How close two stamps have to be to count as the same moment.
 *
 * TICKING A TASK OFF BUMPS ITS DTSTAMP to the COMPLETED instant -- that is what
 * the real server does -- so without this every completion is two rows,
 * "Finished" and "Changed", a second apart. The same tolerance covers a task
 * that is created and completed in one sitting: one row, "Finished", not
 * "Added" and "Finished" at the same minute.
 *
 * A minute, because these stamps are written by two clocks (the phone's and the
 * server's) and can differ by seconds; and because nothing a person does to a
 * task inside a minute is two pieces of news.
 */
export const CHANGE_TOLERANCE_MS = 60_000;

/**
 * How stale a ledger entry's `lastSeenAt` may get before we rewrite it.
 *
 * It exists only for the 90-day prune (see PRUNE_AFTER_MS), so a day's
 * precision is plenty -- and the difference matters: refreshing it on every
 * load would rewrite the whole ledger on every page load, for a field nothing
 * reads to the minute.
 */
export const SEEN_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * How recent a stamp has to be for a task we have never seen to be dated by it
 * rather than by our clock. See `sight`.
 *
 * A DAY, because that is the span over which "its stamp is when it was written"
 * stays a safe guess. Inside a day, a task's DTSTAMP and its arrival are the
 * same event as far as any reader is concerned -- she was asleep for most of
 * it. Beyond a day, the two have come apart for a reason we can actually name:
 * a list shared long after its tasks were written, a task dragged from one list
 * to another, a ledger restored from a backup. Dating those by the stamp is
 * what buries genuinely new work months down the page, unbadged.
 *
 * It is not a clock-skew tolerance (that is CHANGE_TOLERANCE_MS) and it is not
 * a window anything is filtered by: it only ever chooses between two dates for
 * a row that appears either way.
 */
export const FRESH_STAMP_MS = 24 * 60 * 60 * 1000;

/** ISO string, or null for anything that is not a usable date. */
function iso(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

function msOf(isoString) {
  if (typeof isoString !== 'string') return null;
  const ms = Date.parse(isoString);
  return Number.isFinite(ms) ? ms : null;
}

/** Within CHANGE_TOLERANCE_MS of each other, i.e. the same piece of news. */
function sameMoment(a, b) {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= CHANGE_TOLERANCE_MS;
}

/**
 * The list a row belongs to, as the template needs it: a name, a colour class,
 * and somewhere to go.
 *
 * Tapping a task row opens its LIST, not the task: `/tasks/<slug>` is the only
 * page in this app that shows a task in full, and a row that led nowhere would
 * be the only dead end on the page.
 */
function listView(list) {
  return {
    name: list.displayName ?? list.uri ?? 'Tasks',
    slug: list.slug,
    // The owner's own calendar colour, bucketed into a class because the CSP
    // forbids inline styles -- same rule, same function, as the task tiles.
    accentClass: accentClassFor(list.color ?? null),
    href: `/tasks/${encodeURIComponent(list.slug)}`,
  };
}

/**
 * When a task we have never seen before should be said to have been added.
 *
 * CREATED always wins: a client that keeps one has answered the question, and
 * nothing we can infer beats it. Everything below is about the household's own
 * client, which writes only a DTSTAMP -- a stamp that says when the task was
 * last WRITTEN, and says nothing at all about when it was shared with us.
 *
 * THREE CASES, and the difference between them is what the ledger's own state
 * tells us about what kind of sighting this is:
 *
 *  - BACKFILL -- the ledger is empty, so this app is meeting the whole
 *    household at once (a first deploy, a wiped data volume, a `state.json`
 *    directory we could not read). Every task is dated by its own stamp. That
 *    burst of rows IS the household's history, the stamps in it are real, and
 *    showing it once is the right thing; dating forty tasks "now" would be a
 *    page of identical timestamps claiming everything happened this minute.
 *
 *  - A FINISHED TASK arriving late -- same rule as backfill. Its news is its
 *    Finished row, at COMPLETED, where it belongs; and since ticking a task off
 *    bumps its DTSTAMP to that instant, the 60s dedupe usually swallows the
 *    Added row entirely. Dating it "now" would say a chore finished in July was
 *    added today, which is simply false.
 *
 *  - ANYTHING ELSE -- an open task turning up in a ledger that already knows
 *    the household. A stamp inside FRESH_STAMP_MS is kept: the owner wrote it
 *    this morning and we are seeing it as soon as anybody could. An older stamp
 *    is NOT when this task appeared to us: a list has just been shared, or a
 *    task was moved between lists, and the only honest answer to "when did this
 *    turn up?" is now. That is also the only answer that puts it where she will
 *    see it -- top of the history, with a New badge -- rather than months down
 *    the page with none, which is the one event this whole ledger exists to
 *    catch.
 *
 * @param {{createdAt: string|null, stampAt: string|null, isCompleted: boolean}} stamps
 * @param {{nowIso: string, nowMs: number, backfill: boolean}} context
 * @returns {string} an ISO stamp; never null, because a row needs a date
 */
function addedStamp({ createdAt, stampAt, isCompleted }, { nowIso, nowMs, backfill }) {
  if (createdAt !== null) return createdAt;
  if (backfill || isCompleted) return stampAt ?? nowIso;

  const stampMs = msOf(stampAt);
  const fresh = stampMs !== null && Math.abs(nowMs - stampMs) <= FRESH_STAMP_MS;
  return fresh ? stampAt : nowIso;
}

/**
 * One sighting of one task, merged onto what the ledger already knew.
 *
 * @param {object|null} previous the ledger's entry, or null on a first sighting
 * @param {object} todo from `fetchTodos`
 * @param {{nowIso: string, nowMs: number, backfill: boolean}} context
 *   backfill: the ledger was empty when this load started -- see `addedStamp`.
 * @returns {{entry: object, changed: boolean}} entry: what the ledger should
 *   hold for this task now; changed: whether that differs from what it holds.
 */
function sight(previous, todo, context) {
  const { nowIso, nowMs } = context;
  const stampAt = iso(todo.stampAt);
  const etag = todo.etag ?? null;

  if (!previous) {
    return {
      changed: true,
      entry: {
        firstSeenAt: nowIso,
        // Which date, and why, is the whole of `addedStamp`.
        addedAt: addedStamp(
          { createdAt: iso(todo.createdAt), stampAt, isCompleted: Boolean(todo.isCompleted) },
          context
        ),
        stampAt,
        etag,
        changedAt: null,
        lastSeenAt: nowIso,
      },
    };
  }

  // A move, not a difference. A field that was NOT recorded last time (a ledger
  // written before etags, a server that reports none) must not read as a
  // change: it is adopted quietly, because "we did not know" is not news.
  const stampMoved = previous.stampAt !== null && stampAt !== null && stampAt !== previous.stampAt;
  const etagMoved = previous.etag !== null && etag !== null && etag !== previous.etag;
  const moved = stampMoved || etagMoved;

  const lastSeenMs = msOf(previous.lastSeenAt);
  const seenStale = lastSeenMs === null || nowMs - lastSeenMs >= SEEN_REFRESH_MS;

  const entry = {
    ...previous,
    stampAt: stampAt ?? previous.stampAt,
    etag: etag ?? previous.etag,
    // Dated by the task's new stamp when there is one. An ETag that moved while
    // the stamp stood still (a client that edits without touching DTSTAMP) can
    // only be dated by when we noticed -- our clock, which is second best, and
    // better than silence about an edit we can see happened.
    changedAt: moved ? (stampMoved ? stampAt : nowIso) : previous.changedAt,
    lastSeenAt: seenStale ? nowIso : previous.lastSeenAt,
  };

  return {
    // Whether the LEDGER changes, not whether the incoming values differ: a
    // server that has stopped reporting `getetag`, or a blob that has lost its
    // DTSTAMP, differs from what we stored and yet leaves the entry exactly as
    // it was -- and answering "changed" to that would rewrite the whole ledger
    // on every page load, forever, for nothing.
    changed: FIELDS.some((field) => entry[field] !== previous[field]),
    entry,
  };
}

/** The fields a sighting can move. Compared to decide whether to write. */
const FIELDS = ['stampAt', 'etag', 'changedAt', 'lastSeenAt'];

/**
 * What has happened to the tasks in one list, and what the ledger should
 * remember about them.
 *
 * @param {Array<object>} todos from `fetchTodos`
 * @param {{slug: string, uri: string, displayName?: string, color?: string|null}} list
 * @param {Record<string, object>} ledger from `createTasksSeenStore().read()`
 * @param {{now?: Date}} [options]
 * @returns {{events: Array<object>, updates: Record<string, object>}}
 *   events: `{kind: 'task-added'|'task-finished'|'task-changed', at: Date,
 *   label: string, task: {...}}`, in no particular order -- `buildStream`
 *   sorts the whole page by `at`. updates: ledger entries to save AFTER the
 *   page has rendered.
 */
export function taskEvents(todos, list, ledger = {}, options = {}) {
  const { now = new Date() } = options;
  const view = listView(list);
  // Read from the WHOLE ledger, not from this list's slice of it: "have we ever
  // looked at this household's tasks before?" is one question, and a list shared
  // this morning is not a backfill just because none of its own tasks are known.
  // A ledger we failed to read looks empty here, which is the right reading of
  // it: we know nothing, so everything is being met for the first time.
  const context = {
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
    backfill: Object.keys(ledger ?? {}).length === 0,
  };

  const events = [];
  const updates = Object.create(null);

  for (const todo of todos ?? []) {
    // Nothing to remember it by, so nothing can be said about whether it is
    // new. Real servers always send a UID; this is the parser's fallback case.
    if (!todo.uid) continue;
    // Called off: see the note at the top of this file.
    if (todo.isCancelled) continue;

    const key = ledgerKey(list.uri, todo.uid);
    const { entry, changed } = sight(ledger?.[key] ?? null, todo, context);
    if (changed) updates[key] = entry;

    const task = { ...view, summary: todo.summary ?? 'Untitled task' };

    const completedMs = todo.isCompleted ? (todo.completedAt?.getTime() ?? null) : null;
    const addedMs = msOf(entry.addedAt);
    const changedMs = msOf(entry.changedAt);

    // Finished first, because it is the row that wins a tie: the other two are
    // suppressed when they land in the same minute as it.
    if (completedMs !== null) {
      events.push({
        kind: 'task-finished',
        at: new Date(completedMs),
        label: 'Finished',
        task,
      });
    }

    // A task created and ticked off in one go is one piece of news, not two.
    if (addedMs !== null && !sameMoment(addedMs, completedMs)) {
      events.push({ kind: 'task-added', at: new Date(addedMs), label: 'Added', task });
    }

    // One Changed per task -- the latest -- so a much-edited task is one row
    // rather than ten. Suppressed when it is really the completion talking
    // (DTSTAMP is bumped by ticking a task off), and when it is really the
    // creation talking (a task saved twice in the first minute).
    if (
      changedMs !== null &&
      !sameMoment(changedMs, completedMs) &&
      !(addedMs !== null && changedMs - addedMs <= CHANGE_TOLERANCE_MS)
    ) {
      events.push({ kind: 'task-changed', at: new Date(changedMs), label: 'Changed', task });
    }
  }

  return { events, updates };
}

/**
 * A due date as {day, time}, in the same terms the label uses.
 *
 * The same reasoning as `dueOrder` in ../nextcloud/caldav.js, which orders the
 * task pages: a date-only DUE is a calendar day pinned to UTC midnight while a
 * timed one is a real instant, so comparing the raw instants sorts by two
 * different clocks and the page ends up contradicting its own labels.
 */
function dueOrder(task) {
  const isDate = task.dueIsDate !== false;
  return {
    day: civilDay(task.due, isDate),
    // A whole-day task names no time, so it sorts to the far end of its day --
    // furthest from the Today line, since this block runs newest-first.
    time: isDate
      ? Number.POSITIVE_INFINITY
      : task.due.getHours() * 3_600_000 +
        task.due.getMinutes() * 60_000 +
        task.due.getSeconds() * 1_000,
  };
}

/**
 * The open, dated tasks -- what is coming up -- furthest away first.
 *
 * DESCENDING, which looks backwards written down and is right on the page: this
 * block sits ABOVE the Today line, so the last row in it is the one nearest the
 * line, and that should be the thing due soonest. Read downwards, the page is
 * one time axis: next month at the top, this afternoon just above Today, and
 * yesterday's file changes just below it.
 *
 * OVERDUE TASKS ARE IN HERE TOO, at the bottom of the block, right above the
 * line -- which is where the ordering puts them anyway, their due dates being
 * the earliest of the lot. They are flagged so the template can put them in
 * red, and their own labels say "Was due ..." rather than "Due ...".
 *
 * @param {Array<object>} todos
 * @param {object} list
 * @param {{now?: Date}} [options]
 * @returns {Array<object>} `{kind: 'task-due', at, dueLabel, overdue, task}`
 */
export function upcomingTasks(todos, list, options = {}) {
  const { now = new Date() } = options;
  const view = listView(list);

  const dated = (todos ?? []).filter(
    (todo) =>
      !todo.isCancelled &&
      !todo.isCompleted &&
      todo.due instanceof Date &&
      !Number.isNaN(todo.due.getTime())
  );

  const rows = dated.map((todo) => {
    const dueOptions = { isDate: todo.dueIsDate !== false, now };
    return {
      kind: 'task-due',
      // The due date IS this row's place on the axis: it is not something that
      // happened, it is something that is going to.
      at: todo.due,
      dueLabel: formatDueLabel(todo.due, dueOptions),
      overdue: isOverdue(todo.due, dueOptions),
      task: { ...view, summary: todo.summary ?? 'Untitled task' },
      // How it sorts and which day group it lands in -- see `sortUpcoming` and
      // `buildTimeline`. The template never reads it.
      order: dueOrder(todo),
    };
  });

  return sortUpcoming(rows);
}

/**
 * Upcoming rows in page order: furthest away first, overdue last.
 *
 * Exported because the page merges the lists. `upcomingTasks` orders one list's
 * rows, and the route has several to lay on one axis -- and a concatenation of
 * sorted lists is not sorted, which would show next month's chore between
 * tomorrow's two.
 *
 * @param {Array<object>} rows from `upcomingTasks`
 * @returns {Array<object>} a new array
 */
export function sortUpcoming(rows) {
  return [...(rows ?? [])].sort((a, b) => {
    if (a.order.day !== b.order.day) return b.order.day - a.order.day;
    if (a.order.time !== b.order.time) return b.order.time - a.order.time;
    // Same day, same time: A-Z, so the order is never arbitrary. The list name
    // joins in, because two lists can hold the same chore.
    return (
      String(a.task.summary).localeCompare(String(b.task.summary), undefined, {
        sensitivity: 'base',
        numeric: true,
      }) || String(a.task.name).localeCompare(String(b.task.name))
    );
  });
}

/**
 * How many open tasks have no due date at all.
 *
 * They are not on a timeline, so they cannot be on this page's axis -- but
 * leaving them unmentioned would make the block above Today read as "everything
 * she has to do", which it is not. One line just above the line, linking to
 * Tasks, is the honest amount of room for them.
 *
 * @param {Array<object>} todos
 * @returns {number}
 */
export function undatedOpenCount(todos) {
  return (todos ?? []).filter(
    (todo) =>
      !todo.isCancelled &&
      !todo.isCompleted &&
      !(todo.due instanceof Date && !Number.isNaN(todo.due.getTime()))
  ).length;
}
