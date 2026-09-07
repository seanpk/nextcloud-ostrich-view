import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PRUNE_AFTER_MS,
  TASKS_SEEN_FILE_NAME,
  createTasksSeenStore,
  ledgerKey,
} from '../../src/store/tasks-seen.js';

/**
 * The seen-tasks ledger: the file that lets the stream say a task is new.
 *
 * What matters here is not the shape of the JSON but the three promises the
 * stream leans on: that two loads writing at once cannot lose each other's
 * tasks, that a file we cannot read or write costs Added rows and nothing else,
 * and that the file does not grow forever.
 */

const T0 = Date.parse('2026-09-07T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const madeDirs = [];
after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-seen-'));
  madeDirs.push(dir);
  return dir;
}

function entry(overrides = {}) {
  return {
    firstSeenAt: new Date(T0).toISOString(),
    addedAt: '2026-09-01T08:00:00.000Z',
    stampAt: '2026-09-01T08:00:00.000Z',
    etag: 'abc',
    changedAt: null,
    lastSeenAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

test('ledgerKey: a task is remembered per calendar, not per slug', () => {
  // The URI, because a slug can pick up a `-2` suffix the moment another list
  // is shared -- and a ledger keyed on it would call every task in the renamed
  // list brand new.
  assert.equal(ledgerKey('school-tasks', 'task-essay'), 'school-tasks|task-essay');
  assert.notEqual(ledgerKey('a', 'x'), ledgerKey('b', 'x'));
});

test('an empty save writes no file at all', async () => {
  const dir = tempDir();
  const store = createTasksSeenStore({ dir, now: () => T0 });

  await store.save({});

  assert.deepEqual(readdirSync(dir), [], 'a settled household should not rewrite this every load');
  assert.deepEqual(Object.keys(await store.read()), []);
});

test('what is saved comes back, and lands in one whole file', async () => {
  const dir = tempDir();
  const store = createTasksSeenStore({ dir, now: () => T0 });

  await store.save({ 'chores|chore-bins': entry() });
  const ledger = await store.read();

  assert.deepEqual(Object.keys(ledger), ['chores|chore-bins']);
  assert.equal(ledger['chores|chore-bins'].addedAt, '2026-09-01T08:00:00.000Z');
  assert.equal(ledger['chores|chore-bins'].etag, 'abc');
  // Temp files are cleaned up: a reader sees the old file or the new one.
  assert.deepEqual(readdirSync(dir), [TASKS_SEEN_FILE_NAME]);
});

test('two saves at once cannot delete each other’s tasks', async () => {
  const dir = tempDir();
  const store = createTasksSeenStore({ dir, now: () => T0 });

  // Each save rewrites the WHOLE file, so without the serialized read-modify-
  // write the second rename would quietly drop the first list's tasks -- and
  // the next load would announce them all over again as Added.
  await Promise.all([
    store.save({ 'chores|a': entry() }),
    store.save({ 'school-tasks|b': entry() }),
    store.save({ 'school-tasks|c': entry() }),
  ]);

  assert.deepEqual(Object.keys(await store.read()).sort(), [
    'chores|a',
    'school-tasks|b',
    'school-tasks|c',
  ]);
});

test('a later sighting overwrites the entry, not the file', async () => {
  const dir = tempDir();
  const store = createTasksSeenStore({ dir, now: () => T0 });

  await store.save({ 'chores|a': entry(), 'chores|b': entry() });
  await store.save({ 'chores|a': entry({ etag: 'moved', changedAt: '2026-09-05T12:00:00.000Z' }) });

  const ledger = await store.read();
  assert.equal(ledger['chores|a'].etag, 'moved');
  assert.equal(ledger['chores|a'].changedAt, '2026-09-05T12:00:00.000Z');
  assert.equal(ledger['chores|b'].etag, 'abc', 'the untouched task is still there');
});

test('a task nobody has seen for 90 days is forgotten', async () => {
  const dir = tempDir();
  let clock = T0;
  const store = createTasksSeenStore({ dir, now: () => clock });

  await store.save({
    'chores|kept': entry(),
    'chores|gone': entry({ lastSeenAt: new Date(T0 - PRUNE_AFTER_MS - DAY).toISOString() }),
  });

  // The prune runs on the way out, so the second write is what applies it to
  // the first write's entries.
  clock = T0 + 60_000;
  await store.save({ 'chores|kept': entry({ lastSeenAt: new Date(clock).toISOString() }) });

  assert.deepEqual(Object.keys(await store.read()), ['chores|kept']);
});

test('a task missing for a season but seen last week is kept', async () => {
  // We cannot tell "deleted" from "unshared" from "that list's REPORT failed",
  // so a task that has merely gone quiet keeps its entry -- otherwise it comes
  // back as news the moment the list does.
  const dir = tempDir();
  let clock = T0;
  const store = createTasksSeenStore({ dir, now: () => clock });

  await store.save({ 'chores|quiet': entry({ lastSeenAt: new Date(T0 - 7 * DAY).toISOString() }) });
  clock = T0 + 60_000;
  await store.save({ 'chores|other': entry() });

  assert.deepEqual(Object.keys(await store.read()).sort(), ['chores|other', 'chores|quiet']);
});

test('a hand-edited or half-written file starts fresh instead of throwing', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, TASKS_SEEN_FILE_NAME), '{ "chores|a": { "addedAt": ');
  const warnings = [];
  const store = createTasksSeenStore({ dir, now: () => T0, log: { warn: (...a) => warnings.push(a) } });

  assert.deepEqual(
    Object.keys(await store.read()),
    [],
    'unreadable means "we have met nothing", not a crash'
  );
  assert.equal(warnings.length, 1, 'said once');

  // And it is repaired by the next save rather than left broken forever.
  await store.save({ 'chores|a': entry() });
  assert.deepEqual(Object.keys(await store.read()), ['chores|a']);
});

