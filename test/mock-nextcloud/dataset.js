import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { extensionOf } from '../../src/lib/filetypes.js';
import { toSlug } from '../../src/nextcloud/caldav.js';

/**
 * A JSON file as the mock Nextcloud's database.
 *
 * `tree.js` and `calendars.js` are fixtures: hand-written JavaScript, shaped for
 * the awkward cases the test suite needs. That makes them a bad way to say
 * "here is a plausible Nextcloud, show me the app" -- which is what the demo
 * (see `scripts/demo.js`) and anyone poking at the app without a real Nextcloud
 * actually want. This module is that second door: one JSON file describes a
 * whole dataset, and `loadDataset` turns it into exactly the `{ tree, calendars }`
 * pair `createMockNextcloud` already takes. Nothing downstream knows the
 * difference.
 *
 * THE SHAPE
 *
 *   {
 *     "files": {
 *       "Biology 101": {
 *         "children": {
 *           "syllabus.pdf":   { "asset": "assets/sample.pdf" },
 *           "reading.txt":    { "text": "Chapter 4 by Friday\n" },
 *           "photo.jpg":      { "asset": "assets/sample.jpg", "lastModified": "-3h" }
 *         }
 *       }
 *     },
 *     "tasks": [
 *       {
 *         "displayName": "School",
 *         "color": "#1c4f8b",
 *         "tasks": [
 *           { "summary": "Lab report", "due": "+2d", "percent": 40,
 *             "subtasks": [ { "summary": "Collect samples", "due": "+1d" } ] },
 *           { "summary": "Email the professor", "completed": "-1d" }
 *         ]
 *       }
 *     ]
 *   }
 *
 * A file entry carries its bytes one of two ways: `text` for anything typed
 * inline, or `asset` for a real file on disk (PNG, JPEG, PDF), resolved
 * relative to the JSON file itself so a dataset directory can be copied
 * somewhere else whole. Content types are inferred from the extension unless
 * the entry says otherwise.
 *
 * TIMES ARE RELATIVE, ON PURPOSE. `lastModified`, `due` and `completed` accept
 * absolute dates, but also an offset from *now* -- `"-3h"`, `"+2d"`, `"-45m"`.
 * A demo dataset with dates baked into it stops being believable the week
 * after it is written: everything is overdue, and "new since you last looked"
 * is permanently empty. Offsets keep a checked-in dataset true forever. Day
 * offsets produce date-only DUEs (a calendar day, which is what a task list is
 * made of); hour and minute offsets produce timestamps.
 *
 * NOTHING IS IGNORED. Every key is either one this loader reads or an error
 * naming it -- a `"subTasks"` or a `"colour"` that were quietly dropped would
 * take a feature out of the demo while the file still claimed it was there. A
 * key starting with `_` is the one exception: that is how a dataset writes a
 * comment (see `_comment` at the top of demo/dataset.json).
 *
 * WHAT IT DOESN'T DO. Recurrence, recurrence overrides, cancelled tasks,
 * VEVENT-only calendars and orphaned RELATED-TO parents are all deliberately
 * absent: they exist in `calendars.js` because the parser has to survive them,
 * and putting them in the schema too would buy a second way to express the same
 * edge cases and a schema nobody wants to hand-edit.
 */

export class DatasetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatasetError';
  }
}

/**
 * Extension -> content type, for entries that don't name one.
 *
 * Small on purpose: it only has to cover what a dataset plausibly contains, and
 * anything missing becomes `application/octet-stream`, which is exactly how the
 * app treats a file it doesn't recognise anyway (see src/lib/filetypes.js).
 */
const CONTENT_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['heic', 'image/heic'],
  // Script-capable, and served as such by the mock precisely so the app's
  // defanging (octet-stream, no inline link) is exercised by a demo dataset too.
  ['svg', 'image/svg+xml'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['odt', 'application/vnd.oasis.opendocument.text'],
]);

/**
 * `"cell diagram.PNG"` -> `image/png`.
 *
 * The extension itself is worked out by the app's own `extensionOf`, so a
 * dataset agrees with the running app about what `archive.tar.gz` and `LICENSE`
 * are called.
 */
export function contentTypeFor(name) {
  return CONTENT_TYPES.get(extensionOf(name)) ?? 'application/octet-stream';
}

