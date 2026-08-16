import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { sniffImageType } from '../../src/nextcloud/previews.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';
import { fakeEtag, fakeFileId } from '../mock-nextcloud/tree.js';

/**
 * The `/preview/:fileId` route, end to end, with `pdfPreviews` on and off.
 *
 * `test/unit/tiles.test.js` covers "does a PDF entry get a previewUrl at all"
 * and `previews.test.js` covers the cache/proxy in isolation; this is the one
 * place the whole pipeline -- tile -> route -> Nextcloud -- runs together for
 * a PDF, against a mock standing in for the real Imaginary provider our
 * deployment uses (see PDF_Previews.md).
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWERS_FILE = join(HERE, '..', 'e2e', 'viewers.test.json');
const PASSPHRASE = 'correct horse'; // mom, per viewers.test.json

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function bootMock(options) {
  const mock = createMockNextcloud(options);
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();
  return { mock, url };
}

async function boot(baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-pdf-preview-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));

  const config = loadConfig({
    NC_BASE_URL: baseUrl,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: TEST_APP_PASSWORD,
    SESSION_SECRET: 'c'.repeat(64),
    VIEWERS_FILE,
    NODE_ENV: 'test',
    DATA_DIR: dir,
  });

  const app = await buildApp({ config, logger: false });
  cleanups.push(() => app.close());
  return app;
}

async function login(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `passphrase=${encodeURIComponent(PASSPHRASE)}`,
  });
  assert.equal(response.statusCode, 302);
  const cookie = response.headers['set-cookie'];
  return (Array.isArray(cookie) ? cookie : [cookie]).map((c) => c.split(';')[0]).join('; ');
}

const PDF_PATH = 'Biology 101/syllabus.pdf';

test('preview: pdfPreviews off -- a PDF request 404s upstream and redirects to the icon', async () => {
  const { url } = await bootMock();
  const app = await boot(url);
  const cookie = await login(app);

  const response = await app.inject({
    url: `/preview/${fakeFileId(PDF_PATH)}?v=${fakeEtag(PDF_PATH)}&k=pdf`,
    headers: { cookie },
  });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/public/icons/pdf.svg');
});

test('preview: pdfPreviews on -- a PDF gets a real, sniffable thumbnail', async () => {
  const { url } = await bootMock({ pdfPreviews: true });
  const app = await boot(url);
  const cookie = await login(app);

  const response = await app.inject({
    url: `/preview/${fakeFileId(PDF_PATH)}?v=${fakeEtag(PDF_PATH)}&k=pdf`,
    headers: { cookie },
  });

  assert.equal(response.statusCode, 200);
  assert.ok(response.headers['content-type'].startsWith('image/'));
  assert.ok(
    sniffImageType(response.rawPayload),
    'the bytes must actually sniff as an image, not merely claim to be one'
  );
});
