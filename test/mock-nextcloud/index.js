import { createServer } from 'node:http';

import { DEFAULT_TREE, FIXED_LAST_MODIFIED, fakeEtag, fakeFileId, resolveNode } from './tree.js';

/**
 * Mock Nextcloud.
 *
 * Speaks just enough WebDAV for the app: Depth-1 PROPFIND over an in-memory
 * tree, with Basic auth enforced. The response XML mirrors what a real
 * Nextcloud 28+ emits, prefixes and all (including the empty second propstat
 * for properties the server doesn't have), so the parser is exercised against
 * realistic input rather than something tidied up for our convenience.
 *
 * EXTENSION POINTS
 *  - M2: add `GET` on the same DAV paths (serve `node.bytes`) and
 *    `/index.php/core/preview?fileId=...`; `handleRequest` already routes by
 *    method, so add a branch.
 *  - M3: add `/remote.php/dav/calendars/<user>/` PROPFIND plus `REPORT`.
 *  - M4: add the `SEARCH` verb on the files root.
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
          <d:getlastmodified>${FIXED_LAST_MODIFIED}</d:getlastmodified>
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

  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
${parts.join('\n')}
</d:multistatus>
`;
}

/**
 * @param {{ tree?: object, user?: string, password?: string }} [options]
 * @returns {{ start: () => Promise<{url: string, port: number}>,
 *             stop: () => Promise<void>,
 *             url: () => string,
 *             requests: Array<{method: string, url: string}>,
 *             setTree: (tree: object) => void }}
 */
export function createMockNextcloud(options = {}) {
  let tree = options.tree ?? DEFAULT_TREE;
  const user = options.user ?? TEST_USER;
  const password = options.password ?? TEST_APP_PASSWORD;
  const davRoot = davRootFor(user);
  const requests = [];

  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });

    // Drain the body; PROPFIND sends one and we don't need to inspect it.
    req.resume();
    req.on('end', () => handle(req, res));
  });

  function handle(req, res) {
    const pathname = decodeURIComponent(req.url.split('?')[0]);

    if (!checkAuth(req, user, password)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Nextcloud"',
        'Content-Type': 'text/plain',
      });
      res.end('Unauthorized');
      return;
    }

    if (req.method === 'PROPFIND') {
      handlePropfind(req, res, pathname);
      return;
    }

    // M2 adds GET here (file bytes + /index.php/core/preview).
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'PROPFIND' });
    res.end(`Method ${req.method} not implemented by the mock`);
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
