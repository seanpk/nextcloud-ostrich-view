import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PreviewParamError,
  createPreviewCache,
  isValidEtag,
  isValidFileId,
  previewFileName,
  sniffImageType,
  staleVariants,
  sweepTempFiles,
} from '../../src/nextcloud/previews.js';

/**
 * The preview cache writes files whose names are built out of URL parameters,
 * so these tests care about two things above all else: that nothing but a
 * digits-and-hex key can ever reach the filesystem, and that a changed file
 * never serves a stale thumbnail.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ostrich-preview-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A stand-in for the Nextcloud client that records every preview request and
 * answers with whatever the test queued up.
 */
function stubClient(responder) {
  const calls = [];
  return {
    calls,
    request: async (method, path) => {
      calls.push({ method, path });
      return responder(calls.length, path);
    },
  };
}

// --- parameter validation --------------------------------------------------

test('isValidFileId: accepts digits only', () => {
  assert.equal(isValidFileId('1'), true);
  assert.equal(isValidFileId('908603'), true);

  for (const bad of ['', ' 1', '1 ', '-1', '1.0', '1e3', 'abc', '1/2', '../1', '1'.repeat(20)]) {
    assert.equal(isValidFileId(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(isValidFileId(12345), false, 'non-strings are rejected, not coerced');
});

test('isValidEtag: accepts alphanumerics only', () => {
  assert.equal(isValidEtag('000ddd3babcd'), true);
  assert.equal(isValidEtag('ABC123'), true);

  for (const bad of ['', 'a-b', 'a.b', 'a/b', '..', '%2e%2e', 'a b', '"abc"', 'W/abc', 'a'.repeat(65)]) {
    assert.equal(isValidEtag(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('previewFileName: builds a bare name from a validated key', () => {
  assert.equal(previewFileName('42', 'deadbeef', 512), '42-deadbeef-512.png');
});

test('previewFileName: refuses anything that could escape the cache directory', () => {
  assert.throws(() => previewFileName('../../etc/passwd', 'abc'), PreviewParamError);
  assert.throws(() => previewFileName('42', '../../etc/passwd'), PreviewParamError);
  assert.throws(() => previewFileName('42', 'a/b'), PreviewParamError);
  assert.throws(() => previewFileName('42', 'abc', 0), PreviewParamError);
  assert.throws(() => previewFileName('42', 'abc', 99999), PreviewParamError);
});

test('previewFileName: a rejected parameter is a 400, not a 500', () => {
  try {
    previewFileName('nope', 'abc');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.statusCode, 400);
  }
});

// --- pruning ---------------------------------------------------------------

test('staleVariants: older versions of the same file are stale', () => {
  const names = ['42-aaa-512.png', '42-bbb-512.png', '42-ccc-512.png'];
  assert.deepEqual(staleVariants(names, '42', '42-bbb-512.png'), ['42-aaa-512.png', '42-ccc-512.png']);
});

test('staleVariants: never touches another file id, or a partial-id match', () => {
  const names = ['42-aaa-512.png', '420-aaa-512.png', '7-aaa-512.png', '142-aaa-512.png'];
  assert.deepEqual(staleVariants(names, '42', '42-aaa-512.png'), []);
});

test('staleVariants: ignores in-flight temp files', () => {
  const names = ['42-aaa-512.png', '.tmp-42-9f3c'];
  assert.deepEqual(staleVariants(names, '42', '42-bbb-512.png'), ['42-aaa-512.png']);
});

// --- crash leftovers -------------------------------------------------------

const HOUR = 60 * 60 * 1000;

async function agedFile(dir, name, ageMs) {
  const path = join(dir, name);
  await writeFile(path, PNG);
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

test('sweepTempFiles: a temp file left by a crash is collected', async () => {
  await withTempDir(async (dir) => {
    await agedFile(dir, '.tmp-42-9f3c', 3 * HOUR);
    await agedFile(dir, '42-aaa-512.png', 3 * HOUR);

    assert.equal(await sweepTempFiles(dir), 1);
    assert.deepEqual(await readdir(dir), ['42-aaa-512.png'], 'only temp files are swept');
  });
});

test('sweepTempFiles: a write that is still in flight is left alone', async () => {
  await withTempDir(async (dir) => {
    await agedFile(dir, '.tmp-42-9f3c', 5_000);

    assert.equal(await sweepTempFiles(dir), 0);
    assert.deepEqual(await readdir(dir), ['.tmp-42-9f3c']);
  });
});

test('sweepTempFiles: a missing cache directory is not an error', async () => {
  assert.equal(await sweepTempFiles(join(tmpdir(), 'ostrich-nonexistent-cache-dir')), 0);
});

// --- image sniffing --------------------------------------------------------

test('sniffImageType: recognises what Nextcloud actually returns', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImageType(Buffer.from('RIFF____WEBPVP8 ')), 'image/webp');
});

test('sniffImageType: an HTML error page is not an image', () => {
  assert.equal(sniffImageType(Buffer.from('<!DOCTYPE html><html>')), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(undefined), null);
});

// --- cache behaviour -------------------------------------------------------

test('cache: a miss fetches upstream, stores the bytes, and reports the type', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(() => new Response(PNG, { status: 200 }));
    const cache = createPreviewCache({ dir, client });

    const result = await cache.get({ fileId: '42', etag: 'aaa111' });

    assert.equal(result.status, 'ok');
    assert.equal(result.cached, false);
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.path, join(dir, '42-aaa111-512.png'));
    assert.deepEqual(await readFile(result.path), PNG);
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].path, /^\/index\.php\/core\/preview\?fileId=42&x=512&y=512&a=1$/);
    assert.equal(client.calls[0].method, 'GET');
  });
});

