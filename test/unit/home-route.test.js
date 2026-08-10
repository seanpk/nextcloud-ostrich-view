import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';

/**
 * The home route, wired the way it really is: real store, real search, a mock
 * Nextcloud underneath.
 *
 * Two things only this level can show. First, that a home load which fell over
 * does not spend the baseline -- the store's two-phase API is only worth having
 * if the route actually commits after its fetches. Second, that a mid-sitting
 * refresh asks Nextcloud nothing, which is a question about upstream traffic and
 * cannot be answered by a pure function.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWERS_FILE = join(HERE, '..', 'e2e', 'viewers.test.json');
const PASSPHRASE = 'correct horse'; // mom, per viewers.test.json

/**
 * The sitting we backdate to: after the fixture tree's baseline stamp, before
 * its two "recent" files, and long enough ago that the next load rotates.
 */
const LAST_VISIT = '2025-08-05T00:00:00.000Z';

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-home-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An app on the given Nextcloud, sharing whichever data directory it is given. */
async function boot({ baseUrl, dir }) {
  const config = loadConfig({
    NC_BASE_URL: baseUrl,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: TEST_APP_PASSWORD,
    SESSION_SECRET: 'b'.repeat(64),
    VIEWERS_FILE,
    NODE_ENV: 'test',
    DATA_DIR: dir,
  });

  const app = await buildApp({ config, logger: false });
  cleanups.push(() => app.close());
  return app;
}

async function bootMock() {
  const mock = createMockNextcloud();
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();
  return { mock, url };
}

/** Log in as mom and come back with the cookie header for later requests. */
async function login(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `passphrase=${encodeURIComponent(PASSPHRASE)}`,
  });

  assert.equal(response.statusCode, 302, 'the passphrase should have been accepted');
  const cookie = response.headers['set-cookie'];
  return { cookie: (Array.isArray(cookie) ? cookie : [cookie]).map((c) => c.split(';')[0]).join('; ') };
}

function readState(dir) {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
}

/** Backdate mom's sitting, exactly as an operator (or the E2E suite) would. */
function backdate(dir, startedAt) {
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ mom: { currentVisitStartedAt: startedAt, previousVisitStartedAt: null } })
  );
}

test('home: a load that could not reach Nextcloud does not spend the baseline', async () => {
  const dir = dataDir();
  const { url } = await bootMock();

  const working = await boot({ baseUrl: url, dir });
  // Nothing is listening here, so every upstream request fails immediately.
  const broken = await boot({ baseUrl: 'http://127.0.0.1:1', dir });

  // She has been away for days: this is the sitting the section will compare
  // against, and the one a failed load must not throw away.
  backdate(dir, LAST_VISIT);

  const brokenSession = await login(broken);
  const failed = await broken.inject({ url: '/', headers: { cookie: brokenSession.cookie } });
  assert.equal(failed.statusCode, 502, 'the page failed, which is the whole premise');
  assert.equal(
    readState(dir).mom.currentVisitStartedAt,
    LAST_VISIT,
    'a load that rendered nothing must leave state.json exactly as it was'
  );

  // She tries again when the network is back, and still sees what she missed.
  const session = await login(working);
  const ok = await working.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /New since you last looked/);
  assert.match(ok.body, /microscope\.jpg/);
  assert.equal(
    readState(dir).mom.previousVisitStartedAt,
    LAST_VISIT,
    'the successful load is the one that rotates'
  );
});

test('home: refreshing mid-sitting asks Nextcloud nothing new', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.match(first.body, /New since you last looked/);
  const searches = mock.requests.filter((r) => r.method === 'SEARCH').length;
  assert.equal(searches, 1);

  // Pull-to-refresh, twice. The baseline has not moved, so the answer cannot
  // have either -- and the section must still be there.
  for (let i = 0; i < 2; i += 1) {
    const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
    assert.equal(again.statusCode, 200);
    assert.match(again.body, /microscope\.jpg/);
  }

  assert.equal(
    mock.requests.filter((r) => r.method === 'SEARCH').length,
    searches,
    'the same question, with the same answer, should not be asked again'
  );
});
