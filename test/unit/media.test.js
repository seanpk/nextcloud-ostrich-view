import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';
import { SHARE_OWNER } from '../mock-nextcloud/tree.js';
import {
  contentDisposition,
  createStatCache,
  etagMatches,
  forwardRangeHeaders,
  passthroughHeaders,
} from '../../src/routes/media.js';

/**
 * Two halves. First, the pure decisions `/content/*` makes about one proxied
 * file: which request headers go upstream, which response headers come back,
 * and when a revisit can be answered without touching Nextcloud at all. (What
 * the bytes may be called is src/lib/filetypes.js's decision, tested alongside
 * it.) Then, at the bottom, `/download/*` and the document viewer against a
 * booted app -- those are questions about a whole response, not about a
 * function.
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

test('contentDisposition: inline is the default -- /content/* never offers a download', () => {
  assert.match(contentDisposition('syllabus.pdf'), /^inline; /);
});

test('contentDisposition: attachment is opt-in, and only /download/* opts in', () => {
  // A browser saves an attachment rather than rendering it, which is what
  // makes it safe for /download/* to send an office file's real MIME type.
  assert.match(contentDisposition('notes.docx', { attachment: true }), /^attachment; /);
  assert.match(contentDisposition('notes.docx', { attachment: false }), /^inline; /);
  // ...and the filename half is identical either way.
  const [, ...inline] = contentDisposition('notes.docx').split(';');
  const [, ...attached] = contentDisposition('notes.docx', { attachment: true }).split(';');
  assert.deepEqual(attached, inline);
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


// --- /download/* and the document viewer -----------------------------------

/**
 * The two routes office files added, wired the way they really are: real
 * templates, real converter, a mock Nextcloud underneath.
 *
 * These need the whole app rather than a pure function because the questions
 * are about the response: what disposition and Content-Type a download
 * carries, which paths the route refuses to answer at all, and -- the one that
 * matters most -- that a document which will not convert still renders a calm
 * page with a download button instead of a 500.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWERS_FILE = join(HERE, '..', 'e2e', 'viewers.test.json');
const PASSPHRASE = 'correct horse'; // mom, per viewers.test.json

const DOCX = '/Biology%20101/Lectures/Week%203%20Notes.docx';
const XLSX = '/Biology%20101/Lectures/marks.xlsx';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** The app, on a mock Nextcloud serving `tree` (the default fixture unless said). */
async function boot({ tree } = {}) {
  const mock = createMockNextcloud(tree ? { tree } : undefined);
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();

  const config = loadConfig({
    NC_BASE_URL: url,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: TEST_APP_PASSWORD,
    SESSION_SECRET: 'c'.repeat(64),
    VIEWERS_FILE,
    NODE_ENV: 'test',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'ostrich-media-')),
  });

  const app = await buildApp({ config, logger: false });
  cleanups.push(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `passphrase=${encodeURIComponent(PASSPHRASE)}`,
  });
  assert.equal(login.statusCode, 302, 'the passphrase should have been accepted');
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [raw]).map((c) => c.split(';')[0]).join('; ');

  return {
    /** @param {string} url */
    get: (url) => app.inject({ url, headers: { cookie } }),
  };
}

test('/download: hands over a Word document as itself, as an attachment', async () => {
  const { get } = await boot();
  const response = await get(`/download${DOCX}`);

  assert.equal(response.statusCode, 200);
  // The real MIME, which is what makes a phone open it in Word -- safe only
  // because of the disposition on the next line. See src/lib/filetypes.js.
  assert.equal(response.headers['content-type'], DOCX_TYPE);
  assert.match(response.headers['content-disposition'], /^attachment; filename="Week 3 Notes\.docx"/);
  assert.ok(response.headers['content-disposition'].includes("filename*=UTF-8''"));
  // A household's coursework does not sit in a shared browser's disk cache.
  assert.equal(response.headers['cache-control'], 'private, no-store');
  // And the bytes really arrived: a .docx is a zip, so it starts "PK".
  assert.ok(response.rawPayload.length > 1000);
  assert.equal(response.rawPayload.subarray(0, 2).toString('latin1'), 'PK');
});

test('/download: a PDF is offered too, since she may want it on the phone', async () => {
  const { get } = await boot();
  const response = await get('/download/Biology%20101/syllabus.pdf');

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/pdf');
  assert.match(response.headers['content-disposition'], /^attachment;/);
});

test('/download: everything we do not offer 404s rather than gaining a way out', async () => {
  const { get } = await boot();

  for (const path of [
    '/download/welcome.txt',
    '/download/Biology%20101/Lectures/cell%20diagram.png',
    '/download/Biology%20101/Lectures/mitosis.svg',
    '/download/Biology%20101', // a folder
    '/download/Biology%20101/nope.docx', // not there at all
    '/download/', // nothing named
  ]) {
    const response = await get(path);
    assert.equal(response.statusCode, 404, `${path} should not be downloadable`);
  }
});

