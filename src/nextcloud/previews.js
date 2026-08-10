import { randomUUID } from 'node:crypto';
import { open, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NextcloudError } from './client.js';

/**
 * Thumbnail proxy + disk cache.
 *
 * Nextcloud will render a thumbnail for most files, but the round trip is slow
 * enough that a folder of twenty photos would crawl on a phone. So every
 * thumbnail we fetch is written to `data/preview-cache/` under a name that
 * includes the file's etag:
 *
 *     <fileId>-<etag>-512.png
 *
 * Because the etag is part of the name, a changed file simply misses the cache
 * rather than serving a stale image, and the browser's own cache is safe to
 * keep for a day (`/preview/<id>?v=<etag>` changes when the file does). Older
 * variants of the same fileId are deleted on the way past -- but only once
 * they have gone cold, see PRUNE_GRACE_MS -- so the cache tracks the tree
 * instead of growing forever.
 *
 * SECURITY: both halves of the cache key come from a URL, so both are matched
 * against strict allow-lists before they are ever concatenated into a path.
 * Nothing else about the request influences the filename.
 */

export const PREVIEW_SIZE = 512;

/** Nextcloud file ids are positive integers; 19 digits is past 2^63. */
const FILE_ID_PATTERN = /^[0-9]{1,19}$/;
/** Etags are hex-ish, but Nextcloud has shipped alphanumeric ones; no separators. */
const ETAG_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/** Beyond this a "thumbnail" is not a thumbnail and we want no part of it. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * How long a variant is protected from pruning after it is written.
 *
 * Pruning is "delete every other version of this file", and "every other
 * version" includes one another client is using right now: two browsers
 * holding different etags for the same file would otherwise evict each other's
 * thumbnail on every request, forever, and a reader could lose the file
 * between the stat and the open. Anything older than the window is genuinely
 * stale -- nobody's page has been rendering from it for ten minutes.
 */
const PRUNE_GRACE_MS = 10 * 60 * 1000;

/** In-progress writes are named `.tmp-<fileId>-<uuid>`. */
const TEMP_PREFIX = '.tmp-';
/** A temp file this old is a crash leftover, not a write in flight. */
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How long "Nextcloud has no preview for this file" is remembered.
 *
 * Short, because enabling a preview provider should start working on its own;
 * long enough that a folder of twenty PDFs is twenty upstream 404s once rather
 * than on every visit.
 */
const UNAVAILABLE_TTL_MS = 5 * 60 * 1000;

/** Entries in the in-memory memo, before it is dropped wholesale. */
const MEMO_MAX = 2000;

export class PreviewParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreviewParamError';
    this.statusCode = 400;
  }
}

export function isValidFileId(value) {
  return typeof value === 'string' && FILE_ID_PATTERN.test(value);
}

export function isValidEtag(value) {
  return typeof value === 'string' && ETAG_PATTERN.test(value);
}

/**
 * The cache file name for one (file, version, size). Callers must have
 * validated the inputs; this throws rather than trusting them.
 * @returns {string} a bare file name, never a path
 */
export function previewFileName(fileId, etag, size = PREVIEW_SIZE) {
  if (!isValidFileId(fileId)) throw new PreviewParamError('Invalid file id.');
  if (!isValidEtag(etag)) throw new PreviewParamError('Invalid version tag.');
  if (!Number.isInteger(size) || size < 1 || size > 4096) {
    throw new PreviewParamError('Invalid preview size.');
  }
  return `${fileId}-${etag}-${size}.png`;
}

/**
 * Cache entries for `fileId` that are not `keepName` -- i.e. previews of other
 * versions of this file, and so the candidates for pruning. Whether a
 * candidate is actually deleted is a second question, about its age; see
 * PRUNE_GRACE_MS.
 *
 * Split out as a pure function because the "which names even qualify"
 * question is exactly the sort of thing that should be unit-tested without a
 * filesystem.
 *
 * @param {string[]} names directory listing
 * @param {string} fileId
 * @param {string} keepName the current file name
 * @returns {string[]}
 */
