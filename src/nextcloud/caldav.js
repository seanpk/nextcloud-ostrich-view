import { XMLParser } from 'fast-xml-parser';
import ICAL from 'ical.js';

import { NextcloudError } from './client.js';
import { asArray, collectProps, decodeHref, stripTrailingSlash } from './dav-util.js';
import { civilDay } from '../lib/dates.js';

/**
 * CalDAV: discovering the task lists shared with the viewer account and reading
 * the VTODOs inside them.
 *
 * Two halves, deliberately separable:
 *  - pure parsers/sorters (`parseCalendarList`, `parseCalendarQuery`,
 *    `sortOpenTasks`, `sortDoneTasks`, `buildTaskTree`) that take strings and
 *    plain objects, so the unit tests need no server;
 *  - two thin async functions that talk to the client.
 *
 * The XML parser here keeps attributes, unlike the one in webdav.js: the whole
 * point of `<cal:supported-calendar-component-set>` lives in `name="VTODO"`
 * attributes. The multistatus walkers themselves are shape-agnostic and live in
 * dav-util.js, shared with webdav.js.
 */

const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';

const PROPFIND_CALENDARS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cal="${CALDAV_NS}" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <cal:supported-calendar-component-set/>
    <cs:getctag/>
    <ical:calendar-color/>
  </d:prop>
</d:propfind>`;

const REPORT_TODOS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<cal:calendar-query xmlns:d="DAV:" xmlns:cal="${CALDAV_NS}">
  <d:prop>
    <d:getetag/>
    <cal:calendar-data/>
  </d:prop>
  <cal:filter>
    <cal:comp-filter name="VCALENDAR">
      <cal:comp-filter name="VTODO"/>
    </cal:comp-filter>
  </cal:filter>
</cal:calendar-query>`;

/** ~60s: Mom refreshing twice in a row shouldn't hammer Nextcloud. */
export const TASK_CACHE_TTL_MS = 60_000;

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Text of a node that may have come back as a bare string or as `{'#text':…}`. */
function textOf(node) {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') return node === '' ? null : node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object' && typeof node['#text'] === 'string') {
    return node['#text'] === '' ? null : node['#text'];
  }
  return null;
}

/**
 * The calendar home, in the two forms we need.
 *
 * Same pitfall `client.davRoot` solves for files: when NC_BASE_URL carries a
 * base path (`https://host/nextcloud`), every href in the multistatus is
 * `/nextcloud/...`-prefixed while the path we hand to `client.request()` must
 * NOT be (the client prepends the base URL itself). Comparing the two without
 * accounting for that silently drops every calendar.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @returns {{ requestRoot: string, hrefRoot: string }}
 *   requestRoot: path to pass to `client.request` (no base path)
 *   hrefRoot: decoded prefix as it appears in `<d:href>` (base path included)
 */
export function calendarRoots(client) {
  const requestRoot = `/remote.php/dav/calendars/${encodeURIComponent(client.user)}`;
  const basePath = stripTrailingSlash(new URL(client.baseUrl).pathname);
  return { requestRoot, hrefRoot: decodeURIComponent(`${basePath}${requestRoot}`) };
}

/**
 * Route-safe id derived from a calendar's own URI segment.
 *
 * Exported so the mock's dataset loader can mint list ids with the very same
 * rule: a demo whose `/tasks/<slug>` links are built by a *second* slugifier
 * quietly disagrees with production the moment a list is called "Café" (`caf`
 * one side, `cafe` the other), and the demo is where that would go unnoticed.
 */
export function toSlug(decodedSegment) {
  const cleaned = String(decodedSegment)
    .normalize('NFKD')
    // Drop combining marks (NFKD split "é" into "e" + U+0301), then anything
    // that isn't plainly URL-safe.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  return cleaned || 'list';
}

function componentNames(prop) {
  // <cal:supported-calendar-component-set><cal:comp name="VTODO"/>…</…>
  const comps = asArray(prop?.comp);
  return comps
    .map((comp) => (typeof comp === 'object' ? comp['@_name'] : null))
    .filter(Boolean)
    .map((name) => String(name).toUpperCase());
}

function isCalendarCollection(props) {
  const rt = props.resourcetype;
  return typeof rt === 'object' && rt !== null && Object.hasOwn(rt, 'calendar');
}

