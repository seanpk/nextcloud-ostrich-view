import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createTtlCache } from '../../src/lib/stream.js';
import { WALK_MAX_DEPTH } from '../../src/nextcloud/search.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';
import {
  DEFAULT_TREE,
  NEWEST_LAST_MODIFIED,
  SHARE_OWNER,
  resolveNode,
} from '../mock-nextcloud/tree.js';

/**
 * The stream route, wired the way it really is: real store, real search, a mock
 * Nextcloud underneath.
 *
 * Things only this level can show. First, that a load which fell over does not
 * spend the baseline -- the store's two-phase API is only worth having if the
 * route actually commits after its fetch. Second, that an unreachable Nextcloud
 * reaches the error pages rather than rendering as an empty stream, which is
 * the one policy that changed when this page stopped being a bonus section and
 * became the app's front door. Third, how much upstream traffic a refresh costs
 * and when the route is willing to ask again: questions about the conversation
 * with Nextcloud, which no pure function can answer.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWERS_FILE = join(HERE, '..', 'e2e', 'viewers.test.json');
const PASSPHRASE = 'correct horse'; // mom, per viewers.test.json

/**
 * The sitting we backdate to: after the fixture tree's baseline stamp, before
 * its two "recent" files, and long enough ago that the next load rotates.
 */
const LAST_VISIT = '2025-08-05T00:00:00.000Z';

/** The two files the fixture stamps after LAST_VISIT, newest first. */
const RECENT_FILES = ['microscope.jpg', 'Week 2 Notes.pdf'];

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-stream-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An app on the given Nextcloud, sharing whichever data directory it is given. */
async function boot({ baseUrl, dir, streamCache }) {
  const config = loadConfig({
    NC_BASE_URL: baseUrl,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: TEST_APP_PASSWORD,
    SESSION_SECRET: 'b'.repeat(64),
    VIEWERS_FILE,
    NODE_ENV: 'test',
    DATA_DIR: dir,
  });

  const app = await buildApp({ config, logger: false, streamCache });
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

/** The file names on the page, in the order they appear, from the row markup. */
function rowNames(body) {
  return [...body.matchAll(/<span class="stream__name">([^<]*)<\/span>/g)].map((m) => m[1]);
}

/** The names of the rows carrying a New badge. */
function badgedNames(body) {
  return [...body.matchAll(/<li class="stream__item stream__item--new">[\s\S]*?<\/li>/g)].flatMap(
    (m) => rowNames(m[0])
  );
}

// --- What the page is -------------------------------------------------------

test('stream: the whole recent history is listed, grouped by day, newest first', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  const names = rowNames(response.body);

  // Not a filtered slice: files far older than any sitting are on the page too.
  assert.deepEqual(names.slice(0, 2), RECENT_FILES, 'newest first');
  assert.ok(names.includes('Week 1 Notes.pdf'), 'and the older history under it');
  assert.ok(names.includes('résumé draft.pdf'));

  // Day headings, and the anchor #3 builds on.
  assert.match(response.body, /<h2[^>]*id="today"[^>]*>Today<\/h2>/);
  assert.match(response.body, /class="stream__day[^"]*"[^>]*>[A-Z]\w\w, \w\w\w \d/);

  // One SEARCH, and no folder listing: the stream needs neither.
  assert.equal(countSearches(mock), 1);
  assert.equal(countPropfinds(mock), 0, 'the stream costs exactly one upstream request');
});

test('stream: skeleton content never reaches the page, however recently it changed', async () => {
  // Photos/Frog.jpg is stamped as recently as the newest real share, on purpose.
  // With no date filter left to hide behind, ownership is the only thing keeping
  // the viewer account's own content off the page she reads first.
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  for (const skeleton of ['Frog.jpg', 'Example.md', 'Letter.odt', 'Nextcloud Manual.pdf']) {
    assert.ok(!rowNames(response.body).includes(skeleton), `${skeleton} is not a share`);
  }
});

test('stream: a file we cannot open inline is a row, but not a link', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.ok(rowNames(response.body).includes('welcome.txt'));
  assert.match(response.body, /stream__row--static/);
  // And a scripted SVG is never linked from here either -- same rule as a tile.
  assert.doesNotMatch(response.body, /href="\/view\/[^"]*mitosis\.svg"/);
});

// --- Badges -----------------------------------------------------------------

test('stream: a first-ever visit gets the list, with nothing badged and no note', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.ok(rowNames(response.body).length > 3, 'the list is the point of the page');
  assert.deepEqual(badgedNames(response.body), [], 'nothing to compare against yet');
  assert.doesNotMatch(response.body, /You were last here/);
});

