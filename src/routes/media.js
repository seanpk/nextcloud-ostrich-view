import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { NextcloudError } from '../nextcloud/client.js';
import { statFile } from '../nextcloud/webdav.js';
import { kindOf, rendersInline, safeContentType } from '../lib/filetypes.js';
import { encodePath, normalizeRelPath, parentPath } from '../lib/paths.js';
import { ICONS } from '../lib/tiles.js';

/**
 * The three routes that put a file in front of the viewer:
 *
 *   GET /preview/:fileId  a cached thumbnail, or a redirect to a flat icon
 *   GET /content/*        the raw bytes, streamed, Range-capable
 *   GET /view/*           the page she actually looks at, with our chrome
 *
 * Nothing here ever hands the browser a Nextcloud URL or credential: every
 * byte is proxied. All three sit behind the global auth hook in server.js, so
 * an unauthenticated request is redirected to /login before it reaches them.
 */

/**
 * Which request headers to forward upstream for a byte-range read.
 *
 * pdf.js asks for a document in 64 KB slices, so this is what makes a large
 * PDF open on the first page instead of after a full download. The Range value
 * is matched against the grammar before being passed on -- it is going into
 * another server's parser, and we are not in the business of relaying junk.
 *
 * A single range only. A multi-range request is answered with
 * `multipart/byteranges`, whose own Content-Type carries the part boundary --
 * and this route overwrites Content-Type with the file's own, which would
 * leave the browser unable to parse what it got. Dropping the header instead
 * costs one full-file read and is always correct.
 *
 * @param {Record<string, string|string[]|undefined>} headers incoming request headers
 * @returns {Record<string,string>} headers to send upstream (possibly empty)
 */
export function forwardRangeHeaders(headers = {}) {
  const out = {};
  const range = headers.range;
  if (typeof range !== 'string') return out;

  const value = range.trim();
  // bytes=0-1023 | bytes=1024- | bytes=-500; at least one bound, never a list.
  if (!/^bytes=(\d+-\d*|\d*-\d+)$/.test(value) || value.length > 200) return out;

  out.Range = value;
  const ifRange = headers['if-range'];
  if (typeof ifRange === 'string' && ifRange.length <= 200) out['If-Range'] = ifRange;
  return out;
}

/**
 * Which upstream response headers to copy back to the browser. Deliberately a
 * short allow-list: Nextcloud sends cookies, CSP and caching headers of its
 * own that have no business reaching our origin.
 *
 * Content-Length is dropped whenever the upstream response was encoded
 * (gzip, br, ...): fetch hands us the *decoded* body but leaves Content-Length
 * describing the compressed one, so relaying it would promise fewer bytes than
 * we then stream -- a hung or truncated response, and an
 * ERR_HTTP_CONTENT_LENGTH_MISMATCH behind any proxy that gzips. The client
 * asks upstream for `identity` precisely so this stays theoretical; this is
 * the second lock on the same door.
 *
 * @param {Headers} upstreamHeaders
 * @returns {Record<string,string>}
 */
export function passthroughHeaders(upstreamHeaders) {
  const out = {};
  const encoded = Boolean(upstreamHeaders?.get?.('content-encoding'));
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'last-modified']) {
    if (encoded && name === 'content-length') continue;
    const value = upstreamHeaders?.get?.(name);
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Does an `If-None-Match` header match the entry we are about to serve?
 *
 * Weak comparison, which is what RFC 9110 requires for a GET: Nextcloud's
 * etags are already weak in spirit (they change on any write), and a browser
 * that was handed `W/"abc"` must still match `"abc"`.
 *
 * @param {string|string[]|undefined} header raw If-None-Match
 * @param {string|null} etag the quoted etag we would send
 * @returns {boolean}
 */
export function etagMatches(header, etag) {
  if (typeof header !== 'string' || !etag) return false;
  const wanted = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === wanted);
}

