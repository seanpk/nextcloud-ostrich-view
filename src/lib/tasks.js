import { civilDay, dayDelta, dayName, formatTime } from './dates.js';

/**
 * Task view-models: everything the task page needs as plain, already-worded
 * strings, so the template does no thinking and the wording is unit-testable.
 *
 * Dates are the fiddly part, and the fiddly part lives in lib/dates.js, which
 * the home page's "new since" note shares. A VTODO due date is usually date-only
 * (`DUE;VALUE=DATE:20260812`) -- a calendar day, not an instant -- and caldav.js
 * pins those to UTC midnight, which is what `utc: isDate` below is about: it
 * keeps "Aug 12" from becoming "Aug 11" for anyone west of Greenwich. Due dates
 * that really do carry a time are read in the server's local zone, which is the
 * household's zone.
 */

/** Priority 1-4 is "high" per RFC 5545; below that Mom doesn't need telling. */
const HIGH_PRIORITY_MAX = 4;

/**
 * "Due today" / "Due tomorrow" / "Due Tue, Aug 12" / "Was due Mon, Aug 4".
 *
 * @param {Date|null} due
 * @param {{ isDate?: boolean, now?: Date }} [options] isDate: DUE was date-only
 * @returns {string|null} null when the task has no due date at all
 */
export function formatDueLabel(due, options = {}) {
  if (!(due instanceof Date) || Number.isNaN(due.getTime())) return null;
  const { isDate = true, now = new Date() } = options;

  const delta = dayDelta(due, now, { utc: isDate });
  const at = isDate ? '' : ` at ${formatTime(due)}`;

  if (delta === 0) return `Due today${at}`;
  if (delta === 1) return `Due tomorrow${at}`;
  if (delta === -1) return 'Was due yesterday';

  const day = dayName(due, now, { utc: isDate });
  return delta < 0 ? `Was due ${day}` : `Due ${day}${at}`;
}

/**
 * A due date already gone by. Lateness is a question about days, not instants:
 * anything due today is not late yet, whether or not it named a time.
 *
 * Timed dues are included in that on purpose. Styling a 9am task red at 9:01
 * while its own label still reads "Due today at 9:00 AM" is the page arguing
 * with itself, and this household's tasks are day-shaped anyway -- nobody needs
 * an hourly alarm from a viewer that cannot tick anything off.
 *
 * @param {Date|null} due
 * @param {{ isDate?: boolean, now?: Date }} [options]
 */
export function isOverdue(due, options = {}) {
  if (!(due instanceof Date) || Number.isNaN(due.getTime())) return false;
  const { isDate = true, now = new Date() } = options;
  return civilDay(due, isDate) < civilDay(now, false);
}

/**
 * "Finished today" / "Finished Fri, Aug 7". COMPLETED is always a UTC instant,
 * so it is read in local time like any other timestamp.
 *
 * @param {Date|null} completedAt
 * @param {{ now?: Date }} [options]
 * @returns {string|null}
 */
export function formatCompletedLabel(completedAt, options = {}) {
  if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) return null;
  const { now = new Date() } = options;

  const delta = dayDelta(completedAt, now);
  if (delta === 0) return 'Finished today';
  if (delta === -1) return 'Finished yesterday';

  return `Finished ${dayName(completedAt, now)}`;
}

/**
 * One nested todo (from `buildTaskTree`) as the template sees it.
 *
 * @param {object} task
 * @param {{ now?: Date, depth?: number }} [options]
 * @returns {object} {uid, summary, description, dueLabel, overdue, doneLabel,
 *   progressLabel, isImportant, isCompleted, depth, children}
 */
export function toTaskView(task, options = {}) {
  const { now = new Date(), depth = 0 } = options;
  const dueOptions = { isDate: task.dueIsDate !== false, now };

  return {
    uid: task.uid,
    summary: task.summary,
    description: task.description ?? null,
    dueLabel: task.isCompleted ? null : formatDueLabel(task.due, dueOptions),
    overdue: task.isCompleted ? false : isOverdue(task.due, dueOptions),
    doneLabel: task.isCompleted ? formatCompletedLabel(task.completedAt, { now }) : null,
    progressLabel:
      !task.isCompleted &&
      typeof task.percentComplete === 'number' &&
      task.percentComplete > 0 &&
      task.percentComplete < 100
        ? `${task.percentComplete}% done`
        : null,
    isImportant:
      !task.isCompleted &&
      typeof task.priority === 'number' &&
      task.priority >= 1 &&
      task.priority <= HIGH_PRIORITY_MAX,
    isCompleted: Boolean(task.isCompleted),
    depth,
    children: (task.children ?? []).map((child) =>
      toTaskView(child, { now, depth: depth + 1 })
    ),
  };
}

/** @param {Array<object>} tasks nested todos */
export function toTaskViews(tasks, options = {}) {
  return (tasks ?? []).map((task) => toTaskView(task, options));
}

/**
 * A calendar's colour, reduced to one of a handful of CSS classes.
 *
 * It cannot become an inline `style` attribute: our CSP is `style-src 'self'`
 * with no 'unsafe-inline', so inline styles are dropped by the browser (and
 * loosening the policy to tint a tile would be a bad trade). Bucketing by hue
 * keeps the owner's colour recognisable using classes that live in styles.css.
 *
 * @param {string|null} hex `#rrggbb`
 * @returns {string|null} e.g. 'tile--accent-blue'
 */
export function accentClassFor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;

  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;

  if (chroma < 0.08) return 'tile--accent-slate';

  let hue;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;

  if (hue < 20 || hue >= 330) return 'tile--accent-red';
  if (hue < 65) return 'tile--accent-amber';
  if (hue < 160) return 'tile--accent-green';
  if (hue < 200) return 'tile--accent-teal';
  if (hue < 265) return 'tile--accent-blue';
  return 'tile--accent-purple';
}