test('stream: after a few days away, the badges land on what changed since', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(badgedNames(response.body), RECENT_FILES);
  assert.match(response.body, /You were last here on \w{3}, Aug \d/);
  assert.match(response.body, /Newer things are marked New/);
  // The rest of the history is there, unbadged.
  assert.ok(rowNames(response.body).length > RECENT_FILES.length);
});

test('stream: refreshing mid-sitting leaves the badges exactly where they were', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.deepEqual(badgedNames(first.body), RECENT_FILES);

  // The single most likely thing she does next. The baseline must not move --
  // that is the whole reason a visit is a sitting rather than a page load.
  for (let i = 0; i < 2; i += 1) {
    const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
    assert.deepEqual(badgedNames(again.body), RECENT_FILES, `refresh ${i + 1}`);
  }
  assert.equal(readState(dir).mom.previousVisitStartedAt, LAST_VISIT);
});

test('stream: browsing files or tasks does not spend the baseline', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  await app.inject({ url: '/', headers: { cookie: session.cookie } });
  const rotated = readState(dir).mom.currentVisitStartedAt;

  for (const path of ['/files', '/files/Biology%20101', '/tasks']) {
    const response = await app.inject({ url: path, headers: { cookie: session.cookie } });
    assert.equal(response.statusCode, 200, path);
  }

  const state = readState(dir);
  assert.equal(state.mom.previousVisitStartedAt, LAST_VISIT, 'still the same baseline');
  assert.equal(state.mom.currentVisitStartedAt, rotated, 'and the same sitting');
});

// --- Failure policy ---------------------------------------------------------

test('stream: an unreachable Nextcloud reaches the error page, not an empty list', async () => {
  const dir = dataDir();
  const { url } = await bootMock();

  const working = await boot({ baseUrl: url, dir });
  // Nothing is listening here, so every upstream request fails immediately.
  const broken = await boot({ baseUrl: 'http://127.0.0.1:1', dir });

  // She has been away for days: this is the sitting the badges will be measured
  // against, and the one a failed load must not throw away.
  backdate(dir, LAST_VISIT);

  const brokenSession = await login(broken);
  const failed = await broken.inject({ url: '/', headers: { cookie: brokenSession.cookie } });

  // 503 + the "file server is taking a break" page. The policy this asserts is
  // the one that changed with the stream: rendering an empty page would tell her
  // nothing had happened, about a lookup that never happened.
  assert.equal(failed.statusCode, 503);
  assert.match(failed.body, /taking a break/);
  assert.doesNotMatch(failed.body, /Nothing has changed yet/);
  assert.equal(
    readState(dir).mom.currentVisitStartedAt,
    LAST_VISIT,
    'a load that rendered nothing must leave state.json exactly as it was'
  );

  // She tries again when the network is back, and the badges are still right.
  const session = await login(working);
  const ok = await working.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(ok.statusCode, 200);
  assert.deepEqual(badgedNames(ok.body), RECENT_FILES);
  assert.equal(
    readState(dir).mom.previousVisitStartedAt,
    LAST_VISIT,
    'the successful load is the one that rotates'
  );
});

test('stream: an unreadable state file costs the badges and nothing else', async () => {
  const dir = dataDir();
  // A directory where state.json should be: every read AND write fails, which
  // no amount of retrying will fix.
  writeFileSync(join(dir, 'state.json.keep'), '');
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  // The store already survives an unreadable file by starting fresh, so the
  // observable promise is the simpler one: the list is never withheld because a
  // timestamp could not be read.
  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.ok(rowNames(response.body).length > 3);
});

// --- Cost of a refresh ------------------------------------------------------

test('stream: a burst of refreshes asks Nextcloud nothing new', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.ok(rowNames(first.body).includes('microscope.jpg'));
  assert.equal(countSearches(mock), 1);

  // Pull-to-refresh, twice, inside the cache window -- which is what the window
  // is for. The page must still be there, at no upstream cost.
  for (let i = 0; i < 2; i += 1) {
    const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
    assert.equal(again.statusCode, 200);
    assert.ok(rowNames(again.body).includes('microscope.jpg'));
  }

  assert.equal(
    countSearches(mock),
    1,
    'the same question, asked twice in a second, should not travel twice'
  );
});

test('stream: once the cache window passes, a fresh upload turns up', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();

  // The question the stream asks never changes, so only the TTL can let a new
  // file through -- which is exactly the bug a keyed-but-never-expiring cache
  // would have: the first answer of the process would be the last one anybody
  // ever saw.
  let clock = 0;
  const app = await boot({
    baseUrl: url,
    dir,
    streamCache: createTtlCache({ ttlMs: 60_000, now: () => clock }),
  });
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.ok(!rowNames(first.body).includes('lab notebook.png'));
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
  assert.ok(!rowNames(stale.body).includes('lab notebook.png'));
  assert.equal(countSearches(mock), 1);

  // A minute later, the reload really asks again.
  clock += 1_000;
  const fresh = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(fresh.statusCode, 200);
  assert.equal(countSearches(mock), 2, 'the window expired, so the question is asked again');
  assert.ok(rowNames(fresh.body).includes('lab notebook.png'), 'and the new file is on the page');
});