export function staleVariants(names, fileId, keepName) {
  const prefix = `${fileId}-`;
  return names.filter(
    (name) => name !== keepName && name.startsWith(prefix) && name.endsWith('.png')
  );
}

/**
 * Identify an image by its magic bytes. Nextcloud's preview endpoint answers
 * PNG for most providers but JPEG for some, and we store both under a `.png`
 * cache name, so the Content-Type is decided by the bytes rather than by the
 * name or by whatever the upstream claimed hours ago.
 *
 * @param {Uint8Array|Buffer} head first few bytes of the image
 * @returns {string|null} MIME type, or null if it isn't an image we recognise
 */
export function sniffImageType(head) {
  const b = head ?? [];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Read a response body, giving up as soon as it passes `limit`.
 *
 * Nextcloud answers the preview endpoint chunked often enough that the
 * Content-Length check upstream of this cannot be relied on, and buffering an
 * unbounded body to find out how big it was is exactly the failure mode the
 * limit exists to prevent.
 *
 * @param {Response} response
 * @param {number} limit
 * @returns {Promise<Buffer|null>} null when the body is over the limit
 */
async function readCapped(response, limit) {
  if (!response.body) return Buffer.from(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Cancelling propagates upstream: the rest is never transferred.
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Delete `.tmp-*` files older than `maxAgeMs`.
 *
 * A crash between `writeFile` and `rename` leaves one behind, and nothing else
 * ever collects them: `prune` only looks at finished `.png` variants. Run once
 * at startup, where a long-dead container's leftovers actually are.
 *
 * @param {string} dir
 * @param {{maxAgeMs?: number, now?: number}} [options]
 * @returns {Promise<number>} how many were removed
 */
export async function sweepTempFiles(dir, { maxAgeMs = TEMP_MAX_AGE_MS, now = Date.now() } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }

  const removed = await Promise.all(
    names
      .filter((name) => name.startsWith(TEMP_PREFIX))
      .map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path).catch(() => null);
        if (!info || now - info.mtimeMs < maxAgeMs) return 0;
        return unlink(path).then(
          () => 1,
          () => 0
        );
      })
  );
  return removed.reduce((sum, n) => sum + n, 0);
}

async function readHead(path, length = 12) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * @param {{ dir: string,
 *           client: ReturnType<import('./client.js').createClient>,
 *           size?: number,
 *           pruneGraceMs?: number,
 *           unavailableTtlMs?: number,
 *           log?: { warn: Function } }} options
 */