test('/download: a unicode filename survives the header', async () => {
  const { get } = await boot();
  const response = await get('/download/Caf%C3%A9%20Notes/r%C3%A9sum%C3%A9%20draft.pdf');

  assert.equal(response.statusCode, 200);
  const disposition = response.headers['content-disposition'];
  assert.ok(disposition.includes("filename*=UTF-8''r%C3%A9sum%C3%A9%20draft.pdf"));
  assert.ok(disposition.includes('filename="r_sum_ draft.pdf"'), 'with an ASCII fallback');
});

test('/download: climbing out of the shared tree is refused', async () => {
  const { get } = await boot();

  for (const path of ['/download/..%2F..%2Fetc%2Fpasswd', '/download/Biology%20101/..%2F..%2F..%2Fetc%2Fpasswd']) {
    const response = await get(path);
    assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${path}: ${response.statusCode}`);
    assert.ok(!response.body.includes('root:'));
  }
});

test('/view: a Word document arrives as an article, with the original offered', async () => {
  const { get } = await boot();
  const response = await get(`/view${DOCX}`);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<article class="document">/);
  // The fixture's own words, converted rather than described.
  assert.match(response.body, /<h1>Week 3 — Photosynthesis<\/h1>/);
  assert.match(response.body, /<li>The Calvin cycle happens in the stroma<\/li>/);
  assert.match(response.body, /<div class="document__table">/);
  // ...and the way to the real layout.
  assert.match(response.body, new RegExp(`href="/download${DOCX}"`));
  assert.match(response.body, /Download the original/);
  // An ordinary scrolling page: no full-screen chrome, no pdf.js iframe.
  assert.ok(!response.body.includes('viewer__fs'));
  assert.ok(!response.body.includes('<iframe'));
  // Nothing about it says "we can't show this one".
  assert.ok(!response.body.includes('viewer--plain'));
});

test('/view: a second visit is served from the cache, not converted again', async () => {
  const { get } = await boot();

  const first = await get(`/view${DOCX}`);
  const second = await get(`/view${DOCX}`);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  // Same render, byte for byte -- which is the observable half of "converted
  // once". (What the cache costs is asserted in office.test.js.)
  assert.equal(first.body, second.body);
});

test('/view: an office file we cannot render says so, and offers the original', async () => {
  const { get } = await boot();
  const response = await get(`/view${XLSX}`);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /viewer--plain/);
  assert.match(response.body, /We can’t show this one on screen/);
  assert.match(response.body, /Photos, PDFs and Word documents open right here/);
  assert.match(response.body, new RegExp(`href="/download${XLSX}"`));
  assert.match(response.body, /Download marks\.xlsx/);
  // Back is still there, just no longer the loudest thing on the page.
  assert.match(response.body, /Back to the folder/);
});

test('/view: a document that will not convert is a calm page, never a 500', async () => {
  // The file claims to be a .docx and is not one -- which is exactly what a
  // truncated upload, or someone being difficult, looks like.
  const { get } = await boot({
    tree: {
      Broken: {
        type: 'folder',
        sharedBy: SHARE_OWNER,
        children: {
          'not really.docx': {
            type: 'file',
            contentType: DOCX_TYPE,
            bytes: Buffer.from('PK and then nothing that parses', 'utf8'),
            size: 40,
          },
        },
      },
    },
  });

  const response = await get('/view/Broken/not%20really.docx');

  assert.equal(response.statusCode, 200, 'a file we cannot read is not an outage');
  assert.match(response.body, /viewer--plain/);
  assert.match(response.body, /We can’t show this one on screen/);
  assert.match(response.body, new RegExp('href="/download/Broken/not%20really.docx"'));
  assert.ok(!response.body.includes('<article class="document">'));
});

test('/view: a PDF page offers the download next to Full screen', async () => {
  const { get } = await boot();
  const response = await get('/view/Biology%20101/syllabus.pdf');

  assert.equal(response.statusCode, 200);
  // A plain link inside the viewer bar, so it works with JS off -- unlike the
  // full-screen button, which ships hidden and is revealed by viewer.js.
  assert.match(
    response.body,
    /<div class="viewer__bar">[\s\S]*href="\/download\/Biology%20101\/syllabus\.pdf"[\s\S]*viewer__fs/
  );
});

test('/view: a photo has nothing to download, and says nothing about it', async () => {
  const { get } = await boot();
  const response = await get('/view/Biology%20101/Lectures/cell%20diagram.png');

  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes('/download/'), 'a photo is already shown at full size');
  assert.match(response.body, /viewer__fs/, 'but full screen is still offered');
});

test('/view: a file we can neither show nor offer has one button, and it is Back', async () => {
  const { get } = await boot();
  const response = await get('/view/welcome.txt');

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /viewer--plain/);
  assert.ok(!response.body.includes('/download/'));
  assert.match(response.body, /btn btn--primary" href="\/">Back to the folder/);
});
