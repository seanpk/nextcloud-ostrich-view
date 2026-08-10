// Due dates that carry a time are formatted in the server's local zone, so the
// suite pins that zone before anything reads a Date. (Node re-reads TZ on the
// next date operation, so this must happen before the imports run any.)
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accentClassFor,
  formatCompletedLabel,
  formatDueLabel,
  isOverdue,
  toTaskView,
  toTaskViews,
} from '../../src/lib/tasks.js';

const NOW = new Date('2026-08-09T15:00:00Z');

test('formatDueLabel: the friendly form for a plain calendar day', () => {
  const due = new Date('2026-08-12T00:00:00Z');
  assert.equal(formatDueLabel(due, { isDate: true, now: NOW }), 'Due Wed, Aug 12');
});

test('formatDueLabel: today and tomorrow are named, not dated', () => {
  assert.equal(
    formatDueLabel(new Date('2026-08-09T00:00:00Z'), { isDate: true, now: NOW }),
    'Due today'
  );
  assert.equal(
    formatDueLabel(new Date('2026-08-10T00:00:00Z'), { isDate: true, now: NOW }),
    'Due tomorrow'
  );
});

test('formatDueLabel: a date already gone by says so in plain words', () => {
  assert.equal(
    formatDueLabel(new Date('2026-08-08T00:00:00Z'), { isDate: true, now: NOW }),
    'Was due yesterday'
  );
  assert.equal(
    formatDueLabel(new Date('2026-08-03T00:00:00Z'), { isDate: true, now: NOW }),
    'Was due Mon, Aug 3'
  );
});

test('formatDueLabel: another year is spelled out; this year is not', () => {
  assert.equal(
    formatDueLabel(new Date('2027-01-04T00:00:00Z'), { isDate: true, now: NOW }),
    'Due Mon, Jan 4, 2027'
  );
});

test('formatDueLabel: a due date with a time shows the time too', () => {
  assert.equal(
    formatDueLabel(new Date('2026-08-20T21:00:00Z'), { isDate: false, now: NOW }),
    'Due Thu, Aug 20 at 9:00 PM'
  );
});

test('formatDueLabel: a date-only due is read in UTC, so it never slips a day', () => {
  // 2026-08-12 UTC midnight is 2026-08-11 20:00 in New York. Formatting it
  // locally would show "Aug 11" and quietly make the owner a day early.
  const due = new Date(Date.UTC(2026, 7, 12));
  assert.match(formatDueLabel(due, { isDate: true, now: NOW }), /Aug 12/);
});

test('formatDueLabel: no due date at all has no label', () => {
  assert.equal(formatDueLabel(null, { now: NOW }), null);
  assert.equal(formatDueLabel(new Date('nonsense'), { now: NOW }), null);
});

test('isOverdue: a task due today is not late yet', () => {
  assert.equal(isOverdue(new Date('2026-08-09T00:00:00Z'), { isDate: true, now: NOW }), false);
  assert.equal(isOverdue(new Date('2026-08-08T00:00:00Z'), { isDate: true, now: NOW }), true);
  assert.equal(isOverdue(null, { now: NOW }), false);
});

test('isOverdue: a time earlier today is not late either -- the label says "today"', () => {
  // 9am today, read at 3pm. Styling this red while its own label reads
  // "Due today at 9:00 AM" is the page arguing with itself.
  const thisMorning = new Date('2026-08-09T09:00:00Z');
  assert.equal(formatDueLabel(thisMorning, { isDate: false, now: NOW }), 'Due today at 9:00 AM');
  assert.equal(isOverdue(thisMorning, { isDate: false, now: NOW }), false);

  // Yesterday evening is genuinely past, whatever time it named.
  assert.equal(isOverdue(new Date('2026-08-08T23:00:00Z'), { isDate: false, now: NOW }), true);
});

test('formatCompletedLabel: newest days are named, older ones dated', () => {
  assert.equal(formatCompletedLabel(new Date('2026-08-09T09:00:00Z'), { now: NOW }), 'Finished today');
  assert.equal(
    formatCompletedLabel(new Date('2026-08-08T09:00:00Z'), { now: NOW }),
    'Finished yesterday'
  );
  assert.equal(
    formatCompletedLabel(new Date('2026-08-04T08:15:00Z'), { now: NOW }),
    'Finished Tue, Aug 4'
  );
  assert.equal(formatCompletedLabel(null, { now: NOW }), null);
});

test('toTaskView: an open task carries everything the page shows', () => {
  const view = toTaskView(
    {
      uid: 'task-1',
      summary: 'Write the essay',
      description: 'Part one\nPart two',
      due: new Date('2026-08-12T00:00:00Z'),
      dueIsDate: true,
      priority: 1,
      percentComplete: 40,
      completedAt: null,
      isCompleted: false,
      children: [],
    },
    { now: NOW }
  );

  assert.equal(view.dueLabel, 'Due Wed, Aug 12');
  assert.equal(view.overdue, false);
  assert.equal(view.description, 'Part one\nPart two');
  assert.equal(view.progressLabel, '40% done');
  assert.equal(view.isImportant, true);
  assert.equal(view.doneLabel, null);
  assert.equal(view.depth, 0);
});

test('toTaskView: a finished task shows when, not when it was due', () => {
  const view = toTaskView(
    {
      uid: 'task-2',
      summary: 'Hand in the slip',
      due: new Date('2026-08-01T00:00:00Z'),
      dueIsDate: true,
      completedAt: new Date('2026-08-01T12:00:00Z'),
      percentComplete: 100,
      priority: 1,
      isCompleted: true,
      children: [],
    },
    { now: NOW }
  );

  assert.equal(view.doneLabel, 'Finished Sat, Aug 1');
  assert.equal(view.dueLabel, null);
  assert.equal(view.overdue, false, 'finished work is never late');
  assert.equal(view.isImportant, false);
  assert.equal(view.progressLabel, null);
});

test('toTaskViews: subtasks keep their nesting and gain a depth', () => {
  const [parent] = toTaskViews(
    [
      {
        uid: 'p',
        summary: 'Parent',
        due: null,
        isCompleted: false,
        children: [
          { uid: 'c', summary: 'Child', due: null, isCompleted: false, children: [] },
        ],
      },
    ],
    { now: NOW }
  );

  assert.equal(parent.depth, 0);
  assert.equal(parent.children[0].summary, 'Child');
  assert.equal(parent.children[0].depth, 1);
});

test('accentClassFor: buckets a calendar colour into a class we actually ship', () => {
  assert.equal(accentClassFor('#1c4f8b'), 'tile--accent-blue');
  assert.equal(accentClassFor('#2f7a3f'), 'tile--accent-green');
  assert.equal(accentClassFor('#b3352f'), 'tile--accent-red');
  assert.equal(accentClassFor('#888888'), 'tile--accent-slate');
});

test('accentClassFor: anything that is not a plain hex colour is dropped', () => {
  // It ends up in a class attribute, so nothing unvetted may pass through.
  assert.equal(accentClassFor(null), null);
  assert.equal(accentClassFor('red'), null);
  assert.equal(accentClassFor('#fff'), null);
  assert.equal(accentClassFor('#1c4f8b" onload="x'), null);
});
