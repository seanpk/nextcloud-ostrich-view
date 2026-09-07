import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStream,
  buildTimeline,
  createTtlCache,
  fileEvents,
  folderLabelFor,
  formatVisitLabel,
  STREAM_CACHE_TTL_MS,
} from '../../src/lib/stream.js';

/**
 * The stream's view-model.
 *
 * Everything here is a pure function of (entries, previous visit, clock), which
 * is the whole reason the wording, the day grouping and the New badges can be
 * pinned down without a Nextcloud or a browser in sight.
 */

/** A parseMultistatus-shaped entry, the way search.js hands them over. */
function entry(path, overrides = {}) {
  return {
    name: path.split('/').pop(),
    path,
    isFolder: false,
    fileId: 110001,
    etag: 'abc123',
    lastModified: new Date('2026-08-08T10:00:00.000Z'),
    contentType: 'image/png',
    size: 1024,
    ...overrides,
  };
}

/** A local-time Date, so day grouping is asserted in the zone the page uses. */
function at(iso) {
  return new Date(iso);
}

/** A bare event, for the kind-agnostic assertions. */
function event(iso, kind = 'file') {
  return { kind, at: at(iso), tile: { name: iso }, folderLabel: 'Files' };
}

const NOW = at('2026-08-09T20:00:00');

test('folderLabelFor: names the containing folder, not the file', () => {
  assert.equal(folderLabelFor('Biology 101/Lectures/Week 2.pdf'), 'Biology 101 › Lectures');
  assert.equal(folderLabelFor('Biology 101/syllabus.pdf'), 'Biology 101');
});

test('folderLabelFor: a file shared at the top level says Files, like the breadcrumb', () => {
  assert.equal(folderLabelFor('welcome.txt'), 'Files');
});

test('fileEvents: an event carries an ordinary tile plus where the file lives', () => {
  const [made] = fileEvents([
    entry('Biology 101/Lab Reports/microscope.png', { lastModified: at('2026-08-09T15:40:00') }),
  ]);

  assert.equal(made.kind, 'file');
  assert.equal(made.at.getTime(), at('2026-08-09T15:40:00').getTime());
  assert.equal(made.folderLabel, 'Biology 101 › Lab Reports');
  assert.equal(made.tile.name, 'microscope.png');
  // Exactly what a folder listing would produce for the same file.
  assert.equal(made.tile.href, '/view/Biology%20101/Lab%20Reports/microscope.png');
  assert.equal(made.tile.previewUrl, '/preview/110001?v=abc123&k=image');
});

test('fileEvents: a file we cannot open inline is still an event, just not a link', () => {
  const [made] = fileEvents([
    entry('notes.txt', { contentType: 'text/plain', fileId: 42, etag: 'ff00' }),
  ]);

  assert.equal(made.tile.href, null);
  assert.equal(made.tile.previewUrl, null);
  assert.equal(made.folderLabel, 'Files');
});

test('fileEvents: an entry with no usable date is dropped, not guessed at', () => {
  // The page is ordered and grouped by time; a row with no time has nowhere to
  // go on it.
  assert.deepEqual(fileEvents([entry('x.png', { lastModified: null })]), []);
  assert.deepEqual(fileEvents([entry('x.png', { lastModified: new Date('nope') })]), []);
  assert.deepEqual(fileEvents([]), []);
  assert.deepEqual(fileEvents(undefined), []);
});

// --- Grouping ---------------------------------------------------------------

test('buildStream: rows are grouped by day, newest day first', () => {
  const { days } = buildStream(
    [
      event('2026-08-09T09:00:00'),
      event('2026-08-08T21:00:00'),
      event('2026-08-09T15:40:00'),
      event('2026-08-05T11:00:00'),
    ],
    { now: NOW }
  );

  assert.deepEqual(
    days.map((day) => day.label),
    ['Today', 'Yesterday', 'Wed, Aug 5']
  );
  // And inside a day, newest first.
  assert.deepEqual(
    days[0].items.map((item) => item.timeLabel),
    ['3:40 PM', '9:00 AM']
  );
});