/**
 * Parse the calendar-home multistatus into the VTODO-capable calendars.
 *
 * Calendars that advertise only VEVENT (the owner's class schedule, the birthday
 * calendar Nextcloud creates for everyone) are dropped here, as are the
 * non-calendar collections in the home (inbox/outbox/trashbin).
 *
 * @param {string} xml raw 207 body
 * @param {{ hrefRoot: string }} options
 * @returns {Array<{slug:string, uri:string, displayName:string, ctag:string|null, color:string|null}>}
 */
export function parseCalendarList(xml, { hrefRoot } = {}) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new NextcloudError('Empty PROPFIND response from Nextcloud (calendars).');
  }

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new NextcloudError(`Could not parse the calendar list: ${err.message}`);
  }

  // An empty <d:multistatus/> parses to '' -- valid, and means "nothing here".
  const multistatus = doc?.multistatus;
  if (multistatus === undefined || multistatus === null) {
    throw new NextcloudError('Calendar PROPFIND response had no <multistatus> element.');
  }

  const rootPrefix = stripTrailingSlash(hrefRoot ?? '');
  const found = [];

  for (const response of asArray(multistatus.response)) {
    const decodedPath = stripTrailingSlash(decodeHref(response.href));

    // The home itself, and anything outside it, are not calendars.
    if (decodedPath === rootPrefix || !decodedPath.startsWith(`${rootPrefix}/`)) continue;
    // Depth 1 means direct children only; a deeper href is not ours to list.
    const rest = decodedPath.slice(rootPrefix.length + 1);
    if (rest === '' || rest.includes('/')) continue;

    const props = collectProps(response);
    if (!isCalendarCollection(props)) continue;

    const components = componentNames(props['supported-calendar-component-set']);
    // An absent component set means "everything" per RFC 4791; Nextcloud always
    // sends one, so requiring VTODO explicitly is the safe read.
    if (!components.includes('VTODO')) continue;

    found.push({
      uri: rest,
      displayName: textOf(props.displayname) ?? rest,
      ctag: textOf(props.getctag),
      color: normalizeColor(textOf(props['calendar-color'])),
    });
  }

  const slugByUri = assignSlugs(found);
  const calendars = found.map((calendar) => ({ slug: slugByUri.get(calendar.uri), ...calendar }));
  calendars.sort((a, b) => collator.compare(a.displayName, b.displayName));
  return calendars;
}

/**
 * uri -> slug, with `-2`, `-3`… appended where two URIs slugify the same.
 *
 * The suffixes are handed out in URI order, not in the order the server listed
 * the calendars: a slug is a bookmarkable URL, so "Café list" must not become
 * `cafe-list` today and `cafe-list-2` tomorrow because Nextcloud reordered its
 * multistatus. Code-unit order is used rather than the collator's, since only
 * exact reproducibility matters here.
 *
 * @param {Array<{uri: string}>} calendars
 * @returns {Map<string, string>}
 */
function assignSlugs(calendars) {
  const slugByUri = new Map();
  const usedSlugs = new Set();

  const ordered = [...calendars].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  for (const { uri } of ordered) {
    let slug = toSlug(uri);
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);
    slugByUri.set(uri, slug);
  }
  return slugByUri;
}

/**
 * Apple's calendar-color is `#rrggbb` or `#rrggbbaa`. Anything else is dropped
 * rather than interpolated into a stylesheet.
 */
function normalizeColor(value) {
  if (!value) return null;
  const hex = String(value).trim();
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex) ? hex.slice(0, 7) : null;
}

/**
 * Depth-1 PROPFIND of the viewer account's calendar home.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @returns {Promise<Array<{slug:string, uri:string, displayName:string, ctag:string|null, color:string|null}>>}
 */
export async function listTaskCalendars(client) {
  const { requestRoot, hrefRoot } = calendarRoots(client);
  const url = `${requestRoot}/`;

  const response = await client.request('PROPFIND', url, {
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_CALENDARS_BODY,
  });

  if (response.status === 404) {
    // No calendar home at all: nothing has ever been shared with the account.
    return [];
  }
  if (response.status !== 207) {
    const body = await response.text().catch(() => '');
    throw new NextcloudError(`PROPFIND ${url} returned ${response.status}`, {
      status: response.status,
      method: 'PROPFIND',
      url,
      body: body.slice(0, 500),
    });
  }

  return parseCalendarList(await response.text(), { hrefRoot });
}

// --- VTODO parsing ---------------------------------------------------------

/**
 * ICAL.Time -> JS Date.
 *
 * A date-only DUE (`DUE;VALUE=DATE:20260812`) has no time zone at all, so
 * `toJSDate()` would anchor it to the server's local midnight and could show up
 * as the day before or after once formatted. Date-only values are therefore
 * pinned to UTC midnight and formatted back in UTC (see lib/tasks.js).
 */
