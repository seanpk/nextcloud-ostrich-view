import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * In-memory fixture tree for the mock Nextcloud.
 *
 * Shaped like what the owner would actually share: a couple of course folders, a
 * nested sub-folder, a unicode name and a name with spaces (the two things that
 * break naive URL handling), plus the file types the viewer previews -- and,
 * alongside them, the unmarked skeleton content (`Documents`, `Photos`, etc.)
 * a freshly created Nextcloud account seeds itself with, which the app must
 * never show. See `sharedBy` / `shareOwnerOf` below.
 *
 * Every file carries real `bytes` (see assets/, and assets/generate.mjs for how
 * they were made), so `/content/*` and the pdf.js viewer are exercised against
 * genuine PNG/JPEG/PDF data rather than placeholders. `size` is derived from
 * the bytes so `oc:size` and `Content-Length` can never disagree.
 */

const ASSETS = join(fileURLToPath(new URL('.', import.meta.url)), 'assets');

const SAMPLE = {
  // ~215 KB and two pages: comfortably past pdf.js's 64 KB range-chunk
  // threshold, so opening it really does issue Range requests.
  pdf: readFileSync(join(ASSETS, 'sample.pdf')),
  png: readFileSync(join(ASSETS, 'sample.png')),
  jpg: readFileSync(join(ASSETS, 'sample.jpg')),
};

/**
 * @param {string} contentType
 * @param {Buffer} bytes
 * @param {{lastModified?: string}} [extra] per-file overrides; `lastModified`
 *   is an HTTP-date and is what M4's SEARCH filter sorts and compares on.
 */
function file(contentType, bytes, extra = {}) {
  return { type: 'file', contentType, bytes, size: bytes.length, ...extra };
}

const pdf = (extra) => file('application/pdf', SAMPLE.pdf, extra);
const png = (extra) => file('image/png', SAMPLE.png, extra);
const jpg = (extra) => file('image/jpeg', SAMPLE.jpg, extra);

/**
 * Stand-in thumbnail bytes for a PDF preview, when `createMockNextcloud({
 * pdfPreviews: true })` is simulating Imaginary. A real Imaginary render is a
 * scaled rasterization of the PDF's first page; the app only cares that it
 * gets back real, sniffable image bytes, so the mock hands over this instead
 * of actually rasterizing anything.
 */
export const SAMPLE_PDF_THUMBNAIL = SAMPLE.png;

/**
 * An SVG carrying script, because someone the owner shares a folder with can put
 * one there. It is an `image/*`, so anything keying off "is this an image"
 * would offer it inline -- and inline SVG on our own origin is script on our
 * own origin. The suite asserts it is served as a download and never linked.
 */
const svg = () =>
  file(
    'image/svg+xml',
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="pwned"</script></svg>',
      'utf8'
    )
  );

/**
 * Modification times.
 *
 * Most of the tree shares one stamp, so tests can say "nothing has changed"
 * without listing files. The two RECENT/NEWEST ones exist for M4: a visit
 * timestamp between FIXED and RECENT makes exactly those two files "new", which
 * is what the SEARCH filter and the walk fallback are asserted against.
 *
 * HTTP-dates, because that is what `d:getlastmodified` carries on the wire.
 */
export const FIXED_LAST_MODIFIED = 'Mon, 04 Aug 2025 09:15:00 GMT';
export const RECENT_LAST_MODIFIED = 'Wed, 06 Aug 2025 18:30:00 GMT';
export const NEWEST_LAST_MODIFIED = 'Thu, 07 Aug 2025 07:05:00 GMT';

/** The (fictional) owner who shares folders with the viewer account. */
export const SHARE_OWNER = 'liam';

export const DEFAULT_TREE = {
  'Biology 101': {
    type: 'folder',
    // Every top-level node the owner actually shared carries `sharedBy` --
    // see shareOwnerOf() below, and ../../src/nextcloud/shares.js, which is
    // what reads this signal (as oc:owner-id / oc:permissions) in the real app.
    sharedBy: SHARE_OWNER,
    children: {
      Lectures: {
        type: 'folder',
        children: {
          'Week 1 Notes.pdf': pdf(),
          // Two files the owner touched after the fixture's "last visit" -- what
          // M4's "New since you last looked" section is expected to surface.
          // One of each: a PDF (flat icon) and a photo (real thumbnail).
          'Week 2 Notes.pdf': pdf({ lastModified: RECENT_LAST_MODIFIED }),
          'cell diagram.png': png(),
          'mitosis.svg': svg(),
        },
      },
      'Lab Reports': {
        type: 'folder',
        children: {
          'Report 1.pdf': pdf(),
          'microscope.jpg': jpg({ lastModified: NEWEST_LAST_MODIFIED }),
        },
      },
      'syllabus.pdf': pdf(),
    },
  },
  'Math 210': {
    type: 'folder',
    sharedBy: SHARE_OWNER,
    children: {
      'Problem Sets': {
        type: 'folder',
        children: {
          'Set 1.pdf': pdf(),
        },
      },
      'graph sketch.png': png(),
    },
  },
  'Café Notes': {
    // Deliberately unicode + accented: exercises percent-encoding end to end.
    type: 'folder',
    sharedBy: SHARE_OWNER,
    children: {
      'résumé draft.pdf': pdf(),
    },
  },
  'welcome.txt': file('text/plain', Buffer.from('Hello from the mock Nextcloud.\n', 'utf8'), {
    sharedBy: SHARE_OWNER,
  }),

  // Nextcloud seeds a brand-new account with content like this the first time
  // it logs in (README §1 step 2 requires that login) -- unmarked (no
  // `sharedBy`), exactly as the account's own storage would be. The app is
  // expected to hide all of it from the home page; see shares.test.js and
  // home-route.test.js.
  Documents: {
    type: 'folder',
    children: {
      'Example.md': file('text/markdown', Buffer.from('# Nextcloud\n', 'utf8')),
    },
  },
  Photos: {
    type: 'folder',
    children: {
      // Recent on purpose: proves skeleton content is kept out of "New since
      // you last looked" too, not just out of the folder grid.
      'Frog.jpg': jpg({ lastModified: NEWEST_LAST_MODIFIED }),
    },
  },
  Templates: {
    type: 'folder',
    children: {
      'Letter.odt': file(
        'application/vnd.oasis.opendocument.text',
        Buffer.from('placeholder', 'utf8')
      ),
    },
  },
  'Nextcloud.png': png(),
  'Readme.md': file('text/markdown', Buffer.from('# Welcome\n', 'utf8')),
  'Nextcloud Manual.pdf': pdf(),
};

