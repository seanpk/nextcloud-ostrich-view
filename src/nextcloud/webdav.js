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

const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:fileid/>
    <d:getlastmodified/>
    <d:getcontenttype/>
    <d:resourcetype/>
    <oc:size/>
    <d:getetag/>
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
  if (!multistatus) {
    throw new NextcloudError('PROPFIND response had no <multistatus> element.');
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
 * @returns {Promise<{self: object|null, entries: Array<object>, url: string}>}
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
  return { ...parsed, url };
}

/**
 * Depth-1 PROPFIND of one folder under the viewer account's files home.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {string} relPath normalized relative path ('' = root)
 * @returns {Promise<Array<object>>} children, self-entry removed
 */
export async function propfind(client, relPath = '') {
  const normalized = normalizeRelPath(relPath);
  const { self, entries, url } = await doPropfind(client, normalized, {
    depth: '1',
    notFoundMessage: `Folder not found: ${normalized || '/'}`,
  });

  // A Depth-1 PROPFIND on a plain file answers 207 with only the self entry;
  // without this check a file URL would render as an empty "folder".
  if (self && !self.isFolder) {
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
 * "we couldn't find that" page.
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

  const { self, url } = await doPropfind(client, normalized, {
    depth: '0',
    notFoundMessage: `Not found: ${normalized}`,
  });

  if (!self) {
    // A 207 that doesn't describe what we asked about: treat as missing rather
    // than guessing from whatever else the server volunteered.
    throw new NextcloudError(`No metadata returned for ${normalized}`, {
      status: 404,
      method: 'PROPFIND',
      url,
    });
  }

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
