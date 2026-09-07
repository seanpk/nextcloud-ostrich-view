import { parentPath, pathSegments } from './paths.js';
import { toTile } from './tiles.js';
import { MS_PER_DAY, civilDay, dayDelta, dayName, formatDay, formatTime } from './dates.js';

/**
 * The stream ("Latest"), as already-worded strings.
 *
 * Pure: it takes entries and a clock and returns a view-model, so the wording,
 * the grouping and the badges are unit-testable without a Nextcloud or a
 * browser anywhere near them. The route does the fetching; this decides what
 * Mom reads.
 *
 * THE STREAM IS A HIGHLIGHT, NOT A FILTER. It always shows the recent history
 * of changes, newest first; rows newer than the viewer's PREVIOUS sitting (see
 * ../store/visits.js) are flagged `isNew` and nothing else is treated
 * differently. Filtering by a timestamp -- which is what this page used to do,
 * as "New since you last looked" -- meant a stamp we had misread emptied the
 * page. Now a wrong stamp costs a badge.
 *
 * ONE TIME AXIS. `buildStream` groups events into days and always produces a
 * "Today" group, empty if nothing happened today, so the page has a `#today`
 * anchor whether or not there is anything on it. Task changes (see
 * ./stream-tasks.js) arrive as events of another kind and sort in among the
 * file rows by time alone -- which is why an event's shape is deliberately
 * kind-agnostic: `at` and `isNew` are all this module reads, and everything
 * file-specific lives under `tile`.
 *
 * ...AND WHAT IS COMING SITS ABOVE IT. `buildTimeline` puts the open tasks'
 * due dates in day groups ABOVE the Today line and the history below it, so
 * the whole page reads downwards as one axis: next month, then this
 * afternoon, then the line, then yesterday. Nothing above the line is
 * something that HAPPENED, which is why it is built separately rather than
 * fed through `buildStream` as events with dates in the future.
 */

/**
 * How many (viewer-independent) answers the route keeps in memory.
 * A ceiling, not a target: today the stream needs exactly one key.
 */
export const STREAM_CACHE_MAX = 50;

/**
 * How long a remembered answer stays usable.
 *
 * SHORT ON PURPOSE, AND NOT OPTIONAL. The cache key cannot carry this: the
 * stream asks Nextcloud the same question on every load, forever ("the newest
 * 50 files"), so without a TTL the first answer of the process would be the
 * only one anybody ever saw and a file the owner uploaded a minute ago would
 * never appear.
 *
 * A minute is long enough to absorb pull-to-refresh (and the double load a
 * phone browser sometimes makes of one), short enough that coming back to the
 * tab later genuinely asks Nextcloud again.
 */
export const STREAM_CACHE_TTL_MS = 60_000;

/** Between folder names in the muted label; matches the crumbs' visual grammar. */
const FOLDER_SEPARATOR = ' › ';

/**
 * "Biology 101 › Lectures" -- where this file lives, for a row that is shown
 * out of context. Files shared at the top level say "Files", the same name the
 * breadcrumb gives the root now that the folder home lives at /files.
 *
 * @param {string} path normalized path of the FILE (not its folder)
 * @returns {string}
 */
export function folderLabelFor(path) {
  const segments = pathSegments(parentPath(path));
  return segments.length === 0 ? 'Files' : segments.join(FOLDER_SEPARATOR);
}

/**
 * "earlier today" / "yesterday" / "on Fri, Aug 8" -- how the page says when
 * "last time" was. Deliberately vague about the hour: she is being reminded,
 * not audited.
 *
 * The day is read in the server's zone, which is meant to be the household's --
 * see TZ in .env.example. A stamp dated in the FUTURE (a clock that jumped, a
 * hand-edited state file) gets the plain date form rather than "earlier today",
 * which would be a small lie about a stamp we already know is wrong.
 *
 * @param {Date|string|null} value previous visit timestamp
 * @param {{now?: Date}} [options]
 * @returns {string|null} null when there is nothing sensible to say
 */
export function formatVisitLabel(value, options = {}) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;

  const { now = new Date() } = options;
  const delta = dayDelta(date, now);

  if (delta === 0) return 'earlier today';
  if (delta === -1) return 'yesterday';

  return `on ${dayName(date, now)}`;
}

/**
 * Search results (or walk results) as stream events.
 *
 * Each event's `tile` is an ordinary `toTile` tile -- same thumbnail, same
 * `/view/` link, same "not something we can open" fallback as a folder listing
 * -- so a stream row and a folder tile can never disagree about what a file is
 * or where it opens.
 *
 * `at` is the file's modification time and is what the whole page is ordered
 * and grouped by, so an entry without one is dropped rather than guessed at.
 * (search.js drops those already; this is the second lock on the same door,
 * because the task events beside these come in from a second source.)
 *
 * @param {Array<object>} entries parseMultistatus-shaped
 * @returns {Array<{kind: 'file', at: Date, tile: object, folderLabel: string}>}
 */
