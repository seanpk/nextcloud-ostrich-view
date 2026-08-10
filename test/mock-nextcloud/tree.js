/**
 * In-memory fixture tree for the mock Nextcloud.
 *
 * Shaped like what the owner would actually share: a couple of course folders, a
 * nested sub-folder, a unicode name and a name with spaces (the two things that
 * break naive URL handling), plus the file types M2 will need to preview.
 *
 * Files carry `bytes` so M2 can serve real content from the same fixture
 * without reshaping the tree.
 */

export const DEFAULT_TREE = {
  'Biology 101': {
    type: 'folder',
    children: {
      Lectures: {
        type: 'folder',
        children: {
          'Week 1 Notes.pdf': { type: 'file', contentType: 'application/pdf', size: 182_344 },
          'Week 2 Notes.pdf': { type: 'file', contentType: 'application/pdf', size: 201_100 },
          'cell diagram.png': { type: 'file', contentType: 'image/png', size: 44_210 },
        },
      },
      'Lab Reports': {
        type: 'folder',
        children: {
          'Report 1.pdf': { type: 'file', contentType: 'application/pdf', size: 98_400 },
          'microscope.jpg': { type: 'file', contentType: 'image/jpeg', size: 302_991 },
        },
      },
      'syllabus.pdf': { type: 'file', contentType: 'application/pdf', size: 55_120 },
    },
  },
  'Math 210': {
    type: 'folder',
    children: {
      'Problem Sets': {
        type: 'folder',
        children: {
          'Set 1.pdf': { type: 'file', contentType: 'application/pdf', size: 71_002 },
        },
      },
      'graph sketch.png': { type: 'file', contentType: 'image/png', size: 21_004 },
    },
  },
  'Café Notes': {
    // Deliberately unicode + accented: exercises percent-encoding end to end.
    type: 'folder',
    children: {
      'résumé draft.pdf': { type: 'file', contentType: 'application/pdf', size: 12_000 },
    },
  },
  'welcome.txt': { type: 'file', contentType: 'text/plain', size: 42 },
};

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

export const FIXED_LAST_MODIFIED = 'Mon, 04 Aug 2025 09:15:00 GMT';