/**
 * Every file in the tree, keyed by the fileId the PROPFIND response advertises.
 * The preview endpoint is addressed by id, not path, so it needs this.
 *
 * @param {object} tree
 * @returns {Map<number, {path: string, node: object}>}
 */
export function indexByFileId(tree) {
  const index = new Map();
  const walk = (children, prefix) => {
    for (const [name, node] of Object.entries(children ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      index.set(fakeFileId(path), { path, node });
      if (node.type === 'folder') walk(node.children, path);
    }
  };
  walk(tree, '');
  return index;
}

/**
 * The uid of the share `relPath` lives in, or null for the account's own
 * content. Ownership is set once, on the top-level entry, and inherited by
 * everything under it -- there is no per-subfolder override, matching how a
 * real Nextcloud share works (you share the folder, not each file in it).
 *
 * `''` (the root itself) is always null: the root is the account's own DAV
 * home, never a share of itself.
 *
 * @param {object} tree
 * @param {string} relPath decoded, e.g. "Biology 101/Lectures"
 * @returns {string|null}
 */
export function shareOwnerOf(tree, relPath) {
  if (!relPath) return null;

  // Walks the path rather than reading only its first segment, so a share can
  // be mounted below the top -- which is what an instance with `share_folder`
  // set actually does (`/Shared/Family`). Real Nextcloud flags the mount point
  // and everything beneath it, so the SHALLOWEST `sharedBy` on the path wins
  // and children inherit it. A top-level mount still resolves on the first
  // segment, exactly as before.
  let children = tree;
  for (const segment of relPath.split('/')) {
    const node = children?.[segment];
    if (!node) return null;
    if (node.sharedBy) return node.sharedBy;
    children = node.children;
  }
  return null;
}

/**
 * Walk to a node by relative path. Returns null when it doesn't exist.
 * @param {object} tree
 * @param {string} relPath decoded, e.g. "Biology 101/Lectures"
 */
export function resolveNode(tree, relPath) {
  if (relPath === '') return { type: 'folder', children: tree };

  let node = { type: 'folder', children: tree };
  for (const segment of relPath.split('/')) {
    if (node.type !== 'folder') return null;
    const next = node.children?.[segment];
    if (!next) return null;
    node = next;
  }
  return node;
}

/**
 * Stable, fake-but-plausible ids and etags derived from the path, so tests can
 * assert on them and M2's preview cache keys stay deterministic.
 */
export function fakeFileId(relPath) {
  let hash = 2166136261;
  for (let i = 0; i < relPath.length; i += 1) {
    hash ^= relPath.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 900000 + 100000;
}

export function fakeEtag(relPath) {
  return fakeFileId(relPath).toString(16).padStart(8, '0') + 'abcd';
}

/** A node's modification time; everything unstamped shares FIXED_LAST_MODIFIED. */
export function lastModifiedOf(node) {
  return node?.lastModified ?? FIXED_LAST_MODIFIED;
}

/**
 * Stamp one file as modified at `httpDate`, so a test can say "the owner added this
 * while she was away" without rebuilding the whole tree.
 *
 * Mutates in place (the mock holds the same object), and returns the node so a
 * caller can assert it found the right one.
 *
 * @param {object} tree
 * @param {string} relPath e.g. "Biology 101/Lectures/Week 2 Notes.pdf"
 * @param {string} httpDate e.g. "Thu, 07 Aug 2025 07:05:00 GMT"
 */
export function setLastModified(tree, relPath, httpDate) {
  const node = resolveNode(tree, relPath);
  if (!node || node.type === 'folder') {
    throw new Error(`setLastModified: no file at ${relPath}`);
  }
  node.lastModified = httpDate;
  return node;
}

/** Every file in the tree as `{path, node}`, depth-first. */
export function walkFiles(tree) {
  const files = [];
  const visit = (children, prefix) => {
    for (const [name, node] of Object.entries(children ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (node.type === 'folder') visit(node.children, path);
      else files.push({ path, node });
    }
  };
  visit(tree, '');
  return files;
}