test('cache: a hit does not go near the network', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(() => new Response(PNG, { status: 200 }));
    const cache = createPreviewCache({ dir, client });

    await cache.get({ fileId: '42', etag: 'aaa111' });
    const second = await cache.get({ fileId: '42', etag: 'aaa111' });

    assert.equal(second.status, 'ok');
    assert.equal(second.cached, true);
    assert.equal(second.contentType, 'image/png');
    assert.equal(client.calls.length, 1, 'the second read must be served from disk');
  });
});

test('cache: the content type follows the bytes, not the file extension', async () => {
  await withTempDir(async (dir) => {
    // Nextcloud answers JPEG for some providers; we still store it as .png.
    const client = stubClient(() => new Response(JPEG, { status: 200 }));
    const cache = createPreviewCache({ dir, client });

    const written = await cache.get({ fileId: '42', etag: 'aaa111' });
    assert.equal(written.contentType, 'image/jpeg');

    const fromDisk = await cache.get({ fileId: '42', etag: 'aaa111' });
    assert.equal(fromDisk.cached, true);
    assert.equal(fromDisk.contentType, 'image/jpeg');
  });
});

/**
 * A clock a minute ahead of the wall clock. With `pruneGraceMs: 0` it puts the
 * prune cutoff safely past every file the test just wrote, so "is the older
 * variant gone" is a question about the code and not about how many
 * milliseconds the test took.
 */
const clockAhead = () => Date.now() + 60_000;

test('cache: a new etag re-fetches and prunes the previous version', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(() => new Response(PNG, { status: 200 }));
    const cache = createPreviewCache({ dir, client, pruneGraceMs: 0, now: clockAhead });

    await cache.get({ fileId: '42', etag: 'aaa111' });
    await cache.get({ fileId: '42', etag: 'bbb222' });

    assert.equal(client.calls.length, 2);
    assert.deepEqual(await readdir(dir), ['42-bbb222-512.png']);
  });
});

test('cache: a variant still warm from another request is not pruned under it', async () => {
  // Two phones can hold different etag URLs for the same file for a moment.
  // Pruning on sight would have each evict the other's thumbnail forever --
  // and could delete a file between the stat and the open.
  await withTempDir(async (dir) => {
    const client = stubClient(() => new Response(PNG, { status: 200 }));
    const cache = createPreviewCache({ dir, client });

    await cache.get({ fileId: '42', etag: 'aaa111' });
    await cache.get({ fileId: '42', etag: 'bbb222' });

    assert.deepEqual((await readdir(dir)).sort(), ['42-aaa111-512.png', '42-bbb222-512.png']);
    // ...and the older one still serves, rather than 404ing mid-page.
    assert.equal((await cache.get({ fileId: '42', etag: 'aaa111' })).status, 'ok');
  });
});

test('cache: pruning leaves other files alone', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, '77-zzz-512.png'), PNG);
    const client = stubClient(() => new Response(PNG, { status: 200 }));
    const cache = createPreviewCache({ dir, client, pruneGraceMs: 0, now: clockAhead });

    await cache.get({ fileId: '42', etag: 'aaa111' });
    await cache.get({ fileId: '42', etag: 'bbb222' });

    assert.deepEqual((await readdir(dir)).sort(), ['42-bbb222-512.png', '77-zzz-512.png']);
  });
});

test('cache: a variant that has gone cold is pruned under the real grace window', async () => {
  await withTempDir(async (dir) => {
    // Twenty minutes old, so it is past the ten-minute grace without the test
    // touching the clock at all: nobody's page has rendered from it in ages.
    await agedFile(dir, '42-aaa111-512.png', 20 * 60 * 1000);
    const client = stubClient(() => new Response(PNG, { status: 200 }));
    const cache = createPreviewCache({ dir, client });

    await cache.get({ fileId: '42', etag: 'bbb222' });

    assert.deepEqual(await readdir(dir), ['42-bbb222-512.png']);
  });
});