/** `"-3h"`, `"+2d"`, `"-45m"`, and `"+0d"` for "today". */
const OFFSET = /^([+-])(\d+)\s*([mhd])$/;
const OFFSET_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One point in time, however the dataset chose to write it.
 *
 * @param {unknown} raw an offset (`"-3h"`), a calendar day (`"2026-08-12"`), or
 *   anything `Date.parse` understands (ISO 8601, an HTTP-date).
 * @param {{where: string, now: number}} context
 * @returns {{date: Date, dateOnly: boolean}} dateOnly: this names a day, not an
 *   instant, and a DUE built from it must carry `VALUE=DATE`.
 */
function moment(raw, { where, now }) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DatasetError(`${where}: expected a date string, got ${describe(raw)}`);
  }
  const value = raw.trim();

  const offset = OFFSET.exec(value);
  if (offset) {
    const [, sign, amount, unit] = offset;
    const delta = Number(amount) * OFFSET_MS[unit] * (sign === '-' ? -1 : 1);
    const at = new Date(now + delta);
    if (unit === 'd') {
      // A day offset is a day: "+2d" is the day after tomorrow, not this time of
      // day in two days. Which day, though, is a question about the reader's
      // calendar, so it is the LOCAL one -- then pinned to UTC midnight, which
      // is how a date-only DUE is carried on the wire (see src/lib/dates.js:
      // the app names and sorts such a value in UTC, but compares it against
      // *today* read locally).
      //
      // Reading the day in UTC instead put "+0d" on yesterday for anyone east
      // of Greenwich for the first hours of every morning -- so the demo's "Take
      // the bins out" opened overdue in Berlin and Tokyo, every day, until 02:00.
      return {
        date: new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())),
        dateOnly: true,
      };
    }
    return { date: at, dateOnly: false };
  }

  if (DATE_ONLY.test(value)) {
    // The pattern only says it is shaped like a day; it does not say it is one.
    // "2026-13-01" parses to NaN (a DUE of "NaNNaNNaN" and an "Invalid Date"
    // Last-Modified), and "2026-02-30" quietly parses to March 2nd -- a date the
    // dataset never wrote. Both are hand-editing mistakes, so both are named.
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new DatasetError(
        `${where}: ${JSON.stringify(value)} is not a real calendar day. ` +
          'Months run 01-12 and days must exist in the month you name.'
      );
    }
    return { date, dateOnly: true };
  }

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new DatasetError(
      `${where}: could not read ${JSON.stringify(value)} as a date. Use an offset from now ` +
        '("-3h", "+2d"), a day ("2026-08-12"), or a full ISO timestamp.'
    );
  }
  return { date: new Date(ms), dateOnly: false };
}

/** What the value actually was, for an error message. */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function plainObject(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatasetError(`${where}: expected an object, got ${describe(value)}`);
  }
  return value;
}

function optionalString(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new DatasetError(`${where}: expected a string, got ${describe(value)}`);
  }
  return value;
}

