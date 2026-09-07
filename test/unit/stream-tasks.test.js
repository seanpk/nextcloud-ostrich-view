// Due dates and day grouping are read in the server's zone, and the rules that
// matter only bite west of Greenwich. Node re-reads TZ on the next date
// operation, so setting it here is enough.
process.env.TZ = 'America/New_York';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANGE_TOLERANCE_MS,
  SEEN_REFRESH_MS,
  taskEvents,
  undatedOpenCount,
  upcomingTasks,
} from '../../src/lib/stream-tasks.js';
import { ledgerKey } from '../../src/store/tasks-seen.js';

/**
 * What the stream says about tasks, and when it keeps quiet.
 *
 * Everything here is pure: todos in, a ledger in, rows out. The interesting
 * rules are all about not saying the same thing twice -- the household's client
 * bumps a task's DTSTAMP when it is ticked off, so "Finished" and "Changed" are
 * the same event a second apart unless something stops them.
 */

const NOW = new Date('2026-09-07T15:00:00Z');
const LIST = {
  slug: 'school-tasks',
  uri: 'school-tasks',
  displayName: 'School Tasks',
  color: '#1c4f8b',
};

/** A todo as `fetchTodos` hands it over. */
function todo(overrides = {}) {
  return {
    uid: 'task-1',
    summary: 'Write the essay',
    due: null,
    dueIsDate: true,
    status: 'NEEDS-ACTION',
    completedAt: null,
    percentComplete: null,
    relatedTo: null,
    etag: 'etag-1',
    createdAt: null,
    stampAt: new Date('2026-09-05T08:00:00Z'),
    isCompleted: false,
    isCancelled: false,
    ...overrides,
  };
}

/** The ledger a second load would be working from, after `first` was seen. */
function ledgerAfter(todos, options = {}) {
  return taskEvents(todos, LIST, {}, { now: NOW, ...options }).updates;
}

function kinds(events) {
  return events.map((e) => e.kind).sort();
}

// --- first sighting ---------------------------------------------------------

test('a task we have never seen is Added, dated by its own stamp', () => {
  const { events, updates } = taskEvents([todo()], LIST, {}, { now: NOW });

  assert.deepEqual(kinds(events), ['task-added']);
  const [added] = events;
  assert.equal(added.label, 'Added');
  // Its DTSTAMP, not our clock: a task nobody has edited was written then, and
  // dating the row by the moment we happened to look would put the whole
  // household's backlog on top of today.
  assert.equal(added.at.toISOString(), '2026-09-05T08:00:00.000Z');
  assert.equal(added.task.summary, 'Write the essay');
  assert.equal(added.task.href, '/tasks/school-tasks');
  assert.equal(added.task.name, 'School Tasks');
  assert.equal(added.task.accentClass, 'tile--accent-blue');

  // And it is remembered, so the ledger can tell next time.
  const entry = updates[ledgerKey('school-tasks', 'task-1')];
  assert.equal(entry.addedAt, '2026-09-05T08:00:00.000Z');
  assert.equal(entry.stampAt, '2026-09-05T08:00:00.000Z');
  assert.equal(entry.etag, 'etag-1');
  assert.equal(entry.changedAt, null);
});

test('CREATED beats the revision stamp when the client wrote one', () => {
  const { events } = taskEvents(
    [todo({ createdAt: new Date('2026-09-01T09:00:00Z') })],
    LIST,
    {},
    { now: NOW }
  );

  assert.equal(events[0].at.toISOString(), '2026-09-01T09:00:00.000Z');
});

test('a task with no stamps at all is dated by when we first saw it', () => {
  // The only date anybody has. Rare: every VTODO from a real client has a
  // DTSTAMP.
  const { events } = taskEvents([todo({ stampAt: null, createdAt: null })], LIST, {}, { now: NOW });

  assert.equal(events[0].at.toISOString(), NOW.toISOString());
});

test('a task we already know, unchanged, is still one Added row and no more', () => {
  // The row is derived from the ledger, not emitted once and forgotten: a row
  // that vanished on the next load would be worse than no row -- and with two
  // viewers, whoever refreshed first would be the only one ever told.
  const todos = [todo()];
  const ledger = ledgerAfter(todos);

  const { events, updates } = taskEvents(todos, LIST, ledger, { now: NOW });

  assert.deepEqual(kinds(events), ['task-added']);
  assert.equal(events[0].at.toISOString(), '2026-09-05T08:00:00.000Z');
  assert.deepEqual(Object.keys(updates), [], 'and nothing new to write down');
});

