import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createVisitStore,
  rotateRecord,
  STATE_FILE_NAME,
  VISIT_WINDOW_MS,
} from '../../src/store/visits.js';

/**
 * The visit-rotation rules, which are the whole reason "new since you last
 * looked" survives a pull-to-refresh.
 */

const T0 = Date.parse('2026-08-09T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const madeDirs = [];
after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-visits-'));
  madeDirs.push(dir);
  return dir;
}

/** A store whose clock the test drives. */
function storeAt(dir, clock, options = {}) {
  return createVisitStore({ dir, now: () => clock.now, ...options });
}

test('rotateRecord: a first-ever visit has nothing to compare against', () => {
  const { record, changed } = rotateRecord(undefined, T0);

  assert.equal(record.currentVisitStartedAt, new Date(T0).toISOString());
  assert.equal(
    record.previousVisitStartedAt,
    null,
    'no previous stamp is what hides the section; it must not mean "everything is new"'
  );
  assert.equal(changed, true);
});

test('rotateRecord: refreshing mid-sitting moves lastSeenAt and nothing else', () => {
  const first = rotateRecord(undefined, T0).record;
  const second = rotateRecord(first, T0 + 5 * HOUR);

  assert.equal(second.record.currentVisitStartedAt, first.currentVisitStartedAt);
  assert.equal(second.record.previousVisitStartedAt, first.previousVisitStartedAt);
  assert.equal(
    second.record.lastSeenAt,
    new Date(T0 + 5 * HOUR).toISOString(),
    'the sitting is measured from her last page, not her first'
  );
  assert.equal(second.changed, true, 'lastSeenAt moved, so the file is worth rewriting');
});

test('rotateRecord: a long browse stays one sitting, however long she reads', () => {
  // Nine hours of steady reading, well past the six-hour window: measuring from
  // the sitting's START would rotate mid-browse and shrink the very list she is
  // working through.
  let record = rotateRecord(undefined, T0).record;
  const started = record.currentVisitStartedAt;

  for (let hour = 1; hour <= 9; hour += 1) {
    record = rotateRecord(record, T0 + hour * HOUR).record;
    assert.equal(record.currentVisitStartedAt, started, `rotated at hour ${hour}`);
    assert.equal(record.previousVisitStartedAt, null);
  }
});

test('rotateRecord: a record written before lastSeenAt existed still rotates', () => {
  // The migration case: state.json from an earlier deploy has two stamps only,
  // so the sitting is measured from its start, exactly as the old rule did.
  const old = {
    currentVisitStartedAt: new Date(T0).toISOString(),
    previousVisitStartedAt: null,
  };

  const stillSitting = rotateRecord(old, T0 + HOUR).record;
  assert.equal(stillSitting.currentVisitStartedAt, old.currentVisitStartedAt);
  assert.equal(stillSitting.lastSeenAt, new Date(T0 + HOUR).toISOString());

  const later = rotateRecord(old, T0 + VISIT_WINDOW_MS + 1).record;
  assert.equal(later.previousVisitStartedAt, old.currentVisitStartedAt);
});

test('rotateRecord: a gap longer than the window starts a new sitting', () => {
  const first = rotateRecord(undefined, T0).record;
  const second = rotateRecord(first, T0 + VISIT_WINDOW_MS + 1).record;

  assert.equal(second.currentVisitStartedAt, new Date(T0 + VISIT_WINDOW_MS + 1).toISOString());
  assert.equal(second.previousVisitStartedAt, first.currentVisitStartedAt);
});

test('rotateRecord: the previous stamp survives refreshes inside the new sitting', () => {
  const first = rotateRecord(undefined, T0).record;
  const second = rotateRecord(first, T0 + 24 * HOUR).record;
  // Three refreshes over the next few hours: "new since" must not empty out.
  let record = second;
  for (const offset of [1, 2, 5]) {
    record = rotateRecord(record, T0 + (24 + offset) * HOUR).record;
    assert.equal(record.previousVisitStartedAt, first.currentVisitStartedAt);
    assert.equal(record.currentVisitStartedAt, second.currentVisitStartedAt);
  }
});

test('rotateRecord: exactly at the window boundary the sitting is over', () => {
  const first = rotateRecord(undefined, T0).record;
  const atBoundary = rotateRecord(first, T0 + VISIT_WINDOW_MS).record;
  assert.equal(atBoundary.previousVisitStartedAt, first.currentVisitStartedAt);
});

test('rotateRecord: unusable stamps are treated as absent, never repaired', () => {
  const { record } = rotateRecord(
    { currentVisitStartedAt: 'sometime last week', previousVisitStartedAt: 42 },
    T0
  );
  assert.equal(record.currentVisitStartedAt, new Date(T0).toISOString());
  assert.equal(record.previousVisitStartedAt, null);
});