test('nonsense inside the file is dropped entry by entry', async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, TASKS_SEEN_FILE_NAME),
    JSON.stringify({
      'chores|good': entry(),
      'chores|not-an-object': 'nope',
      'chores|no-stamps': { etag: 'x' },
      'chores|bad-stamp': { addedAt: 'last Tuesday' },
      __proto__: entry(),
    })
  );
  const store = createTasksSeenStore({ dir, now: () => T0 });

  const ledger = await store.read();
  assert.deepEqual(Object.keys(ledger), ['chores|good']);
  // The file is ours, but it is still parsed input: a `__proto__` key in it is
  // an odd task key and nothing more.
  assert.equal(Object.getPrototypeOf(ledger), null);
  assert.equal(({}).addedAt, undefined);
});

test('an entry that lost its addedAt falls back to when we first saw the task', async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, TASKS_SEEN_FILE_NAME),
    JSON.stringify({ 'chores|a': { firstSeenAt: '2026-09-01T08:00:00.000Z' } })
  );
  const store = createTasksSeenStore({ dir, now: () => T0 });

  const ledger = await store.read();
  assert.equal(ledger['chores|a'].addedAt, '2026-09-01T08:00:00.000Z');
  assert.equal(ledger['chores|a'].lastSeenAt, '2026-09-01T08:00:00.000Z');
});

test('a directory where the file should be costs Added rows, not the page', async () => {
  const dir = tempDir();
  // Nothing can be written here, and no retry will fix it.
  const warnings = [];
  const store = createTasksSeenStore({
    dir: join(dir, TASKS_SEEN_FILE_NAME, 'nested'),
    now: () => T0,
    log: { warn: (...a) => warnings.push(a) },
  });
  writeFileSync(join(dir, TASKS_SEEN_FILE_NAME), '');

  await store.save({ 'chores|a': entry() });

  assert.ok(warnings.length > 0, 'logged, and swallowed: the page has already rendered');
  assert.match(
    warnings.at(-1)[1],
    /could not save the seen-tasks ledger/,
    'and it says which file it gave up on'
  );
});

test('the file is written for the owner only', async () => {
  const dir = tempDir();
  const store = createTasksSeenStore({ dir, now: () => T0 });
  await store.save({ 'chores|a': entry() });

  const raw = readFileSync(join(dir, TASKS_SEEN_FILE_NAME), 'utf8');
  assert.match(raw, /"chores\|a"/);
  assert.match(raw, /\n$/, 'ends with a newline, like every other file we write');
});
