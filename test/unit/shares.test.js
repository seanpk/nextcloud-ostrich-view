import test from 'node:test';
import assert from 'node:assert/strict';

import { shareSignal, selectReceivedShares } from '../../src/nextcloud/shares.js';

/**
 * `shareSignal` combines two independent PROPFIND properties into one
 * verdict; `selectReceivedShares` is the root-listing filter built on top.
 * The one rule that matters everywhere here: an entry the server gave us no
 * signal for must survive, because that is what keeps an odd Nextcloud
 * version from silently emptying the home page.
 */

const USER = 'ostrich-viewer';

function entry(overrides = {}) {
  return { permissions: null, ownerId: null, ...overrides };
}

// --- shareSignal -------------------------------------------------------

test('shareSignal: permissions containing S is a share', () => {
  assert.equal(shareSignal(entry({ permissions: 'SRGDNVCK' }), { user: USER }), true);
});

test('shareSignal: permissions containing M (a group folder) is a share', () => {
  assert.equal(shareSignal(entry({ permissions: 'MRGDNVCK' }), { user: USER }), true);
});

test('shareSignal: the account\'s own permissions, with a matching owner, is not a share', () => {
  assert.equal(
    shareSignal(entry({ permissions: 'RGDNVCK', ownerId: USER }), { user: USER }),
    false
  );
});

test('shareSignal: an owner-id that differs is a share, even with no permissions letter', () => {
  assert.equal(shareSignal(entry({ ownerId: 'liam' }), { user: USER }), true);
});

test('shareSignal: an owner-id differing only in case is NOT a share', () => {
  assert.equal(
    shareSignal(entry({ permissions: 'RGDNVCK', ownerId: USER.toUpperCase() }), { user: USER }),
    false
  );
});

test('shareSignal: a positive from one property wins over a negative from the other', () => {
  // permissions says "ours"; owner-id says "shared". The share wins.
  assert.equal(
    shareSignal(entry({ permissions: 'RGDNVCK', ownerId: 'liam' }), { user: USER }),
    true
  );
});

test('shareSignal: both properties absent is unknown, not "not a share"', () => {
  assert.equal(shareSignal(entry(), { user: USER }), null);
});

test('shareSignal: an empty-string permissions value is treated as absent', () => {
  assert.equal(shareSignal(entry({ permissions: '' }), { user: USER }), null);
});

// --- selectReceivedShares ------------------------------------------------

test('selectReceivedShares: keeps shares, drops the account\'s own content', () => {
  const list = [
    entry({ permissions: 'SRGDNVCK' }), // Biology 101
    entry({ permissions: 'RGDNVCK', ownerId: USER }), // Documents (skeleton)
  ];
  const result = selectReceivedShares(list, { user: USER });
  assert.equal(result.entries.length, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.sawSignal, true);
});

test('selectReceivedShares: no signal anywhere keeps every entry, and says so', () => {
  const list = [entry(), entry(), entry()];
  const result = selectReceivedShares(list, { user: USER });
  assert.equal(result.entries.length, 3);
  assert.equal(result.dropped, 0);
  assert.equal(result.sawSignal, false, 'a fallback must be distinguishable from an empty result');
});

test('selectReceivedShares: signal present but nothing qualifies yields an empty list', () => {
  const list = [entry({ permissions: 'RGDNVCK', ownerId: USER })];
  const result = selectReceivedShares(list, { user: USER });
  assert.deepEqual(result.entries, []);
  assert.equal(result.sawSignal, true, 'distinct from the no-signal fallback case');
});

test('selectReceivedShares: a mix of known and unknown entries keeps the unknown one', () => {
  const list = [
    entry({ permissions: 'RGDNVCK', ownerId: USER }), // known: ours, dropped
    entry(), // unknown: kept
  ];
  const result = selectReceivedShares(list, { user: USER });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0], list[1]);
  assert.equal(result.sawSignal, true);
});

test('selectReceivedShares: an empty list is handled', () => {
  const result = selectReceivedShares([], { user: USER });
  assert.deepEqual(result.entries, []);
  assert.equal(result.sawSignal, false);
});
