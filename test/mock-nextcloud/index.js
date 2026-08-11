import { createServer } from 'node:http';

import {
  DEFAULT_TREE,
  fakeEtag,
  fakeFileId,
  indexByFileId,
  lastModifiedOf,
  resolveNode,
  walkFiles,
} from './tree.js';
import { CALENDAR_FIXTURES, handleCalendarRequest } from './calendars.js';

/**
 * Mock Nextcloud.
 *
 * Speaks just enough WebDAV for the app: Depth-1 PROPFIND over an in-memory
 * tree, with Basic auth enforced. The response XML mirrors what a real
 * Nextcloud 28+ emits, prefixes and all (including the empty second propstat
 * for properties the server doesn't have), so the parser is exercised against
 * realistic input rather than something tidied up for our convenience.
 *
 * M2 added two more things it has to be honest about:
 *  - `GET` on a DAV path serves the node's real bytes, and implements a single
 *    byte range, because pdf.js will not open a large document without one;
 *  - `/index.php/core/preview` behaves like a default Nextcloud: it renders
 *    thumbnails for images and answers 404 for everything else (the PDF
 *    preview provider is off by default), which is exactly the case the icon
 *    fallback exists for.
 *
 * M4 added the third verb: `SEARCH` on `/remote.php/dav/`, parsing just enough
 * of the `d:basicsearch` body to honour the scope, the `getlastmodified`
 * comparison and the result limit. `createMockNextcloud({ searchStatus: 405 })`
 * turns it into a server that refuses SEARCH, which is how the walk fallback
 * gets tested against something that behaves like a real refusal.
 *
 * EXTENSION POINTS
 *  - M3 (done): `/remote.php/dav/calendars/<user>/` PROPFIND and `REPORT` live
 *    in calendars.js and are dispatched from `handle`.
 */

export const TEST_USER = 'ostrich-viewer';
export const TEST_APP_PASSWORD = 'test-app-password-not-real';

