import { XMLParser } from 'fast-xml-parser';

import { NextcloudError } from './client.js';
import { asArray, collectProps, decodeHref, stripTrailingSlash } from './dav-util.js';
import { encodePath, normalizeRelPath } from '../lib/paths.js';

/**
 * WebDAV listing for the viewer account's files home.
 *
 * Only `Depth: 1` PROPFIND lives here -- enough to render one folder at a time.
 * The parsing half is a pure function so it can be unit-tested against canned
 * XML with no server in sight.
 */

// oc:permissions and oc:owner-id ride along on every listing -- they cost
// nothing extra (same round trip) and are what ../nextcloud/shares.js reads
// to tell a received share apart from the viewer account's own content.
const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:fileid/>
    <d:getlastmodified/>
    <d:getcontenttype/>
    <d:resourcetype/>
    <oc:size/>
    <d:getetag/>
    <oc:permissions/>
    <oc:owner-id/>
  </d:prop>
</d:propfind>`;

// `removeNSPrefix` collapses d:/oc:/nc:/s: prefixes, which is what makes this
// parser resilient to Nextcloud choosing different prefixes per response.
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

function cleanEtag(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).replace(/^W\//i, '').replace(/^"|"$/g, '');
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** '' and missing both mean "the server didn't tell us" -- normalize both to null. */
function toStringOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

/**
 * Is this response a collection? `<d:resourcetype><d:collection/></d:resourcetype>`
 * parses to `{ collection: '' }`; a plain file's empty resourcetype parses to ''.
 */
function isCollection(props) {
  const rt = props.resourcetype;
  if (rt === undefined || rt === null || rt === '') return false;
  if (typeof rt === 'object') return Object.hasOwn(rt, 'collection');
  return false;
}

function toEntry(relPath, props) {
  const folder = isCollection(props);
  const segments = relPath.split('/');

  return {
    name: segments[segments.length - 1],
    path: relPath,
    isFolder: folder,
    fileId: toNumber(props.fileid),
    etag: cleanEtag(props.getetag),
    lastModified: toDate(props.getlastmodified),
    contentType: folder ? null : props.getcontenttype || null,
    size: toNumber(props.size),
    // Read by ../nextcloud/shares.js to tell a received share apart from the
    // viewer account's own content. removeNSPrefix hands us `owner-id`
    // hyphenated, not camelCased.
    permissions: toStringOrNull(props.permissions),
    ownerId: toStringOrNull(props['owner-id']),
  };
}

/**
 * Parse a 207 multistatus body into `{ self, entries }` relative to `davRoot`.
 *
 * `self` is the entry for the requested path itself (null if the server didn't
 * include one) -- callers use it to tell a folder listing apart from a Depth-1
 * PROPFIND on a plain file, which returns only the self entry.
 *
 * @param {string} xml raw multistatus body
 * @param {{ davRoot: string, requestPath?: string }} options
 *   davRoot: decoded DAV home, e.g. `/remote.php/dav/files/ostrich-viewer`
 *   requestPath: normalized relative path that was requested
 * @returns {{ self: object|null, entries: Array<object> }} entry shape:
 *   {name,path,isFolder,fileId,etag,lastModified,contentType,size}
 */
export function parseMultistatus(xml, { davRoot, requestPath = '' } = {}) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new NextcloudError('Empty PROPFIND response from Nextcloud.');
  }

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new NextcloudError(`Could not parse PROPFIND response: ${err.message}`);
  }

  const multistatus = doc?.multistatus;
  if (multistatus === undefined || multistatus === null) {
    throw new NextcloudError('PROPFIND response had no <multistatus> element.');
  }

  // `<d:multistatus/>` -- an element with no responses in it -- parses to the
  // empty string, and it is a perfectly VALID answer: it is what a SEARCH sends
  // back when nothing has changed, which is the ordinary case. Only a
  // multistatus that is present but holds something other than responses is
  // garbage worth throwing over.
  //
  // It is valid HERE, at the parse layer, and only because SEARCH says so. A
  // PROPFIND caller must not accept it as a folder with no children -- see the
  // `self === null` check in `propfind`, and the one in `statFile`.
  if (typeof multistatus !== 'object') {
    if (String(multistatus).trim() === '') return { self: null, entries: [] };
    throw new NextcloudError('PROPFIND response had an unreadable <multistatus> element.');
  }

  const rootPrefix = stripTrailingSlash(davRoot);
  // The path we asked about; its own entry is in the multistatus.
  const selfPath = stripTrailingSlash(requestPath ? `${rootPrefix}/${requestPath}` : rootPrefix);

  let self = null;
  const entries = [];
  for (const response of asArray(multistatus.response)) {
    const hrefPath = stripTrailingSlash(decodeHref(response.href));
    if (hrefPath === selfPath) {
      const name = requestPath === '' ? '' : requestPath.split('/').pop();
      self = { ...toEntry(name || '', collectProps(response)), path: requestPath };
      continue;
    }

    if (!hrefPath.startsWith(`${rootPrefix}/`)) {
      // Outside our DAV home entirely -- should never happen, but never trust it.
      continue;
    }

    const relPath = hrefPath.slice(rootPrefix.length + 1);
    entries.push(toEntry(relPath, collectProps(response)));
  }

  return { self, entries };
}

/**
 * Children of a folder, self-entry removed. Kept as the simple list-shaped API
 * most callers want; use `parseMultistatus` when the self entry matters.
 */
export function parsePropfind(xml, options) {
  return parseMultistatus(xml, options).entries;
}

/**
 * One PROPFIND, parsed. The whole conversation with Nextcloud lives here so
 * that the depth-0 and depth-1 callers cannot drift apart -- notably over the
 * redirect follow, which is easy to leave out of a second copy and impossible
 * to notice until a particular deployment breaks.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {string} normalized already normalized relative path ('' = root)
 * @param {{depth: '0'|'1', notFoundMessage: string}} options
 * @returns {Promise<{self: object, entries: Array<object>, url: string}>}
 *   `self` is never null: a 207 that does not describe what was asked about is
 *   an upstream failure, and is thrown here rather than handed on.
 */
async function doPropfind(client, normalized, { depth, notFoundMessage }) {
  const encoded = encodePath(normalized);
  const url = encoded ? `${client.filesRoot}/${encoded}` : client.filesRoot;

  const propfindOptions = {
    headers: {
      Depth: depth,
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: PROPFIND_BODY,
  };

  let response = await client.request('PROPFIND', url, propfindOptions);

  // Some deployments 301 a collection PROPFIND to its slash-terminated form
  // (SabreDAV behind certain proxies). The client uses redirect:'manual', so
  // follow exactly one same-instance redirect ourselves.
  if ([301, 302, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    const target = location ? new URL(location, `${client.baseUrl}${url}`) : null;
    if (target && `${target.origin}` === new URL(client.baseUrl).origin) {
      response = await client.request('PROPFIND', target.pathname, propfindOptions);
    }
  }

  if (response.status === 404) {
    throw new NextcloudError(notFoundMessage, { status: 404, method: 'PROPFIND', url });
  }
  if (response.status !== 207) {
    const body = await response.text().catch(() => '');
    throw new NextcloudError(`PROPFIND ${url} returned ${response.status}`, {
      status: response.status,
      method: 'PROPFIND',
      url,
      body: body.slice(0, 500),
    });
  }

  const parsed = parseMultistatus(await response.text(), {
    davRoot: client.davRoot,
    requestPath: normalized,
  });

  // A PROPFIND MUST describe the resource it was asked about -- at Depth 1 even
  // when the collection is empty, at Depth 0 always. An answer without a self
  // entry (a bodyless 207, or `<d:multistatus/>`, which is a perfectly good
  // SEARCH result and no kind of PROPFIND answer at all) would otherwise sail
  // through as zero children and render as "Nothing has been shared with you
  // yet" -- a confident, wrong sentence about somebody's files.
  //
  // This lives HERE, not in the two callers, because the fault is one fault and
  // it had grown two contradictory stories: a folder listing called it an
  // upstream failure while a file stat called the very same answer a 404
  // ("moved or unshared"). It is neither missing nor gone: the server answered
  // badly. No status, so the error handler renders the upstream-failure page,
  // and a genuine upstream 404 -- the case above -- stays the only route to
  // "we couldn't find that".
  if (parsed.self === null) {
    throw new NextcloudError(`PROPFIND response did not describe ${normalized || '/'}`, {
      method: 'PROPFIND',
      url,
    });
  }

  return { ...parsed, url };
}

/**
 * Depth-1 PROPFIND of one folder under the viewer account's files home.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {string} relPath normalized relative path ('' = root)
 * @returns {Promise<Array<object>>} children, self-entry removed
 * @throws {NextcloudError} 404 when the path is missing or is a plain file;
 *   status-less (i.e. an upstream failure) when the 207 does not describe the
 *   requested collection at all.
 */
export async function propfind(client, relPath = '') {
  const normalized = normalizeRelPath(relPath);
  const { self, entries, url } = await doPropfind(client, normalized, {
    depth: '1',
    notFoundMessage: `Folder not found: ${normalized || '/'}`,
  });

  // A Depth-1 PROPFIND on a plain file answers 207 with only the self entry;
  // without this check a file URL would render as an empty "folder".
  if (!self.isFolder) {
    throw new NextcloudError(`Not a folder: ${normalized}`, {
      status: 404,
      method: 'PROPFIND',
      url,
    });
  }

  return entries;
}

/**
 * Depth-0 PROPFIND of a single resource: enough metadata to serve `/view/`,
 * `/content/` and `/preview/` without listing (or trusting) its parent.
 *
 * Returns the entry for the path itself, folders included -- callers decide
 * what to do with `isFolder` (the media routes 404 on it). A missing file is a
 * NextcloudError with status 404, so the shared error handler renders the calm
 * "we couldn't find that" page; a 207 that describes nothing we asked about is
 * status-less instead, because that is an upstream that answered badly and not
 * a file that has gone.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {string} relPath normalized relative path; '' (the root) is rejected
 * @returns {Promise<{name:string,path:string,isFolder:boolean,fileId:number|null,
 *                    etag:string|null,lastModified:Date|null,
 *                    contentType:string|null,size:number|null}>}
 */
export async function statFile(client, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (normalized === '') {
    throw new NextcloudError('The files root is not a file.', {
      status: 404,
      method: 'PROPFIND',
      url: client.filesRoot,
    });
  }

  // A 207 that doesn't describe what we asked about is an upstream failure, not
  // a missing file, and `doPropfind` has already thrown it as one -- the two
  // callers must not tell a reader two different stories about one fault.
  const { self } = await doPropfind(client, normalized, {
    depth: '0',
    notFoundMessage: `Not found: ${normalized}`,
  });

  return self;
}

/**
 * Folders first, then files; each group A-Z, case- and accent-insensitively.
 * Kept separate from `propfind` so later milestones can reuse the ordering.
 */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

export { PROPFIND_BODY };
