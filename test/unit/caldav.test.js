import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_CACHE_TTL_MS,
  buildTaskTree,
  calendarRoots,
  fetchTodos,
  listTaskCalendars,
  nestTasks,
  parseCalendarList,
  parseCalendarQuery,
  parseTodoBlob,
  sortDoneTasks,
  sortOpenTasks,
} from '../../src/nextcloud/caldav.js';
import { createClient, NextcloudError } from '../../src/nextcloud/client.js';
import {
  CALENDAR_FIXTURES,
  buildCalendarHomeMultistatus,
  buildCalendarQueryMultistatus,
} from '../mock-nextcloud/calendars.js';

const HREF_ROOT = '/remote.php/dav/calendars/ostrich-viewer';

function clientWith(fetchImpl, baseUrl = 'http://nextcloud.test') {
  return createClient({ baseUrl, user: 'ostrich-viewer', appPassword: 'pw', fetchImpl });
}

function xmlResponse(body, status = 207) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/xml' } });
}

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO', ...lines, 'END:VTODO', 'END:VCALENDAR'].join(
    '\r\n'
  );
}

// --- calendar discovery ----------------------------------------------------

test('parseCalendarList: keeps only the calendars that hold VTODOs', () => {
  const xml = buildCalendarHomeMultistatus({ hrefRoot: HREF_ROOT });
  const calendars = parseCalendarList(xml, { hrefRoot: HREF_ROOT });

  assert.deepEqual(
    calendars.map((c) => c.displayName),
    ['Chores', 'School Tasks']
  );
  // The VEVENT-only calendar and the inbox/outbox collections are not lists.
  assert.ok(!calendars.some((c) => c.uri === 'class-schedule'));
  assert.ok(!calendars.some((c) => c.uri === 'inbox' || c.uri === 'outbox'));
});

test('parseCalendarList: maps slug, ctag and colour off each calendar', () => {
  const xml = buildCalendarHomeMultistatus({ hrefRoot: HREF_ROOT });
  const school = parseCalendarList(xml, { hrefRoot: HREF_ROOT }).find(
    (c) => c.displayName === 'School Tasks'
  );

  assert.deepEqual(school, {
    slug: 'school-tasks',
    uri: 'school-tasks',
    displayName: 'School Tasks',
    ctag: 'http://sabre.io/ns/sync/42',
    color: '#1c4f8b',
  });
});

test('parseCalendarList: hrefs keep working when Nextcloud lives under a base path', () => {
  // NC_BASE_URL=https://host/nextcloud -> every href is /nextcloud-prefixed.
  const prefixed = `/nextcloud${HREF_ROOT}`;
  const xml = buildCalendarHomeMultistatus({ hrefRoot: prefixed });

  assert.equal(parseCalendarList(xml, { hrefRoot: prefixed }).length, 2);
  // …and the un-prefixed root must not silently match the prefixed hrefs.
  assert.equal(parseCalendarList(xml, { hrefRoot: HREF_ROOT }).length, 0);
});

test('parseCalendarList: slugs are URL-safe and unique even for awkward URIs', () => {
  const calendars = parseCalendarList(
    buildCalendarHomeMultistatus({
      hrefRoot: HREF_ROOT,
      calendars: [
        { uri: 'Café ☕ list', displayName: 'Café', ctag: '1', color: null, components: ['VTODO'] },
        { uri: 'cafe-list', displayName: 'Second', ctag: '2', color: null, components: ['VTODO'] },
      ],
    }),
    { hrefRoot: HREF_ROOT }
  );

  const slugs = calendars.map((c) => c.slug);
  assert.ok(slugs.every((s) => /^[A-Za-z0-9._-]+$/.test(s)), `not URL-safe: ${slugs}`);
  assert.equal(new Set(slugs).size, 2, 'colliding slugs must be disambiguated');
  // The original URI is kept verbatim -- it is what the REPORT is addressed to.
  assert.ok(calendars.some((c) => c.uri === 'Café ☕ list'));
});