test('buildStream: the day boundary is midnight in the process zone', () => {
  // A minute either side of local midnight belongs to different days, and the
  // page must say so in the household's terms rather than UTC's.
  const { days } = buildStream(
    [event('2026-08-09T00:01:00'), event('2026-08-08T23:59:00')],
    { now: NOW }
  );

  assert.deepEqual(
    days.map((day) => day.label),
    ['Today', 'Yesterday']
  );
  assert.equal(days[0].items.length, 1);
  assert.equal(days[1].items.length, 1);
});

test('buildStream: a year-old day is named with its year, or it is a riddle', () => {
  const { days } = buildStream([event('2025-08-09T09:00:00')], { now: NOW });
  assert.equal(days.at(-1).label, 'Sat, Aug 9, 2025');
});

test('buildStream: there is always a Today group, empty when nothing happened today', () => {
  // The #today anchor has to exist on a quiet day too -- it is what /#today
  // means, and what the block of what-is-coming stacks on top of.
  const { days } = buildStream([event('2026-08-08T21:00:00')], { now: NOW });

  assert.deepEqual(
    days.map((day) => day.label),
    ['Today', 'Yesterday']
  );
  assert.deepEqual(days[0].items, [], 'a bare divider, not a row');
  assert.equal(days[0].isToday, true);
  assert.equal(days[1].isToday, false);
});

test('buildStream: an empty stream is still a Today line and nothing else', () => {
  const { days, newCount, moreLabel, total } = buildStream([], { now: NOW });

  assert.equal(days.length, 1);
  assert.equal(days[0].isToday, true);
  assert.deepEqual(days[0].items, []);
  assert.equal(newCount, 0);
  assert.equal(moreLabel, null);
  assert.equal(total, 0);
});

test('buildStream: exactly one group is ever marked today', () => {
  const { days } = buildStream(
    [event('2026-08-09T09:00:00'), event('2026-08-09T15:00:00')],
    { now: NOW }
  );

  assert.equal(days.filter((day) => day.isToday).length, 1);
  assert.equal(days[0].items.length, 2, 'both of today’s rows are in the one group');
});

test('buildStream: a stamp in the future sits above the Today line, not inside it', () => {
  // A clock that jumped: a file cannot really be modified tomorrow. Either
  // way, "Tomorrow"
  // is not today, and the Today divider belongs underneath it.
  const { days } = buildStream(
    [event('2026-08-10T09:00:00'), event('2026-08-08T09:00:00')],
    { now: NOW }
  );

  assert.deepEqual(
    days.map((day) => day.label),
    ['Tomorrow', 'Today', 'Yesterday']
  );
  assert.deepEqual(days[1].items, []);
});

// --- New badges -------------------------------------------------------------

test('buildStream: rows newer than the previous sitting are marked New', () => {
  const previousVisitAt = at('2026-08-09T08:00:00');
  const { days, newCount } = buildStream(
    [
      event('2026-08-09T15:40:00'),
      event('2026-08-09T07:00:00'),
      event('2026-08-01T07:00:00'),
    ],
    { now: NOW, previousVisitAt }
  );

  assert.equal(newCount, 1);
  assert.deepEqual(
    days[0].items.map((item) => item.isNew),
    [true, false]
  );
  assert.equal(days.at(-1).items[0].isNew, false);
});

test('buildStream: a row exactly at the previous sitting is not new', () => {
  const previousVisitAt = at('2026-08-09T08:00:00');
  const { newCount } = buildStream([event('2026-08-09T08:00:00')], { now: NOW, previousVisitAt });
  assert.equal(newCount, 0, 'strictly newer, the same rule the search filter used');
});

test('buildStream: a first-ever visit gets the rows and no badges at all', () => {
  const events = [event('2026-08-09T15:40:00'), event('2026-08-08T09:00:00')];

  for (const previousVisitAt of [null, undefined, '', 'not a date']) {
    const { days, newCount } = buildStream(events, { now: NOW, previousVisitAt });

    assert.equal(newCount, 0, `previousVisitAt ${JSON.stringify(previousVisitAt)}`);
    assert.ok(
      days.flatMap((day) => day.items).every((item) => item.isNew === false),
      'no baseline means nothing can be newer than it -- but the list is still there'
    );
    assert.equal(days.flatMap((day) => day.items).length, 2, 'which is the point of the page');
  }
});