function optionalInteger(value, where, { min, max }) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DatasetError(
      `${where}: expected a whole number between ${min} and ${max}, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * Every key a given kind of entry may carry.
 *
 * A dataset is hand-edited, and a key nobody reads is worse than a key nobody
 * wrote: `"subTasks"` and `"colour"` are exactly the two typos this schema
 * invites, and silently ignoring either deletes a feature from the demo while
 * the file on disk still says it is there. So anything unrecognised is refused
 * by name -- except a leading underscore, which is how a dataset writes a
 * comment (see `_comment` in demo/dataset.json).
 */
const FILE_KEYS = ['children', 'text', 'asset', 'contentType', 'lastModified'];
const TASK_KEYS = [
  'summary',
  'description',
  'due',
  'priority',
  'percent',
  'status',
  'completed',
  'subtasks',
];
const LIST_KEYS = ['displayName', 'uri', 'color', 'tasks'];
const TOP_KEYS = ['files', 'tasks'];

function checkKeys(entry, allowed, where) {
  for (const key of Object.keys(entry)) {
    if (key.startsWith('_') || allowed.includes(key)) continue;
    // Only the trivial near-miss is offered: a case slip ("subTasks"). Anything
    // else gets the list, which is more useful than a bad guess.
    const near = allowed.find((valid) => valid.toLowerCase() === key.toLowerCase());
    throw new DatasetError(
      `${where}: unknown key ${JSON.stringify(key)}. ` +
        (near
          ? `Did you mean ${JSON.stringify(near)}?`
          : `Allowed here: ${allowed.map((valid) => JSON.stringify(valid)).join(', ')}.`)
    );
  }
}

// --- files -----------------------------------------------------------------

/**
 * Names that would poison the map they are collected into. `children` is built
 * with a null prototype so they cannot, but a file called `__proto__` would
 * then still be a file the mock serves and no tree walk ever names the same way
 * twice -- so it is refused outright, which is at least honest about it.
 */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** File names, not paths: the tree's own nesting is the only nesting there is. */
function checkName(name, where) {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    throw new DatasetError(
      `${where}: ${JSON.stringify(name)} is not a usable name. Names may not be empty, ` +
        '"." or "..", and may not contain "/" -- nest a folder instead.'
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new DatasetError(
      `${where}: ${JSON.stringify(name)} is not a usable name. ` +
        `JavaScript reserves ${[...RESERVED_NAMES].map((n) => `"${n}"`).join(', ')} on a plain ` +
        'object, so a file or folder called that would not survive being loaded.'
    );
  }
}

/**
 * Asset bytes, read once per dataset.
 *
 * The cache is per `buildDataset` call rather than module-level: a demo that
 * points eight entries at the same sample PDF should hold one buffer, not eight,
 * but a *second* load in the same process (a test that edits a file and reloads
 * it) must still see the bytes on disk.
 */
function readAsset(relPath, { baseDir, where, assets }) {
  if (isAbsolute(relPath)) {
    throw new DatasetError(
      `${where}: asset paths must be relative to the dataset file, got ${JSON.stringify(relPath)}`
    );
  }
  const fullPath = resolve(baseDir, relPath);
  const cached = assets?.get(fullPath);
  if (cached) return cached;

  let bytes;
  try {
    bytes = readFileSync(fullPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new DatasetError(
        `${where}: asset ${JSON.stringify(relPath)} does not exist (looked in ${fullPath})`
      );
    }
    throw new DatasetError(`${where}: could not read asset ${JSON.stringify(relPath)}: ${err.message}`);
  }

  assets?.set(fullPath, bytes);
  return bytes;
}

/**
 * One `{name: node}` map, recursively, in the shape tree.js hands the mock:
 * folders are `{type: 'folder', children}` and files carry real `bytes` with a
 * `size` derived from them, so `oc:size` and `Content-Length` cannot disagree.
 */
function buildChildren(raw, { baseDir, where, now, assets }) {
  // Null prototype: a name like "__proto__" would otherwise be swallowed by the
  // object's own prototype slot rather than stored -- the entry vanishes from
  // every listing while the dataset still says it is there. `checkName` refuses
  // such names outright; this is the belt to that pair of braces, and costs
  // nothing (every reader below goes through Object.entries or `?.[name]`).
  const children = Object.create(null);

  for (const [name, value] of Object.entries(plainObject(raw, where))) {
    const at = `${where}.${JSON.stringify(name)}`;
    checkName(name, where);
    const entry = plainObject(value, at);
    checkKeys(entry, FILE_KEYS, at);

    const lastModified =
      entry.lastModified === undefined
        ? {}
        : { lastModified: moment(entry.lastModified, { where: `${at}.lastModified`, now }).date.toUTCString() };

    const ways = ['children', 'text', 'asset'].filter((key) => entry[key] !== undefined);
    if (ways.length === 0) {
      throw new DatasetError(
        `${at}: needs one of "children" (a folder), "text" (an inline file) or ` +
          '"asset" (a file on disk).'
      );
    }
    if (ways.length > 1) {
      throw new DatasetError(`${at}: has ${ways.map((k) => `"${k}"`).join(' and ')}; pick one.`);
    }

    if (entry.children !== undefined) {
      children[name] = {
        type: 'folder',
        children: buildChildren(entry.children, {
          baseDir,
          where: `${at}.children`,
          now,
          assets,
        }),
        ...lastModified,
      };
      continue;
    }

    let bytes;
    if (entry.text !== undefined) {
      if (typeof entry.text !== 'string') {
        throw new DatasetError(`${at}.text: expected a string, got ${describe(entry.text)}`);
      }
      bytes = Buffer.from(entry.text, 'utf8');
    } else {
      if (typeof entry.asset !== 'string') {
        throw new DatasetError(`${at}.asset: expected a string, got ${describe(entry.asset)}`);
      }
      bytes = readAsset(entry.asset, { baseDir, where: at, assets });
    }

    children[name] = {
      type: 'file',
      contentType: optionalString(entry.contentType, `${at}.contentType`) ?? contentTypeFor(name),
      bytes,
      size: bytes.length,
      ...lastModified,
    };
  }

  return children;
}

// --- tasks -----------------------------------------------------------------

/**
 * A URL-safe id, and never the same one twice.
 *
 * The rule itself is the app's own `toSlug` (src/nextcloud/caldav.js), not a
 * copy of it. A calendar's `uri` is what the app slugifies into `/tasks/<slug>`,
 * so a dataset that minted uris with a *different* rule would hand out links the
 * app then renamed: "Café" became `caf` here and `cafe` there, and the demo's
 * own task list 404'd.
 *
 * @param {unknown} value what to name it after (a display name, a summary)
 * @param {string} fallback used when `value` has no name in it at all
 * @param {Set<string>} taken slugs already handed out
 */
function uniqueSlug(value, fallback, taken) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const base = raw === '' ? fallback : toSlug(raw);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

/** RFC 5545 §3.3.11: backslash, newline, semicolon and comma are special. */
function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

const two = (n) => String(n).padStart(2, '0');

/** `20260812` */
function icsDate(date) {
  return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`;
}