test('parseCalendarList: a missing calendar-color is null, not an empty string', () => {
  const xml = buildCalendarHomeMultistatus({
    hrefRoot: HREF_ROOT,
    calendars: [{ uri: 'plain', displayName: 'Plain', ctag: '1', color: null, components: ['VTODO'] }],
  });
  assert.equal(parseCalendarList(xml, { hrefRoot: HREF_ROOT })[0].color, null);
});

test('parseCalendarList: rejects junk instead of returning half a list', () => {
  assert.throws(() => parseCalendarList('', { hrefRoot: HREF_ROOT }), NextcloudError);
  assert.throws(
    () => parseCalendarList('<?xml version="1.0"?><html>Login</html>', { hrefRoot: HREF_ROOT }),
    NextcloudError
  );
});

test('listTaskCalendars: Depth-1 PROPFIND of the calendar home', async () => {
  const seen = [];
  const client = clientWith(async (url, init) => {
    seen.push({ url, method: init.method, depth: init.headers.Depth, body: init.body });
    return xmlResponse(buildCalendarHomeMultistatus({ hrefRoot: HREF_ROOT }));
  });

  const calendars = await listTaskCalendars(client);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'PROPFIND');
  assert.equal(seen[0].depth, '1');
  assert.equal(seen[0].url, `http://nextcloud.test${HREF_ROOT}/`);
  assert.match(seen[0].body, /supported-calendar-component-set/);
  assert.match(seen[0].body, /getctag/);
  assert.equal(calendars.length, 2);
});

test('listTaskCalendars: a base-path install asks the prefixed URL and still parses', async () => {
  const client = clientWith(async (url) => {
    assert.ok(
      url.startsWith('http://nextcloud.test/nextcloud/remote.php/dav/calendars/'),
      `request must carry the base path, got ${url}`
    );
    return xmlResponse(buildCalendarHomeMultistatus({ hrefRoot: `/nextcloud${HREF_ROOT}` }));
  }, 'http://nextcloud.test/nextcloud');

  assert.equal(calendarRoots(client).hrefRoot, `/nextcloud${HREF_ROOT}`);
  assert.equal((await listTaskCalendars(client)).length, 2);
});

test('listTaskCalendars: no calendar home at all is an empty list, not an error', async () => {
  const client = clientWith(async () => new Response('nope', { status: 404 }));
  assert.deepEqual(await listTaskCalendars(client), []);
});

// --- VTODO parsing ---------------------------------------------------------

test('parseTodoBlob: reads every field we render', () => {
  const [todo] = parseTodoBlob(
    ics([
      'UID:task-1',
      'SUMMARY:Write the Café essay — 日本語',
      'DESCRIPTION:Part one\\nPart two\\nPart three',
      'DUE;VALUE=DATE:20260812',
      'PRIORITY:1',
      'PERCENT-COMPLETE:40',
      'STATUS:NEEDS-ACTION',
      'RELATED-TO;RELTYPE=PARENT:task-parent',
    ])
  );

  assert.equal(todo.uid, 'task-1');
  assert.equal(todo.summary, 'Write the Café essay — 日本語');
  assert.equal(todo.description, 'Part one\nPart two\nPart three');
  // A date-only DUE is a calendar day, pinned to UTC so it never slides a day.
  assert.equal(todo.due.toISOString(), '2026-08-12T00:00:00.000Z');
  assert.equal(todo.dueIsDate, true);
  assert.equal(todo.priority, 1);
  assert.equal(todo.percentComplete, 40);
  assert.equal(todo.status, 'NEEDS-ACTION');
  assert.equal(todo.relatedTo, 'task-parent');
  assert.equal(todo.completedAt, null);
  assert.equal(todo.isCompleted, false);
});