test('cache: upstream 404 means "no preview", not an error', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(() => new Response('No preview', { status: 404 }));
    const cache = createPreviewCache({ dir, client });

    const result = await cache.get({ fileId: '42', etag: 'aaa111' });

    assert.equal(result.status, 'unavailable');
    assert.deepEqual(await readdir(dir), [], 'nothing may be cached for a missing preview');
  });
});

test('cache: a redirect to the login page is treated as no preview', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(
      () => new Response('', { status: 302, headers: { Location: '/login' } })
    );
    const cache = createPreviewCache({ dir, client });

    assert.equal((await cache.get({ fileId: '42', etag: 'aaa111' })).status, 'unavailable');
  });
});

test('cache: a non-image body is never written to the cache', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(
      () => new Response('<!DOCTYPE html><html>error</html>', { status: 200 })
    );
    const cache = createPreviewCache({ dir, client });

    assert.equal((await cache.get({ fileId: '42', etag: 'aaa111' })).status, 'unavailable');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('cache: an oversized preview is refused rather than buffered', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(
      () =>
        new Response(PNG, {
          status: 200,
          headers: { 'Content-Length': String(64 * 1024 * 1024) },
        })
    );
    const cache = createPreviewCache({ dir, client });

    assert.equal((await cache.get({ fileId: '42', etag: 'aaa111' })).status, 'unavailable');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('cache: a chunked body over the cap is abandoned mid-stream', async () => {
  await withTempDir(async (dir) => {
    // No Content-Length to check, so the only defence is stopping as the bytes
    // arrive. The stream would run to 64 MB if it were read to the end.
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= 64) return controller.close();
        sent += 1;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = stubClient(() => new Response(body, { status: 200 }));
    const cache = createPreviewCache({ dir, client });

    assert.equal((await cache.get({ fileId: '42', etag: 'aaa111' })).status, 'unavailable');
    assert.equal(cancelled, true, 'the rest of the body must never be transferred');
    assert.ok(sent <= 10, `read ${sent} MB before giving up`);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('cache: "no preview for this" is remembered, not re-asked on every tile', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(() => new Response('No preview', { status: 404 }));
    const cache = createPreviewCache({ dir, client });

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await cache.get({ fileId: '42', etag: 'aaa111' })).status, 'unavailable');
    }

    assert.equal(client.calls.length, 1, 'a folder of PDFs is one 404, not twenty');
  });
});

test('cache: the negative answer expires, so enabling a provider takes effect', async () => {
  await withTempDir(async (dir) => {
    let status = 404;
    const client = stubClient(() =>
      status === 404 ? new Response('No preview', { status: 404 }) : new Response(PNG, { status: 200 })
    );
    const cache = createPreviewCache({ dir, client, unavailableTtlMs: 0 });

    assert.equal((await cache.get({ fileId: '42', etag: 'aaa111' })).status, 'unavailable');
    status = 200;
    assert.equal((await cache.get({ fileId: '42', etag: 'aaa111' })).status, 'ok');
    assert.equal(client.calls.length, 2);
  });
});

test('cache: simultaneous requests for one thumbnail make one upstream call', async () => {
  await withTempDir(async (dir) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = stubClient(async () => {
      await gate;
      return new Response(PNG, { status: 200 });
    });
    const cache = createPreviewCache({ dir, client });

    const both = Promise.all([
      cache.get({ fileId: '42', etag: 'aaa111' }),
      cache.get({ fileId: '42', etag: 'aaa111' }),
    ]);
    release();
    const [a, b] = await both;

    assert.equal(a.status, 'ok');
    assert.equal(b.status, 'ok');
    assert.equal(client.calls.length, 1, 'a folder of photos must not stampede Nextcloud');
  });
});

test('cache: a failed fetch leaves no half-written file behind', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(() => {
      throw new Error('connection reset');
    });
    const cache = createPreviewCache({ dir, client });

    await assert.rejects(() => cache.get({ fileId: '42', etag: 'aaa111' }));
    assert.deepEqual(await readdir(dir), [], 'no temp file, no truncated png');
  });
});

test('cache: a rejected key never reaches the filesystem', async () => {
  await withTempDir(async (dir) => {
    const client = stubClient(() => new Response(PNG, { status: 200 }));
    const cache = createPreviewCache({ dir, client });

    await assert.rejects(
      () => cache.get({ fileId: '../../etc', etag: 'aaa111' }),
      PreviewParamError
    );
    assert.equal(client.calls.length, 0, 'validation happens before the network');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('cache: a zero-byte cache file is refetched rather than served', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, '42-aaa111-512.png'), '');
    const client = stubClient(() => new Response(PNG, { status: 200 }));
    const cache = createPreviewCache({ dir, client });

    const result = await cache.get({ fileId: '42', etag: 'aaa111' });

    assert.equal(result.cached, false);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(await readFile(result.path), PNG);
  });
});
