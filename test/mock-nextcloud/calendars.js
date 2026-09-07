/**
 * Mock CalDAV: the calendar home and one `calendar-query` REPORT per calendar.
 *
 * The fixtures are deliberately awkward in the ways real data is awkward:
 *  - a VEVENT-only calendar (the owner's class schedule) that must never appear as a
 *    task list, sitting next to the scheduling collections Nextcloud creates;
 *  - completed tasks stored out of COMPLETED order, so any accidental reliance
 *    on document order shows up immediately;
 *  - a parent with subtasks via RELATED-TO, one of them already finished, plus
 *    a subtask whose parent no longer exists;
 *  - a recurring task whose latest occurrence was completed as an override, so
 *    master and override share one UID in one resource;
 *  - a cancelled task, which belongs in neither section of the page;
 *  - unicode summaries, a folded DESCRIPTION line, and escaped newlines;
 *  - the revision stamps the stream dates its rows by, in all three shapes the
 *    real server was found writing (see docs/plans/issue-3-tasks-in-stream.md
 *    §1): DTSTAMP alone, DTSTAMP bumped to the COMPLETED instant, and -- from
 *    a client that keeps them -- CREATED and LAST-MODIFIED as well;
 *  - a floating DUE (`DUE:20260909T130000`, no zone), which is what Nextcloud
 *    Tasks Android writes for a task due at a time of day.
 *
 * STAMPS SIT IN THE SAME WEEK AS THE FILE FIXTURES (tree.js: 4-7 Aug 2025), so
 * the stream's task rows genuinely interleave with its file rows instead of
 * every task landing above every file. Due dates are relative to now -- see
 * `ymdOffset` -- because those ARE read against today's date.
 */

/** Join VTODO lines the way a server does, CRLF and all. */
function ics(lines) {
  return icsResource([lines]);
}

/**
 * One resource holding several VTODOs -- how a recurring task and its
 * recurrence overrides actually arrive, all under a single UID.
 *
 * Each component gets `DEFAULT_DTSTAMP` unless its own lines carry a DTSTAMP:
 * every VTODO on the real server has one (it is the only revision stamp that
 * client writes), and the stream dates its rows by it, so a fixture that wants
 * to say WHEN a task was written says so in its own lines.
 *
 * @param {Array<string[]>} components lines for each VTODO
 */
function icsResource(components) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nextcloud Tasks Android//EN',
    ...components.flatMap((lines) => [
      'BEGIN:VTODO',
      ...(lines.some((line) => line.startsWith('DTSTAMP')) ? [] : [`DTSTAMP:${DEFAULT_DTSTAMP}`]),
      ...lines,
      'END:VTODO',
    ]),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/**
 * The stamp a fixture gets when it says nothing: the morning after the newest
 * file in tree.js, so an unspecified task is simply the most recent thing that
 * happened.
 */
const DEFAULT_DTSTAMP = '20250808T101500Z';

/**
 * A weekly chore whose most recent occurrence has been ticked off: the master
 * is still NEEDS-ACTION forever, and only the COMPLETED override says it was
 * done. Reading the master alone would show it as still to do.
 */
export const RECURRING_TODO = icsResource([
  [
    'UID:chore-recycling',
    'DTSTAMP:20250805T190000Z',
    'SUMMARY:Put the recycling out',
    'DUE;VALUE=DATE:20250805',
    'RRULE:FREQ=WEEKLY;BYDAY=WE',
    'STATUS:NEEDS-ACTION',
  ],
  [
    'UID:chore-recycling',
    // Ticking a task off rewrites DTSTAMP to the COMPLETED instant -- that is
    // what the real server does, and the reason the stream dedupes the two
    // (see ../../src/lib/stream-tasks.js).
    'DTSTAMP:20250805T190000Z',
    'RECURRENCE-ID;VALUE=DATE:20250805',
    'SUMMARY:Put the recycling out',
    'DUE;VALUE=DATE:20250805',
    'STATUS:COMPLETED',
    'COMPLETED:20250805T190000Z',
    'PERCENT-COMPLETE:100',
  ],
]);

/**
 * Open-task due dates are DYNAMIC: offsets from the local today. Fixed dates
 * here are time bombs — the e2e spec asserts the essay's dated label ("Due
 * Tue, Aug 12"), but for the two real-world days when a fixed date reads "Due
 * today"/"Due tomorrow" the assertion fails (it did, in CI, on 2026-08-11) —
 * and the school-list ordering (essay before lab report) only holds while the
 * dates keep their relative distance. Offsets keep both true forever; the
 * spec computes its label expectation from the exported value.
 */