test('an Added row keeps its date even after the task is edited', () => {
  const ledger = ledgerAfter([todo()]);
  const edited = [
    todo({ stampAt: new Date('2026-09-06T19:00:00Z'), etag: 'etag-2' }),
  ];

  const { events } = taskEvents(edited, LIST, ledger, { now: NOW });
  const added = events.find((e) => e.kind === 'task-added');

  assert.equal(added.at.toISOString(), '2026-09-05T08:00:00.000Z', 'frozen at first sighting');
});

// --- finished --------------------------------------------------------------

test('a finished task is Finished, dated by COMPLETED', () => {
  const done = todo({
    isCompleted: true,
    status: 'COMPLETED',
    completedAt: new Date('2026-09-06T16:12:00Z'),
    stampAt: new Date('2026-09-06T16:12:00Z'),
  });

  const { events } = taskEvents([done], LIST, ledgerAfter([todo()]), { now: NOW });
  const finished = events.find((e) => e.kind === 'task-finished');

  assert.equal(finished.label, 'Finished');
  assert.equal(finished.at.toISOString(), '2026-09-06T16:12:00.000Z');
});

test('ticking a task off is one row, not a Finished and a Changed a second apart', () => {
  // The whole reason CHANGE_TOLERANCE_MS exists: completing a task rewrites
  // DTSTAMP to the COMPLETED instant, so the ledger sees the stamp move too.
  const ledger = ledgerAfter([todo()]);
  const at = new Date('2026-09-06T16:12:00Z');
  const done = todo({
    isCompleted: true,
    completedAt: at,
    stampAt: new Date(at.getTime() + 30_000),
    etag: 'etag-2',
  });

  const { events } = taskEvents([done], LIST, ledger, { now: NOW });

  assert.deepEqual(kinds(events), ['task-added', 'task-finished']);
});

test('a task created and finished in the same minute is only Finished', () => {
  const at = new Date('2026-09-06T16:12:00Z');
  const done = todo({ isCompleted: true, completedAt: at, stampAt: at });

  const { events } = taskEvents([done], LIST, {}, { now: NOW });

  assert.deepEqual(kinds(events), ['task-finished'], 'one piece of news, not two');
});

test('a task marked done with no COMPLETED stamp is not dated by guesswork', () => {
  // STATUS:COMPLETED or PERCENT-COMPLETE:100 with no COMPLETED line: we know it
  // is done, and we do not know when.
  const done = todo({ isCompleted: true, status: 'COMPLETED', completedAt: null });

  const { events } = taskEvents([done], LIST, {}, { now: NOW });

  assert.deepEqual(kinds(events), ['task-added']);
});

// --- changed ---------------------------------------------------------------

test('a stamp that has moved since we last looked is Changed, at the new stamp', () => {
  const ledger = ledgerAfter([todo()]);
  const edited = [todo({ stampAt: new Date('2026-09-06T19:00:00Z'), etag: 'etag-2' })];

  const { events, updates } = taskEvents(edited, LIST, ledger, { now: NOW });
  const changed = events.find((e) => e.kind === 'task-changed');

  assert.equal(changed.label, 'Changed');
  assert.equal(changed.at.toISOString(), '2026-09-06T19:00:00.000Z');
  assert.equal(updates[ledgerKey('school-tasks', 'task-1')].changedAt, '2026-09-06T19:00:00.000Z');
});

test('an ETag that has moved is Changed too, even with the stamp standing still', () => {
  // Some clients edit a task without touching DTSTAMP. The ETag is then the
  // only thing that says anything happened.
  const ledger = ledgerAfter([todo()]);
  const edited = [todo({ etag: 'etag-2' })];

  const { events } = taskEvents(edited, LIST, ledger, { now: NOW });

  assert.deepEqual(kinds(events), ['task-added', 'task-changed']);
  // The stamp did not move, so the only date left is when we noticed.
  assert.equal(events.find((e) => e.kind === 'task-changed').at.toISOString(), NOW.toISOString());
});