function toDate(time) {
  if (!time || typeof time.toJSDate !== 'function') return null;
  if (time.isDate) return new Date(Date.UTC(time.year, time.month - 1, time.day));
  const date = time.toJSDate();
  return Number.isNaN(date.getTime()) ? null : date;
}

function toText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function toInteger(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

/**
 * The parent this VTODO hangs off, if any.
 *
 * RELATED-TO defaults to RELTYPE=PARENT (RFC 5545 3.2.15), and Nextcloud Tasks
 * writes subtasks exactly that way. A CHILD/SIBLING relation is somebody else's
 * bookkeeping and is ignored.
 */
function parentUidOf(vtodo) {
  for (const prop of vtodo.getAllProperties('related-to')) {
    const reltype = String(prop.getParameter('reltype') ?? 'PARENT').toUpperCase();
    if (reltype !== 'PARENT') continue;
    const uid = toText(prop.getFirstValue());
    if (uid) return uid;
  }
  return null;
}

/**
 * Every VTODO in one calendar-data blob (normally one, but a recurring master
 * plus overrides share a resource).
 *
 * @param {string} ics raw iCalendar text
 * @returns {Array<object>} see `fetchTodos` for the shape
 */
export function parseTodoBlob(ics) {
  if (typeof ics !== 'string' || ics.trim() === '') return [];

  let component;
  try {
    component = new ICAL.Component(ICAL.parse(ics));
  } catch {
    // One malformed resource must not blank out the whole list.
    return [];
  }

  const vtodos =
    component.name === 'vtodo' ? [component] : component.getAllSubcomponents('vtodo');

  return vtodos.map((vtodo) => {
    const status = toText(vtodo.getFirstPropertyValue('status'))?.toUpperCase() ?? null;
    const completedAt = toDate(vtodo.getFirstPropertyValue('completed'));
    const percentComplete = toInteger(vtodo.getFirstPropertyValue('percent-complete'));

    return {
      uid: toText(vtodo.getFirstPropertyValue('uid')),
      // Set only on a recurrence override: which occurrence of the master this
      // component replaces. `parseCalendarQuery` needs it to tell the master
      // and its overrides apart -- they share a UID.
      recurrenceId: toDate(vtodo.getFirstPropertyValue('recurrence-id')),
      summary: toText(vtodo.getFirstPropertyValue('summary')) ?? 'Untitled task',
      // Newlines are meaningful here (the owner writes checklists); the template
      // renders them with white-space: pre-line rather than collapsing them.
      description: toText(vtodo.getFirstPropertyValue('description')),
      due: toDate(vtodo.getFirstPropertyValue('due')),
      dueIsDate: Boolean(vtodo.getFirstPropertyValue('due')?.isDate),
      priority: toInteger(vtodo.getFirstPropertyValue('priority')),
      status,
      completedAt,
      percentComplete,
      relatedTo: parentUidOf(vtodo),
      isCompleted:
        status === 'COMPLETED' || completedAt !== null || percentComplete === 100,
      // Called off rather than finished. Neither section is the right home for
      // it; see `buildTaskTree`.
      isCancelled: status === 'CANCELLED',
    };
  });
}

/**
 * The one component to render for a UID that arrived as a recurring master plus
 * recurrence overrides.
 *
 * A deliberate simplification: this viewer never expands an RRULE, so it cannot
 * say which occurrence is "current". What it can say is whether the household
 * has ticked the latest occurrence off -- and showing a recurring chore as
 * still-to-do right after the owner completed it is the failure that matters. So the
 * latest override wins when it is completed; otherwise the master (which is
 * what carries the summary, description and DUE) is shown.
 *
 * @param {{master: object|null, overrides: Array<object>}} group
 * @returns {object|null}
 */
function pickOccurrence({ master, overrides }) {
  if (overrides.length === 0) return master;

  const latest = overrides.reduce((best, todo) =>
    (todo.recurrenceId?.getTime() ?? 0) > (best.recurrenceId?.getTime() ?? 0) ? todo : best
  );
  if (!master) return latest;
  return latest.isCompleted ? latest : master;
}

/**
 * Parse a `calendar-query` REPORT multistatus into todos, one per UID.
 *
 * A UID appears more than once when a recurring task has overrides; nesting
 * (and the page) needs exactly one component per UID, chosen by
 * `pickOccurrence`.
 *
 * @param {string} xml raw 207 body
 * @returns {Array<object>}
 */
export function parseCalendarQuery(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new NextcloudError('Empty REPORT response from Nextcloud.');
  }

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new NextcloudError(`Could not parse the task REPORT: ${err.message}`);
  }

  // A calendar with nothing in it answers with an empty multistatus.
  const multistatus = doc?.multistatus;
  if (multistatus === undefined || multistatus === null) {
    throw new NextcloudError('REPORT response had no <multistatus> element.');
  }

  // Order of first appearance is preserved; only the choice within a UID is
  // ours to make.
  const todos = [];
  const groups = new Map();
  for (const response of asArray(multistatus.response)) {
    const data = textOf(collectProps(response)['calendar-data']);
    if (!data) continue;
    for (const todo of parseTodoBlob(data)) {
      if (!todo.uid) {
        // Nothing to group it with, and nothing can be a child of it either.
        todos.push(todo);
        continue;
      }
      let group = groups.get(todo.uid);
      if (!group) {
        group = { master: null, overrides: [], index: todos.length };
        groups.set(todo.uid, group);
        todos.push(null); // placeholder, filled once the whole UID is in
      }
      if (todo.recurrenceId) group.overrides.push(todo);
      else group.master ??= todo;
    }
  }

  for (const group of groups.values()) {
    todos[group.index] = pickOccurrence(group);
  }
  return todos.filter(Boolean);
}