function davRootFor(user) {
  return `/remote.php/dav/files/${user}`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Percent-encode each segment, as a real server does in <d:href>. */
function encodeHref(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function checkAuth(req, user, password) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;
  return decoded.slice(0, separator) === user && decoded.slice(separator + 1) === password;
}

function responseXmlFor(davRoot, relPath, node) {
  const isFolder = node.type === 'folder';
  // Folders carry a modification time too, and a JSON dataset (dataset.js) may
  // stamp one. Unstamped nodes -- which is every folder in the fixture tree --
  // fall back to FIXED_LAST_MODIFIED exactly as before.
  const lastModified = lastModifiedOf(node);
  const href = `${davRoot}${relPath ? '/' + encodeHref(relPath) : ''}${isFolder ? '/' : ''}`;
  const id = fakeFileId(relPath === '' ? '/' : relPath);
  const etag = fakeEtag(relPath === '' ? '/' : relPath);
  const size = isFolder ? 4096 : (node.size ?? 0);

  const resourcetype = isFolder ? '<d:collection/>' : '';
  // Real Nextcloud omits getcontenttype for collections and reports it as a
  // "not found" property in a second propstat block.
  const contentTypeProp = isFolder
    ? ''
    : `<d:getcontenttype>${xmlEscape(node.contentType ?? 'application/octet-stream')}</d:getcontenttype>`;

  const notFoundBlock = isFolder
    ? `      <d:propstat>
        <d:prop><d:getcontenttype/></d:prop>
        <d:status>HTTP/1.1 404 Not Found</d:status>
      </d:propstat>
`
    : '';

  return `    <d:response>
      <d:href>${xmlEscape(href)}</d:href>
      <d:propstat>
        <d:prop>
          <oc:fileid>${id}</oc:fileid>
          <d:getlastmodified>${lastModified}</d:getlastmodified>
          ${contentTypeProp}
          <d:resourcetype>${resourcetype}</d:resourcetype>
          <oc:size>${size}</oc:size>
          <d:getetag>&quot;${etag}&quot;</d:getetag>
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
${notFoundBlock}    </d:response>`;
}

/**
 * Build a 207 multistatus body for a Depth-1 PROPFIND.
 * The first entry is always the collection itself -- exactly the thing the
 * parser has to skip.
 */
export function buildMultistatus({ davRoot, relPath, node }) {
  const parts = [responseXmlFor(davRoot, relPath, node)];

  if (node.type === 'folder') {
    for (const [name, child] of Object.entries(node.children ?? {})) {
      const childPath = relPath === '' ? name : `${relPath}/${name}`;
      parts.push(responseXmlFor(davRoot, childPath, child));
    }
  }

  return wrapMultistatus(parts);
}

function wrapMultistatus(parts) {
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
${parts.join('\n')}
</d:multistatus>
`;
}

/**
 * A 207 for a SEARCH: a flat list of results, with no self entry and no
 * particular relationship between them -- which is exactly the shape the app's
 * parser has to cope with when it reuses `parseMultistatus` for search results.
 *
 * @param {{davRoot: string, files: Array<{path: string, node: object}>}} options
 */
export function buildSearchMultistatus({ davRoot, files }) {
  return wrapMultistatus(files.map(({ path, node }) => responseXmlFor(davRoot, path, node)));
}

/** Nothing this mock is asked to accept is anywhere near this big. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @param {{ tree?: object, calendars?: Array<object>, user?: string, password?: string,
 *           searchStatus?: number|null }} [options]
 *   searchStatus: answer every SEARCH with this status instead of running it.
 *   405 is what a Nextcloud without the search backend sends, and is the case
 *   the app's walk fallback exists for.
 * @returns {{ start: () => Promise<{url: string, port: number}>,
 *             stop: () => Promise<void>,
 *             url: () => string,
 *             requests: Array<{method: string, url: string}>,
 *             setTree: (tree: object) => void,
 *             setSearchStatus: (status: number|null) => void }}
 */
export function createMockNextcloud(options = {}) {
  let tree = options.tree ?? DEFAULT_TREE;
  const calendars = options.calendars ?? CALENDAR_FIXTURES;
  const user = options.user ?? TEST_USER;
  const password = options.password ?? TEST_APP_PASSWORD;
  let searchStatus = options.searchStatus ?? null;
  const davRoot = davRootFor(user);
  const requests = [];

  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });

    // SEARCH is the one verb whose body we actually have to read, so bodies are
    // collected (capped) rather than simply drained.
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });

  function handle(req, res, body) {
    const [rawPath, rawQuery = ''] = req.url.split('?');
    const pathname = decodeURIComponent(rawPath);

    if (!checkAuth(req, user, password)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Nextcloud"',
        'Content-Type': 'text/plain',
      });
      res.end('Unauthorized');
      return;
    }

    // M3: the calendar home answers PROPFIND and REPORT (see calendars.js).
    const calendarRoot = `/remote.php/dav/calendars/${user}`;
    if (pathname === calendarRoot || pathname.startsWith(`${calendarRoot}/`)) {
      handleCalendarRequest(req, res, { pathname, hrefRoot: calendarRoot, calendars });
      return;
    }

    if (req.method === 'SEARCH') {
      handleSearch(req, res, pathname, body);
      return;
    }

    if (req.method === 'PROPFIND') {
      handlePropfind(req, res, pathname);
      return;
    }

    if (req.method === 'GET' && pathname === '/index.php/core/preview') {
      handlePreview(req, res, new URLSearchParams(rawQuery));
      return;
    }

    if (req.method === 'GET') {
      handleGet(req, res, pathname);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, PROPFIND, REPORT, SEARCH' });
    res.end(`Method ${req.method} not implemented by the mock`);
  }

  /**
   * `SEARCH /remote.php/dav/` with a `d:basicsearch` body.
   *
   * Deliberately a shallow parser -- regexes over the body, no XML machinery.
   * Its job is to be strict about the things the app could plausibly get wrong
   * (the endpoint, the scope, the date literal's format) and indifferent to the
   * rest, so the test tells us "the request was wrong" rather than quietly
   * passing whatever we happened to send.
   */
  function handleSearch(req, res, pathname, body) {
    if (searchStatus !== null) {
      // A Nextcloud without the search backend. 405 carries an Allow header.
      res.writeHead(searchStatus, {
        'Content-Type': 'text/plain',
        Allow: 'GET, PROPFIND, REPORT',
      });
      res.end('SEARCH is not supported by this server');
      return;
    }

    if (pathname.replace(/\/+$/, '') !== '/remote.php/dav') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('SEARCH is only supported on the DAV endpoint');
      return;
    }

    const scope = decodeURIComponent(/<[^:>]*:?scope>[\s\S]*?<[^:>]*:?href>([^<]*)</.exec(body)?.[1] ?? '');
    if (scope.replace(/\/+$/, '') !== `/files/${user}`) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Unknown search scope: ${scope}`);
      return;
    }

    const literal = /<[^:>]*:?literal>([^<]*)</.exec(body)?.[1] ?? '';
    // Nextcloud parses this with DateTime::createFromFormat(ATOM, …) and treats
    // anything else as timestamp 0 -- i.e. "match everything". Being strict here
    // is the only way a wrongly-formatted literal shows up as a test failure
    // instead of a suspiciously generous result set.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(literal)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Unparseable date literal: ${literal}`);
      return;
    }

    const sinceMs = Date.parse(literal);
    const limit = Number(/<[^:>]*:?nresults>(\d+)</.exec(body)?.[1] ?? '50');

    const matches = walkFiles(tree)
      .filter(({ node }) => Date.parse(lastModifiedOf(node)) > sinceMs)
      .sort((a, b) => Date.parse(lastModifiedOf(b.node)) - Date.parse(lastModifiedOf(a.node)))
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50);

    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(buildSearchMultistatus({ davRoot: davRoot.replace(/\/+$/, ''), files: matches }));
  }

  /**
   * `Range: bytes=a-b`. One range only -- which is all pdf.js ever asks for,
   * and all real Nextcloud reliably answers.
   * @returns {{start: number, end: number}|null|'unsatisfiable'}
   */
  function parseRange(header, length) {
    if (typeof header !== 'string') return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;

    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') return null;

    let start;
    let end;
    if (rawStart === '') {
      // Suffix range: the last N bytes.
      const suffix = Number(rawEnd);
      if (suffix === 0) return 'unsatisfiable';
      start = Math.max(0, length - suffix);
      end = length - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? length - 1 : Math.min(Number(rawEnd), length - 1);
    }
    if (start > end || start >= length) return 'unsatisfiable';
    return { start, end };
  }

  function handleGet(req, res, pathname) {
    const normalized = pathname.replace(/\/+$/, '');
    const rootNormalized = davRoot.replace(/\/+$/, '');

    if (!normalized.startsWith(`${rootNormalized}/`)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const relPath = normalized.slice(rootNormalized.length + 1);
    const node = resolveNode(tree, relPath);
    if (!node || node.type === 'folder' || !node.bytes) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const bytes = node.bytes;
    const headers = {
      'Content-Type': node.contentType ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ETag: `"${fakeEtag(relPath)}"`,
      'Last-Modified': lastModifiedOf(node),
    };

    const range = parseRange(req.headers.range, bytes.length);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}` });
      res.end();
      return;
    }
    if (range) {
      const slice = bytes.subarray(range.start, range.end + 1);
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}`,
        'Content-Length': String(slice.length),
      });
      res.end(slice);
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': String(bytes.length) });
    res.end(bytes);
  }

  /**
   * Stand-in for `/index.php/core/preview`. Images get a thumbnail; everything
   * else 404s, the way a stock Nextcloud does for PDFs.
   */
  function handlePreview(req, res, params) {
    const fileId = Number(params.get('fileId'));
    if (!Number.isInteger(fileId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad fileId');
      return;
    }

    const found = indexByFileId(tree).get(fileId);
    if (!found || found.node.type === 'folder' || !found.node.bytes) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No preview');
      return;
    }
    if (!String(found.node.contentType ?? '').startsWith('image/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No preview provider');
      return;
    }

    // The real endpoint scales the image; the app only cares that it gets
    // image bytes back, so hand over the original.
    res.writeHead(200, {
      'Content-Type': found.node.contentType,
      'Content-Length': String(found.node.bytes.length),
    });
    res.end(found.node.bytes);
  }

  function handlePropfind(req, res, pathname) {
    const normalized = pathname.replace(/\/+$/, '');
    const rootNormalized = davRoot.replace(/\/+$/, '');

    if (normalized !== rootNormalized && !normalized.startsWith(`${rootNormalized}/`)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const relPath = normalized === rootNormalized ? '' : normalized.slice(rootNormalized.length + 1);
    const node = resolveNode(tree, relPath);

    if (!node) {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0"?><d:error xmlns:d="DAV:"><s:message>File not found</s:message></d:error>');
      return;
    }

    if (node.type !== 'folder') {
      // Depth-1 on a file is legal and returns just the file itself.
      const xml = buildMultistatus({ davRoot: rootNormalized, relPath, node });
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(xml);
      return;
    }

    const depth = req.headers.depth ?? '1';
    const xml = buildMultistatus({
      davRoot: rootNormalized,
      relPath,
      node: depth === '0' ? { ...node, children: {} } : node,
    });
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
  }

  let boundPort = null;

  return {
    requests,
    setTree(next) {
      tree = next;
    },
    /**
     * Change how SEARCH answers, mid-run. `null` runs the real thing again.
     * Lets one test play "SEARCH was having a bad minute, and then wasn't" --
     * the case the app's transient/structural distinction exists for.
     */
    setSearchStatus(next) {
      searchStatus = next ?? null;
    },
    url() {
      if (boundPort === null) throw new Error('Mock Nextcloud is not started');
      return `http://127.0.0.1:${boundPort}`;
    },
    /** Listen on an ephemeral port. */
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          boundPort = server.address().port;
          resolve({ port: boundPort, url: `http://127.0.0.1:${boundPort}` });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (boundPort === null) return resolve();
        server.close(() => {
          boundPort = null;
          resolve();
        });
      });
    },
  };
}

export { DEFAULT_TREE };
export default createMockNextcloud;