test('parseTodoBlob: a DUE with a time keeps its instant', () => {
  const [todo] = parseTodoBlob(ics(['UID:t', 'SUMMARY:Timed', 'DUE:20260820T210000Z']));

  assert.equal(todo.dueIsDate, false);
  assert.equal(todo.due.toISOString(), '2026-08-20T21:00:00.000Z');
});

test('parseTodoBlob: unfolds continuation lines', () => {
  const blob = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    'UID:t',
    'SUMMARY:A summary long enough that a real server would fold it right ab',
    ' out here',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  assert.equal(
    parseTodoBlob(blob)[0].summary,
    'A summary long enough that a real server would fold it right about here'
  );
});

test('parseTodoBlob: RELATED-TO defaults to PARENT; other relation types are ignored', () => {
  const [implicit] = parseTodoBlob(ics(['UID:a', 'SUMMARY:A', 'RELATED-TO:parent-uid']));
  assert.equal(implicit.relatedTo, 'parent-uid');

  const [child] = parseTodoBlob(
    ics(['UID:b', 'SUMMARY:B', 'RELATED-TO;RELTYPE=CHILD:some-child-uid'])
  );
  assert.equal(child.relatedTo, null, 'a CHILD relation is not our parent link');
});

test('parseTodoBlob: completion is recognised from STATUS, COMPLETED or 100%', () => {
  const byStatus = parseTodoBlob(ics(['UID:a', 'SUMMARY:A', 'STATUS:COMPLETED']))[0];
  const byStamp = parseTodoBlob(ics(['UID:b', 'SUMMARY:B', 'COMPLETED:20260807T093000Z']))[0];
  const byPercent = parseTodoBlob(ics(['UID:c', 'SUMMARY:C', 'PERCENT-COMPLETE:100']))[0];
  const open = parseTodoBlob(ics(['UID:d', 'SUMMARY:D', 'PERCENT-COMPLETE:99']))[0];

  assert.equal(byStatus.isCompleted, true);
  assert.equal(byStamp.isCompleted, true);
  assert.equal(byStamp.completedAt.toISOString(), '2026-08-07T09:30:00.000Z');
  assert.equal(byPercent.isCompleted, true);
  assert.equal(open.isCompleted, false);
});

test('parseTodoBlob: a summary-less or unparseable resource never throws', () => {
  assert.deepEqual(parseTodoBlob('not an ical file at all'), []);
  assert.deepEqual(parseTodoBlob(''), []);
  assert.equal(parseTodoBlob(ics(['UID:x']))[0].summary, 'Untitled task');
});

test('parseCalendarQuery: pulls every VTODO out of a REPORT multistatus', () => {
  const school = CALENDAR_FIXTURES.find((c) => c.uri === 'school-tasks');
  const todos = parseCalendarQuery(
    buildCalendarQueryMultistatus({ hrefRoot: HREF_ROOT, calendar: school })
  );

  assert.equal(todos.length, school.todos.length);
  assert.ok(todos.some((t) => t.summary === 'Write the Café history essay — 日本語 sources'));
  assert.ok(todos.some((t) => t.description?.includes('\n')));
});

test('parseCalendarQuery: an empty calendar is an empty list', () => {
  const xml = buildCalendarQueryMultistatus({
    hrefRoot: HREF_ROOT,
    calendar: { uri: 'empty', todos: [] },
  });
  assert.deepEqual(parseCalendarQuery(xml), []);
});

// --- sorting and nesting ---------------------------------------------------

const dated = (summary, iso) => ({
  uid: summary,
  summary,
  due: iso ? new Date(iso) : null,
  relatedTo: null,
});

test('sortOpenTasks: soonest first, undated last', () => {
  const sorted = sortOpenTasks([
    dated('no date', null),
    dated('later', '2026-09-01'),
    dated('sooner', '2026-08-12'),
    dated('also undated', null),
  ]);

  assert.deepEqual(
    sorted.map((t) => t.summary),
    ['sooner', 'later', 'also undated', 'no date']
  );
});