// --- Sorting and nesting (pure) --------------------------------------------

/**
 * A due date as {day, time}, in the same terms the label uses.
 *
 * Comparing raw instants would sort by two different clocks: a date-only DUE is
 * a calendar day pinned to UTC midnight, a timed DUE is a real instant read in
 * the household's zone. West of Greenwich that inverts the order around
 * midnight and the page contradicts its own labels ("Due today" listed below
 * "Due tomorrow"). So the day is read exactly as `formatDueLabel` reads it, and
 * only tasks on the same civil day are compared by time -- with a whole-day
 * task last on its day, since it names no time to be due at.
 */
function dueOrder(task) {
  if (!(task.due instanceof Date) || Number.isNaN(task.due.getTime())) return null;
  const isDate = task.dueIsDate !== false;
  return {
    day: civilDay(task.due, isDate),
    time: isDate
      ? Number.POSITIVE_INFINITY
      : task.due.getHours() * 3_600_000 +
        task.due.getMinutes() * 60_000 +
        task.due.getSeconds() * 1_000,
  };
}

/** Soonest first; undated tasks last, then A-Z so the order is never arbitrary. */
export function sortOpenTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const ao = dueOrder(a);
    const bo = dueOrder(b);
    if (ao === null || bo === null) {
      if (ao !== bo) return ao === null ? 1 : -1;
    } else {
      if (ao.day !== bo.day) return ao.day - bo.day;
      if (ao.time !== bo.time) return ao.time - bo.time;
    }
    return collator.compare(a.summary ?? '', b.summary ?? '');
  });
}

/** Most recently finished first; anything without a COMPLETED stamp trails. */
export function sortDoneTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const at = a.completedAt ? a.completedAt.getTime() : null;
    const bt = b.completedAt ? b.completedAt.getTime() : null;
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt - at;
    }
    return collator.compare(a.summary ?? '', b.summary ?? '');
  });
}

/**
 * Nest subtasks under their parents.
 *
 * A task whose RELATED-TO points at a uid that isn't in `tasks` (unshared,
 * deleted, or -- commonly -- sitting in the other completion group) renders at
 * the top level rather than vanishing. Cycles are broken the same way.
 *
 * @param {Array<object>} tasks
 * @param {(tasks: Array<object>) => Array<object>} sortFn applied at every level
 * @returns {Array<object>} copies with a `children` array
 */
export function nestTasks(tasks, sortFn = sortOpenTasks) {
  const byUid = new Map();
  for (const task of tasks) {
    if (task.uid && !byUid.has(task.uid)) byUid.set(task.uid, task);
  }

  /** The parent we will actually honour, after orphan and cycle checks. */
  function effectiveParent(task) {
    const parentUid = task.relatedTo;
    if (!parentUid || parentUid === task.uid || !byUid.has(parentUid)) return null;

    const seen = new Set([task.uid]);
    let cursor = byUid.get(parentUid);
    while (cursor) {
      if (seen.has(cursor.uid)) return null; // cycle: treat this task as a root
      seen.add(cursor.uid);
      cursor = cursor.relatedTo ? byUid.get(cursor.relatedTo) : null;
    }
    return parentUid;
  }

  const childrenOf = new Map();
  const roots = [];
  for (const task of tasks) {
    const parentUid = effectiveParent(task);
    if (parentUid === null) {
      roots.push(task);
      continue;
    }
    if (!childrenOf.has(parentUid)) childrenOf.set(parentUid, []);
    childrenOf.get(parentUid).push(task);
  }

  const build = (task) => ({
    ...task,
    children: sortFn(childrenOf.get(task.uid) ?? []).map(build),
  });

  return sortFn(roots).map(build);
}