/** `20260812T210000Z` */
function icsDateTime(date) {
  return `${icsDate(date)}T${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(
    date.getUTCSeconds()
  )}Z`;
}

const STATUSES = new Set(['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']);

/**
 * One VTODO's property lines.
 *
 * Deliberately unfolded. RFC 5545 asks producers to fold past 75 octets, but
 * folding here would mean splitting a JavaScript string by UTF-16 code units --
 * which can cut a surrogate pair in half and corrupt exactly the unicode
 * summaries a dataset is most likely to contain. ical.js reads long lines
 * without complaint, and calendars.js is the only consumer.
 */
function todoLines(task, { uid, parentUid, where, now }) {
  const summary = optionalString(task.summary, `${where}.summary`);
  if (summary === null || summary.trim() === '') {
    throw new DatasetError(`${where}: needs a non-empty "summary".`);
  }

  const lines = [`UID:${uid}`, `SUMMARY:${escapeText(summary)}`];

  const description = optionalString(task.description, `${where}.description`);
  if (description !== null && description.trim() !== '') {
    lines.push(`DESCRIPTION:${escapeText(description)}`);
  }

  if (task.due !== undefined && task.due !== null) {
    const { date, dateOnly } = moment(task.due, { where: `${where}.due`, now });
    lines.push(dateOnly ? `DUE;VALUE=DATE:${icsDate(date)}` : `DUE:${icsDateTime(date)}`);
  }

  const priority = optionalInteger(task.priority, `${where}.priority`, { min: 0, max: 9 });
  if (priority !== null) lines.push(`PRIORITY:${priority}`);

  const percent = optionalInteger(task.percent, `${where}.percent`, { min: 0, max: 100 });
  if (percent !== null) lines.push(`PERCENT-COMPLETE:${percent}`);

  if (parentUid) {
    // No RELTYPE: PARENT is the RFC 5545 default, and what Nextcloud Tasks writes.
    lines.push(`RELATED-TO:${parentUid}`);
  }

  let completedAt = null;
  if (task.completed !== undefined && task.completed !== null) {
    completedAt = moment(task.completed, { where: `${where}.completed`, now }).date;
  }

  // "completed" is the whole statement: saying when it was finished should not
  // also require saying that it was.
  const status = (optionalString(task.status, `${where}.status`) ?? (completedAt ? 'completed' : 'needs-action'))
    .trim()
    .toUpperCase();
  if (!STATUSES.has(status)) {
    throw new DatasetError(
      `${where}.status: expected one of ${[...STATUSES].join(', ').toLowerCase()}, ` +
        `got ${JSON.stringify(task.status)}`
    );
  }
  lines.push(`STATUS:${status}`);
  if (completedAt) lines.push(`COMPLETED:${icsDateTime(completedAt)}`);
  if (status === 'COMPLETED' && percent === null) lines.push('PERCENT-COMPLETE:100');

  return lines;
}

/** One `.ics` resource per task, exactly as a CalDAV server stores them. */
function icsResource(lines, now) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nextcloud Ostrich View//Demo dataset//EN',
    'BEGIN:VTODO',
    `DTSTAMP:${icsDateTime(new Date(now))}`,
    ...lines,
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/**
 * Flatten `subtasks` into siblings wired together by RELATED-TO -- which is how
 * they really arrive: CalDAV has no nesting, only pointers, and the app's
 * `buildTaskTree` rebuilds the shape from them.
 */