export function createPreviewCache({
  dir,
  client,
  size = PREVIEW_SIZE,
  pruneGraceMs = PRUNE_GRACE_MS,
  unavailableTtlMs = UNAVAILABLE_TTL_MS,
  log,
} = {}) {
  if (!dir) throw new Error('createPreviewCache: dir is required');
  if (!client) throw new Error('createPreviewCache: client is required');

  // Two tiles of the same image render at once on every folder page; without
  // this, both would fetch and both would write.
  const inFlight = new Map();

  /**
   * What we already know about a cache name, so neither answer has to be
   * worked out twice:
   *   {status:'ok', contentType}          sniffed once, not on every hit
   *   {status:'unavailable', expires}     a file Nextcloud won't render
   * Bounded by dropping the lot: it is a memo, and rebuilding it costs a
   * `stat` and twelve bytes.
   */
  const memo = new Map();

  function remember(fileName, value) {
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(fileName, value);
  }

  async function ensureDir() {
    await mkdir(dir, { recursive: true });
  }

  /**
   * Drop versions of this file nobody can still be reading. See PRUNE_GRACE_MS
   * for why "nobody can still be reading" is a question about mtime and not
   * simply "is it the current etag".
   */
  async function prune(fileId, keepName) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - pruneGraceMs;
    await Promise.all(
      staleVariants(names, fileId, keepName).map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path).catch(() => null);
        if (!info || info.mtimeMs > cutoff) return;
        memo.delete(name);
        await unlink(path).catch(() => {});
      })
    );
  }

  /** Fetch from Nextcloud and land the bytes in the cache atomically. */
  async function fill(fileId, fileName) {
    const query = `fileId=${fileId}&x=${size}&y=${size}&a=1`;
    const response = await client.request('GET', `/index.php/core/preview?${query}`);

    // 404 is the normal answer for "no preview provider handles this type"
    // (PDFs, on a default Nextcloud). 403 and redirects-to-login get the same
    // treatment: show the icon, don't fail the page.
    if (response.status === 404 || response.status === 403 || response.status >= 300) {
      // The body must be drained or the connection is held open.
      await response.arrayBuffer().catch(() => {});
      return { status: 'unavailable' };
    }
    if (response.status !== 200) {
      const body = await response.text().catch(() => '');
      throw new NextcloudError(`Preview for fileId ${fileId} returned ${response.status}`, {
        status: response.status,
        method: 'GET',
        url: '/index.php/core/preview',
        body: body.slice(0, 200),
      });
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_BYTES) {
      await response.arrayBuffer().catch(() => {});
      return { status: 'unavailable' };
    }

    // A chunked response declares no length, so the cap has to be enforced as
    // the bytes arrive rather than after they are all in memory.
    const bytes = await readCapped(response, MAX_PREVIEW_BYTES);
    if (!bytes || bytes.length === 0) {
      return { status: 'unavailable' };
    }
    const contentType = sniffImageType(bytes);
    if (!contentType) {
      // Not an image at all -- an error page, most likely. Fall back to the icon.
      log?.warn?.({ fileId }, 'preview response was not an image');
      return { status: 'unavailable' };
    }

    await ensureDir();
    const finalPath = join(dir, fileName);
    // Temp-file + rename: a reader either sees no file or a whole one, even if
    // the process dies mid-write or two requests race.
    const tempPath = join(dir, `.tmp-${fileId}-${randomUUID()}`);
    try {
      await writeFile(tempPath, bytes);
      await rename(tempPath, finalPath);
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }

    await prune(fileId, fileName);
    return { status: 'ok', path: finalPath, contentType, cached: false };
  }

  // Crash leftovers from a previous run. Fire-and-forget: a cache directory
  // we can't tidy is not a reason to refuse to serve thumbnails.
  sweepTempFiles(dir).catch(() => {});

  return {
    dir,
    size,

    /**
     * @param {{ fileId: string, etag: string }} params straight off the URL
     * @returns {Promise<{status:'ok', path:string, contentType:string, cached:boolean}
     *                  | {status:'unavailable'}>}
     * @throws {PreviewParamError} when the URL params don't validate
     */
    async get({ fileId, etag }) {
      const fileName = previewFileName(fileId, etag, size);
      const path = join(dir, fileName);

      const known = memo.get(fileName);
      if (known?.status === 'unavailable') {
        if (known.expires > Date.now()) return { status: 'unavailable' };
        memo.delete(fileName);
      }

      const existing = await stat(path).catch(() => null);
      if (existing?.isFile() && existing.size > 0) {
        const contentType =
          known?.contentType ?? sniffImageType(await readHead(path)) ?? 'image/png';
        remember(fileName, { status: 'ok', contentType });
        return { status: 'ok', path, contentType, cached: true };
      }

      const pending = inFlight.get(fileName);
      if (pending) return pending;

      const promise = fill(fileId, fileName)
        .then((result) => {
          if (result.status === 'ok') {
            remember(fileName, { status: 'ok', contentType: result.contentType });
          } else {
            remember(fileName, {
              status: 'unavailable',
              expires: Date.now() + unavailableTtlMs,
            });
          }
          return result;
        })
        .finally(() => inFlight.delete(fileName));
      inFlight.set(fileName, promise);
      return promise;
    },
  };
}

export default createPreviewCache;