test('sortOpenTasks does not mutate its input', () => {
  const tasks = [dated('b', '2026-09-01'), dated('a', '2026-08-01')];
  sortOpenTasks(tasks);
  assert.deepEqual(tasks.map((t) => t.summary), ['b', 'a']);
});

test('sortDoneTasks: most recently finished first', () => {
  const done = (summary, iso) => ({
    uid: summary,
    summary,
    completedAt: iso ? new Date(iso) : null,
    relatedTo: null,
  });

  assert.deepEqual(
    sortDoneTasks([
      done('oldest', '2026-08-01T12:00:00Z'),
      done('newest', '2026-08-07T09:30:00Z'),
      done('undated', null),
      done('middle', '2026-08-04T08:15:00Z'),
    ]).map((t) => t.summary),
    ['newest', 'middle', 'oldest', 'undated']
  );
});

test('nestTasks: subtasks hang off their parent, sorted by the same rule', () => {
  const roots = nestTasks([
    { uid: 'p', summary: 'Parent', due: new Date('2026-08-20'), relatedTo: null },
    { uid: 'c2', summary: 'Second', due: null, relatedTo: 'p' },
    { uid: 'c1', summary: 'First', due: new Date('2026-08-18'), relatedTo: 'p' },
  ]);

  assert.deepEqual(roots.map((t) => t.summary), ['Parent']);
  assert.deepEqual(roots[0].children.map((t) => t.summary), ['First', 'Second']);
});

test('nestTasks: a subtask whose parent is missing renders at the top level', () => {
  const roots = nestTasks([
    { uid: 'a', summary: 'Kept', due: null, relatedTo: 'deleted-parent' },
    { uid: 'b', summary: 'Plain', due: null, relatedTo: null },
  ]);

  assert.deepEqual(roots.map((t) => t.summary).sort(), ['Kept', 'Plain']);
  assert.ok(roots.every((t) => t.children.length === 0));
});

test('nestTasks: a RELATED-TO cycle cannot swallow tasks or loop forever', () => {
  const roots = nestTasks([
    { uid: 'a', summary: 'A', due: null, relatedTo: 'b' },
    { uid: 'b', summary: 'B', due: null, relatedTo: 'a' },
    { uid: 'self', summary: 'Self', due: null, relatedTo: 'self' },
  ]);

  const flat = [];
  const walk = (tasks) => tasks.forEach((t) => (flat.push(t.summary), walk(t.children)));
  walk(roots);
  assert.deepEqual(flat.sort(), ['A', 'B', 'Self']);
});

test('buildTaskTree: open and done split first, so a finished subtask is visible', () => {
  const school = CALENDAR_FIXTURES.find((c) => c.uri === 'school-tasks');
  const { open, done } = buildTaskTree(
    parseCalendarQuery(buildCalendarQueryMultistatus({ hrefRoot: HREF_ROOT, calendar: school }))
  );

  assert.deepEqual(
    open.map((t) => t.summary),
    [
      'Write the Café history essay — 日本語 sources',
      'Biology lab report',
      'Read chapter 4',
      'Return the library book',
    ]
  );
  assert.deepEqual(
    open[1].children.map((t) => t.summary),
    ['Collect pond samples', 'Draw the graphs']
  );

  // 'Borrow the lab manual' is a subtask of the still-open lab report; it
  // belongs in Done, at the top level, ordered by when it was finished.
  assert.deepEqual(
    done.map((t) => t.summary),
    [
      'Buy a lab notebook',
      'Borrow the lab manual',
      'Email Professor Ruiz',
      'Hand in the permission slip',
    ]
  );
  assert.ok(done.every((t) => t.children.length === 0));
});

// --- fetching and the ctag cache -------------------------------------------

const TEST_CALENDARS = [
  { slug: 'school-tasks', uri: 'school-tasks', displayName: 'School Tasks', ctag: 'v1', color: null },
];

