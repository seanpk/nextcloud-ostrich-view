import test from 'node:test';
import assert from 'node:assert/strict';

import { FILE_TYPES, kindOf, rendersInline, safeContentType } from '../../src/lib/filetypes.js';

/**
 * One table decides what `/content/*` may call a file and whether a tile links
 * to `/view/`. These tests pin the invariant that keeps those two honest --
 * nothing is linked that the proxy will turn into a download -- as well as the
 * XSS rule that puts SVG and HTML on the octet-stream side of the line.
 */

// --- the invariant ---------------------------------------------------------

test('every renderable type is also one we serve honestly', () => {
  for (const [type, rule] of FILE_TYPES) {
    if (!rule.renders) continue;
    assert.ok(rule.serveAs, `${type} is linked as viewable but has no Content-Type`);
    assert.equal(safeContentType(type), rule.serveAs);
    assert.ok(['image', 'pdf'].includes(rule.kind), `${type} renders but has kind ${rule.kind}`);
  }
});

test('a linked file is always a file the browser is given the real type for', () => {
  for (const type of [...FILE_TYPES.keys(), 'image/svg+xml', 'image/tiff', 'text/html']) {
    const entry = { isFolder: false, name: 'thing', contentType: type };
    if (!rendersInline(entry)) continue;
    assert.notEqual(
      safeContentType(type),
      'application/octet-stream',
      `${type} would be linked but served as a download`
    );
  }
});

// --- content type ----------------------------------------------------------

test('safeContentType: previewable types pass through untouched', () => {
  assert.equal(safeContentType('image/png'), 'image/png');
  assert.equal(safeContentType('image/jpeg'), 'image/jpeg');
  assert.equal(safeContentType('application/pdf'), 'application/pdf');
});

test('safeContentType: parameters and casing are normalised away', () => {
  assert.equal(safeContentType('IMAGE/PNG'), 'image/png');
  assert.equal(safeContentType('application/pdf; charset=binary'), 'application/pdf');
  assert.equal(safeContentType('  image/jpeg  '), 'image/jpeg');
});

test('safeContentType: anything script-capable is defanged', () => {
  // Served inline from our own origin, these would be an XSS delivered by
  // whoever can put a file in a shared folder.
  assert.equal(safeContentType('text/html'), 'application/octet-stream');
  assert.equal(safeContentType('image/svg+xml'), 'application/octet-stream');
  assert.equal(safeContentType('application/xhtml+xml'), 'application/octet-stream');
  assert.equal(safeContentType('application/javascript'), 'application/octet-stream');
});

test('safeContentType: unknown or missing types fall back to octet-stream', () => {
  assert.equal(safeContentType(''), 'application/octet-stream');
  assert.equal(safeContentType(null), 'application/octet-stream');
  assert.equal(safeContentType(undefined), 'application/octet-stream');
  assert.equal(safeContentType('application/vnd.oasis.opendocument.text'), 'application/octet-stream');
});

test('safeContentType: plain text keeps a charset so it renders as text', () => {
  assert.equal(safeContentType('text/plain'), 'text/plain; charset=utf-8');
});

// --- kinds -----------------------------------------------------------------

test('kindOf: the content type decides, the extension only fills gaps', () => {
  assert.equal(kindOf({ isFolder: true }), 'folder');
  assert.equal(kindOf({ isFolder: false, contentType: 'image/jpeg' }), 'image');
  assert.equal(kindOf({ isFolder: false, contentType: 'application/pdf' }), 'pdf');
  assert.equal(kindOf({ isFolder: false, contentType: null, name: 'notes.docx' }), 'document');
  assert.equal(kindOf({ isFolder: false, contentType: null, name: 'archive.zip' }), 'file');
});

test('kindOf: an image we cannot show still looks like an image on the grid', () => {
  // The icon is generous where the link is not: a photo tile that says
  // "picture" and doesn't open beats one that says "unknown file".
  assert.equal(kindOf({ isFolder: false, contentType: 'image/svg+xml' }), 'image');
  assert.equal(kindOf({ isFolder: false, contentType: 'image/tiff' }), 'image');
  assert.equal(kindOf({ isFolder: false, contentType: 'image/heic' }), 'image');
});

// --- what may be viewed ----------------------------------------------------

test('rendersInline: the formats every browser paints', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf']) {
    assert.equal(rendersInline({ isFolder: false, contentType: type }), true, type);
  }
});

test('rendersInline: SVG and TIFF are not offered -- we serve them as downloads', () => {
  assert.equal(rendersInline({ isFolder: false, contentType: 'image/svg+xml' }), false);
  assert.equal(rendersInline({ isFolder: false, contentType: 'image/tiff' }), false);
});

test('rendersInline: HEIC is served honestly but no browser decodes it', () => {
  assert.equal(safeContentType('image/heic'), 'image/heic');
  assert.equal(rendersInline({ isFolder: false, contentType: 'image/heic' }), false);
});

test('rendersInline: folders, text and unknown types are never viewable', () => {
  assert.equal(rendersInline({ isFolder: true, contentType: null }), false);
  assert.equal(rendersInline({ isFolder: false, contentType: 'text/plain' }), false);
  assert.equal(rendersInline({ isFolder: false, contentType: null, name: 'photo.png' }), false);
  assert.equal(rendersInline(null), false);
});
