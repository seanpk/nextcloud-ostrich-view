/**
 * What a file is, and what we are allowed to do with it.
 *
 * One table answers three questions, so their answers cannot drift apart:
 *
 *   kind     which icon a tile wears
 *   serveAs  the Content-Type `/content/*` may hand the browser; anything not
 *            in the table is served as application/octet-stream
 *   renders  whether a browser actually paints it -- i.e. whether a tile links
 *            to `/view/` and the viewer picks an image/pdf mode
 *
 * Two rules are encoded here, and both matter:
 *
 *  - Nothing script-capable gets a `serveAs`. `Content-Disposition: inline`
 *    plus an attacker-chosen `text/html` (or `image/svg+xml`, which can carry
 *    script) would be a same-origin XSS on our app, and anyone the owner shares a
 *    folder with can put a file in that folder.
 *  - `renders` is a strict subset of `serveAs`. A tile may only link to
 *    `/view/` when `/content/` will serve the bytes as something the browser
 *    can paint; otherwise the link leads to a broken <img>. SVG and TIFF are
 *    defanged to octet-stream, and HEIC is served honestly but no desktop
 *    browser decodes it, so all three keep the flat icon and get the calm
 *    "we can't show this one" page if someone arrives by URL.
 *
 * Both answers come from the content type Nextcloud reports, never from the
 * file name: a `.pdf` that PROPFIND calls octet-stream is served as
 * octet-stream, so it must not be linked as a document either. The extension
 * map below only picks an icon when there is no content type at all.
 */

/** @typedef {'folder'|'image'|'pdf'|'document'|'file'} Kind */

const TYPES = new Map([
  // Painted by every browser this app will ever meet.
  ['image/png', { kind: 'image', serveAs: 'image/png', renders: true }],
  ['image/jpeg', { kind: 'image', serveAs: 'image/jpeg', renders: true }],
  ['image/gif', { kind: 'image', serveAs: 'image/gif', renders: true }],
  ['image/webp', { kind: 'image', serveAs: 'image/webp', renders: true }],
  ['image/avif', { kind: 'image', serveAs: 'image/avif', renders: true }],
  ['application/pdf', { kind: 'pdf', serveAs: 'application/pdf', renders: true }],
  // Safe to hand over as themselves, but not something to send her to:
  // Chrome and Firefox cannot decode HEIC/HEIF, and BMP is only ever a
  // surprise. They stream correctly if something else asks for the bytes.
  ['image/bmp', { kind: 'image', serveAs: 'image/bmp' }],
  ['image/heic', { kind: 'image', serveAs: 'image/heic' }],
  ['image/heif', { kind: 'image', serveAs: 'image/heif' }],
  // Inert, and worth serving as text so a shared note is readable at all.
  ['text/plain', { kind: 'document', serveAs: 'text/plain; charset=utf-8' }],
]);

/** Icon-only fallback for entries Nextcloud reports no content type for. */
const EXTENSION_KINDS = new Map([
  ['png', 'image'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['gif', 'image'],
  ['webp', 'image'],
  ['heic', 'image'],
  ['pdf', 'pdf'],
  ['doc', 'document'],
  ['docx', 'document'],
  ['odt', 'document'],
  ['txt', 'document'],
  ['md', 'document'],
]);

/** `IMAGE/PNG; charset=binary` -> `image/png`. */
function normalizeType(raw) {
  return String(raw ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * `"cell diagram.PNG"` -> `"png"`; `""` when there is no usable extension (a
 * dotfile's leading dot and a trailing dot are both "no extension").
 *
 * Exported because the mock's dataset loader infers content types the same way,
 * and two copies of this three-line rule is two chances to disagree about
 * `archive.tar.gz` or `LICENSE`.
 */
export function extensionOf(name) {
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return '';
  return text.slice(dot + 1).toLowerCase();
}

/**
 * Decide what Content-Type to serve a proxied file as. Everything we don't
 * positively recognise becomes application/octet-stream.
 *
 * @param {string|null|undefined} raw the type Nextcloud reported
 * @returns {string}
 */
export function safeContentType(raw) {
  const type = normalizeType(raw);
  // Images we don't list are still images: octet-stream keeps them inert
  // without pretending we know what they are.
  return TYPES.get(type)?.serveAs ?? 'application/octet-stream';
}

/**
 * Coarse kind, used to pick an icon. Unlike `rendersInline` this is generous:
 * an unlisted `image/*` still looks like a picture on the tile grid, it just
 * doesn't become a link.
 *
 * @param {{isFolder?: boolean, contentType?: string|null, name?: string}} entry
 * @returns {Kind}
 */
export function kindOf(entry) {
  if (entry?.isFolder) return 'folder';
  const type = normalizeType(entry?.contentType);
  const rule = TYPES.get(type);
  if (rule) return rule.kind;
  if (type.startsWith('image/')) return 'image';
  return EXTENSION_KINDS.get(extensionOf(entry?.name ?? '')) ?? 'file';
}

/**
 * Will a browser paint this file if we stream it from `/content/`? True only
 * for the types the table says we serve honestly *and* every browser renders,
 * which is what keeps a `/view/` link from ever landing on a broken image.
 *
 * @param {{isFolder?: boolean, contentType?: string|null}} entry
 * @returns {boolean}
 */
export function rendersInline(entry) {
  if (!entry || entry.isFolder) return false;
  return Boolean(TYPES.get(normalizeType(entry.contentType))?.renders);
}

/** The table itself, for tests that want to assert its invariants. */
export { TYPES as FILE_TYPES };