test('only the latest Changed is shown, so a much-edited task is one row', () => {
  let ledger = ledgerAfter([todo()]);
  for (const [stamp, etag] of [
    ['2026-09-06T09:00:00Z', 'etag-2'],
    ['2026-09-06T12:00:00Z', 'etag-3'],
    ['2026-09-06T19:00:00Z', 'etag-4'],
  ]) {
    const pass = taskEvents([todo({ stampAt: new Date(stamp), etag })], LIST, ledger, { now: NOW });
    ledger = { ...ledger, ...pass.updates };
  }

  const { events } = taskEvents(
    [todo({ stampAt: new Date('2026-09-06T19:00:00Z'), etag: 'etag-4' })],
    LIST,
    ledger,
    { now: NOW }
  );

  assert.deepEqual(kinds(events), ['task-added', 'task-changed']);
  assert.equal(events.find((e) => e.kind === 'task-changed').at.toISOString(), '2026-09-06T19:00:00.000Z');
});

test('an edit within a minute of the task appearing is not a second row', () => {
  const ledger = ledgerAfter([todo()]);
  const saved_again = [
    todo({ stampAt: new Date(Date.parse('2026-09-05T08:00:00Z') + CHANGE_TOLERANCE_MS), etag: 'etag-2' }),
  ];

  const { events } = taskEvents(saved_again, LIST, ledger, { now: NOW });

  assert.deepEqual(kinds(events), ['task-added']);
});

test('a field the ledger never recorded is adopted quietly, not announced', () => {
  // An entry written before ETags were kept, or a server that reports none:
  // "we did not know" is not news.
  const ledger = {
    [ledgerKey('school-tasks', 'task-1')]: {
      firstSeenAt: '2026-09-05T08:00:00.000Z',
      addedAt: '2026-09-05T08:00:00.000Z',
      stampAt: null,
      etag: null,
      changedAt: null,
      lastSeenAt: new Date(NOW).toISOString(),
    },
  };

  const { events, updates } = taskEvents([todo()], LIST, ledger, { now: NOW });

  assert.deepEqual(kinds(events), ['task-added']);
  assert.equal(updates[ledgerKey('school-tasks', 'task-1')].etag, 'etag-1', 'but it is written down');
});

// --- silence ---------------------------------------------------------------

test('a cancelled task says nothing at all', () => {
  const called_off = todo({ isCancelled: true, status: 'CANCELLED', due: new Date('2026-09-12') });

  const { events, updates } = taskEvents([called_off], LIST, {}, { now: NOW });

  assert.deepEqual(events, [], 'the task pages leave it out of both sections; so does this');
  assert.deepEqual(Object.keys(updates), []);
  assert.deepEqual(upcomingTasks([called_off], LIST, { now: NOW }), []);
  assert.equal(undatedOpenCount([called_off]), 0);
});

test('a task with no UID is passed over rather than half-remembered', () => {
  const { events, updates } = taskEvents([todo({ uid: null })], LIST, {}, { now: NOW });

  assert.deepEqual(events, []);
  assert.deepEqual(Object.keys(updates), []);
});

test('a task that has gone missing is not mentioned, and not forgotten', () => {
  // Deleted, unshared, or in a list whose REPORT failed today -- we cannot tell
  // which, so the ledger keeps it (the store's 90-day prune is what ends it)
  // and the page says nothing.
  const ledger = ledgerAfter([todo()]);

  const { events, updates } = taskEvents([], LIST, ledger, { now: NOW });

  assert.deepEqual(events, []);
  assert.deepEqual(Object.keys(updates), []);
});

// --- what the ledger is rewritten for --------------------------------------

test('lastSeenAt is refreshed a day at a time, not on every load', () => {
  // It exists for the 90-day prune and nothing else, so rewriting the whole
  // ledger on every page load would be work nobody reads.
  const todos = [todo()];
  const ledger = ledgerAfter(todos);

  const soon = new Date(NOW.getTime() + SEEN_REFRESH_MS - 1_000);
  assert.deepEqual(Object.keys(taskEvents(todos, LIST, ledger, { now: soon }).updates), []);

  const tomorrow = new Date(NOW.getTime() + SEEN_REFRESH_MS + 1_000);
  const entry = taskEvents(todos, LIST, ledger, { now: tomorrow }).updates[
    ledgerKey('school-tasks', 'task-1')
  ];
  assert.equal(entry.lastSeenAt, tomorrow.toISOString());
});

