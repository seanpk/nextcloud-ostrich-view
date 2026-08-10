/**
 * Path safety.
 *
 * Every route that accepts a user-supplied path runs it through
 * `normalizeRelPath()` first. The rule is deliberately strict: the result is
 * always a clean, relative, forward-slash path rooted at the viewer account's
 * WebDAV home. Anything that could climb out of that home -- `..`, backslashes,
 * absolute paths, null bytes -- is rejected outright rather than silently
 * sanitised, so a bug upstream turns into a 400 instead of a data leak.
 *
 * NOTE ON DECODING: Fastify (find-my-way) already percent-decodes route params,
 * including the `*` wildcard, so routes pass their params in as-is and
 * `decode` stays false. Decoding a second time would be a vulnerability --
 * `%2e%2e` is a legal (if silly) file name, not a traversal.
 */

export class InvalidPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPathError';
    this.statusCode = 400;
  }
}

// NUL and other C0/C1 control characters have no business in a file name and
// are the classic way to confuse downstream parsers.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function decodeOnce(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InvalidPathError('Path contains a malformed percent-escape.');
  }
}

/**
 * Normalize a user-supplied relative path.
 *
 * @param {string|undefined|null} input raw path, e.g. "Biology 101/Lectures"
 * @param {{ decode?: boolean }} [options] percent-decode first (default false; see note above)
 * @returns {string} normalized path, no leading/trailing slash ('' means the root)
 * @throws {InvalidPathError}
 */
export function normalizeRelPath(input, options = {}) {
  const { decode = false } = options;

  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    throw new InvalidPathError('Path must be a string.');
  }

  let value = decode ? decodeOnce(input) : input;

  if (CONTROL_CHARS.test(value)) {
    throw new InvalidPathError('Path contains control characters.');
  }
  // Windows drive letters (C:\... , C:/...) and other absolute escapes.
  if (/^[a-zA-Z]:/.test(value)) {
    throw new InvalidPathError('Path contains a drive letter.');
  }
  // Backslash is deliberately allowed: it is a legal character in Nextcloud
  // file names (Linux + web uploads) and carries no traversal meaning here --
  // segments are split on '/' only and '..' is matched exactly, so a name
  // like 'Physics\Notes' is just one odd-looking WebDAV segment.

  const out = [];
  for (const segment of value.split('/')) {
    // Collapse '//', './' and any leading/trailing slash.
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new InvalidPathError('Path traversal ("..") is not allowed.');
    }
    out.push(segment);
  }

  return out.join('/');
}

/**
 * Split a normalized path into segments. '' -> [].
 * @param {string} normalized
 * @returns {string[]}
 */
export function pathSegments(normalized) {
  return normalized === '' ? [] : normalized.split('/');
}

/**
 * Percent-encode a normalized path for use in a URL, one segment at a time so
 * that `/` stays a separator while spaces and unicode are escaped properly.
 * @param {string} normalized
 * @returns {string}
 */
export function encodePath(normalized) {
  return pathSegments(normalized).map(encodeURIComponent).join('/');
}

/**
 * Parent of a normalized path. '' and single segments both yield ''.
 * @param {string} normalized
 * @returns {string}
 */
export function parentPath(normalized) {
  const segments = pathSegments(normalized);
  segments.pop();
  return segments.join('/');
}

/**
 * Join a normalized parent path with a single child name.
 * The child is validated too, so `..` arriving as a "name" is rejected.
 * @param {string} normalizedParent
 * @param {string} childName
 * @returns {string}
 */
export function joinPath(normalizedParent, childName) {
  const child = normalizeRelPath(childName);
  if (child === '') return normalizedParent;
  return normalizedParent === '' ? child : `${normalizedParent}/${child}`;
}

/**
 * Breadcrumb trail for a normalized path, root first.
 * Each crumb: { name, path, href }. Powers the unobtrusive location line.
 * @param {string} normalized
 * @returns {Array<{name: string, path: string, href: string}>}
 */
export function breadcrumbs(normalized) {
  const crumbs = [{ name: 'Home', path: '', href: '/' }];
  let acc = '';
  for (const segment of pathSegments(normalized)) {
    acc = acc === '' ? segment : `${acc}/${segment}`;
    crumbs.push({ name: segment, path: acc, href: `/files/${encodePath(acc)}` });
  }
  return crumbs;
}
