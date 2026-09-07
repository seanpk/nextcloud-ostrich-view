import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE_TYPES,
  canView,
  convertsInline,
  downloadContentType,
  isDownloadable,
  kindOf,
  rendersInline,
  safeContentType,
} from '../../src/lib/filetypes.js';

/**
 * One table decides what `/content/*` may call a file, whether a tile links to
 * `/view/`, whether we convert the bytes ourselves, and whether `/download/*`
 * will hand the original over. These tests pin the invariants that keep those
 * answers honest -- nothing is linked that the viewer cannot show, nothing
 * converts that is also served as itself, everything downloadable has a real
 * MIME type -- as well as the XSS rule that puts SVG and HTML on the
 * octet-stream side of the line.
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

// --- office files ----------------------------------------------------------

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('a converted type is never also handed to the browser as itself', () => {
  // The whole point of converting is that the raw bytes are no use to a
  // browser. A row with both would mean /content/ offering a .docx download
  // behind a tile that claims to open it on the page.
  for (const [type, rule] of FILE_TYPES) {
    if (!rule.converts) continue;
    assert.equal(rule.serveAs, undefined, `${type} both converts and has a serveAs`);
    assert.equal(safeContentType(type), 'application/octet-stream');
    assert.notEqual(rule.renders, true, `${type} both converts and renders`);
  }
});

test('every downloadable type has a real MIME to be downloaded as', () => {
  for (const [type, rule] of FILE_TYPES) {
    if (!rule.download) continue;
    const entry = { isFolder: false, contentType: type };
    assert.equal(downloadContentType(entry), type, `${type} would download as something else`);
    assert.notEqual(downloadContentType(entry), 'application/octet-stream');
  }
});

test('convertsInline: DOCX and nothing else', () => {
  assert.equal(convertsInline({ isFolder: false, contentType: DOCX }), 'docx');
  assert.equal(convertsInline({ isFolder: false, contentType: `${DOCX}; charset=binary` }), 'docx');
  for (const type of [PPTX, XLSX, 'application/msword', 'application/pdf', 'text/plain']) {
    assert.equal(convertsInline({ isFolder: false, contentType: type }), null, type);
  }
});

test('convertsInline: the file name never decides -- only the content type', () => {
  // A .docx that PROPFIND calls octet-stream is something else wearing a
  // familiar extension, and a zip parser is not how we find out what.
  assert.equal(convertsInline({ isFolder: false, contentType: null, name: 'notes.docx' }), null);
  assert.equal(
    convertsInline({ isFolder: false, contentType: 'application/octet-stream', name: 'a.docx' }),
    null
  );
  assert.equal(convertsInline({ isFolder: true, contentType: DOCX }), null);
  assert.equal(convertsInline(null), null);
});

test('canView: painted, converted, or nothing to tap', () => {
  const view = (contentType, extra = {}) => canView({ isFolder: false, contentType, ...extra });

  // Painted by the browser.
  assert.equal(view('image/png'), true);
  assert.equal(view('application/pdf'), true);
  // Converted by us.
  assert.equal(view(DOCX), true);
  // Neither: the calm page, and a tile with no link.
  assert.equal(view(PPTX), false);
  assert.equal(view(XLSX), false);
  assert.equal(view('application/msword'), false);
  assert.equal(view('text/plain'), false);
  assert.equal(view('image/svg+xml'), false);
  assert.equal(view('image/heic'), false);
  assert.equal(view(null, { name: 'notes.docx' }), false);
  assert.equal(canView({ isFolder: true, contentType: null }), false);
  assert.equal(canView(null), false);
});

test('isDownloadable: office files and PDFs, and nothing a stranger dropped in', () => {
  for (const type of [
    DOCX,
    PPTX,
    XLSX,
    'application/msword',
    'application/vnd.ms-powerpoint',
    'application/vnd.ms-excel',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/pdf',
  ]) {
    assert.equal(isDownloadable({ isFolder: false, contentType: type }), true, type);
  }

  // Anyone the owner shares a folder with can put a file in it; none of these
  // gains a new way out of the app.
  for (const type of [
    'text/plain',
    'text/html',
    'image/png',
    'image/svg+xml',
    'image/heic',
    'application/zip',
    'application/octet-stream',
    '',
    null,
  ]) {
    assert.equal(isDownloadable({ isFolder: false, contentType: type }), false, String(type));
  }

  assert.equal(isDownloadable({ isFolder: true, contentType: DOCX }), false);
  assert.equal(isDownloadable(null), false);
});

test('downloadContentType: octet-stream for everything we do not offer', () => {
  assert.equal(downloadContentType({ isFolder: false, contentType: DOCX }), DOCX);
  assert.equal(downloadContentType({ isFolder: false, contentType: 'application/pdf' }), 'application/pdf');
  // Casing and parameters are normalised away, exactly as safeContentType does.
  assert.equal(downloadContentType({ isFolder: false, contentType: 'APPLICATION/PDF' }), 'application/pdf');

  for (const type of ['text/html', 'image/svg+xml', 'image/png', 'text/plain', null]) {
    assert.equal(
      downloadContentType({ isFolder: false, contentType: type }),
      'application/octet-stream',
      String(type)
    );
  }
});

test('kindOf: office files wear the document icon', () => {
  for (const type of [DOCX, PPTX, XLSX, 'application/vnd.ms-excel']) {
    assert.equal(kindOf({ isFolder: false, contentType: type }), 'document', type);
  }
  // ...and so do the ones we only recognise by extension.
  for (const name of ['deck.pptx', 'marks.xlsx', 'old.xls', 'slides.odp', 'sheet.ods']) {
    assert.equal(kindOf({ isFolder: false, contentType: null, name }), 'document', name);
  }
});

test('safeContentType: an office file is still a download, not a document', () => {
  // /content/* is unchanged by any of this: only /download/* may say docx.
  for (const type of [DOCX, PPTX, XLSX, 'application/msword']) {
    assert.equal(safeContentType(type), 'application/octet-stream', type);
  }
});