// --- what is coming up -----------------------------------------------------

/** An open task due on a date-only day. */
function due(summary, isoDay, extra = {}) {
  return todo({
    uid: `uid-${summary}`,
    summary,
    due: new Date(`${isoDay}T00:00:00Z`),
    dueIsDate: true,
    ...extra,
  });
}

test('upcoming tasks run furthest-away first, so the soonest sits nearest Today', () => {
  const now = new Date('2026-09-07T15:00:00'); // local
  const todos = [
    due('Tomorrow', '2026-09-08'),
    due('Next week', '2026-09-14'),
    due('Late', '2026-09-04'),
    due('Today', '2026-09-07'),
  ];

  const rows = upcomingTasks(todos, LIST, { now });

  assert.deepEqual(
    rows.map((r) => r.task.summary),
    ['Next week', 'Tomorrow', 'Today', 'Late'],
    'the block sits ABOVE the line, so it reads down towards now'
  );
  // Overdue last: directly above the line, which is where the eye lands.
  assert.deepEqual(
    rows.map((r) => r.overdue),
    [false, false, false, true]
  );
  assert.equal(rows.at(-1).dueLabel, 'Was due Fri, Sep 4');
  assert.equal(rows.find((r) => r.task.summary === 'Tomorrow').dueLabel, 'Due tomorrow');
});

test('upcoming tasks say which list they came from, and where to tap', () => {
  const [row] = upcomingTasks([due('Essay', '2026-09-20')], LIST, { now: NOW });

  assert.equal(row.kind, 'task-due');
  assert.equal(row.task.name, 'School Tasks');
  assert.equal(row.task.href, '/tasks/school-tasks');
  assert.equal(row.at.toISOString(), '2026-09-20T00:00:00.000Z');
});

test('a floating due time is ordered by the clock on the wall, not by UTC', () => {
  // A date-only DUE is a calendar day pinned to UTC midnight; a timed one is a
  // real instant read locally. Comparing the raw instants sorts by two
  // different clocks and the page contradicts its own labels.
  const now = new Date('2026-09-07T15:00:00');
  const timed = todo({
    uid: 'timed',
    summary: 'At 1pm',
    due: new Date('2026-09-09T17:00:00Z'), // 1pm in America/New_York
    dueIsDate: false,
  });
  const wholeDay = due('All of that day', '2026-09-09');

  const rows = upcomingTasks([timed, wholeDay], LIST, { now });

  assert.deepEqual(
    rows.map((r) => r.task.summary),
    ['All of that day', 'At 1pm'],
    'a whole-day task names no hour, so it sits at the top of its day'
  );
  assert.equal(rows[1].dueLabel, 'Due Wed, Sep 9 at 1:00 PM');
});

test('finished and undated tasks are not on the timeline above the line', () => {
  const todos = [
    due('Done', '2026-09-20', { isCompleted: true, completedAt: new Date('2026-09-06T12:00:00Z') }),
    todo({ uid: 'undated', summary: 'Read chapter 4' }),
    due('Open', '2026-09-20'),
  ];

  assert.deepEqual(
    upcomingTasks(todos, LIST, { now: NOW }).map((r) => r.task.summary),
    ['Open']
  );
});

test('undatedOpenCount counts the open tasks with nowhere on the axis to be', () => {
  const todos = [
    todo({ uid: 'a', summary: 'One' }),
    todo({ uid: 'b', summary: 'Two' }),
    due('Dated', '2026-09-20'),
    todo({ uid: 'c', summary: 'Done', isCompleted: true, completedAt: NOW }),
    todo({ uid: 'd', summary: 'Called off', isCancelled: true }),
  ];

  assert.equal(undatedOpenCount(todos), 2);
  assert.equal(undatedOpenCount([]), 0);
  assert.equal(undatedOpenCount(undefined), 0);
});

test('every function copes with a list that came back empty', () => {
  const { events, updates } = taskEvents(undefined, LIST, undefined, { now: NOW });
  assert.deepEqual(events, []);
  assert.deepEqual(Object.keys(updates), []);
  assert.deepEqual(upcomingTasks(undefined, LIST, { now: NOW }), []);
});
