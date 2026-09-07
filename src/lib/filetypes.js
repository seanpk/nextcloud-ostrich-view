/**
 * What a file is, and what we are allowed to do with it.
 *
 * One table answers five questions, so their answers cannot drift apart:
 *
 *   kind     which icon a tile wears
 *   serveAs  the Content-Type `/content/*` may hand the browser; anything not
 *            in the table is served as application/octet-stream
 *   renders  whether a browser actually paints it -- i.e. whether a tile links
 *            to `/view/` and the viewer picks an image/pdf mode
 *   converts whether we can turn the bytes into HTML ourselves rather than ask
 *            the browser to paint them (`'docx'` is the only converter we have)
 *   download whether the viewer page should offer the original as a file to
 *            keep, because we cannot show its real layout on screen
 *
 * Four rules are encoded here, and all four matter:
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
 *  - `converts` never coexists with `serveAs`. A DOCX is never handed to the
 *    browser as itself; `/view/` reads the bytes server-side and renders
 *    sanitized HTML (src/lib/office.js), so `/content/` has no reason to call
 *    a Word document anything but octet-stream.
 *  - `download` is the one place a real office MIME is allowed out, and only
 *    ever with `Content-Disposition: attachment` (see `/download/*` in
 *    src/routes/media.js). A browser never renders an attachment, so the XSS
 *    argument that keeps HTML and SVG out of `serveAs` does not apply -- what
 *    matters instead is that the phone hands the file to the right app.
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
  // Painted inline *and* worth keeping: a PDF is the one type we can both
  // show and hand over, and the layout she sees is the real one either way.
  ['application/pdf', { kind: 'pdf', serveAs: 'application/pdf', renders: true, download: true }],
  // Safe to hand over as themselves, but not something to send her to:
  // Chrome and Firefox cannot decode HEIC/HEIF, and BMP is only ever a
  // surprise. They stream correctly if something else asks for the bytes.
  ['image/bmp', { kind: 'image', serveAs: 'image/bmp' }],
  ['image/heic', { kind: 'image', serveAs: 'image/heic' }],
  ['image/heif', { kind: 'image', serveAs: 'image/heif' }],
  // Inert, and worth serving as text so a shared note is readable at all.
  ['text/plain', { kind: 'document', serveAs: 'text/plain; charset=utf-8' }],

  // --- office files ---------------------------------------------------------
  //
  // None of these gets a `serveAs`: a DOCX handed to a browser as itself is a
  // download prompt at best, and the legacy formats are macro carriers. What
  // they get instead is `download: true` -- the viewer page offers the
  // original, so whoever wants the real layout can open it in Word, Pages or
  // Google Docs -- and, for DOCX alone, `converts: 'docx'`, which is what
  // makes the words appear on the page (src/lib/office.js).
  //
  // DOCX is the only converter because it is the only one with a trustworthy
  // pure-JS renderer. XLSX-as-a-table is a plausible follow-up; PPTX has no
  // good answer short of LibreOffice, which this app deliberately does not run.
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { kind: 'document', converts: 'docx', download: true },
  ],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    { kind: 'document', download: true },
  ],
  [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    { kind: 'document', download: true },
  ],
  ['application/msword', { kind: 'document', download: true }],
  ['application/vnd.ms-powerpoint', { kind: 'document', download: true }],
  ['application/vnd.ms-excel', { kind: 'document', download: true }],
  ['application/vnd.oasis.opendocument.text', { kind: 'document', download: true }],
  ['application/vnd.oasis.opendocument.presentation', { kind: 'document', download: true }],
  ['application/vnd.oasis.opendocument.spreadsheet', { kind: 'document', download: true }],
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
  ['ppt', 'document'],
  ['pptx', 'document'],
  ['xls', 'document'],
  ['xlsx', 'document'],
  ['odt', 'document'],
  ['odp', 'document'],
  ['ods', 'document'],
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

/**
 * Can we turn these bytes into HTML ourselves? `'docx'` names the converter to
 * use (src/lib/office.js); null means we cannot.
 *
 * Read from the content type only, never the file name -- the same rule as
 * `rendersInline`, and for the same reason: a `.docx` that PROPFIND calls
 * octet-stream is something else wearing a familiar extension, and feeding it
 * to a zip parser is not how this app finds out what.
 *
 * @param {{isFolder?: boolean, contentType?: string|null}} entry
 * @returns {'docx'|null}
 */
export function convertsInline(entry) {
  if (!entry || entry.isFolder) return null;
  return TYPES.get(normalizeType(entry.contentType))?.converts ?? null;
}

/**
 * Is there anything to see at `/view/<path>`? True when the browser will paint
 * the file itself, and true when we can convert it into something readable --
 * which is exactly when a tile should become tappable.
 *
 * @param {{isFolder?: boolean, contentType?: string|null}} entry
 * @returns {boolean}
 */
export function canView(entry) {
  return rendersInline(entry) || convertsInline(entry) !== null;
}

/**
 * Should the viewer page offer the original as a file to keep?
 *
 * Only for the types where the answer is genuinely useful: office documents,
 * whose real layout we either approximate (DOCX) or cannot show at all, and
 * PDFs, which someone may want on the phone rather than in a browser tab.
 * Everything else -- an unrecognised binary, a scripted SVG, a HEIC -- keeps
 * the calm "we can't show this one" page with no download button, so a file
 * dropped in a shared folder gains no new way out of this app.
 *
 * @param {{isFolder?: boolean, contentType?: string|null}} entry
 * @returns {boolean}
 */
export function isDownloadable(entry) {
  if (!entry || entry.isFolder) return false;
  return Boolean(TYPES.get(normalizeType(entry.contentType))?.download);
}

/**
 * The Content-Type `/download/*` may send. The real MIME for downloadable
 * types -- which is what makes a phone open a `.docx` in Word rather than in a
 * text editor -- and application/octet-stream for anything else.
 *
 * Handing out `application/msword` is safe here in a way it would not be from
 * `/content/*`, because `/download/*` only ever sends it with
 * `Content-Disposition: attachment`: a browser saves an attachment, it never
 * renders one. See the header comment.
 *
 * @param {{isFolder?: boolean, contentType?: string|null}} entry
 * @returns {string}
 */
export function downloadContentType(entry) {
  if (!isDownloadable(entry)) return 'application/octet-stream';
  return normalizeType(entry.contentType);
}

/** The table itself, for tests that want to assert its invariants. */
export { TYPES as FILE_TYPES };