/**
 * Split a flat todo list into the two sections the task page renders.
 *
 * Grouping happens before nesting on purpose: a finished subtask belongs in
 * "Done" with everything else she has already seen completed, not buried under
 * an unfinished parent where she'd never notice it.
 *
 * STATUS:CANCELLED tasks appear in neither section. A called-off chore is not
 * still to do, and it was never finished; on a page whose whole job is "what is
 * left and what got done", it is noise. Nothing here can un-cancel it either --
 * this app only reads. A cancelled parent's open subtasks are not hidden with
 * it: `nestTasks` renders them at the top level, the same as any other orphan.
 *
 * @param {Array<object>} todos
 * @returns {{ open: Array<object>, done: Array<object> }}
 */
export function buildTaskTree(todos) {
  const live = todos.filter((t) => !t.isCancelled);
  const open = live.filter((t) => !t.isCompleted);
  const done = live.filter((t) => t.isCompleted);
  return {
    open: nestTasks(open, sortOpenTasks),
    done: nestTasks(done, sortDoneTasks),
  };
}

// --- Fetching (cached per calendar by ctag) --------------------------------

/** calendar uri -> { ctag, fetchedAt, todos }. Module-level: one process, one cache. */
const taskCache = new Map();

/** Drop every cached calendar. Exposed for tests. */
export function clearTaskCache(cache = taskCache) {
  cache.clear();
}

/**
 * Every VTODO in one calendar, newest state within ~60s.
 *
 * The cache is keyed by the calendar's `getctag`, which Nextcloud bumps on any
 * change inside the collection: a stale entry is reused only while the ctag is
 * unchanged AND younger than the TTL, so the owner ticking something off shows up on
 * the next load rather than a minute later. (The TTL is what covers servers
 * that don't report a ctag at all.)
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {string} calendarSlug slug from `listTaskCalendars`
 * @param {{ calendars?: Array<object>, now?: number, cache?: Map }} [options]
 *   calendars: an already-fetched list, to avoid a second PROPFIND
 * @returns {Promise<Array<object>>} todos: {uid, recurrenceId, summary,
 *   description, due, dueIsDate, priority, status, completedAt,
 *   percentComplete, relatedTo, isCompleted, isCancelled}
 */
export async function fetchTodos(client, calendarSlug, options = {}) {
  const { now = Date.now(), cache = taskCache } = options;
  const calendars = options.calendars ?? (await listTaskCalendars(client));
  const calendar = calendars.find((c) => c.slug === calendarSlug);

  if (!calendar) {
    throw new NextcloudError(`No task list with id ${calendarSlug}`, { status: 404 });
  }

  // Keyed by the calendar's own URI, not its slug: a slug can pick up a
  // collision suffix from a calendar that was shared or unshared meanwhile, and
  // a cache keyed on it would then hand back another list's tasks.
  const key = `${client.baseUrl}|${calendar.uri}`;
  const cached = cache.get(key);
  if (
    cached &&
    cached.ctag === calendar.ctag &&
    now - cached.fetchedAt < TASK_CACHE_TTL_MS
  ) {
    return cached.todos;
  }

  const { requestRoot } = calendarRoots(client);
  const url = `${requestRoot}/${encodeURIComponent(calendar.uri)}/`;

  const response = await client.request('REPORT', url, {
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body: REPORT_TODOS_BODY,
  });

  if (response.status === 404) {
    throw new NextcloudError(`Task list not found: ${calendar.uri}`, {
      status: 404,
      method: 'REPORT',
      url,
    });
  }
  if (response.status !== 207) {
    const body = await response.text().catch(() => '');
    throw new NextcloudError(`REPORT ${url} returned ${response.status}`, {
      status: response.status,
      method: 'REPORT',
      url,
      body: body.slice(0, 500),
    });
  }

  const todos = parseCalendarQuery(await response.text());
  cache.set(key, { ctag: calendar.ctag, fetchedAt: now, todos });
  return todos;
}

export { PROPFIND_CALENDARS_BODY, REPORT_TODOS_BODY };
