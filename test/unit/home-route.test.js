import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createNewSinceCache } from '../../src/lib/new-since.js';
import { WALK_MAX_DEPTH } from '../../src/nextcloud/search.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';
import { DEFAULT_TREE, NEWEST_LAST_MODIFIED, resolveNode } from '../mock-nextcloud/tree.js';

/**
 * The home route, wired the way it really is: real store, real search, a mock
 * Nextcloud underneath.
 *
 * Things only this level can show. First, that a home load which fell over does
 * not spend the baseline -- the store's two-phase API is only worth having if
 * the route actually commits after its fetches. Second, how much upstream
 * traffic a refresh costs, and when the route is willing to ask again: both are
 * questions about the conversation with Nextcloud, and no pure function can
 * answer them.
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
async function boot({ baseUrl, dir, newSinceCache }) {
  const config = loadConfig({
    NC_BASE_URL: baseUrl,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: TEST_APP_PASSWORD,
    SESSION_SECRET: 'b'.repeat(64),
    VIEWERS_FILE,
    NODE_ENV: 'test',
    DATA_DIR: dir,
  });

  const app = await buildApp({ config, logger: false, newSinceCache });
  cleanups.push(() => app.close());
  return app;
}

async function bootMock(options) {
  const mock = createMockNextcloud(options);
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();
  return { mock, url };
}

function countSearches(mock) {
  return mock.requests.filter((r) => r.method === 'SEARCH').length;
}

function countPropfinds(mock) {
  return mock.requests.filter((r) => r.method === 'PROPFIND').length;
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
  // 503 + the "file server is taking a break" page: nothing answered, which is
  // the whole premise of this test.
  assert.equal(failed.statusCode, 503, 'the page failed, which is the whole premise');
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

test('home: a burst of mid-sitting refreshes asks Nextcloud nothing new', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.match(first.body, /New since you last looked/);
  assert.equal(countSearches(mock), 1);

  // Pull-to-refresh, twice, inside the cache window -- which is what the window
  // is for. The section must still be there, at no upstream cost.
  for (let i = 0; i < 2; i += 1) {
    const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
    assert.equal(again.statusCode, 200);
    assert.match(again.body, /microscope\.jpg/);
  }

  assert.equal(
    countSearches(mock),
    1,
    'the same question, asked twice in a second, should not travel twice'
  );
});

test('home: once the cache window passes, a mid-sitting upload turns up', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();

  // The sitting cannot rotate for six hours, so the cache key is frozen for the
  // whole test. Only the TTL can let a new file through -- which is exactly the
  // bug: without one, she would not see this file until tomorrow.
  let clock = 0;
  const app = await boot({
    baseUrl: url,
    dir,
    newSinceCache: createNewSinceCache({ ttlMs: 60_000, now: () => clock }),
  });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.match(first.body, /microscope\.jpg/);
  assert.doesNotMatch(first.body, /lab notebook\.png/);
  assert.equal(countSearches(mock), 1);

  // The owner uploads something while she is still sitting there.
  const graph = resolveNode(DEFAULT_TREE, 'Math 210/graph sketch.png');
  mock.setTree({
    ...DEFAULT_TREE,
    'Math 210': {
      ...DEFAULT_TREE['Math 210'],
      children: {
        ...DEFAULT_TREE['Math 210'].children,
        'lab notebook.png': { ...graph, lastModified: NEWEST_LAST_MODIFIED },
      },
    },
  });

  // Still inside the window: she gets the remembered answer, upload and all.
  clock += 59_000;
  const stale = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.doesNotMatch(stale.body, /lab notebook\.png/);
  assert.equal(countSearches(mock), 1);

  // A minute later, the reload really asks again.
  clock += 1_000;
  const fresh = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(fresh.statusCode, 200);
  assert.equal(countSearches(mock), 2, 'the window expired, so the question is asked again');
  assert.match(fresh.body, /lab notebook\.png/, 'and the new file is finally on the page');
});

/**
 * DEFAULT_TREE plus a branch buried deeper than the walk will ever descend, so
 * a fallback walk comes back `truncated` while SEARCH (depth infinity) does not.
 */
function treeWithBuriedUpload() {
  const pdf = resolveNode(DEFAULT_TREE, 'Biology 101/Lectures/Week 1 Notes.pdf');
  let node = {
    type: 'folder',
    children: { 'buried notes.pdf': { ...pdf, lastModified: NEWEST_LAST_MODIFIED } },
  };
  for (let i = 0; i < WALK_MAX_DEPTH; i += 1) {
    node = { type: 'folder', children: { [`level ${i}`]: node } };
  }
  return { ...DEFAULT_TREE, Deep: node };
}

test('home: on an instance that has settled on the walk, a truncated answer IS cached', async () => {
  const dir = dataDir();
  // 405 is the honest "we do not do SEARCH": structural, remembered for good.
  // From here on the walk is not a fallback, it is the strategy -- and on a
  // share deep enough to hit its bounds, EVERY answer it can give is truncated.
  // Refusing to remember those means the cache is never used at all on exactly
  // the instances that can least afford it: a whole tree walk on every
  // pull-to-refresh, for a section that is a bonus.
  const { mock, url } = await bootMock({ tree: treeWithBuriedUpload(), searchStatus: 405 });
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(first.statusCode, 200);
  assert.match(first.body, /microscope\.jpg/, 'the walk found what it could reach');
  assert.match(first.body, /and more besides/, 'and says it gave up before the rest');
  const walked = countPropfinds(mock);
  assert.ok(walked > 2, `the first load really walked the tree (${walked} PROPFINDs)`);

  const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(again.statusCode, 200);
  assert.match(again.body, /microscope\.jpg/, 'the section is still there');
  assert.match(again.body, /and more besides/);
  assert.equal(
    countPropfinds(mock) - walked,
    1,
    'and it cost one PROPFIND: the folder listing the page always needs, and no second walk'
  );
  assert.equal(countSearches(mock), 1, 'a settled instance never probes SEARCH again either');
});

test('home: a truncated answer from a one-off walk is not cached, so SEARCH replaces it', async () => {
  const dir = dataDir();
  // The other half of the pair. SEARCH is having a bad minute -- transient, so
  // the instance is NOT demoted and the next load tries it again. The walk here
  // is a stand-in, not the strategy, so its half-answer must not be held on to.
  const { mock, url } = await bootMock({ tree: treeWithBuriedUpload(), searchStatus: 502 });
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const degraded = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(degraded.statusCode, 200);
  assert.match(degraded.body, /microscope\.jpg/, 'the walk still finds what it can reach');
  assert.doesNotMatch(degraded.body, /buried notes\.pdf/, 'and gives up before the deep branch');
  assert.match(degraded.body, /and more besides/, 'a truncated list says so');

  // SEARCH recovers. Had the half-answer been cached, this load would have
  // served it from memory and the deep file would stay invisible for the rest
  // of the window -- for exactly as long as it is worth re-asking.
  mock.setSearchStatus(null);

  const healthy = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(healthy.statusCode, 200);
  assert.match(healthy.body, /buried notes\.pdf/, 'the full answer replaces the degraded one');
  assert.doesNotMatch(healthy.body, /and more besides/);
});
