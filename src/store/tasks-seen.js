import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * "Which tasks have we seen before?" -- the one thing that lets the stream say
 * a task is NEW.
 *
 * One flat JSON file, `<dataDir>/tasks-seen.json`:
 *
 *   { "<calendar uri>|<uid>": { "firstSeenAt": "...", "addedAt": "...",
 *                               "stampAt": "...", "etag": "...",
 *                               "changedAt": "...", "lastSeenAt": "..." } }
 *
 * WHY THIS FILE HAS TO EXIST. A VTODO from the household's client carries no
 * CREATED, no LAST-MODIFIED and no SEQUENCE -- only DTSTAMP, which is bumped on
 * every edit (see ../nextcloud/caldav.js). So the data cannot tell us that a
 * task is new; the only thing that can is us remembering which UIDs we have
 * already met. That memory is this file, and "Added" means "the first time this
 * viewer app ever saw it", dated by the task's own stamp rather than by our
 * clock.
 *
 * IT IS NOT PER VIEWER, unlike state.json next to it. Which tasks exist is a
 * fact about the household, not about who is reading: if it were per viewer,
 * the first person to open the app would consume the news and the second would
 * be told nothing had been added. (Who has SEEN the news is what state.json's
 * visit stamps are for, and they still decide the New badges.)
 *
 * LOSING IT COSTS A BURST OF "ADDED" ROWS, and nothing else. Every task is
 * then first-seen again, so each gets an Added row dated by its own DTSTAMP --
 * real timestamps, in the right order, just more of them than the week
 * deserved. That is the whole downside, which is why this is a plain file with
 * no schema and no migration story.
 *
 * DURABILITY AND CONCURRENCY are handled exactly as in ./visits.js: temp file
 * plus rename, so a reader never sees half a write, and `save` re-reads inside
 * one serialized chain, because each write rewrites the WHOLE file and two
 * interleaved ones would silently drop each other's tasks. (The bare `read`
 * this module also exports does not queue behind that chain -- it is what the
 * route and the tests use to LOOK at the ledger, and rename makes any single
 * read a whole file or the previous whole file.) A write that fails is logged
 * once and swallowed -- see above for what it costs.
 */

/** How long an entry survives after the last time we saw its task. */
export const PRUNE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export const TASKS_SEEN_FILE_NAME = 'tasks-seen.json';

/** In-progress writes are `.tasks-seen-<uuid>.tmp`, alongside the real file. */
const TEMP_PREFIX = '.tasks-seen-';

/**
 * The key one task is remembered under: its calendar's URI and its UID.
 *
 * The URI rather than the slug, for the same reason ../nextcloud/caldav.js
 * keys its cache that way: a slug can pick up a `-2` collision suffix when
 * another list is shared or unshared, and a ledger keyed on it would then think
 * every task in the renamed list was brand new. A UID alone is not enough
 * either -- copying a task list duplicates its UIDs.
 *
 * `|` cannot appear in a Nextcloud calendar URI, and a UID containing one
 * would at worst collide with itself.
 *
 * @param {string} calendarUri
 * @param {string} uid
 * @returns {string}
 */
export function ledgerKey(calendarUri, uid) {
  return `${calendarUri}|${uid}`;
}

/**
 * A stored timestamp, normalized -- or null if it is missing or unusable.
 * Anything unparseable is treated as absent rather than repaired: a corrupt
 * stamp must not be able to date a row.
 */
function isoOrNull(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function etagOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  // Long enough for any real validator; a pathological one is truncated rather
  // than trusted to be a sensible size, since this file is read back later.
  return value.trim().slice(0, 200);
}

/** One entry, reduced to the six fields anything downstream reads. */
export function sanitizeEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const firstSeenAt = isoOrNull(entry.firstSeenAt);
  return {
    // When WE first met it. Used for pruning and for diagnostics, never for
    // dating a row: our clock is not when anything happened.
    firstSeenAt,
    // The stamp the Added row is dated by, frozen at first sighting: the task's
    // own CREATED if it had one, else the stamp it carried when we met it.
    // Frozen, because a task edited later must not have its Added row walk
    // forward with it.
    addedAt: isoOrNull(entry.addedAt) ?? firstSeenAt,
    // The revision we last saw, in both the shapes a server offers.
    stampAt: isoOrNull(entry.stampAt),
    etag: etagOrNull(entry.etag),
    // The stamp of the last revision we NOTICED, which is what a Changed row is
    // dated by. Null until something moves.
    changedAt: isoOrNull(entry.changedAt),
    // The last sighting, to the day (see SEEN_REFRESH_MS in
    // ../lib/stream-tasks.js). Only the prune reads it.
    lastSeenAt: isoOrNull(entry.lastSeenAt) ?? firstSeenAt,
  };
}