// --- The walk fallback ------------------------------------------------------

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
  // Marked as shared like every other real top-level entry -- otherwise the
  // walk fallback prunes it as skeleton content before ever reaching the
  // depth this test exists to hit. See src/nextcloud/shares.js.
  return { ...DEFAULT_TREE, Deep: { ...node, sharedBy: SHARE_OWNER } };
}

test('stream: a truncated walk still renders, and says the history goes further back', async () => {
  const dir = dataDir();
  // 405 is the honest "we do not do SEARCH": structural, remembered for good.
  // From here on the walk is not a fallback, it is the strategy -- and on a
  // share deep enough to hit its bounds, EVERY answer it can give is truncated.
  // Refusing to remember those means the cache is never used at all on exactly
  // the instances that can least afford it: a whole tree walk on every
  // pull-to-refresh, for the page she opens the app on.
  const { mock, url } = await bootMock({ tree: treeWithBuriedUpload(), searchStatus: 405 });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(first.statusCode, 200, 'a walk that gave up early is not a failed page');
  assert.ok(rowNames(first.body).includes('microscope.jpg'), 'the walk found what it could reach');
  assert.match(first.body, /Older changes aren’t listed here\./);
  const walked = countPropfinds(mock);
  assert.ok(walked > 2, `the first load really walked the tree (${walked} PROPFINDs)`);

  const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(again.statusCode, 200);
  assert.ok(rowNames(again.body).includes('microscope.jpg'), 'the page is still there');
  assert.equal(
    countPropfinds(mock) - walked,
    0,
    'and it cost nothing: the answer was remembered, and the stream needs no folder listing'
  );
  assert.equal(countSearches(mock), 1, 'a settled instance never probes SEARCH again either');
});

test('stream: a truncated answer from a one-off walk is not cached, so SEARCH replaces it', async () => {
  const dir = dataDir();
  // The other half of the pair. SEARCH is having a bad minute -- transient, so
  // the instance is NOT demoted and the next load tries it again. The walk here
  // is a stand-in, not the strategy, so its half-answer must not be held on to.
  const { mock, url } = await bootMock({ tree: treeWithBuriedUpload(), searchStatus: 502 });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const degraded = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(degraded.statusCode, 200);
  assert.ok(rowNames(degraded.body).includes('microscope.jpg'), 'the walk finds what it can reach');
  assert.ok(!rowNames(degraded.body).includes('buried notes.pdf'), 'and gives up before the deep branch');
  assert.match(degraded.body, /Older changes aren/, 'a truncated list says so');

  // SEARCH recovers. Had the half-answer been cached, this load would have
  // served it from memory and the deep file would stay invisible for the rest
  // of the window -- for exactly as long as it is worth re-asking.
  mock.setSearchStatus(null);

  const healthy = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(healthy.statusCode, 200);
  assert.ok(rowNames(healthy.body).includes('buried notes.pdf'), 'the full answer replaces the degraded one');
  assert.doesNotMatch(healthy.body, /Older changes aren/);
});

test('stream: a truncated walk that found nothing does not claim nothing changed', async () => {
  // The two lines contradict each other, and only one of them is a claim this
  // lookup can make: whole subtrees went unvisited, so "nothing has changed
  // yet" is exactly what we do not know.
  const skeletonOnly = Object.fromEntries(
    Object.entries(DEFAULT_TREE).filter(([, node]) => !node.sharedBy)
  );
  const buried = { type: 'folder', children: {} };
  let node = buried;
  for (let i = 0; i < WALK_MAX_DEPTH + 1; i += 1) {
    node = { type: 'folder', children: { [`level ${i}`]: node } };
  }

  const dir = dataDir();
  const { url } = await bootMock({
    tree: { ...skeletonOnly, Deep: { ...node, sharedBy: SHARE_OWNER } },
    searchStatus: 405,
  });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Older changes aren’t listed here\./);
  assert.doesNotMatch(response.body, /Nothing has changed yet/);
});

// --- The empty case ---------------------------------------------------------

test('stream: an account with nothing shared says nothing has changed, and means it', async () => {
  const skeletonOnly = Object.fromEntries(
    Object.entries(DEFAULT_TREE).filter(([, node]) => !node.sharedBy)
  );

  const dir = dataDir();
  const { url } = await bootMock({ tree: skeletonOnly });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(rowNames(response.body), []);
  assert.match(response.body, /Nothing has changed yet/);
  // Still a Today line, so the page has a shape and an anchor either way.
  assert.match(response.body, /id="today"/);
});