function ymdOffset(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export const ESSAY_DUE_YMD = ymdOffset(10);
const SAMPLES_DUE_YMD = ymdOffset(16);
const LAB_DUE_YMD = ymdOffset(18);
/** Due the day after tomorrow, and three days overdue: both sides of Today. */
export const BINS_DUE_YMD = ymdOffset(2);
export const PLANTS_DUE_YMD = ymdOffset(-3);
const SHED_DUE_YMD = ymdOffset(5);

const SCHOOL_TODOS = [
  ics([
    'UID:task-essay',
    // The one fixture written by a client that keeps a full history: CREATED
    // and LAST-MODIFIED as well as DTSTAMP, which is what the stream prefers
    // when it is there. The household's own client writes none of it.
    'CREATED:20250801T090000Z',
    'LAST-MODIFIED:20250806T161500Z',
    'DTSTAMP:20250806T161500Z',
    'SUMMARY:Write the Café history essay — 日本語 sources',
    // Folded continuation line (leading space) plus escaped newlines: both are
    // things a naive line-by-line parser gets wrong.
    'DESCRIPTION:Three parts:\\n1. Outline the argument\\n2. First draft\\n3. Pro',
    ' ofread it out loud',
    `DUE;VALUE=DATE:${ESSAY_DUE_YMD}`,
    'PRIORITY:1',
    'PERCENT-COMPLETE:40',
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:task-lab',
    'DTSTAMP:20250805T113000Z',
    'SUMMARY:Biology lab report',
    `DUE:${LAB_DUE_YMD}T210000Z`,
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:task-lab-samples',
    'DTSTAMP:20250805T113500Z',
    'SUMMARY:Collect pond samples',
    `DUE;VALUE=DATE:${SAMPLES_DUE_YMD}`,
    'RELATED-TO;RELTYPE=PARENT:task-lab',
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:task-lab-graphs',
    'DTSTAMP:20250807T190000Z',
    'SUMMARY:Draw the graphs',
    // No RELTYPE: PARENT is the RFC 5545 default and what Nextcloud writes.
    'RELATED-TO:task-lab',
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:task-read',
    'DTSTAMP:20250803T204500Z',
    'SUMMARY:Read chapter 4',
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:task-orphan',
    'DTSTAMP:20250802T101500Z',
    'SUMMARY:Return the library book',
    // Parent was deleted (or never shared): must still render, top level.
    'RELATED-TO;RELTYPE=PARENT:task-deleted-long-ago',
    'STATUS:NEEDS-ACTION',
  ]),
  // --- finished, stored oldest-first so the sort has something to do ---
  ics([
    'UID:task-slip',
    'DTSTAMP:20250801T120000Z',
    'SUMMARY:Hand in the permission slip',
    'STATUS:COMPLETED',
    'COMPLETED:20250801T120000Z',
    'PERCENT-COMPLETE:100',
  ]),
  ics([
    'UID:task-notebook',
    'DTSTAMP:20250807T093000Z',
    'SUMMARY:Buy a lab notebook',
    'STATUS:COMPLETED',
    'COMPLETED:20250807T093000Z',
    'PERCENT-COMPLETE:100',
  ]),
  ics([
    'UID:task-email',
    'DTSTAMP:20250804T081500Z',
    'SUMMARY:Email Professor Ruiz',
    'STATUS:COMPLETED',
    'COMPLETED:20250804T081500Z',
    'PERCENT-COMPLETE:100',
  ]),
  ics([
    // A finished subtask of an unfinished parent: it belongs in "Done", where
    // she will see it, not hidden under a task that is still open.
    'UID:task-lab-manual',
    'CREATED:20250803T080000Z',
    'LAST-MODIFIED:20250806T140000Z',
    'DTSTAMP:20250806T140000Z',
    'SUMMARY:Borrow the lab manual',
    'RELATED-TO;RELTYPE=PARENT:task-lab',
    'STATUS:COMPLETED',
    'COMPLETED:20250806T140000Z',
  ]),
];

const CHORE_TODOS = [
  ics([
    // Three days late, and due at a time of day written as a FLOATING local
    // time -- no zone, no Z. That is what Nextcloud Tasks Android writes, and
    // it is read in the process zone (the household's), so a fixture with one
    // is the only way the tests see what the household sees.
    'UID:chore-plants',
    'DTSTAMP:20250806T090000Z',
    'SUMMARY:Water the plants',
    `DUE:${PLANTS_DUE_YMD}T130000`,
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:chore-bins',
    'DTSTAMP:20250804T072000Z',
    'SUMMARY:Take the bins out',
    `DUE;VALUE=DATE:${BINS_DUE_YMD}`,
    'STATUS:NEEDS-ACTION',
  ]),
  ics(['UID:chore-dishes', 'SUMMARY:Empty the dishwasher', 'STATUS:NEEDS-ACTION']),
  ics([
    // Called off, not finished: it belongs in neither section -- and, dated
    // ahead of today, it must not appear above the Today line either.
    'UID:chore-shed',
    'SUMMARY:Clear out the shed',
    `DUE;VALUE=DATE:${SHED_DUE_YMD}`,
    'STATUS:CANCELLED',
  ]),
  RECURRING_TODO,
  ics([
    'UID:chore-vacuum',
    'DTSTAMP:20250807T170000Z',
    'SUMMARY:Vacuum the stairs',
    'STATUS:COMPLETED',
    'COMPLETED:20250807T170000Z',
  ]),
];

/** @type {Array<{uri:string, displayName:string, ctag:string, color:string|null, components:string[], todos:string[]}>} */
export const CALENDAR_FIXTURES = [
  {
    uri: 'school-tasks',
    displayName: 'School Tasks',
    ctag: 'http://sabre.io/ns/sync/42',
    color: '#1c4f8b',
    components: ['VTODO'],
    todos: SCHOOL_TODOS,
  },
  {
    uri: 'chores',
    displayName: 'Chores',
    ctag: 'http://sabre.io/ns/sync/7',
    color: '#2f7a3f',
    components: ['VEVENT', 'VTODO'],
    todos: CHORE_TODOS,
  },
  {
    uri: 'class-schedule',
    displayName: 'Class Schedule',
    ctag: 'http://sabre.io/ns/sync/3',
    color: '#b3352f',
    // Events only: never a task list, however tempting the name.
    components: ['VEVENT'],
    todos: [],
  },
];

/** Non-calendar collections that share the home and must be skipped. */
const SCHEDULING_COLLECTIONS = ['inbox', 'outbox'];

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function encodeHref(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function calendarResponse(hrefRoot, calendar) {
  const comps = calendar.components
    .map((name) => `<cal:comp name="${name}"/>`)
    .join('');
  const colorProp = calendar.color
    ? `<x1:calendar-color>${xmlEscape(calendar.color)}</x1:calendar-color>`
    : '';
  // Real Nextcloud reports absent properties in a second, 404 propstat block.
  const notFound = calendar.color
    ? ''
    : `      <d:propstat>
        <d:prop><x1:calendar-color/></d:prop>
        <d:status>HTTP/1.1 404 Not Found</d:status>
      </d:propstat>
`;

  return `    <d:response>
      <d:href>${xmlEscape(`${hrefRoot}/${encodeHref(calendar.uri)}/`)}</d:href>
      <d:propstat>
        <d:prop>
          <d:displayname>${xmlEscape(calendar.displayName)}</d:displayname>
          <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
          <cal:supported-calendar-component-set>${comps}</cal:supported-calendar-component-set>
          <cs:getctag>${xmlEscape(calendar.ctag)}</cs:getctag>
          ${colorProp}
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
${notFound}    </d:response>`;
}

function plainCollectionResponse(hrefRoot, name, extraResourceType = '') {
  return `    <d:response>
      <d:href>${xmlEscape(`${hrefRoot}/${name}/`)}</d:href>
      <d:propstat>
        <d:prop>
          <d:resourcetype><d:collection/>${extraResourceType}</d:resourcetype>
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
      <d:propstat>
        <d:prop><d:displayname/><cal:supported-calendar-component-set/><cs:getctag/><x1:calendar-color/></d:prop>
        <d:status>HTTP/1.1 404 Not Found</d:status>
      </d:propstat>
    </d:response>`;
}

/**
 * Depth-1 multistatus for the calendar home: the home itself, the scheduling
 * collections, then the calendars.
 *
 * @param {{ hrefRoot: string, calendars?: Array<object> }} options
 *   hrefRoot: href prefix INCLUDING any base path, e.g.
 *   `/nextcloud/remote.php/dav/calendars/ostrich-viewer`
 */
export function buildCalendarHomeMultistatus({ hrefRoot, calendars = CALENDAR_FIXTURES }) {
  const parts = [
    `    <d:response>
      <d:href>${xmlEscape(`${hrefRoot}/`)}</d:href>
      <d:propstat>
        <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
    </d:response>`,
    ...SCHEDULING_COLLECTIONS.map((name) =>
      plainCollectionResponse(hrefRoot, name, `<cal:schedule-${name}/>`)
    ),
    ...calendars.map((calendar) => calendarResponse(hrefRoot, calendar)),
  ];

  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns" xmlns:x1="http://apple.com/ns/ical/">
${parts.join('\n')}
</d:multistatus>
`;
}

/**
 * An ETag for one resource, derived from its bytes.
 *
 * A version marker, not a name: the stream's ledger asks "has this resource
 * changed since I last saw it" and nothing else (see
 * ../../src/store/tasks-seen.js), so an etag keyed on the calendar and the
 * task's position would answer "no" to an edited task and "yes" to a
 * reordered one -- both backwards. Hashing the blob is what a real server's
 * etag behaves like, and it is what lets a test edit a fixture and watch the
 * app notice.
 */
function fakeEtag(blob) {
  let hash = 2166136261;
  for (let i = 0; i < blob.length; i += 1) {
    hash ^= blob.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** One response per VTODO resource, as a real calendar-query REPORT returns. */
export function buildCalendarQueryMultistatus({ hrefRoot, calendar }) {
  const parts = calendar.todos.map((blob, index) => {
    const uid = /^UID:(.*)$/m.exec(blob)?.[1]?.trim() ?? `todo-${index}`;
    return `    <d:response>
      <d:href>${xmlEscape(`${hrefRoot}/${encodeHref(calendar.uri)}/${encodeHref(uid)}.ics`)}</d:href>
      <d:propstat>
        <d:prop>
          <d:getetag>&quot;${fakeEtag(blob)}&quot;</d:getetag>
          <cal:calendar-data>${xmlEscape(blob)}</cal:calendar-data>
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
    </d:response>`;
  });

  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
${parts.join('\n')}
</d:multistatus>
`;
}

/**
 * Serve anything under the calendar home.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ pathname: string, hrefRoot: string, calendars?: Array<object>,
 *           failCalendar?: string|null, homeStatus?: number|null }} options
 *   failCalendar: the `uri` of one calendar whose REPORT answers 500. One list
 *   failing while the others answer is the case the stream's task half is
 *   best-effort FOR (see ../../src/routes/stream.js), and it cannot be
 *   simulated by taking the whole server away.
 *   homeStatus: answer the calendar home's PROPFIND with this status instead of
 *   listing anything -- "we do not even know what task lists exist", which is
 *   the one task failure the reader is told about.
 * @returns {boolean} true if the request was handled here
 */
export function handleCalendarRequest(
  req,
  res,
  { pathname, hrefRoot, calendars = CALENDAR_FIXTURES, failCalendar = null, homeStatus = null }
) {
  const normalized = pathname.replace(/\/+$/, '');
  const root = hrefRoot.replace(/\/+$/, '');

  if (normalized === root) {
    if (homeStatus !== null) {
      res.writeHead(homeStatus, { 'Content-Type': 'text/plain' });
      res.end('The calendar home is not answering');
      return true;
    }
    if (req.method !== 'PROPFIND') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'PROPFIND' });
      res.end('Only PROPFIND on the calendar home');
      return true;
    }
    const xml = buildCalendarHomeMultistatus({ hrefRoot: root, calendars });
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
    return true;
  }

  const rest = normalized.slice(root.length + 1);
  const calendar = calendars.find((c) => c.uri === rest);

  if (!calendar) {
    res.writeHead(404, { 'Content-Type': 'application/xml' });
    res.end(
      '<?xml version="1.0"?><d:error xmlns:d="DAV:"><s:message>Calendar not found</s:message></d:error>'
    );
    return true;
  }

  if (req.method === 'REPORT') {
    if (failCalendar !== null && calendar.uri === failCalendar) {
      // A list that is there, listed, and will not be read: a Nextcloud
      // mid-upgrade, a broken share, a calendar Sabre trips over.
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Sabre\\DAV\\Exception: something went wrong reading that calendar');
      return true;
    }
    const xml = buildCalendarQueryMultistatus({ hrefRoot: root, calendar });
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
    return true;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'REPORT' });
  res.end(`Method ${req.method} not implemented for calendars`);
  return true;
}