test('rotateRecord: a stamp a minute ahead is clock skew, and keeps the sitting', () => {
  const record = {
    currentVisitStartedAt: new Date(T0 + 60 * 1000).toISOString(),
    previousVisitStartedAt: new Date(T0 - 48 * HOUR).toISOString(),
  };
  const rotated = rotateRecord(record, T0).record;

  assert.equal(rotated.previousVisitStartedAt, record.previousVisitStartedAt);
  assert.equal(rotated.currentVisitStartedAt, record.currentVisitStartedAt);
});

test('rotateRecord: a wildly-future stamp is bogus and never becomes the baseline', () => {
  const previous = new Date(T0 - 48 * HOUR).toISOString();
  const record = {
    currentVisitStartedAt: new Date(T0 + 30 * 24 * HOUR).toISOString(),
    previousVisitStartedAt: previous,
  };
  const rotated = rotateRecord(record, T0).record;

  assert.equal(rotated.currentVisitStartedAt, new Date(T0).toISOString());
  assert.equal(
    rotated.previousVisitStartedAt,
    previous,
    'a date in the future as the baseline would mean "nothing is ever new"'
  );

  // And with nothing to preserve, it stays the first-visit shape.
  const fresh = rotateRecord(
    { currentVisitStartedAt: new Date(T0 + 30 * 24 * HOUR).toISOString(), previousVisitStartedAt: null },
    T0
  ).record;
  assert.equal(fresh.currentVisitStartedAt, new Date(T0).toISOString());
  assert.equal(fresh.previousVisitStartedAt, null);
});

test('rotateRecord: a lastSeenAt from the future cannot keep a sitting alive forever', () => {
  const record = {
    currentVisitStartedAt: new Date(T0 - 48 * HOUR).toISOString(),
    previousVisitStartedAt: null,
    lastSeenAt: new Date(T0 + 30 * 24 * HOUR).toISOString(),
  };
  const rotated = rotateRecord(record, T0).record;

  assert.equal(rotated.currentVisitStartedAt, new Date(T0).toISOString());
  assert.equal(rotated.previousVisitStartedAt, record.currentVisitStartedAt);
});

test('store: first visit writes state.json; the second sitting rotates', async () => {
  const dir = tempDir();
  const clock = { now: T0 };
  const store = storeAt(dir, clock);

  const first = await store.rotate('mom');
  assert.equal(first.previousVisitStartedAt, null);

  const onDisk = JSON.parse(readFileSync(join(dir, STATE_FILE_NAME), 'utf8'));
  assert.deepEqual(Object.keys(onDisk), ['mom']);
  assert.equal(onDisk.mom.currentVisitStartedAt, new Date(T0).toISOString());

  clock.now = T0 + 26 * HOUR;
  const second = await store.rotate('mom');
  assert.equal(second.previousVisitStartedAt, new Date(T0).toISOString());
});

test('store: viewers keep separate visits', async () => {
  const dir = tempDir();
  const clock = { now: T0 };
  const store = storeAt(dir, clock);

  await store.rotate('mom');
  clock.now = T0 + 26 * HOUR;
  await store.rotate('gran');

  const state = await store.read();
  assert.equal(state.mom.currentVisitStartedAt, new Date(T0).toISOString());
  assert.equal(state.gran.previousVisitStartedAt, null, 'gran has never been here before');
  assert.equal(state.mom.previousVisitStartedAt, null, 'mom must not inherit gran’s rotation');
});

test('store: a corrupt state file is recovered from, not thrown over', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, STATE_FILE_NAME), '{"mom": {"currentVisitStar');

  const warnings = [];
  const store = createVisitStore({
    dir,
    now: () => T0,
    log: { warn: (...args) => warnings.push(args) },
  });

  const record = await store.rotate('mom');
  assert.equal(record.currentVisitStartedAt, new Date(T0).toISOString());
  assert.equal(warnings.length, 1, 'the operator should hear about it exactly once');

  // And the file is valid JSON again afterwards.
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, STATE_FILE_NAME), 'utf8')));
});

test('store: a state file that is not an object at all starts fresh', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, STATE_FILE_NAME), '["mom"]');

  const store = createVisitStore({ dir, now: () => T0 });
  assert.equal((await store.rotate('mom')).previousVisitStartedAt, null);
});

test('store: writes land atomically and leave no temp files behind', async () => {
  const dir = tempDir();
  const clock = { now: T0 };
  const store = storeAt(dir, clock);

  for (let i = 0; i < 5; i += 1) {
    clock.now = T0 + i * 24 * HOUR;
    await store.rotate('mom');
  }

  const names = readdirSync(dir);
  assert.deepEqual(names, [STATE_FILE_NAME], `expected only state.json, saw ${names.join(', ')}`);
});