/**
 * `Content-Disposition: inline` with a filename the browser can read, RFC 5987
 * encoded so unicode names survive. Quotes and backslashes are stripped from
 * the ASCII fallback rather than escaped -- simpler, and header injection is
 * already impossible (paths reject control characters).
 */
export function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function notFound(message) {
  return new NextcloudError(message, { status: 404 });
}

/**
 * A short-lived memo of `statFile` results.
 *
 * pdf.js reads a document in 64 KB slices, so one PDF is dozens of requests to
 * `/content/*` -- and each one needs the file's type and name before it can
 * answer. Without this, every slice would cost an extra PROPFIND and Nextcloud
 * would see twice the traffic for no new information. The window is deliberately
 * short: a stale content type for a few seconds is invisible, and the bytes
 * themselves are never cached here.
 *
 * Concurrent misses share one in-flight lookup, and a failed lookup is not
 * remembered at all.
 *
 * @param {{ ttlMs?: number, max?: number }} [options]
 */
export function createStatCache({ ttlMs = 30_000, max = 500 } = {}) {
  const entries = new Map();

  return {
    /** @param {string} key @param {() => Promise<any>} load */
    async get(key, load, now = Date.now()) {
      const hit = entries.get(key);
      if (hit && hit.expires > now) return hit.value;

      // Bounded without an LRU: the tree is small, and dropping everything
      // occasionally is cheaper (and far less code) than tracking recency.
      if (entries.size >= max) entries.clear();

      const value = load();
      entries.set(key, { value, expires: now + ttlMs });
      try {
        return await value;
      } catch (err) {
        entries.delete(key);
        throw err;
      }
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * A read stream with its file descriptor already open, or null if the file
 * vanished first.
 *
 * The preview cache prunes old etag variants in the background, so the file
 * `previews.get` just stat-ed can in principle be unlinked a moment later.
 * Waiting for `open` moves that race somewhere harmless: either we never get a
 * descriptor and fall back to the icon, or we hold one -- and on Linux an open
 * descriptor keeps the bytes readable even after the name is gone.
 *
 * @param {string} path
 * @returns {Promise<import('node:fs').ReadStream|null>}
 */
async function openCachedFile(path) {
  const stream = createReadStream(path);
  try {
    await once(stream, 'open');
    return stream;
  } catch {
    stream.destroy();
    return null;
  }
}

export default async function registerMediaRoutes(app) {
  const previews = app.previewCache;
  const stats = createStatCache();

  // --- GET /preview/:fileId --------------------------------------------------
  app.get('/preview/:fileId', async (request, reply) => {
    const fileId = String(request.params.fileId ?? '');
    const etag = String(request.query?.v ?? '');
    // Optional hint so the fallback icon matches the file; never trusted for
    // anything but choosing between five bundled SVGs.
    const kind = Object.hasOwn(ICONS, request.query?.k) ? request.query.k : 'file';

    /** No preview provider for this type (PDFs, on a default Nextcloud). */
    const icon = () => {
      // A short cache: enabling the provider later should start working
      // without anyone clearing a browser cache.
      reply.header('Cache-Control', 'private, max-age=300');
      return reply.redirect(ICONS[kind], 302);
    };

    // `previews.get` re-validates both halves of the key and throws a 400.
    const result = await previews.get({ fileId, etag });
    if (result.status !== 'ok') return icon();

    const stream = await openCachedFile(result.path);
    if (!stream) return icon();

    reply.header('Cache-Control', 'private, max-age=86400');
    reply.type(result.contentType);
    return reply.send(stream);
  });

  // --- GET /content/* --------------------------------------------------------
  app.get('/content/*', async (request, reply) => {
    const path = normalizeRelPath(request.params['*']);
    if (path === '') throw notFound('No file requested.');

    // Stat first: it tells us the real content type, proves the thing exists,
    // and rules out folders before we open a byte stream to one.
    const entry = await stats.get(path, () => statFile(app.nextcloud, path));
    if (entry.isFolder) throw notFound(`Not a file: ${path}`);

    const rangeHeaders = forwardRangeHeaders(request.headers);
    // The stat already told us the version, so a revalidation costs nothing:
    // no upstream request, no bytes. Ranged reads are left alone -- pdf.js
    // manages its own slices and a 304 mid-document would only confuse it.
    const etag = entry.etag ? `"${entry.etag}"` : null;
    if (!rangeHeaders.Range && etagMatches(request.headers['if-none-match'], etag)) {
      reply.header('ETag', etag);
      reply.header('Cache-Control', 'private, no-cache');
      return reply.code(304).send();
    }

    const url = `${app.nextcloud.filesRoot}/${encodePath(path)}`;
    const upstream = await app.nextcloud.request('GET', url, { headers: rangeHeaders });

    if (upstream.status === 404) throw notFound(`File not found: ${path}`);
    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.arrayBuffer().catch(() => {});
      throw new NextcloudError(`GET ${url} returned ${upstream.status}`, {
        status: upstream.status,
        method: 'GET',
        url,
      });
    }

    reply.code(upstream.status);
    for (const [name, value] of Object.entries(passthroughHeaders(upstream.headers))) {
      reply.header(name, value);
    }
    // Nextcloud always supports ranges; say so even on a plain 200 so pdf.js
    // switches to range mode instead of pulling the whole file down.
    if (!reply.getHeader('accept-ranges')) reply.header('Accept-Ranges', 'bytes');

    // `no-cache` (revalidate every time), not `no-store` (download it all
    // again every time): reopening the same photo on a phone should be one
    // conditional request, not another few megabytes. Only whole responses --
    // a 206 is a fragment and a 416 is an error, and neither is the entity the
    // etag names.
    if (upstream.status === 200 && etag) {
      reply.header('ETag', etag);
      reply.header('Cache-Control', 'private, no-cache');
    } else {
      reply.header('Cache-Control', 'private, no-store');
    }
    reply.header('Content-Disposition', contentDisposition(entry.name));
    reply.type(safeContentType(entry.contentType));

    if (!upstream.body) return reply.send('');
    return reply.send(Readable.fromWeb(upstream.body));
  });

  // --- GET /view/* -----------------------------------------------------------
  app.get('/view/*', async (request, reply) => {
    const path = normalizeRelPath(request.params['*']);
    if (path === '') return reply.redirect('/', 302);

    // The same memo `/content/*` uses: opening a file is a /view/ and a
    // /content/ hit back to back, and they ask Nextcloud the same question.
    const entry = await stats.get(path, () => statFile(app.nextcloud, path));
    const parent = parentPath(path);
    const backHref = parent === '' ? '/' : `/files/${encodePath(parent)}`;

    if (entry.isFolder) {
      // Someone hand-typed a folder into /view/; show them the folder.
      return reply.redirect(`/files/${encodePath(path)}`, 302);
    }

    const kind = kindOf(entry);
    const contentUrl = `/content/${encodePath(path)}`;
    // pdf.js gets the document URL as a query parameter, so it has to be
    // encoded as one; the fragment is read by our viewer, not sent to us.
    const pdfViewerUrl =
      `/public/pdfjs/web/viewer.html?file=${encodeURIComponent(contentUrl)}#zoom=page-width`;

    const mode = rendersInline(entry) ? kind : 'unsupported';

    return reply.view('view', {
      title: entry.name,
      viewer: request.viewer,
      name: entry.name,
      kind,
      // `rendersInline` and `safeContentType` read one table, so the viewer
      // can only pick an image/pdf mode for bytes /content/ will serve as
      // something the browser paints.
      mode,
      contentUrl,
      pdfViewerUrl,
      icon: ICONS[kind] ?? ICONS.file,
      showBack: true,
      backHref,
      // Present on every page, viewer included; see the folder route.
      showToggle: true,
      section: 'files',
      breadcrumbs: [],
      // Only a photo or a PDF gets the full-screen chrome (public/viewer.js) --
      // the "we can't show this" page has nothing worth clearing space for.
      immersive: mode === 'image' || mode === 'pdf',
    });
  });
}
