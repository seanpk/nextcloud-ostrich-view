import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shareSignal,
  selectReceivedShares,
  shareListingRoots,
} from '../../src/nextcloud/shares.js';

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

/**
 * `shareListingRoots` decides WHICH folders get listed, which is the half of
 * the problem `shareSignal` cannot see: on an instance with `share_folder` set,
 * the shares are not in the folder being filtered at all.
 */

test('shareListingRoots: with no shares, only the files home is listed', () => {
  assert.deepEqual(shareListingRoots([]), ['']);
});

test('shareListingRoots: shares mounted at the top need nothing extra', () => {
  // A plain instance with no share_folder: '' already covers these.
  assert.deepEqual(shareListingRoots(['Biology 101', 'Math 210']), ['']);
});

test('shareListingRoots: a share_folder adds its container, files home first', () => {
  // The case that was rendering an empty page: /Shared is owned by the viewer
  // account, so filtering the root drops it and everything under it.
  assert.deepEqual(shareListingRoots(['Shared/Family']), ['', 'Shared']);
});

test('shareListingRoots: several shares in one container list it once', () => {
  assert.deepEqual(shareListingRoots(['Shared/Family', 'Shared/Photos', 'Shared/Recipes']), [
    '',
    'Shared',
  ]);
});

test('shareListingRoots: mixed depths are all covered', () => {
  // A group folder mounted at the top alongside ordinary shares under
  // share_folder -- the root listing catches the first, 'Shared' the rest.
  assert.deepEqual(shareListingRoots(['Team', 'Shared/Family']), ['', 'Shared']);
});

test('shareListingRoots: the files home is always first, whatever the input order', () => {
  const roots = shareListingRoots(['Shared/Family']);
  assert.equal(roots[0], '', 'the files home is listed unconditionally');
});

test('shareListingRoots: a container nested inside a share is not listed', () => {
  // Listing 'Shared/Family' would spill that share's own contents onto the home
  // page as though each child were a share in its own right.
  assert.deepEqual(shareListingRoots(['Shared/Family', 'Shared/Family/Sub']), ['', 'Shared']);
});

test('shareListingRoots: deeper containers are listed at their own level', () => {
  assert.deepEqual(shareListingRoots(['a/b/c']), ['', 'a/b']);
});

test('shareListingRoots: survives junk without throwing', () => {
  // The targets come from a network response; the caller has already filtered,
  // but this must not be the thing that breaks the page if that ever changes.
  assert.deepEqual(shareListingRoots(undefined), ['']);
  assert.deepEqual(shareListingRoots(null), ['']);
});