function collectTodos(tasks, { calendarUri, parentUid, where, now, uids, out }) {
  if (!Array.isArray(tasks)) {
    throw new DatasetError(`${where}: expected an array of tasks, got ${describe(tasks)}`);
  }

  tasks.forEach((task, index) => {
    const at = `${where}[${index}]`;
    plainObject(task, at);
    checkKeys(task, TASK_KEYS, at);
    const uid = `${calendarUri}-${uniqueSlug(task.summary ?? '', `task-${index + 1}`, uids)}`;

    out.push(icsResource(todoLines(task, { uid, parentUid, where: at, now }), now));

    if (task.subtasks !== undefined) {
      collectTodos(task.subtasks, {
        calendarUri,
        parentUid: uid,
        where: `${at}.subtasks`,
        now,
        uids,
        out,
      });
    }
  });
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

function buildCalendars(raw, { where, now }) {
  if (!Array.isArray(raw)) {
    throw new DatasetError(`${where}: expected an array of task lists, got ${describe(raw)}`);
  }

  const uris = new Set();

  return raw.map((entry, index) => {
    const at = `${where}[${index}]`;
    plainObject(entry, at);
    checkKeys(entry, LIST_KEYS, at);

    const displayName = optionalString(entry.displayName, `${at}.displayName`);
    if (displayName === null || displayName.trim() === '') {
      throw new DatasetError(`${at}: needs a non-empty "displayName".`);
    }

    const color = optionalString(entry.color, `${at}.color`);
    if (color !== null && !COLOR.test(color)) {
      throw new DatasetError(`${at}.color: expected "#rrggbb", got ${JSON.stringify(color)}`);
    }

    const uri = uniqueSlug(entry.uri ?? displayName, `list-${index + 1}`, uris);
    const todos = [];
    collectTodos(entry.tasks ?? [], {
      calendarUri: uri,
      parentUid: null,
      where: `${at}.tasks`,
      now,
      uids: new Set(),
      out: todos,
    });

    return {
      uri,
      displayName: displayName.trim(),
      // Stable per list, and moves when the list does: the app only ever
      // compares ctags, never interprets them.
      ctag: `http://sabre.io/ns/sync/${index + 1}-${todos.length}`,
      color,
      components: ['VTODO'],
      todos,
    };
  });
}

// --- entry points ----------------------------------------------------------

/**
 * Turn already-parsed dataset JSON into the mock's in-memory structures.
 *
 * @param {object} data
 * @param {{ baseDir: string, now?: number, source?: string }} options
 *   baseDir: what `asset` paths are relative to (the JSON file's directory)
 *   now: the clock relative offsets are measured from; injectable so a test can
 *        assert on an exact DUE instead of racing midnight.
 * @returns {{ tree: object, calendars: Array<object> }} ready for
 *   `createMockNextcloud({ tree, calendars })`
 */
export function buildDataset(data, { baseDir, now = Date.now(), source = 'dataset' } = {}) {
  if (!baseDir) throw new DatasetError('buildDataset: baseDir is required to resolve assets');
  plainObject(data, source);
  checkKeys(data, TOP_KEYS, source);

  if (data.files === undefined && data.tasks === undefined) {
    throw new DatasetError(`${source}: has neither "files" nor "tasks"; there is nothing to serve.`);
  }

  // One buffer per asset file, for this load only. A demo pointing eight
  // entries at the same sample PDF is the ordinary case, not the odd one.
  const assets = new Map();

  return {
    tree:
      data.files === undefined
        ? {}
        : buildChildren(data.files, { baseDir, where: `${source}.files`, now, assets }),
    calendars: data.tasks === undefined ? [] : buildCalendars(data.tasks, { where: `${source}.tasks`, now }),
  };
}

/**
 * Read a dataset JSON file and build it.
 *
 * @param {string} jsonPath
 * @param {{ now?: number }} [options]
 * @returns {{ tree: object, calendars: Array<object> }}
 */
export function loadDataset(jsonPath, options = {}) {
  const fullPath = resolve(jsonPath);

  let raw;
  try {
    raw = readFileSync(fullPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new DatasetError(`Dataset file not found: ${fullPath}`);
    throw new DatasetError(`Could not read dataset ${fullPath}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new DatasetError(`${fullPath} is not valid JSON: ${err.message}`);
  }

  return buildDataset(data, { ...options, baseDir: dirname(fullPath), source: fullPath });
}

export default loadDataset;