test('store: concurrent rotations keep every viewer, not just the last writer', async () => {
  const dir = tempDir();
  const clock = { now: T0 };
  const store = storeAt(dir, clock);

  // Three viewers opening the page at once. Each write rewrites the whole file,
  // so reading outside the write chain would have each of them save a snapshot
  // taken before the others existed -- and the last rename would win, alone.
  await Promise.all(['mom', 'gran', 'nana'].map((name) => store.rotate(name)));

  const parsed = JSON.parse(readFileSync(join(dir, STATE_FILE_NAME), 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['gran', 'mom', 'nana']);
  // And the file is one whole state object, never two of them concatenated.
  for (const record of Object.values(parsed)) {
    assert.equal(record.currentVisitStartedAt, new Date(T0).toISOString());
  }
});

test('store: startVisit decides the rotation but writes nothing until it is committed', async () => {
  const dir = tempDir();
  const clock = { now: T0 };
  const store = storeAt(dir, clock);

  await store.rotate('mom');

  // A day later she opens the page and Nextcloud is down: the rotation is
  // worked out, but nothing is saved.
  clock.now = T0 + 26 * HOUR;
  const failed = await store.startVisit('mom');
  assert.equal(failed.previousVisitStartedAt, new Date(T0).toISOString());
  assert.equal(
    (await store.read()).mom.currentVisitStartedAt,
    new Date(T0).toISOString(),
    'an uncommitted visit must leave state.json exactly as it was'
  );

  // She tries again an hour later and it works. The baseline is still the
  // sitting before -- the failed load did not spend it.
  clock.now = T0 + 27 * HOUR;
  const worked = await store.startVisit('mom');
  assert.equal(worked.previousVisitStartedAt, new Date(T0).toISOString());
  await worked.commit();

  const state = await store.read();
  assert.equal(state.mom.currentVisitStartedAt, new Date(T0 + 27 * HOUR).toISOString());
  assert.equal(state.mom.previousVisitStartedAt, new Date(T0).toISOString());
});

test('store: committing one viewer does not drop another written in between', async () => {
  const dir = tempDir();
  const clock = { now: T0 };
  const store = storeAt(dir, clock);

  const momsVisit = await store.startVisit('mom');
  await store.rotate('gran');
  await momsVisit.commit();

  const state = await store.read();
  assert.deepEqual(Object.keys(state).sort(), ['gran', 'mom']);
});

test('store: a mid-sitting load still refreshes lastSeenAt on disk', async () => {
  const dir = tempDir();
  const clock = { now: T0 };
  const store = storeAt(dir, clock);

  await store.rotate('mom');
  clock.now = T0 + 3 * HOUR;
  await store.rotate('mom');

  const state = await store.read();
  assert.equal(state.mom.currentVisitStartedAt, new Date(T0).toISOString());
  assert.equal(state.mom.lastSeenAt, new Date(T0 + 3 * HOUR).toISOString());

  // Which is what keeps a long browse from rotating: five more hours of reading
  // is still the same sitting, because the last page was three hours ago.
  clock.now = T0 + 8 * HOUR;
  const record = await store.rotate('mom');
  assert.equal(record.currentVisitStartedAt, new Date(T0).toISOString());
});

test('store: an unwritable directory is logged, and the page still gets an answer', async () => {
  const parent = tempDir();
  // A plain file where the store expects a directory: mkdir -p can't win.
  writeFileSync(join(parent, 'blocked'), 'not a directory');

  const warnings = [];
  const store = createVisitStore({
    dir: join(parent, 'blocked', 'data'),
    now: () => T0,
    log: { warn: (...args) => warnings.push(args) },
  });

  const record = await store.rotate('mom');
  assert.equal(record.currentVisitStartedAt, new Date(T0).toISOString());
  assert.ok(warnings.length >= 1, 'a failed write must be logged, not swallowed silently');
});

test('store: reads come off disk every time, so an external edit is seen', async () => {
  const dir = tempDir();
  const clock = { now: T0 };
  const store = storeAt(dir, clock);

  await store.rotate('mom');
  // Somebody (the E2E suite) rewrites the file to fake a visit days ago.
  writeFileSync(
    join(dir, STATE_FILE_NAME),
    JSON.stringify({ mom: { currentVisitStartedAt: new Date(T0 - 48 * HOUR).toISOString() } })
  );

  const record = await store.rotate('mom');
  assert.equal(record.previousVisitStartedAt, new Date(T0 - 48 * HOUR).toISOString());
});
