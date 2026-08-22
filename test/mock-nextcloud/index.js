import { createServer } from 'node:http';

import {
  DEFAULT_TREE,
  SAMPLE_PDF_THUMBNAIL,
  SHARE_OWNER,
  fakeEtag,
  fakeFileId,
  indexByFileId,
  lastModifiedOf,
  resolveNode,
  shareOwnerOf,
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
 *    thumbnails for images and 404s a PDF, which is exactly the case the icon
 *    fallback exists for. `createMockNextcloud({ pdfPreviews: true })` turns
 *    it into a server running the Imaginary provider our deployment actually
 *    uses (PDF_Previews.md), which renders PDFs too.
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

/**
 * The `oc:owner-id` this response should report, or null when the answer is
 * "the account's own content, no signal to give". Mirrors real Nextcloud:
 * the root itself is never a share of itself, and everything else inherits
 * its top-level entry's `sharedBy` when a live `tree` is available.
 *
 * Direct `buildMultistatus`/`buildSearchMultistatus` callers that don't pass
 * `tree` (most of the existing unit tests) get the pre-M5 behaviour instead:
 * every non-root response is a share, owned by `shareOwner`. That is what
 * keeps those tests passing unchanged now that the props exist at all.
 */
function ownerIdFor(relPath, { tree, shareOwner, user }) {
  if (relPath === '') return null;
  if (tree) return shareOwnerOf(tree, relPath);
  return shareOwner ?? user;
}

/**
 * @param {{user: string, ownerId: string|null, shareProps: boolean}} share
 *   ownerId: null means "the account's own content" -- reported as the
 *   account itself, with no S/M permission letter. shareProps: false omits
 *   both properties from the 200 propstat and lists them as 404 instead, the
 *   way a Nextcloud that doesn't know them at all would answer.
 */
function responseXmlFor(davRoot, relPath, node, { user, ownerId = null, shareProps = true } = {}) {
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

  const effectiveOwnerId = ownerId ?? user;
  const permissions = isFolder
    ? `${ownerId ? 'S' : ''}RGDNVCK`
    : `${ownerId ? 'S' : ''}RGDNVW`;
  const shareProp = shareProps
    ? `<oc:permissions>${permissions}</oc:permissions>
          <oc:owner-id>${xmlEscape(effectiveOwnerId)}</oc:owner-id>`
    : '';

  // Not-found props for this response, all in the one 404 propstat a real
  // server would use -- getcontenttype for a collection, and/or the share
  // props when the caller is simulating a Nextcloud that doesn't know them.
  const notFoundProps = [
    ...(isFolder ? ['<d:getcontenttype/>'] : []),
    ...(shareProps ? [] : ['<oc:permissions/>', '<oc:owner-id/>']),
  ];
  const notFoundBlock = notFoundProps.length
    ? `      <d:propstat>
        <d:prop>${notFoundProps.join('')}</d:prop>
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
          ${shareProp}
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
${notFoundBlock}    </d:response>`;
}

/**
 * Build a 207 multistatus body for a Depth-1 PROPFIND.
 * The first entry is always the collection itself -- exactly the thing the
 * parser has to skip.
 *
 * @param {{davRoot: string, relPath: string, node: object, tree?: object|null,
 *           shareOwner?: string, shareProps?: boolean, user?: string}} options
 *   tree: the live fixture tree, used to look up each entry's real `sharedBy`
 *     via shareOwnerOf(). Omit it (as most direct unit-test callers do) to
 *     get the simpler "everything is a share" behaviour via `shareOwner`.
 */
export function buildMultistatus({
  davRoot,
  relPath,
  node,
  tree = null,
  shareOwner = SHARE_OWNER,
  shareProps = true,
  user = TEST_USER,
}) {
  const share = { tree, shareOwner, user };
  const parts = [
    responseXmlFor(davRoot, relPath, node, {
      user,
      shareProps,
      ownerId: ownerIdFor(relPath, share),
    }),
  ];

  if (node.type === 'folder') {
    for (const [name, child] of Object.entries(node.children ?? {})) {
      const childPath = relPath === '' ? name : `${relPath}/${name}`;
      parts.push(
        responseXmlFor(davRoot, childPath, child, {
          user,
          shareProps,
          ownerId: ownerIdFor(childPath, share),
        })
      );
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
 * @param {{davRoot: string, files: Array<{path: string, node: object}>,
 *           tree?: object|null, shareOwner?: string, shareProps?: boolean,
 *           user?: string}} options see buildMultistatus for `tree`/`shareOwner`.
 */
export function buildSearchMultistatus({
  davRoot,
  files,
  tree = null,
  shareOwner = SHARE_OWNER,
  shareProps = true,
  user = TEST_USER,
}) {
  const share = { tree, shareOwner, user };
  return wrapMultistatus(
    files.map(({ path, node }) =>
      responseXmlFor(davRoot, path, node, { user, shareProps, ownerId: ownerIdFor(path, share) })
    )
  );
}

/** Nothing this mock is asked to accept is anywhere near this big. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @param {{ tree?: object, calendars?: Array<object>, user?: string, password?: string,
 *           searchStatus?: number|null, shareProps?: boolean,
 *           pdfPreviews?: boolean }} [options]
 *   searchStatus: answer every SEARCH with this status instead of running it.
 *   405 is what a Nextcloud without the search backend sends, and is the case
 *   the app's walk fallback exists for.
 *   shareProps: false simulates a Nextcloud that doesn't know oc:permissions
 *   or oc:owner-id at all (both come back 404'd) -- the case
 *   src/nextcloud/shares.js's no-signal fallback exists for. Default true.
 *   pdfPreviews: true simulates the Imaginary preview provider rendering a
 *   real PDF thumbnail instead of 404ing (see PDF_Previews.md). Default
 *   false, which is a stock Nextcloud with no PDF-capable provider.
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
  let shareProps = options.shareProps ?? true;
  // What the OCS Share API reports as shared WITH this account.
  //   undefined -> derived from the tree: every top-level node carrying
  //                `sharedBy`, mounted at the top. A plain instance with no
  //                share_folder, which is what most tests want.
  //   null      -> the endpoint 404s, as if files_sharing were unavailable.
  //                How a test exercises the home page's fallback path.
  //   [...]     -> explicit `file_target` values, e.g. ['/Shared/Family'] for
  //                an instance with share_folder set.
  let receivedShares = options.receivedShares;
  let pdfPreviews = options.pdfPreviews ?? false;
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

    if (req.method === 'GET' && pathname === '/ocs/v2.php/apps/files_sharing/api/v1/shares') {
      handleOcsShares(req, res, new URLSearchParams(rawQuery));
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
    res.end(
      buildSearchMultistatus({
        davRoot: davRoot.replace(/\/+$/, ''),
        files: matches,
        tree,
        shareProps,
        user,
      })
    );
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
   * Stand-in for `/index.php/core/preview`. Images always get a thumbnail;
   * PDFs get one only when `pdfPreviews` is on (simulating Imaginary --
   * see PDF_Previews.md), otherwise 404 exactly like a stock Nextcloud with
   * no PDF-capable provider.
   *
   * `forceIcon=0` is asserted rather than merely accepted: the app depends on
   * it to tell "no provider" (404) apart from "here is a generic mimetype
   * icon" (200), and a mock that silently tolerated its absence would never
   * catch a regression that dropped it from the request.
   */
  /**
   * The OCS Share API, incoming direction only -- see ../../src/nextcloud/ocs.js.
   *
   * Answers 404 when `receivedShares` is null, which is what an instance
   * without files_sharing (or a request the app is not allowed to make) looks
   * like, and what the home page's fallback is written against.
   */
  function handleOcsShares(req, res, query) {
    // Derived rather than fixed, because setTree() can swap the fixture after
    // the mock is built and the two must not drift apart.
    const targets =
      receivedShares === undefined
        ? Object.entries(tree)
            .filter(([, node]) => node?.sharedBy)
            .map(([name]) => `/${name}`)
        : receivedShares;

    if (targets === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // The app must send this header or real Nextcloud answers 401 regardless of
    // credentials. Enforced here so a regression that drops it fails in tests
    // rather than only against the real server.
    if (req.headers['ocs-apirequest'] !== 'true') {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('CSRF check failed');
      return;
    }

    // Only the incoming direction is implemented; the app asks nothing else.
    if (query.get('shared_with_me') !== 'true') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Mock only implements shared_with_me=true');
      return;
    }

    const data = targets.map((target, index) => ({
      id: String(100 + index),
      share_type: 0,
      uid_owner: SHARE_OWNER,
      file_target: target,
      item_type: 'folder',
      permissions: 1,
    }));

    const payload = JSON.stringify({
      ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data },
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function handlePreview(req, res, params) {
    const fileId = Number(params.get('fileId'));
    if (!Number.isInteger(fileId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad fileId');
      return;
    }
    if (params.get('forceIcon') !== '0') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Expected forceIcon=0');
      return;
    }

    const found = indexByFileId(tree).get(fileId);
    if (!found || found.node.type === 'folder' || !found.node.bytes) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No preview');
      return;
    }

    const contentType = String(found.node.contentType ?? '');
    if (contentType.startsWith('image/')) {
      // The real endpoint scales the image; the app only cares that it gets
      // image bytes back, so hand over the original.
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': String(found.node.bytes.length),
      });
      res.end(found.node.bytes);
      return;
    }

    if (pdfPreviews && contentType === 'application/pdf') {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(SAMPLE_PDF_THUMBNAIL.length),
      });
      res.end(SAMPLE_PDF_THUMBNAIL);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('No preview provider');
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
      const xml = buildMultistatus({ davRoot: rootNormalized, relPath, node, tree, shareProps, user });
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(xml);
      return;
    }

    const depth = req.headers.depth ?? '1';
    const xml = buildMultistatus({
      davRoot: rootNormalized,
      relPath,
      node: depth === '0' ? { ...node, children: {} } : node,
      tree,
      shareProps,
      user,
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
    /** false simulates a Nextcloud with no oc:permissions/oc:owner-id at all. */
    setShareProps(next) {
      shareProps = next ?? true;
    },
    /** true simulates Imaginary rendering real PDF thumbnails. */
    setPdfPreviews(next) {
      pdfPreviews = next ?? false;
    },
    /**
     * What the OCS Share API reports. `undefined` derives it from the tree,
     * `null` makes the endpoint 404 (the fallback path), an array sets the
     * `file_target` values verbatim -- which is how a share_folder instance is
     * simulated.
     */
    setReceivedShares(next) {
      receivedShares = next;
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
