import { parentPath, pathSegments } from './paths.js';
import { toTile } from './tiles.js';
import { dayDelta, dayName } from './dates.js';

/**
 * The "New since you last looked" section, as already-worded strings.
 *
 * Pure: it takes entries and a clock and returns a view-model, so the wording
 * and the cap are unit-testable without a Nextcloud or a browser anywhere near
 * them. The route does the fetching; this decides what Mom reads.
 */

/** Tiles on the page. Past this it stops being news and starts being a list. */
export const NEW_SINCE_CAP = 20;

/**
 * How many (viewer, previous-visit) answers the route keeps in memory.
 * A household has a handful of viewers; this is a ceiling, not a target.
 */
export const NEW_SINCE_CACHE_MAX = 50;

/** Between folder names in the muted label; matches the crumbs' visual grammar. */
const FOLDER_SEPARATOR = ' › ';

/**
 * "Biology 101 › Lectures" -- where this file lives, for a tile that is shown
 * out of context. Files shared at the top level say "Home", the same name the
 * breadcrumb gives the root.
 *
 * @param {string} path normalized path of the FILE (not its folder)
 * @returns {string}
 */
export function folderLabelFor(path) {
  const segments = pathSegments(parentPath(path));
  return segments.length === 0 ? 'Home' : segments.join(FOLDER_SEPARATOR);
}

/**
 * "earlier today" / "yesterday" / "on Fri, Aug 8" -- how the section says when
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
 * Entries (newest first) as the section's view-model.
 *
 * Each tile is an ordinary `toTile` tile -- same thumbnail, same `/view/` link,
 * same "not something we can open" fallback as a folder listing -- plus the
 * muted `folderLabel` the tile macro renders in place of the file size.
 *
 * The overflow line is careful about what it claims. Two things make the true
 * total unknowable: we only ever fetched `fetchLimit` results, so once that many
 * came back there may be more behind them; and a fallback walk that hit its
 * bounds (`truncated`) never saw whole subtrees, so even a short list may be
 * missing things. Either way the line goes vague rather than under-reporting a
 * precise number that is quietly wrong.
 *
 * @param {Array<object>} entries parseMultistatus-shaped, newest first
 * @param {{limit?: number, fetchLimit?: number, truncated?: boolean}} [options]
 * @returns {{tiles: Array<object>, moreLabel: string|null, total: number}}
 */
export function buildNewSince(entries, options = {}) {
  const { limit = NEW_SINCE_CAP, fetchLimit = null, truncated = false } = options;
  const list = entries ?? [];

  const tiles = list.slice(0, limit).map((entry) => ({
    ...toTile(entry),
    folderLabel: folderLabelFor(entry.path),
  }));

  const extra = list.length - tiles.length;
  const uncertain = truncated || (fetchLimit !== null && list.length >= fetchLimit);

  let moreLabel = null;
  if (extra > 0) {
    moreLabel = uncertain ? '…and more besides.' : `…and ${extra} more.`;
  } else if (truncated && tiles.length > 0) {
    // Nothing overflowed the cap, but the lookup gave up early: say so, rather
    // than letting a short list imply "and that's everything".
    moreLabel = '…and more besides.';
  }

  return { tiles, moreLabel, total: list.length };
}

/**
 * The route's memory of what it last found, keyed by (viewer, previous visit).
 *
 * Mid-sitting, `previousVisitStartedAt` does not move, so every refresh asks
 * Nextcloud the identical question -- and pull-to-refresh is the single most
 * likely thing Mom does on this page. The key changes by itself when the sitting
 * rotates, which is the only moment the answer can change, so nothing here has
 * to be invalidated by hand. Failures are never stored: the caller only calls
 * `set` once it has an answer worth keeping.
 *
 * @param {{max?: number}} [options]
 */
export function createNewSinceCache({ max = NEW_SINCE_CACHE_MAX } = {}) {
  // Insertion-ordered, so the oldest key is simply the first one.
  const entries = new Map();
  // A NUL separator cannot occur in a viewer name or an ISO stamp, so no two
  // (viewer, since) pairs can collide once concatenated.
  const keyFor = (viewerName, since) => `${viewerName}\u0000${since}`;

  return {
    get size() {
      return entries.size;
    },

    get(viewerName, since) {
      return entries.get(keyFor(viewerName, since));
    },

    set(viewerName, since, value) {
      const key = keyFor(viewerName, since);
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}
