import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNewSince,
  createNewSinceCache,
  folderLabelFor,
  formatVisitLabel,
  NEW_SINCE_CAP,
} from '../../src/lib/new-since.js';

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

test('folderLabelFor: names the containing folder, not the file', () => {
  assert.equal(folderLabelFor('Biology 101/Lectures/Week 2.pdf'), 'Biology 101 › Lectures');
  assert.equal(folderLabelFor('Biology 101/syllabus.pdf'), 'Biology 101');
});

test('folderLabelFor: a file shared at the top level says Home, like the breadcrumb', () => {
  assert.equal(folderLabelFor('welcome.txt'), 'Home');
});

test('buildNewSince: tiles carry the folder label, a preview and a viewer link', () => {
  const { tiles } = buildNewSince([entry('Biology 101/Lab Reports/microscope.png')]);

  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].name, 'microscope.png');
  assert.equal(tiles[0].folderLabel, 'Biology 101 › Lab Reports');
  // Exactly what a folder listing would produce for the same file.
  assert.equal(tiles[0].href, '/view/Biology%20101/Lab%20Reports/microscope.png');
  assert.equal(tiles[0].previewUrl, '/preview/110001?v=abc123&k=image');
});

test('buildNewSince: a file we cannot open inline is still shown, just not linked', () => {
  const { tiles } = buildNewSince([
    entry('notes.txt', { contentType: 'text/plain', fileId: 42, etag: 'ff00' }),
  ]);

  assert.equal(tiles[0].href, null);
  assert.equal(tiles[0].previewUrl, null);
  assert.equal(tiles[0].folderLabel, 'Home');
});

test('buildNewSince: nothing new means no tiles and no overflow line', () => {
  assert.deepEqual(buildNewSince([]), { tiles: [], moreLabel: null, total: 0 });
  assert.deepEqual(buildNewSince(undefined), { tiles: [], moreLabel: null, total: 0 });
});

test('buildNewSince: at the cap exactly, there is nothing "more" to say', () => {
  const entries = Array.from({ length: NEW_SINCE_CAP }, (_, i) => entry(`Course/file-${i}.png`));
  const { tiles, moreLabel } = buildNewSince(entries);

  assert.equal(tiles.length, NEW_SINCE_CAP);
  assert.equal(moreLabel, null);
});

test('buildNewSince: past the cap it shows 20 and counts the rest', () => {
  const entries = Array.from({ length: 26 }, (_, i) => entry(`Course/file-${i}.png`));
  const { tiles, moreLabel, total } = buildNewSince(entries, { fetchLimit: 50 });

  assert.equal(tiles.length, NEW_SINCE_CAP);
  assert.equal(total, 26);
  assert.equal(moreLabel, '…and 6 more.');
  // Order is preserved: the newest results are the ones that got a tile.
  assert.equal(tiles[0].name, 'file-0.png');
  assert.equal(tiles[19].name, 'file-19.png');
});

test('buildNewSince: when the fetch itself was capped, it does not claim a total it cannot know', () => {
  const entries = Array.from({ length: 50 }, (_, i) => entry(`Course/file-${i}.png`));
  const { moreLabel } = buildNewSince(entries, { fetchLimit: 50 });

  assert.equal(
    moreLabel,
    '…and more besides.',
    'we asked for 50 and got 50, so "and 30 more" would be a guess'
  );
});

test('buildNewSince: a walk that hit its bounds never claims a precise count', () => {
  const entries = Array.from({ length: 25 }, (_, i) => entry(`Course/file-${i}.png`));
  const { moreLabel } = buildNewSince(entries, { fetchLimit: 50, truncated: true });

  assert.equal(
    moreLabel,
    '…and more besides.',
    'whole subtrees went unvisited, so "and 5 more" would be a number we cannot know'
  );
});

test('buildNewSince: a truncated walk says so even when nothing overflowed the cap', () => {
  const { moreLabel } = buildNewSince([entry('Course/one.png')], {
    fetchLimit: 50,
    truncated: true,
  });

  assert.equal(moreLabel, '…and more besides.', 'a short list must not imply "that is everything"');
});

test('buildNewSince: a truncated walk that found nothing still shows nothing', () => {
  const { tiles, moreLabel } = buildNewSince([], { fetchLimit: 50, truncated: true });

  assert.deepEqual(tiles, []);
  assert.equal(moreLabel, null, 'an "and more besides" under an empty section says nothing useful');
});

test('formatVisitLabel: says when, in words nobody has to decode', () => {
  const now = new Date('2026-08-09T20:00:00');

  assert.equal(formatVisitLabel(new Date('2026-08-09T07:00:00'), { now }), 'earlier today');
  assert.equal(formatVisitLabel(new Date('2026-08-08T21:00:00'), { now }), 'yesterday');
  assert.equal(formatVisitLabel(new Date('2026-08-05T21:00:00'), { now }), 'on Wed, Aug 5');
  // A year old wants the year, or "on Sat, Aug 9" would be a riddle.
  assert.equal(formatVisitLabel(new Date('2025-08-09T21:00:00'), { now }), 'on Sat, Aug 9, 2025');
});

test('formatVisitLabel: accepts the ISO string the store hands back', () => {
  const now = new Date('2026-08-09T20:00:00');
  assert.equal(formatVisitLabel(new Date('2026-08-08T21:00:00').toISOString(), { now }), 'yesterday');
});

test('formatVisitLabel: nothing sensible to say produces nothing', () => {
  assert.equal(formatVisitLabel(null), null);
  assert.equal(formatVisitLabel(''), null);
  assert.equal(formatVisitLabel('never'), null);
});

test('formatVisitLabel: a stamp from the future is dated, not called "earlier today"', () => {
  const now = new Date('2026-08-09T20:00:00');

  // A clock that jumped, or a hand-edited state file. Naming the day is honest;
  // "earlier today" would be a small lie about a stamp we know is wrong.
  assert.equal(formatVisitLabel(new Date('2026-08-11T09:00:00'), { now }), 'on Tue, Aug 11');
  assert.equal(formatVisitLabel(new Date('2027-01-02T09:00:00'), { now }), 'on Sat, Jan 2, 2027');
  // Later the same day is still today, which is the ordinary skew case.
  assert.equal(formatVisitLabel(new Date('2026-08-09T23:00:00'), { now }), 'earlier today');
});

test('createNewSinceCache: the same viewer and baseline is answered from memory', () => {
  const cache = createNewSinceCache();
  const answer = { entries: [], strategy: 'search', truncated: false };

  cache.set('mom', '2026-08-08T09:00:00.000Z', answer);

  assert.equal(cache.get('mom', '2026-08-08T09:00:00.000Z'), answer);
  // A new sitting changes the baseline, which is the only moment the answer can
  // change -- so nothing has to be invalidated by hand.
  assert.equal(cache.get('mom', '2026-08-09T09:00:00.000Z'), undefined);
  // And one viewer's answer is never handed to another.
  assert.equal(cache.get('gran', '2026-08-08T09:00:00.000Z'), undefined);
});

test('createNewSinceCache: it is a cache, not a leak', () => {
  const cache = createNewSinceCache({ max: 3 });

  for (let i = 0; i < 10; i += 1) cache.set(`viewer-${i}`, 'since', { entries: [i] });

  assert.equal(cache.size, 3);
  assert.equal(cache.get('viewer-0', 'since'), undefined, 'the oldest key goes first');
  assert.deepEqual(cache.get('viewer-9', 'since'), { entries: [9] });
});
