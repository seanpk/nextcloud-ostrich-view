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
import {
  DEFAULT_TREE,
  NEWEST_LAST_MODIFIED,
  SHARE_OWNER,
  resolveNode,
} from '../mock-nextcloud/tree.js';

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
  // Marked as shared like every other real top-level entry -- otherwise the
  // walk fallback prunes it as skeleton content before ever reaching the
  // depth this test exists to hit. See src/nextcloud/shares.js.
  return { ...DEFAULT_TREE, Deep: { ...node, sharedBy: SHARE_OWNER } };
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

// --- Share-only home (M5) ---------------------------------------------------

test('home: only received shares become folder buttons; the account\'s own content does not', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(response.statusCode, 200);

  for (const shared of ['Biology 101', 'Math 210', 'Café Notes']) {
    assert.match(response.body, new RegExp(shared));
  }
  for (const skeleton of ['Documents', 'Photos', 'Templates', 'Nextcloud.png', 'Readme.md']) {
    assert.doesNotMatch(response.body, new RegExp(skeleton), `${skeleton} is the account's own content`);
  }
});

test('home: a Nextcloud that sends no share signal at all falls back to showing everything', async () => {
  // shareProps: false -- oc:permissions and oc:owner-id come back 404'd on
  // every entry, the way an old or unusual Nextcloud might. Rather than
  // guessing wrong and hiding real shares, the page must render exactly as it
  // did before this feature existed.
  const dir = dataDir();
  const { url } = await bootMock({ shareProps: false });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(response.statusCode, 200);

  for (const name of ['Biology 101', 'Math 210', 'Café Notes', 'Documents', 'Photos', 'Templates']) {
    assert.match(response.body, new RegExp(name), `${name} must still show up with no share signal at all`);
  }
});

test('home: a viewer account with nothing actually shared sees the friendly empty message', async () => {
  const skeletonOnly = Object.fromEntries(
    Object.entries(DEFAULT_TREE).filter(([, node]) => !node.sharedBy)
  );
  assert.ok(Object.keys(skeletonOnly).length > 0, 'the fixture must still have skeleton entries to test with');

  const dir = dataDir();
  const { url } = await bootMock({ tree: skeletonOnly });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Nothing has been shared with you yet\./);
  for (const skeleton of Object.keys(skeletonOnly)) {
    assert.doesNotMatch(response.body, new RegExp(skeleton));
  }
});

/**
 * An instance with `share_folder` set -- Nextcloud's own default is `/Shared`.
 *
 * Received shares are mounted inside a folder the viewer account OWNS, so that
 * folder carries neither the `S`/`M` permission letters nor a foreign
 * `oc:owner-id`: by inspection it is indistinguishable from the skeleton
 * content Nextcloud seeds on first login. Filtering the files home therefore
 * drops it and every share underneath, and the page renders "Nothing has been
 * shared with you yet" on an account that has plenty.
 *
 * Locating the shares is what fixes it; see src/nextcloud/ocs.js.
 */
const SHARE_FOLDER_TREE = {
  // Skeleton: seeded by the first login the setup requires, owned by the
  // account, and never to be shown.
  Documents: { type: 'folder', children: {} },
  Photos: { type: 'folder', children: {} },
  Templates: { type: 'folder', children: {} },
  // The mount point. Created by Nextcloud, owned by the account -- no
  // `sharedBy` -- which is precisely why it cannot be recognised by inspection.
  Shared: {
    type: 'folder',
    children: {
      Family: { type: 'folder', sharedBy: SHARE_OWNER, children: {} },
      Recipes: { type: 'folder', sharedBy: SHARE_OWNER, children: {} },
    },
  },
};

function tileNames(body) {
  // Folder tiles link to /files/<encoded path> (see src/lib/tiles.js), and the
  // path is what matters here: a share under a share_folder is mounted at
  // 'Shared/Family', not 'Family'.
  return [...body.matchAll(/href="\/files\/([^"]+)"/g)].map((m) =>
    m[1].split('/').map(decodeURIComponent).join('/')
  );
}

test('home: shares mounted under a share_folder are found, not filtered away', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock({
    tree: SHARE_FOLDER_TREE,
    receivedShares: ['/Shared/Family', '/Shared/Recipes'],
  });
  const app = await boot({ baseUrl: url, dir });

  const session = await login(app);
  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  const names = tileNames(response.body);

  assert.deepEqual(
    names.sort(),
    ['Shared/Family', 'Shared/Recipes'],
    'both shares should be tiles, at the paths they are really mounted at'
  );
  // The regression this test exists for: before the shares were located rather
  // than assumed, this list was empty.
  assert.notEqual(names.length, 0, 'the page must not claim nothing has been shared');

  // Skeleton content still never reaches the page, and neither does the mount
  // point itself -- its children are listed separately and would be duplicates.
  for (const hidden of ['Documents', 'Photos', 'Templates', 'Shared']) {
    assert.ok(!names.includes(hidden), `${hidden} is the account's own content, not a share`);
  }

  // Two listings, not one per share: the files home plus the container.
  assert.equal(countPropfinds(mock), 2, 'one PROPFIND for the files home, one for Shared');
});

test('home: with no share_folder, one PROPFIND still does it', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock(); // DEFAULT_TREE: shares at the top
  const app = await boot({ baseUrl: url, dir });

  const session = await login(app);
  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.ok(tileNames(response.body).length > 0, 'the shared folders should be tiles');
  // The common case must not have got more expensive: the files home is the
  // only share root, so there is nothing extra to list.
  assert.equal(countPropfinds(mock), 1, 'no extra round trip when shares are at the top');
});

test('home: when the share lookup fails, the files home is still listed', async () => {
  const dir = dataDir();
  // receivedShares: null makes the OCS endpoint 404, as an instance without
  // files_sharing would -- or a Nextcloud that refuses the request.
  const { url } = await bootMock({ receivedShares: null });
  const app = await boot({ baseUrl: url, dir });

  const session = await login(app);
  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  // Degraded, not broken: shares at the top of the files home still show. Only
  // shares hidden under a share_folder are lost, and the route logs why.
  assert.equal(response.statusCode, 200);
  assert.ok(
    tileNames(response.body).length > 0,
    'a failed share lookup must not empty the page when the shares are reachable anyway'
  );
});

test('home: a share_folder that has gone missing does not fail the page', async () => {
  const dir = dataDir();
  // OCS says the shares live under Shared/, but the tree has no such folder --
  // a share revoked, or the folder renamed, between the two round trips.
  const { url } = await bootMock({ receivedShares: ['/Shared/Family'] });
  const app = await boot({ baseUrl: url, dir });

  const session = await login(app);
  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200, 'one dead root must not take the page down');
  assert.ok(
    tileNames(response.body).length > 0,
    'the shares that are still there should still be listed'
  );
});