function reportingClient(counter, calendar = CALENDAR_FIXTURES[0]) {
  return clientWith(async (url, init) => {
    counter.push({ url, method: init.method, depth: init.headers.Depth, body: init.body });
    return xmlResponse(buildCalendarQueryMultistatus({ hrefRoot: HREF_ROOT, calendar }));
  });
}

test('fetchTodos: issues a VTODO-filtered calendar-query REPORT at Depth 1', async () => {
  const calls = [];
  const todos = await fetchTodos(reportingClient(calls), 'school-tasks', {
    calendars: TEST_CALENDARS,
    cache: new Map(),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'REPORT');
  assert.equal(calls[0].depth, '1');
  assert.equal(calls[0].url, `http://nextcloud.test${HREF_ROOT}/school-tasks/`);
  assert.match(calls[0].body, /calendar-query/);
  assert.match(calls[0].body, /comp-filter name="VTODO"/);
  assert.ok(todos.length > 0);
});

test('fetchTodos: a slug that is not in the calendar list is a 404, not a request', async () => {
  const calls = [];
  await assert.rejects(
    () => fetchTodos(reportingClient(calls), 'made-up', { calendars: TEST_CALENDARS, cache: new Map() }),
    (err) => {
      assert.ok(err instanceof NextcloudError);
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
  assert.equal(calls.length, 0, 'nothing from the URL may reach Nextcloud');
});

test('fetchTodos: a second look within the TTL is served from the cache', async () => {
  const calls = [];
  const client = reportingClient(calls);
  const cache = new Map();

  await fetchTodos(client, 'school-tasks', { calendars: TEST_CALENDARS, cache, now: 1_000 });
  await fetchTodos(client, 'school-tasks', { calendars: TEST_CALENDARS, cache, now: 30_000 });

  assert.equal(calls.length, 1);
});

test('fetchTodos: a changed ctag refetches immediately, TTL or not', async () => {
  const calls = [];
  const client = reportingClient(calls);
  const cache = new Map();

  await fetchTodos(client, 'school-tasks', { calendars: TEST_CALENDARS, cache, now: 1_000 });
  // The owner ticks something off: Nextcloud bumps the collection's ctag.
  const bumped = [{ ...TEST_CALENDARS[0], ctag: 'v2' }];
  await fetchTodos(client, 'school-tasks', { calendars: bumped, cache, now: 2_000 });

  assert.equal(calls.length, 2);
});

test('fetchTodos: the cache expires, so a server without ctags still refreshes', async () => {
  const calls = [];
  const client = reportingClient(calls);
  const cache = new Map();
  const calendars = [{ ...TEST_CALENDARS[0], ctag: null }];

  await fetchTodos(client, 'school-tasks', { calendars, cache, now: 1_000 });
  await fetchTodos(client, 'school-tasks', { calendars, cache, now: 1_000 + TASK_CACHE_TTL_MS });

  assert.equal(calls.length, 2);
});

test('fetchTodos: each calendar is cached on its own', async () => {
  const calls = [];
  const client = reportingClient(calls);
  const cache = new Map();
  const calendars = [
    TEST_CALENDARS[0],
    { slug: 'chores', uri: 'chores', displayName: 'Chores', ctag: 'c1', color: null },
  ];

  await fetchTodos(client, 'school-tasks', { calendars, cache, now: 1_000 });
  await fetchTodos(client, 'chores', { calendars, cache, now: 1_000 });
  await fetchTodos(client, 'school-tasks', { calendars, cache, now: 1_000 });

  assert.equal(calls.length, 2);
});

test('fetchTodos: an upstream 404 for the calendar itself surfaces as a 404', async () => {
  const client = clientWith(async () => new Response('gone', { status: 404 }));
  await assert.rejects(
    () => fetchTodos(client, 'school-tasks', { calendars: TEST_CALENDARS, cache: new Map() }),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
});
