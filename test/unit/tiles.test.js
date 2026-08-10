import test from 'node:test';
import assert from 'node:assert/strict';

import { toTile, toTiles } from '../../src/lib/tiles.js';

/**
 * `toTile` is the seam every page renders through, so this is where the two
 * M2 promises are pinned down: previewable files get a thumbnail URL keyed by
 * etag, and only files the viewer can actually show become links.
 */

function entry(overrides = {}) {
  return {
    name: 'cell diagram.png',
    path: 'Biology 101/cell diagram.png',
    isFolder: false,
    fileId: 908603,
    etag: '000ddd3babcd',
    lastModified: null,
    contentType: 'image/png',
    size: 28081,
    ...overrides,
  };
}

// --- destinations ----------------------------------------------------------

test('toTile: folders link into the folder listing', () => {
  const tile = toTile(entry({ name: 'Lectures', path: 'Biology 101/Lectures', isFolder: true, contentType: null }));
  assert.equal(tile.href, '/files/Biology%20101/Lectures');
  assert.equal(tile.previewUrl, null, 'folders never get a thumbnail');
  assert.equal(tile.sizeLabel, null);
});

test('toTile: images and PDFs open in the inline viewer', () => {
  assert.equal(toTile(entry()).href, '/view/Biology%20101/cell%20diagram.png');

  const pdf = toTile(entry({ name: 'syllabus.pdf', path: 'Biology 101/syllabus.pdf', contentType: 'application/pdf' }));
  assert.equal(pdf.href, '/view/Biology%20101/syllabus.pdf');
  assert.equal(pdf.kind, 'pdf');
});

test('toTile: files we cannot show inline stay plain labels', () => {
  const txt = toTile(entry({ name: 'welcome.txt', path: 'welcome.txt', contentType: 'text/plain' }));
  assert.equal(txt.href, null);
  assert.equal(txt.previewUrl, null);
  assert.equal(txt.icon, '/public/icons/document.svg');
});

test('toTile: an image the proxy will not serve as an image is not a link', () => {
  // /content/ defangs SVG to octet-stream (it can carry script) and doesn't
  // claim to know TIFF, so linking either would open a broken picture.
  for (const contentType of ['image/svg+xml', 'image/tiff', 'image/heic']) {
    const tile = toTile(entry({ name: `art.x`, path: 'art.x', contentType }));
    assert.equal(tile.href, null, `${contentType} must not link to /view/`);
    assert.equal(tile.icon, '/public/icons/image.svg', 'but it still looks like a picture');
  }
});

test('toTile: unicode and spaces are encoded once, per segment', () => {
  const tile = toTile(entry({ name: 'résumé draft.pdf', path: 'Café Notes/résumé draft.pdf', contentType: 'application/pdf' }));
  assert.equal(tile.href, '/view/Caf%C3%A9%20Notes/r%C3%A9sum%C3%A9%20draft.pdf');
});

// --- thumbnails ------------------------------------------------------------

test('toTile: an image gets a preview URL keyed by its etag', () => {
  const tile = toTile(entry());
  assert.equal(tile.previewUrl, '/preview/908603?v=000ddd3babcd&k=image');
});

test('toTile: the preview URL changes when the file does', () => {
  const before = toTile(entry()).previewUrl;
  const after = toTile(entry({ etag: 'ffff1111' })).previewUrl;
  assert.notEqual(before, after, 'a changed file must not serve a cached thumbnail');
});

test('toTile: PDFs deliberately keep the flat icon', () => {
  // Nextcloud ships with OC\Preview\PDF disabled, so asking would only ever
  // round-trip to a 404 and fall back to this icon anyway.
  const tile = toTile(entry({ name: 'syllabus.pdf', path: 'syllabus.pdf', contentType: 'application/pdf' }));
  assert.equal(tile.previewUrl, null);
  assert.equal(tile.icon, '/public/icons/pdf.svg');
});

test('toTile: an entry with no fileId or etag falls back to the icon', () => {
  assert.equal(toTile(entry({ fileId: null })).previewUrl, null);
  assert.equal(toTile(entry({ etag: null })).previewUrl, null);
  assert.equal(toTile(entry({ etag: '' })).previewUrl, null);
});

test('toTile: an etag the preview route would reject is not emitted', () => {
  // Better a flat icon than an <img> pointed at a guaranteed 400.
  for (const etag of ['abc-def', 'W/"weak"', 'a b', '../../etc']) {
    assert.equal(toTile(entry({ etag })).previewUrl, null, `etag ${etag} must not be used`);
  }
});

// --- the rest of the view model -------------------------------------------

test('toTile: kind drives the icon', () => {
  assert.equal(toTile(entry({ isFolder: true, contentType: null })).icon, '/public/icons/folder.svg');
  assert.equal(toTile(entry({ contentType: 'image/jpeg' })).icon, '/public/icons/image.svg');
  assert.equal(
    toTile(entry({ contentType: null, name: 'notes.docx' })).icon,
    '/public/icons/document.svg'
  );
  assert.equal(
    toTile(entry({ contentType: null, name: 'archive.zip' })).icon,
    '/public/icons/file.svg'
  );
});

test('toTile: files carry a human-readable size, folders do not', () => {
  assert.equal(toTile(entry({ size: 28081 })).sizeLabel, '27 KB');
  assert.equal(toTile(entry({ size: 5_120 })).sizeLabel, '5.0 KB');
  assert.equal(toTile(entry({ isFolder: true })).sizeLabel, null);
});

test('toTiles: maps a listing without reordering it', () => {
  const tiles = toTiles([entry({ name: 'b.png', path: 'b.png' }), entry({ name: 'a.png', path: 'a.png' })]);
  assert.deepEqual(tiles.map((t) => t.name), ['b.png', 'a.png']);
});