export function fileEvents(entries) {
  const list = entries ?? [];
  const events = [];

  for (const entry of list) {
    if (!(entry.lastModified instanceof Date) || Number.isNaN(entry.lastModified.getTime())) {
      continue;
    }
    events.push({
      kind: 'file',
      at: entry.lastModified,
      tile: toTile(entry),
      folderLabel: folderLabelFor(entry.path),
    });
  }

  return events;
}

/** "Today" / "Yesterday" / "Tomorrow" / "Fri, Aug 8" -- one day, out loud. */
function dayLabel(date, now) {
  const delta = dayDelta(date, now);
  if (delta === 0) return 'Today';
  if (delta === -1) return 'Yesterday';
  if (delta === 1) return 'Tomorrow';
  return dayName(date, now);
}

/**
 * Events as the page's view-model: days, newest first, with the rows inside
 * each day newest first too.
 *
 * `days` ALWAYS contains a group for today, with an empty `items` when nothing
 * happened today -- the template renders that as a bare "Today" divider, which
 * is what makes `/#today` mean something on a quiet day and what
 * `buildTimeline` stacks what is coming on top of. It sits below any group
 * dated in the future (a clock that jumped) and above every past group.
 *
 * `isNew` is `at > previousVisitAt`, and always false when there is no previous
 * sitting: a first-ever visit gets the list (which is the point of the page)
 * but no badges, because "everything the owner has ever shared" is not news.
 *
 * `moreLabel` is careful about what it claims. Two things make the true total
 * unknowable: once `fetchLimit` events came back there may be more behind them
 * -- the file search fetched at most that many, and the page shows at most that
 * many of the file rows and task rows combined, so either bound firing means
 * something older was left off; and a fallback walk that hit its bounds
 * (`truncated`) never saw whole subtrees. Either way the line goes vague rather
 * than implying the list is complete.
 *
 * @param {Array<{kind: string, at: Date, isNew?: boolean}>} events any mix of
 *   kinds; only `at` (and the `isNew` this function sets) is read here.
 * @param {{previousVisitAt?: Date|string|null, now?: Date, limit?: number,
 *          fetchLimit?: number|null, truncated?: boolean}} [options]
 * @returns {{days: Array<{label: string, isToday: boolean, items: Array<object>}>,
 *            newCount: number, moreLabel: string|null, total: number}}
 */
export function buildStream(events, options = {}) {
  const {
    previousVisitAt = null,
    now = new Date(),
    limit = null,
    fetchLimit = null,
    truncated = false,
  } = options;

  const all = events ?? [];
  // Newest first, then bounded: dropping the oldest is the only honest way to
  // cap a page ordered by time.
  const sorted = [...all].sort((a, b) => b.at.getTime() - a.at.getTime());
  const kept = limit === null ? sorted : sorted.slice(0, Math.max(0, limit));

  const previousMs = visitMs(previousVisitAt);
  let newCount = 0;

  const days = [];
  let currentDay = null;
  for (const event of kept) {
    const isNew = previousMs !== null && event.at.getTime() > previousMs;
    if (isNew) newCount += 1;

    const delta = dayDelta(event.at, now);
    if (currentDay === null || currentDay.delta !== delta) {
      currentDay = {
        label: dayLabel(event.at, now),
        delta,
        isToday: delta === 0,
        items: [],
      };
      days.push(currentDay);
    }
    currentDay.items.push({ ...event, isNew, timeLabel: formatTime(event.at) });
  }

  if (!days.some((day) => day.isToday)) {
    // The Today line goes below anything dated ahead of now and above the
    // history, which is where `delta` puts it: groups are already in
    // descending delta order.
    const index = days.findIndex((day) => day.delta < 0);
    const today = { label: 'Today', delta: 0, isToday: true, items: [] };
    days.splice(index === -1 ? days.length : index, 0, today);
  }

  const uncertain = truncated || (fetchLimit !== null && all.length >= fetchLimit);

  return {
    days,
    newCount,
    // Deliberately not a count. There is no cap for the page to overflow any
    // more -- only the bound on what we fetched -- so the honest thing to say
    // is that the list has an end and the history does not.
    moreLabel: uncertain ? "Older changes aren’t listed here." : null,
    total: all.length,
  };
}

/**
 * A day heading for the block above the line, from a civil-day number.
 *
 * The block's rows are due dates, and a due date is a calendar DAY (a date-only
 * DUE is pinned to UTC midnight; a timed one is an instant in the household's
 * zone), so `upcomingTasks` hands over the comparable civil day it sorted by
 * and this names it. Formatting that number back in UTC is what keeps "Sep 9"
 * from becoming "Sep 8" west of Greenwich.
 *
 * EVERY LABEL HERE SAYS "DUE", and the history's labels never do. That is what
 * keeps the two halves apart for a reader who cannot see the page: someone
 * moving heading to heading with a screen reader hears "Due Sat, Sep 12",
 * "Due tomorrow", "Overdue", then "Today", "Yesterday", "Fri, Aug 8" -- each
 * one saying which side of the line it is on, without a "what is coming"
 * heading having to be announced first.
 *
 * Two labels differ from the history's vocabulary for a second reason too:
 *  - today's group says "Due today", not "Today" -- there is already a Today
 *    line on this page, it is the divider below, and two headings reading
 *    "Today" would make the axis unreadable (and `#today` ambiguous);
 *  - anything late says "Overdue", one group for all of it, sitting directly
 *    above the line. Every row in it still says which day it was due.
 */
