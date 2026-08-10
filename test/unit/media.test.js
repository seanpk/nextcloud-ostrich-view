import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contentDisposition,
  createStatCache,
  etagMatches,
  forwardRangeHeaders,
  passthroughHeaders,
} from '../../src/routes/media.js';

/**
 * The pure decisions `/content/*` makes about one proxied file: which request
 * headers go upstream, which response headers come back, and when a revisit
 * can be answered without touching Nextcloud at all. (What the bytes may be
 * called is src/lib/filetypes.js's decision, tested alongside it.)
 */

// --- range passthrough -----------------------------------------------------

test('forwardRangeHeaders: forwards the shapes pdf.js actually sends', () => {
  assert.deepEqual(forwardRangeHeaders({ range: 'bytes=0-65535' }), { Range: 'bytes=0-65535' });
  assert.deepEqual(forwardRangeHeaders({ range: 'bytes=65536-' }), { Range: 'bytes=65536-' });
  assert.deepEqual(forwardRangeHeaders({ range: 'bytes=-500' }), { Range: 'bytes=-500' });
});

test('forwardRangeHeaders: a multi-range request is not relayed', () => {
  // The answer would be multipart/byteranges, whose Content-Type carries the
  // part boundary -- and this route replaces Content-Type with the file's own,
  // leaving the browser holding an unparseable body.
  assert.deepEqual(forwardRangeHeaders({ range: 'bytes=0-99,200-299' }), {});
  assert.deepEqual(forwardRangeHeaders({ range: 'bytes=0-99, 200-299' }), {});
});

test('forwardRangeHeaders: surrounding whitespace is trimmed, not rejected', () => {
  assert.deepEqual(forwardRangeHeaders({ range: '  bytes=0-10 ' }), { Range: 'bytes=0-10' });
});

test('forwardRangeHeaders: no Range header means nothing is forwarded', () => {
  assert.deepEqual(forwardRangeHeaders({}), {});
  assert.deepEqual(forwardRangeHeaders(), {});
});

test('forwardRangeHeaders: malformed ranges are dropped rather than relayed', () => {
  for (const range of [
    'items=0-10',
    'bytes=abc-def',
    'bytes=',
    'bytes=-',
    'bytes',
    'bytes=0-10; drop table',
    'bytes=0-10\r\nX-Injected: 1',
    `bytes=${'0-1,'.repeat(80)}0-1`,
  ]) {
    assert.deepEqual(forwardRangeHeaders({ range }), {}, `${range} must not be forwarded`);
  }
});

test('forwardRangeHeaders: a non-string Range is ignored', () => {
  assert.deepEqual(forwardRangeHeaders({ range: ['bytes=0-1', 'bytes=2-3'] }), {});
});

test('forwardRangeHeaders: If-Range rides along, but only with a valid Range', () => {
  assert.deepEqual(forwardRangeHeaders({ range: 'bytes=0-10', 'if-range': '"etag"' }), {
    Range: 'bytes=0-10',
    'If-Range': '"etag"',
  });
  assert.deepEqual(forwardRangeHeaders({ 'if-range': '"etag"' }), {});
});

// --- response headers ------------------------------------------------------

test('passthroughHeaders: copies exactly the headers a range response needs', () => {
  const upstream = new Headers({
    'Content-Length': '1024',
    'Content-Range': 'bytes 0-1023/219877',
    'Accept-Ranges': 'bytes',
    'Last-Modified': 'Mon, 04 Aug 2025 09:15:00 GMT',
  });

  assert.deepEqual(passthroughHeaders(upstream), {
    'content-length': '1024',
    'content-range': 'bytes 0-1023/219877',
    'accept-ranges': 'bytes',
    'last-modified': 'Mon, 04 Aug 2025 09:15:00 GMT',
  });
});

test('passthroughHeaders: Nextcloud’s own cookies and policies stay upstream', () => {
  const upstream = new Headers({
    'Content-Length': '10',
    'Set-Cookie': 'nc_session=secret',
    'Content-Security-Policy': "default-src 'none'",
    'X-Robots-Tag': 'none',
  });

  assert.deepEqual(Object.keys(passthroughHeaders(upstream)), ['content-length']);
});

test('passthroughHeaders: absent headers are simply absent', () => {
  assert.deepEqual(passthroughHeaders(new Headers()), {});
  assert.deepEqual(passthroughHeaders(undefined), {});
});

