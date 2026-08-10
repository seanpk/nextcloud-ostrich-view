/**
 * Days, as the pages talk about them.
 *
 * Both the task list ("Due tomorrow", "Finished Fri, Aug 7") and the home
 * page's "new since you last looked" note ("yesterday", "on Wed, Aug 5") ask
 * the same two questions: which calendar day is this, and how do we name it
 * out loud? They used to answer them with two copies of the same arithmetic and
 * two formatter caches, which is one copy too many for a rule this fiddly.
 *
 * ZONES. Everything except a date-only value is read in the server's zone,
 * which is meant to be the household's zone -- see TZ in .env.example. A
 * date-only VTODO DUE is a calendar day rather than an instant, and caldav.js
 * pins those to UTC midnight, so those are read in UTC (`utc: true`) or "Aug 12"
 * becomes "Aug 11" for anyone west of Greenwich.
 */

export const MS_PER_DAY = 86_400_000;

/**
 * Calendar day as a comparable number, read in whichever zone applies.
 *
 * Exported because caldav.js orders open tasks by it: whatever decides which
 * day a due date is named after has to be the same thing that decides which day
 * it sorts into, or the list contradicts its own labels.
 *
 * @param {Date} date
 * @param {boolean} utc true for a date-only value (a calendar day pinned to UTC)
 */
export function civilDay(date, utc) {
  return utc
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    : Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Whole days from `now`'s day to `date`'s day: 0 today, 1 tomorrow, -1
 * yesterday. `now` is always a real instant, so it is always read locally.
 *
 * @param {Date} date
 * @param {Date} now
 * @param {{utc?: boolean}} [options] utc: `date` is a date-only value
 * @returns {number}
 */
export function dayDelta(date, now, { utc = false } = {}) {
  return Math.round((civilDay(date, utc) - civilDay(now, false)) / MS_PER_DAY);
}

/**
 * The formatters this app can need -- a handful of day shapes and one time --
 * each built once and kept.
 *
 * Constructing an `Intl.DateTimeFormat` is the expensive half of formatting
 * (it resolves the locale and the zone), and a task page asks for one or two
 * labels per task, so a fresh formatter per call was real work on a long list.
 *
 * Built on first use rather than at import: a formatter pins its time zone when
 * it is constructed, and the process must be free to set TZ after this module
 * has loaded (the unit suite does exactly that).
 */
const FORMATTERS = new Map();

function formatter(key, options) {
  let cached = FORMATTERS.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', options);
    FORMATTERS.set(key, cached);
  }
  return cached;
}

/** "Wed, Aug 5", or "Wed, Aug 5, 2025" when the year is asked for. */
export function formatDay(date, { utc = false, withYear = false } = {}) {
  return formatter(`day:${utc ? 'utc' : 'local'}:${withYear ? 'y' : 'n'}`, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    ...(utc ? { timeZone: 'UTC' } : {}),
  }).format(date);
}

/** "9:05 AM", in the server's zone. */
export function formatTime(date) {
  return formatter('time', { hour: 'numeric', minute: '2-digit' }).format(date);
}

/**
 * How a day is named once "today"/"tomorrow"/"yesterday" won't do: "Wed, Aug 5",
 * and the year too once it differs from the year we are in -- without it, "Sat,
 * Aug 9" a year later is a riddle rather than a date.
 *
 * @param {Date} date
 * @param {Date} now
 * @param {{utc?: boolean}} [options] utc: `date` is a date-only value
 * @returns {string}
 */
export function dayName(date, now, { utc = false } = {}) {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  return formatDay(date, { utc, withYear: year !== now.getFullYear() });
}