function dueDayLabel(civilMs, now) {
  const delta = Math.round((civilMs - civilDay(now, false)) / MS_PER_DAY);
  if (delta < 0) return 'Overdue';
  if (delta === 0) return 'Due today';
  if (delta === 1) return 'Due tomorrow';

  const day = new Date(civilMs);
  return `Due ${formatDay(day, { utc: true, withYear: day.getUTCFullYear() !== now.getFullYear() })}`;
}

/**
 * The whole page: what is coming, the line, and what happened.
 *
 * `future` is the block above the Today line -- the open tasks' due dates,
 * grouped by day, furthest away first, with everything late collapsed into one
 * "Overdue" group at the bottom of the block (i.e. immediately above the line,
 * where the eye lands). `days` is the history from `buildStream`, unchanged and
 * still carrying the `#today` anchor, so the template above and below the line
 * is the same template it was before tasks existed.
 *
 * `undatedLabel` is the one line that stands in for tasks with no due date at
 * all: they are not on a timeline and cannot be placed on this axis, but a
 * block above Today that quietly omitted them would read as "everything she has
 * to do".
 *
 * `moreUpcomingLabel` only appears if the future block itself had to be capped,
 * which needs an implausible number of dated open tasks; the soonest are kept,
 * because those are the ones the line is about.
 *
 * @param {{upcoming?: Array<object>, history: object, undatedCount?: number,
 *          now?: Date, limit?: number|null}} options
 *   history: a `buildStream` result. upcoming: rows from `upcomingTasks`,
 *   already ordered furthest-first.
 * @returns {{future: Array<{label: string, isOverdue: boolean, items: Array<object>}>,
 *            undatedLabel: string|null, moreUpcomingLabel: string|null,
 *            days: Array<object>, newCount: number, moreLabel: string|null,
 *            total: number}}
 */
export function buildTimeline(options) {
  const { upcoming = [], history, undatedCount = 0, now = new Date(), limit = null } = options;

  // Capping keeps the SOONEST, so it drops from the top of the block: the rows
  // nearest the line are the ones the reader came for, and the note that goes
  // with them says where the rest live.
  const capped =
    limit === null || upcoming.length <= limit ? upcoming : upcoming.slice(upcoming.length - limit);

  const future = [];
  let group = null;
  for (const item of capped) {
    const civil = item.order.day;
    // One group per day, except the overdue ones, which share a single group
    // however many days late they are.
    const label = dueDayLabel(civil, now);
    const isOverdue = label === 'Overdue';
    if (group === null || (isOverdue ? !group.isOverdue : group.civil !== civil)) {
      group = { label, civil, isOverdue, items: [] };
      future.push(group);
    }
    group.items.push(item);
  }

  return {
    ...history,
    future,
    undatedLabel:
      undatedCount > 0
        ? `Also ${undatedCount} task${undatedCount === 1 ? '' : 's'} without a due date`
        : null,
    moreUpcomingLabel: capped.length < upcoming.length ? 'Later tasks are in Tasks.' : null,
  };
}

/** A previous-visit stamp as milliseconds, or null if there is nothing usable. */
function visitMs(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The route's short-lived memory of what it last found, held for
 * STREAM_CACHE_TTL_MS.
 *
 * The stream asks the same question on every load, and pull-to-refresh is the
 * single most likely thing Mom does on this page. Deduplicating that burst is
 * all this is for, which is why the entries expire: the question is stable
 * forever, but the ANSWER is only stable for as long as nobody uploads
 * anything, and those are not the same span at all. See STREAM_CACHE_TTL_MS.
 *
 * Keys are the caller's business (the stream uses two constants: the files it
 * found, and which task lists are shared). Failures are never stored: the
 * caller only calls `set` once it has an answer worth keeping.
 *
 * @param {{max?: number, ttlMs?: number, now?: () => number}} [options]
 *   now: clock, injectable so expiry can be tested without waiting a minute.
 */
export function createTtlCache({
  max = STREAM_CACHE_MAX,
  ttlMs = STREAM_CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  // Insertion-ordered, so the oldest key is simply the first one.
  const entries = new Map();

  return {
    get size() {
      return entries.size;
    },

    get(key) {
      const held = entries.get(key);
      if (held === undefined) return undefined;

      if (now() - held.storedAt >= ttlMs) {
        // Stale: drop it rather than leave it to be re-checked on every load,
        // and let the caller ask Nextcloud the question again.
        entries.delete(key);
        return undefined;
      }
      return held.value;
    },

    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, storedAt: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}