test('buildStream: the previous sitting is accepted as the ISO string the store hands back', () => {
  const { newCount } = buildStream([event('2026-08-09T15:40:00')], {
    now: NOW,
    previousVisitAt: at('2026-08-09T08:00:00').toISOString(),
  });
  assert.equal(newCount, 1);
});

// --- Mixed kinds ------------------------------------------------------------

test('buildStream: events of any kind interleave by time alone', () => {
  const { days } = buildStream(
    [
      event('2026-08-09T09:00:00', 'file'),
      event('2026-08-09T16:00:00', 'task-finished'),
      event('2026-08-09T12:00:00', 'file'),
    ],
    { now: NOW, previousVisitAt: at('2026-08-09T10:00:00') }
  );

  assert.deepEqual(
    days[0].items.map((item) => item.kind),
    ['task-finished', 'file', 'file']
  );
  // And the badge rule knows nothing about kinds either.
  assert.deepEqual(
    days[0].items.map((item) => item.isNew),
    [true, true, false]
  );
});

// --- Bounds and the honest "there is more" line ------------------------------

test('buildStream: the limit drops the oldest, never the newest', () => {
  const events = Array.from({ length: 5 }, (_, i) =>
    event(`2026-08-0${i + 1}T09:00:00`)
  );

  const { days, total } = buildStream(events, { now: NOW, limit: 2 });
  const kept = days.flatMap((day) => day.items).map((item) => item.at.getDate());

  assert.deepEqual(kept, [5, 4]);
  assert.equal(total, 5, 'total is what we were handed, not what fitted');
});

test('buildStream: a full fetch says the history goes further back than the page', () => {
  const events = Array.from({ length: 50 }, () => event('2026-08-09T09:00:00'));
  const { moreLabel } = buildStream(events, { now: NOW, limit: 50, fetchLimit: 50 });

  assert.equal(moreLabel, "Older changes aren’t listed here.");
});

test('buildStream: a short list that is all there is says nothing extra', () => {
  const { moreLabel } = buildStream([event('2026-08-09T09:00:00')], {
    now: NOW,
    limit: 50,
    fetchLimit: 50,
  });
  assert.equal(moreLabel, null, 'there is nothing to warn about, so no line');
});

test('buildStream: a walk that hit its bounds says so however short the list', () => {
  const { moreLabel } = buildStream([event('2026-08-09T09:00:00')], {
    now: NOW,
    fetchLimit: 50,
    truncated: true,
  });

  assert.equal(
    moreLabel,
    "Older changes aren’t listed here.",
    'whole subtrees went unvisited: a short list must not imply "that is everything"'
  );
});

test('buildStream: a truncated walk that found nothing still says so', () => {
  // Different from the old "…and more besides" rule, deliberately. This line is
  // about the SHAPE of the page ("this is a window, not the archive"), not about
  // rows that did not fit, so it is worth saying even above an empty list --
  // "Nothing has changed yet" on its own would be a claim we cannot make.
  const { days, moreLabel } = buildStream([], { now: NOW, fetchLimit: 50, truncated: true });

  assert.deepEqual(days[0].items, []);
  assert.equal(moreLabel, "Older changes aren’t listed here.");
});

// --- Above the line: what is coming ------------------------------------------

/** An upcomingTasks-shaped row: what matters here is `order.day`. */
function upcomingRow(summary, civilDay, extra = {}) {
  return {
    kind: 'task-due',
    at: new Date(civilDay),
    dueLabel: 'Due whenever',
    overdue: false,
    task: { name: 'School Tasks', summary, href: '/tasks/school-tasks' },
    order: { day: civilDay, time: Number.POSITIVE_INFINITY },
    ...extra,
  };
}

