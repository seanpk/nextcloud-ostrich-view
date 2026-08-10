import test from 'node:test';
import assert from 'node:assert/strict';

import bcrypt from 'bcryptjs';

import { matchViewer } from '../../src/lib/auth.js';
import { createLoginWindow } from '../../src/routes/auth.js';

// Cost 4 keeps the suite in milliseconds; production hashes use 12.
const hash = (phrase) => bcrypt.hashSync(phrase, 4);

const VIEWERS = [
  { name: 'mom', label: 'Mom', passphraseHash: hash('correct horse') },
  { name: 'gran', label: 'Gran', passphraseHash: hash('battery staple') },
  { name: 'sean', label: 'Sean', passphraseHash: hash('a third phrase entirely') },
];

test('matchViewer: finds the viewer whose passphrase matches', async () => {
  assert.deepEqual(await matchViewer(VIEWERS, 'correct horse'), { name: 'mom', label: 'Mom' });
  assert.deepEqual(await matchViewer(VIEWERS, 'battery staple'), { name: 'gran', label: 'Gran' });
  assert.deepEqual(await matchViewer(VIEWERS, 'a third phrase entirely'), {
    name: 'sean',
    label: 'Sean',
  });
});

test('matchViewer: returns null for a wrong passphrase', async () => {
  assert.equal(await matchViewer(VIEWERS, 'correct horse battery staple'), null);
  assert.equal(await matchViewer(VIEWERS, 'CORRECT HORSE'), null);
  assert.equal(await matchViewer(VIEWERS, 'correct horse '), null);
  assert.equal(await matchViewer(VIEWERS, 'nope'), null);
});

test('matchViewer: rejects empty and non-string input without touching bcrypt', async () => {
  assert.equal(await matchViewer(VIEWERS, ''), null);
  assert.equal(await matchViewer(VIEWERS, undefined), null);
  assert.equal(await matchViewer(VIEWERS, null), null);
  assert.equal(await matchViewer(VIEWERS, 12345), null);
  assert.equal(await matchViewer(VIEWERS, {}), null);
});

test('matchViewer: an unusable hash fails that viewer, not the whole login', async () => {
  const viewers = [
    { name: 'broken', label: 'Broken', passphraseHash: 'not-a-bcrypt-hash' },
    { name: 'mom', label: 'Mom', passphraseHash: hash('correct horse') },
  ];
  assert.deepEqual(await matchViewer(viewers, 'correct horse'), { name: 'mom', label: 'Mom' });
});

test('matchViewer: with no viewers configured, nobody matches', async () => {
  assert.equal(await matchViewer([], 'correct horse'), null);
});

test('matchViewer: when two viewers share a phrase, the first configured wins', async () => {
  const shared = hash('same phrase');
  const viewers = [
    { name: 'first', label: 'First', passphraseHash: shared },
    { name: 'second', label: 'Second', passphraseHash: shared },
  ];
  assert.deepEqual(await matchViewer(viewers, 'same phrase'), { name: 'first', label: 'First' });
});

test('matchViewer: compares against every viewer, not just until the first hit', async () => {
  // The last viewer holds the matching phrase; if the implementation bailed
  // early on a non-match it would never reach them.
  const viewers = [
    { name: 'a', label: 'A', passphraseHash: hash('aaa') },
    { name: 'b', label: 'B', passphraseHash: hash('bbb') },
    { name: 'z', label: 'Z', passphraseHash: hash('zzz') },
  ];
  assert.deepEqual(await matchViewer(viewers, 'zzz'), { name: 'z', label: 'Z' });
});

test('createLoginWindow: rejects once failures reach the cap, recovers after the window', () => {
  const win = createLoginWindow({ limit: 3, windowMs: 60_000 });
  const t0 = 1_000_000;

  assert.equal(win.isOver(t0), false);
  win.recordFailure(t0);
  win.recordFailure(t0 + 1);
  assert.equal(win.isOver(t0 + 2), false);
  win.recordFailure(t0 + 2);
  // Cap reached: further attempts in the window are rejected...
  assert.equal(win.isOver(t0 + 3), true);
  assert.equal(win.isOver(t0 + 30_000), true);
  // ...but once the window slides past the earliest failures, life goes on.
  assert.equal(win.isOver(t0 + 61_000), false);
});

test('createLoginWindow: only recorded failures count, so real logins never burn budget', () => {
  const win = createLoginWindow({ limit: 2, windowMs: 60_000 });
  // A pile of successful logins = isOver checks with nothing recorded.
  for (let i = 0; i < 50; i += 1) assert.equal(win.isOver(i), false);
  win.recordFailure(100);
  win.recordFailure(101);
  assert.equal(win.isOver(102), true);
  // Blocked checks do not extend the window (no lockout spiral).
  for (let i = 0; i < 50; i += 1) assert.equal(win.isOver(10_000 + i), true);
  assert.equal(win.isOver(60_102), false);
});
