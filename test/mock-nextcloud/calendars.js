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
 *  - unicode summaries, a folded DESCRIPTION line, and escaped newlines.
 */

/** Join VTODO lines the way a server does, CRLF and all. */
function ics(lines) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nextcloud/Tasks//EN',
    'BEGIN:VTODO',
    'DTSTAMP:20260808T101500Z',
    ...lines,
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const SCHOOL_TODOS = [
  ics([
    'UID:task-essay',
    'SUMMARY:Write the Café history essay — 日本語 sources',
    // Folded continuation line (leading space) plus escaped newlines: both are
    // things a naive line-by-line parser gets wrong.
    'DESCRIPTION:Three parts:\\n1. Outline the argument\\n2. First draft\\n3. Pro',
    ' ofread it out loud',
    'DUE;VALUE=DATE:20260812',
    'PRIORITY:1',
    'PERCENT-COMPLETE:40',
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:task-lab',
    'SUMMARY:Biology lab report',
    'DUE:20260820T210000Z',
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:task-lab-samples',
    'SUMMARY:Collect pond samples',
    'DUE;VALUE=DATE:20260818',
    'RELATED-TO;RELTYPE=PARENT:task-lab',
    'STATUS:NEEDS-ACTION',
  ]),
  ics([
    'UID:task-lab-graphs',
    'SUMMARY:Draw the graphs',
    // No RELTYPE: PARENT is the RFC 5545 default and what Nextcloud writes.
    'RELATED-TO:task-lab',
    'STATUS:NEEDS-ACTION',
  ]),
  ics(['UID:task-read', 'SUMMARY:Read chapter 4', 'STATUS:NEEDS-ACTION']),
  ics([
    'UID:task-orphan',
    'SUMMARY:Return the library book',
    // Parent was deleted (or never shared): must still render, top level.
    'RELATED-TO;RELTYPE=PARENT:task-deleted-long-ago',
    'STATUS:NEEDS-ACTION',
  ]),
  // --- finished, stored oldest-first so the sort has something to do ---
  ics([
    'UID:task-slip',
    'SUMMARY:Hand in the permission slip',
    'STATUS:COMPLETED',
    'COMPLETED:20260801T120000Z',
    'PERCENT-COMPLETE:100',
  ]),
  ics([
    'UID:task-notebook',
    'SUMMARY:Buy a lab notebook',
    'STATUS:COMPLETED',
    'COMPLETED:20260807T093000Z',
    'PERCENT-COMPLETE:100',
  ]),
  ics([
    'UID:task-email',
    'SUMMARY:Email Professor Ruiz',
    'STATUS:COMPLETED',
    'COMPLETED:20260804T081500Z',
    'PERCENT-COMPLETE:100',
  ]),
  ics([
    // A finished subtask of an unfinished parent: it belongs in "Done", where
    // she will see it, not hidden under a task that is still open.
    'UID:task-lab-manual',
    'SUMMARY:Borrow the lab manual',
    'RELATED-TO;RELTYPE=PARENT:task-lab',
    'STATUS:COMPLETED',
    'COMPLETED:20260806T140000Z',
  ]),
];

const CHORE_TODOS = [
  ics([
    'UID:chore-bins',
    'SUMMARY:Take the bins out',
    'DUE;VALUE=DATE:20260810',
    'STATUS:NEEDS-ACTION',
  ]),
  ics(['UID:chore-dishes', 'SUMMARY:Empty the dishwasher', 'STATUS:NEEDS-ACTION']),
  ics([
    'UID:chore-vacuum',
    'SUMMARY:Vacuum the stairs',
    'STATUS:COMPLETED',
    'COMPLETED:20260808T170000Z',
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

/** One response per VTODO resource, as a real calendar-query REPORT returns. */
export function buildCalendarQueryMultistatus({ hrefRoot, calendar }) {
  const parts = calendar.todos.map((blob, index) => {
    const uid = /^UID:(.*)$/m.exec(blob)?.[1]?.trim() ?? `todo-${index}`;
    return `    <d:response>
      <d:href>${xmlEscape(`${hrefRoot}/${encodeHref(calendar.uri)}/${encodeHref(uid)}.ics`)}</d:href>
      <d:propstat>
        <d:prop>
          <d:getetag>&quot;etag-${index}&quot;</d:getetag>
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
 * @param {{ pathname: string, hrefRoot: string, calendars?: Array<object> }} options
 * @returns {boolean} true if the request was handled here
 */
export function handleCalendarRequest(req, res, { pathname, hrefRoot, calendars = CALENDAR_FIXTURES }) {
  const normalized = pathname.replace(/\/+$/, '');
  const root = hrefRoot.replace(/\/+$/, '');

  if (normalized === root) {
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
    const xml = buildCalendarQueryMultistatus({ hrefRoot: root, calendar });
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
    return true;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'REPORT' });
  res.end(`Method ${req.method} not implemented for calendars`);
  return true;
}