/** The civil day `days` from NOW's day, as upcomingTasks computes it. */
function dayFromNow(days) {
  const base = Date.UTC(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  return base + days * 86_400_000;
}

test('buildTimeline: what is coming is grouped by day, furthest away first', () => {
  const { future, days } = buildTimeline({
    upcoming: [
      upcomingRow('Next week', dayFromNow(6)),
      upcomingRow('Tomorrow', dayFromNow(1)),
      upcomingRow('Also tomorrow', dayFromNow(1)),
      upcomingRow('This afternoon', dayFromNow(0)),
    ],
    history: buildStream([event('2026-08-09T09:00:00')], { now: NOW }),
    now: NOW,
  });

  // Every heading here says "Due", and none of the history's do: that is what
  // tells a reader moving heading to heading which side of the line they are on.
  assert.deepEqual(
    future.map((group) => group.label),
    ['Due Sat, Aug 15', 'Due tomorrow', 'Due today']
  );
  // Two tasks due the same day share one heading.
  assert.deepEqual(
    future[1].items.map((item) => item.task.summary),
    ['Tomorrow', 'Also tomorrow']
  );
  // "Due today", not "Today": the Today line is the divider below this block,
  // and two headings reading Today would make the axis unreadable.
  assert.ok(!future.some((group) => group.label === 'Today'));
  // The history is handed through untouched, anchor and all.
  assert.ok(days.some((day) => day.isToday));
});

test('buildTimeline: everything late shares one Overdue group, right above the line', () => {
  const { future } = buildTimeline({
    upcoming: [
      upcomingRow('Tomorrow', dayFromNow(1)),
      upcomingRow('Was due yesterday', dayFromNow(-1), { overdue: true }),
      upcomingRow('Was due last week', dayFromNow(-8), { overdue: true }),
    ],
    history: buildStream([], { now: NOW }),
    now: NOW,
  });

  assert.deepEqual(
    future.map((group) => group.label),
    ['Due tomorrow', 'Overdue']
  );
  assert.equal(future.at(-1).isOverdue, true);
  assert.deepEqual(
    future.at(-1).items.map((item) => item.task.summary),
    ['Was due yesterday', 'Was due last week'],
    'in the order they were handed over: nearest the line first'
  );
});

test('buildTimeline: a due date next year is named with its year', () => {
  const { future } = buildTimeline({
    upcoming: [upcomingRow('Far off', Date.UTC(2027, 0, 20))],
    history: buildStream([], { now: NOW }),
    now: NOW,
  });

  assert.equal(future[0].label, 'Due Wed, Jan 20, 2027');
});

test('buildTimeline: with nothing coming up, there is no block above the line', () => {
  const { future, undated, moreUpcomingLabel } = buildTimeline({
    upcoming: [],
    history: buildStream([event('2026-08-09T09:00:00')], { now: NOW }),
    now: NOW,
  });

  assert.deepEqual(future, []);
  assert.equal(undated, null);
  assert.equal(moreUpcomingLabel, null);
});

// --- the twisty above the line ---------------------------------------------

/** A row as `undatedTasks` hands it over. */
function undatedRow(summary, extra = {}) {
  return {
    kind: 'task-undated',
    dueLabel: 'No due date',
    task: { name: 'School Tasks', summary, slug: 'school-tasks', href: '/tasks/school-tasks' },
    ...extra,
  };
}

test('buildTimeline: the twisty is counted out loud, and pluralized', () => {
  const label = (count) =>
    buildTimeline({
      history: buildStream([], { now: NOW }),
      undated: Array.from({ length: count }, (_, i) => undatedRow(`Task ${i}`)),
      now: NOW,
    }).undated?.label ?? null;

  assert.equal(label(1), 'Also 1 task without a due date');
  assert.equal(label(17), 'Also 17 tasks without a due date');
  // Nothing to say, so nothing is said -- not "Also 0 tasks", and no lid over
  // an empty box.
  assert.equal(label(0), null);
});

test('buildTimeline: the twisty holds the rows it was given, in the order given', () => {
  const rows = [undatedRow('Empty the dishwasher'), undatedRow('Read chapter 4')];

  const { undated } = buildTimeline({
    history: buildStream([], { now: NOW }),
    undated: rows,
    now: NOW,
  });

  assert.deepEqual(
    undated.rows.map((row) => row.task.summary),
    ['Empty the dishwasher', 'Read chapter 4'],
    'ordering is `sortUndated`\'s job, not this one\'s'
  );
  assert.equal(undated.rows[0].dueLabel, 'No due date');
});

test('buildTimeline: a twisty row is badged when its Added row below the line is', () => {
  // The badge rule reads `at`, which an undated row has not got -- so the
  // twisty borrows the answer the history already came to, matched by list and
  // UID rather than by name.
  const added = (uid, summary, iso, slug = 'school-tasks') => ({
    kind: 'task-added',
    at: at(iso),
    label: 'Added',
    task: { name: 'School Tasks', summary, slug, uid, href: `/tasks/${slug}` },
  });

  const history = buildStream(
    [
      added('uid-new', 'Turned up today', '2026-08-09T09:00:00'),
      added('uid-old', 'Been there for weeks', '2026-07-01T09:00:00'),
    ],
    { previousVisitAt: at('2026-08-08T20:00:00'), now: NOW }
  );

  const { undated } = buildTimeline({
    history,
    undated: [
      undatedRow('Turned up today', {
        task: { name: 'School Tasks', summary: 'Turned up today', slug: 'school-tasks', uid: 'uid-new', href: '/tasks/school-tasks' },
      }),
      undatedRow('Been there for weeks', {
        task: { name: 'School Tasks', summary: 'Been there for weeks', slug: 'school-tasks', uid: 'uid-old', href: '/tasks/school-tasks' },
      }),
      // Same summary, different list: it must not catch the other one's badge.
      undatedRow('Turned up today', {
        task: { name: 'Chores', summary: 'Turned up today', slug: 'chores', uid: 'uid-new', href: '/tasks/chores' },
      }),
    ],
    now: NOW,
  });

  assert.deepEqual(
    undated.rows.map((row) => [row.task.slug, row.isNew]),
    [
      ['school-tasks', true],
      ['school-tasks', false],
      ['chores', false],
    ]
  );
});

test('buildTimeline: with no previous sitting, nothing in the twisty is badged', () => {
  const history = buildStream(
    [
      {
        kind: 'task-added',
        at: at('2026-08-09T09:00:00'),
        label: 'Added',
        task: { name: 'School Tasks', summary: 'Anything', slug: 'school-tasks', uid: 'uid-1', href: '/tasks/school-tasks' },
      },
    ],
    { now: NOW }
  );

  const { undated } = buildTimeline({
    history,
    undated: [
      undatedRow('Anything', {
        task: { name: 'School Tasks', summary: 'Anything', slug: 'school-tasks', uid: 'uid-1', href: '/tasks/school-tasks' },
      }),
    ],
    now: NOW,
  });

  assert.equal(undated.rows[0].isNew, false, 'a first visit badges nothing at all');
});

test('buildTimeline: a capped future block keeps the soonest and says where the rest are', () => {
  const upcoming = [
    upcomingRow('Furthest', dayFromNow(30)),
    upcomingRow('Middle', dayFromNow(10)),
    upcomingRow('Soonest', dayFromNow(1)),
  ];

  const { future, moreUpcomingLabel } = buildTimeline({
    upcoming,
    history: buildStream([], { now: NOW }),
    limit: 2,
    now: NOW,
  });

  assert.deepEqual(
    future.flatMap((group) => group.items.map((item) => item.task.summary)),
    ['Middle', 'Soonest'],
    'the rows nearest the line are the ones she came for'
  );
  assert.equal(moreUpcomingLabel, 'Later tasks are in Tasks.');
});

// --- The "when were you last here" note --------------------------------------

test('formatVisitLabel: says when, in words nobody has to decode', () => {
  const now = at('2026-08-09T20:00:00');

  assert.equal(formatVisitLabel(at('2026-08-09T07:00:00'), { now }), 'earlier today');
  assert.equal(formatVisitLabel(at('2026-08-08T21:00:00'), { now }), 'yesterday');
  assert.equal(formatVisitLabel(at('2026-08-05T21:00:00'), { now }), 'on Wed, Aug 5');
  // A year old wants the year, or "on Sat, Aug 9" would be a riddle.
  assert.equal(formatVisitLabel(at('2025-08-09T21:00:00'), { now }), 'on Sat, Aug 9, 2025');
});

test('formatVisitLabel: accepts the ISO string the store hands back', () => {
  const now = at('2026-08-09T20:00:00');
  assert.equal(formatVisitLabel(at('2026-08-08T21:00:00').toISOString(), { now }), 'yesterday');
});

test('formatVisitLabel: nothing sensible to say produces nothing', () => {
  assert.equal(formatVisitLabel(null), null);
  assert.equal(formatVisitLabel(''), null);
  assert.equal(formatVisitLabel('never'), null);
});

test('formatVisitLabel: a stamp from the future is dated, not called "earlier today"', () => {
  const now = at('2026-08-09T20:00:00');

  // A clock that jumped, or a hand-edited state file. Naming the day is honest;
  // "earlier today" would be a small lie about a stamp we know is wrong.
  assert.equal(formatVisitLabel(at('2026-08-11T09:00:00'), { now }), 'on Tue, Aug 11');
  assert.equal(formatVisitLabel(at('2027-01-02T09:00:00'), { now }), 'on Sat, Jan 2, 2027');
  // Later the same day is still today, which is the ordinary skew case.
  assert.equal(formatVisitLabel(at('2026-08-09T23:00:00'), { now }), 'earlier today');
});

// --- The cache ---------------------------------------------------------------

test('createTtlCache: the same key is answered from memory', () => {
  const cache = createTtlCache();
  const answer = { entries: [], strategy: 'search', truncated: false };

  cache.set('files', answer);

  assert.equal(cache.get('files'), answer);
  assert.equal(cache.get('tasks'), undefined, 'and one key is never answered with another');
});

test('createTtlCache: an answer goes stale, so the page is not frozen', () => {
  // The bug this exists for: the stream asks Nextcloud the identical question
  // on every load, forever. Without expiry the first answer of the process
  // would be the last one anybody ever saw.
  let clock = 1_000;
  const cache = createTtlCache({ ttlMs: 100, now: () => clock });
  const answer = { entries: [] };

  cache.set('files', answer);
  clock += 99;
  assert.equal(cache.get('files'), answer, 'a burst of refreshes still dedupes');

  clock += 1;
  assert.equal(cache.get('files'), undefined, 'and then the question gets asked again');
  assert.equal(cache.size, 0, 'the stale entry is dropped, not re-checked forever');
});

test('createTtlCache: re-setting an answer starts its life over', () => {
  let clock = 0;
  const cache = createTtlCache({ ttlMs: 100, now: () => clock });

  cache.set('files', { entries: [1] });
  clock += 100;
  assert.equal(cache.get('files'), undefined);

  cache.set('files', { entries: [2] });
  clock += 99;
  assert.deepEqual(cache.get('files'), { entries: [2] });
});

test('createTtlCache: the default window is short enough to matter', () => {
  // Long enough to swallow pull-to-refresh; far shorter than a sitting.
  assert.ok(STREAM_CACHE_TTL_MS > 0);
  assert.ok(
    STREAM_CACHE_TTL_MS <= 5 * 60_000,
    'a long window would mean a fresh upload stayed invisible for it'
  );
});

test('createTtlCache: it is a cache, not a leak', () => {
  const cache = createTtlCache({ max: 3 });

  for (let i = 0; i < 10; i += 1) cache.set(`key-${i}`, { entries: [i] });

  assert.equal(cache.size, 3);
  assert.equal(cache.get('key-0'), undefined, 'the oldest key goes first');
  assert.deepEqual(cache.get('key-9'), { entries: [9] });
});