test('passthroughHeaders: a compressed upstream never dictates our byte count', () => {
  // fetch hands us the decoded body but leaves Content-Length describing the
  // compressed one; relaying it promises fewer bytes than we go on to stream.
  const upstream = new Headers({
    'Content-Length': '512',
    'Content-Encoding': 'gzip',
    'Accept-Ranges': 'bytes',
  });

  assert.deepEqual(passthroughHeaders(upstream), { 'accept-ranges': 'bytes' });
});

// --- revalidation ----------------------------------------------------------

test('etagMatches: the browser sending back what we gave it is a match', () => {
  assert.equal(etagMatches('"abc123"', '"abc123"'), true);
  assert.equal(etagMatches('  "abc123"  ', '"abc123"'), true);
});

test('etagMatches: weak and strong forms compare equal, as RFC 9110 requires', () => {
  assert.equal(etagMatches('W/"abc123"', '"abc123"'), true);
  assert.equal(etagMatches('"abc123"', 'W/"abc123"'), true);
});

test('etagMatches: a list, and the wildcard, both count', () => {
  assert.equal(etagMatches('"other", "abc123"', '"abc123"'), true);
  assert.equal(etagMatches('*', '"abc123"'), true);
});

test('etagMatches: a different version is a miss, so the bytes get sent', () => {
  assert.equal(etagMatches('"older"', '"abc123"'), false);
  assert.equal(etagMatches('"abc123"', null), false);
  assert.equal(etagMatches(undefined, '"abc123"'), false);
  assert.equal(etagMatches(['"abc123"'], '"abc123"'), false, 'a repeated header is not trusted');
});

// --- content disposition ---------------------------------------------------

test('contentDisposition: always inline -- this app never offers a download', () => {
  assert.match(contentDisposition('syllabus.pdf'), /^inline; /);
});

test('contentDisposition: unicode names survive in the RFC 5987 form', () => {
  const header = contentDisposition('résumé draft.pdf');
  assert.ok(header.includes("filename*=UTF-8''r%C3%A9sum%C3%A9%20draft.pdf"));
  // ...and the ASCII fallback stays a well-formed quoted string.
  assert.ok(header.includes('filename="r_sum_ draft.pdf"'));
});

test('contentDisposition: quotes in a file name cannot break out of the header', () => {
  const header = contentDisposition('we"ird\\name.png');
  assert.equal(header.split(';')[1].trim(), 'filename="weirdname.png"');
});

// --- stat memo -------------------------------------------------------------

test('statCache: one PDF read as 40 byte ranges costs one PROPFIND', async () => {
  const cache = createStatCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { name: 'syllabus.pdf' };
  };

  for (let i = 0; i < 40; i += 1) await cache.get('syllabus.pdf', load);

  assert.equal(loads, 1);
});

test('statCache: different files are cached separately', async () => {
  const cache = createStatCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return loads;
  };

  await cache.get('a.pdf', load);
  await cache.get('b.pdf', load);
  await cache.get('a.pdf', load);

  assert.equal(loads, 2);
});

test('statCache: the entry expires, so a renamed or retyped file is picked up', async () => {
  const cache = createStatCache({ ttlMs: 1000 });
  let loads = 0;
  const load = async () => {
    loads += 1;
    return loads;
  };

  assert.equal(await cache.get('a.pdf', load, 0), 1);
  assert.equal(await cache.get('a.pdf', load, 999), 1);
  assert.equal(await cache.get('a.pdf', load, 1001), 2);
});

test('statCache: concurrent misses share a single lookup', async () => {
  const cache = createStatCache();
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const load = async () => {
    loads += 1;
    await gate;
    return 'entry';
  };

  const both = Promise.all([cache.get('a.pdf', load), cache.get('a.pdf', load)]);
  release();

  assert.deepEqual(await both, ['entry', 'entry']);
  assert.equal(loads, 1);
});

test('statCache: a failure is never remembered', async () => {
  const cache = createStatCache();
  let attempts = 0;
  const load = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('upstream down');
    return 'entry';
  };

  await assert.rejects(() => cache.get('a.pdf', load));
  assert.equal(cache.size, 0);
  assert.equal(await cache.get('a.pdf', load), 'entry');
});

test('statCache: it stays bounded', async () => {
  const cache = createStatCache({ max: 4 });
  for (let i = 0; i < 20; i += 1) await cache.get(`file-${i}`, async () => i);
  assert.ok(cache.size <= 4, `expected <= 4 entries, got ${cache.size}`);
});

