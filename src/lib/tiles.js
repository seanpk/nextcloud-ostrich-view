import { encodePath } from './paths.js';
import { kindOf, rendersInline } from './filetypes.js';
import { isValidEtag, isValidFileId } from '../nextcloud/previews.js';

/**
 * View-model for a "big button" tile.
 *
 * M2 filled in the two seams M1 left here:
 *  - `previewUrl` points at `/preview/<fileId>?v=<etag>`, so the template swaps
 *    the flat icon for a real thumbnail;
 *  - `href` points file tiles at `/view/<path>` for the files we can actually
 *    show inline -- which is `rendersInline`'s decision, taken from the same
 *    table `/content/*` reads to choose a Content-Type, so a tile can never
 *    link to something the proxy will defang into a download.
 *
 * Only kinds Nextcloud reliably renders a thumbnail for get a `previewUrl`.
 * PDFs deliberately do not: Nextcloud ships with `OC\Preview\PDF` disabled, so
 * every PDF tile would be a round trip that 404s and falls back to the icon
 * anyway. If that provider is ever enabled, add 'pdf' to PREVIEWABLE_KINDS and
 * nothing else needs to change.
 */

const ICONS = {
  folder: '/public/icons/folder.svg',
  image: '/public/icons/image.svg',
  pdf: '/public/icons/pdf.svg',
  document: '/public/icons/document.svg',
  file: '/public/icons/file.svg',
};

/** Human-friendly size, or null for folders / unknown. */
function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Kinds worth asking Nextcloud for a thumbnail of. */
const PREVIEWABLE_KINDS = new Set(['image']);

/**
 * `/preview/<fileId>?v=<etag>&k=<kind>`, or null when we can't build a usable
 * one. The etag is what makes the URL change when the file does, so the
 * browser may cache it for a day; `k` only picks which bundled SVG the route
 * redirects to when Nextcloud has no thumbnail to give.
 *
 * Both ids are checked against the preview route's own validators rather than
 * assumed well-formed: emitting a URL the route would reject with a 400 would
 * turn one odd etag into a broken image.
 */
function previewUrlFor(entry, kind) {
  if (entry.isFolder || !PREVIEWABLE_KINDS.has(kind)) return null;
  const fileId = entry.fileId === null || entry.fileId === undefined ? '' : String(entry.fileId);
  const etag = entry.etag ?? '';
  if (!isValidFileId(fileId) || !isValidEtag(etag)) return null;
  return `/preview/${fileId}?v=${etag}&k=${kind}`;
}

/**
 * Turn a PROPFIND entry into a tile.
 *
 * Folders link into `/files/...`; images and PDFs link into `/view/...`.
 * Anything else keeps `href: null` and renders as a plain label -- M1's visual
 * language for "this is here, but there is nothing to tap". (`/view/` still
 * answers for those paths with a calm "we can't show this one" page if someone
 * arrives by URL.)
 *
 * The same function feeds "new since you last looked": those entries come from
 * `search.js` in the identical `parseMultistatus` shape, and `buildNewSince`
 * (src/lib/new-since.js) only adds a `folderLabel` on top, which the tile macro
 * renders in place of `sizeLabel`. Everything else -- previewUrl included --
 * comes out of here unchanged, which is why a new-since tile and a folder tile
 * behave identically.
 *
 * @param {object} entry from `parsePropfind`
 * @returns {{name:string, path:string, isFolder:boolean, kind:string,
 *            href:string|null, icon:string, previewUrl:string|null,
 *            sizeLabel:string|null, fileId:number|null}}
 */
export function toTile(entry) {
  const kind = kindOf(entry);
  const encoded = encodePath(entry.path);

  let href = null;
  if (entry.isFolder) href = `/files/${encoded}`;
  else if (rendersInline(entry)) href = `/view/${encoded}`;

  return {
    name: entry.name,
    path: entry.path,
    isFolder: entry.isFolder,
    kind,
    href,
    icon: ICONS[kind] ?? ICONS.file,
    previewUrl: previewUrlFor(entry, kind),
    sizeLabel: entry.isFolder ? null : formatSize(entry.size),
    fileId: entry.fileId,
  };
}

/** @param {object[]} entries */
export function toTiles(entries) {
  return entries.map(toTile);
}

export { ICONS };
