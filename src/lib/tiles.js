import { encodePath } from './paths.js';

/**
 * View-model for a "big button" tile.
 *
 * M1 renders a name plus a flat SVG icon. M2 adds thumbnails: the seam is
 * `previewUrl` below -- fill it in with `/preview/<fileId>` when the file has a
 * fileId and a previewable content type, and the template will prefer it over
 * `icon` with no other changes.
 */

const IMAGE_TYPES = /^image\//;
const PDF_TYPE = /^application\/pdf$/;

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

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Coarse kind used to pick an icon (and, in M2, to decide previewability).
 * @returns {'folder'|'image'|'pdf'|'document'|'file'}
 */
export function kindOf(entry) {
  if (entry.isFolder) return 'folder';
  const type = entry.contentType ?? '';
  if (IMAGE_TYPES.test(type)) return 'image';
  if (PDF_TYPE.test(type)) return 'pdf';
  return EXTENSION_KINDS.get(extensionOf(entry.name ?? '')) ?? 'file';
}

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

/**
 * Turn a PROPFIND entry into a tile.
 *
 * M1: folders link into `/files/...`; files have no destination yet, so they
 * render as non-interactive tiles. M2 points `href` at `/view/<path>`.
 *
 * @param {object} entry from `parsePropfind`
 * @returns {{name:string, path:string, isFolder:boolean, kind:string,
 *            href:string|null, icon:string, previewUrl:string|null,
 *            sizeLabel:string|null, fileId:number|null}}
 */
export function toTile(entry) {
  const kind = kindOf(entry);
  const encoded = encodePath(entry.path);

  return {
    name: entry.name,
    path: entry.path,
    isFolder: entry.isFolder,
    kind,
    // M2 seam: files get `/view/${encoded}` once the inline viewer exists.
    href: entry.isFolder ? `/files/${encoded}` : null,
    icon: ICONS[kind] ?? ICONS.file,
    // M2 seam: `/preview/${entry.fileId}` for previewable kinds.
    previewUrl: null,
    sizeLabel: entry.isFolder ? null : formatSize(entry.size),
    fileId: entry.fileId,
  };
}

/** @param {object[]} entries */
export function toTiles(entries) {
  return entries.map(toTile);
}

export { ICONS };