/**
 * Whatever was on disk, reduced to entries we are willing to act on.
 *
 * Built on a null-prototype object and copied key by key: the file is ours, but
 * it is still parsed input, and a `__proto__` key in it should be an odd task
 * key and nothing more.
 */
function sanitizeLedger(parsed) {
  const ledger = Object.create(null);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ledger;

  for (const [key, entry] of Object.entries(parsed)) {
    const clean = sanitizeEntry(entry);
    // An entry with no stamps at all cannot date a row or be pruned sensibly;
    // dropping it means the task is simply met again next time.
    if (clean && (clean.addedAt !== null || clean.firstSeenAt !== null)) ledger[key] = clean;
  }
  return ledger;
}

/**
 * @param {{ dir: string, now?: () => number, pruneAfterMs?: number,
 *           log?: {warn: Function} }} [options]
 *   now: clock, injectable so the 90-day prune can be tested without waiting.
 */
export function createTasksSeenStore({
  dir,
  now = Date.now,
  pruneAfterMs = PRUNE_AFTER_MS,
  log,
} = {}) {
  if (!dir) throw new Error('createTasksSeenStore: dir is required');

  const filePath = join(dir, TASKS_SEEN_FILE_NAME);

  // Every read-modify-write goes through one chain -- see the note at the top of
  // the file, and the longer version of the same argument in ./visits.js.
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

  // The last unreadable file we complained about: an unwritable volume would
  // otherwise put the same line in the log on every stream load forever.
  let complainedAbout = null;

  function complainOnce(about, err, message) {
    if (complainedAbout === about) return;
    complainedAbout = about;
    log?.warn?.({ err, filePath }, message);
  }

  async function readLedger() {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      // No file yet is the normal first-boot case, not a problem.
      if (err.code !== 'ENOENT') {
        complainOnce(`read:${err.code}`, err, 'could not read the seen-tasks ledger; every task will look new');
      }
      return sanitizeLedger(null);
    }

    try {
      const ledger = sanitizeLedger(JSON.parse(raw));
      complainedAbout = null;
      return ledger;
    } catch (err) {
      complainOnce(`parse:${raw.length}`, err, 'the seen-tasks ledger is not valid JSON; starting fresh');
      return sanitizeLedger(null);
    }
  }

  async function writeLedger(ledger) {
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, filePath);
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  /**
   * Entries whose task we have not seen for `pruneAfterMs`, dropped.
   *
   * A task can go missing because it was finished and cleared out, because its
   * list was unshared, or because a REPORT failed -- and we cannot tell those
   * apart, which is exactly why the entry is KEPT for a season first. Ninety
   * days is long enough that a term's worth of unsharing and resharing does not
   * turn into a page of "Added" rows.
   */
  function prune(ledger, nowMs) {
    const nowIso = new Date(nowMs).toISOString();
    for (const [key, entry] of Object.entries(ledger)) {
      const seen = entry.lastSeenAt ?? entry.firstSeenAt;
      const seenMs = seen === null ? null : Date.parse(seen);
      if (seenMs === null) {
        // We cannot date this one, so we cannot say it has been gone for a
        // season -- and dropping it would announce its task as Added all over
        // again. Start its clock now instead.
        entry.lastSeenAt = nowIso;
        continue;
      }
      if (nowMs - seenMs <= pruneAfterMs) continue;
      delete ledger[key];
    }
    return ledger;
  }

  return {
    filePath,

    /** Every task we have met, normalized. @returns {Promise<object>} */
    read: readLedger,

    /**
     * Merge `updates` onto the freshest ledger on disk, prune, and save.
     *
     * Never rejects: a ledger we failed to write costs a repeat of the same
     * Added rows next load, and is never a reason to fail a page that has
     * already rendered.
     *
     * @param {Record<string, object>} updates key -> entry, from
     *   `taskEvents` in ../lib/stream-tasks.js. An empty object writes nothing
     *   at all, which is the common case once the household is settled.
     * @returns {Promise<void>}
     */
    save(updates) {
      const keys = Object.keys(updates ?? {});
      if (keys.length === 0) return Promise.resolve();

      return serialize(async () => {
        // Re-read inside the chain rather than trusting the caller's snapshot:
        // another load may have met a task since it was taken.
        const ledger = await readLedger();
        for (const key of keys) {
          const clean = sanitizeEntry(updates[key]);
          if (clean) ledger[key] = clean;
        }
        try {
          await writeLedger(prune(ledger, now()));
        } catch (err) {
          log?.warn?.({ err, filePath }, 'could not save the seen-tasks ledger');
        }
      });
    },
  };
}

export default createTasksSeenStore;
