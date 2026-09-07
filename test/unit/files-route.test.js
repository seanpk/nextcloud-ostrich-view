import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';
import { DEFAULT_TREE, SHARE_OWNER } from '../mock-nextcloud/tree.js';

/**
 * The Files home -- the folder-button page that used to be `/`.
 *
 * These are the tests that were written for the home route and follow the page
 * rather than the URL: locating received shares (a `share_folder` instance
 * mounts them a level down), telling them apart from the skeleton content
 * Nextcloud seeds an account with, and how many round trips each of those costs.
 * The stream's own tests live in stream-route.test.js.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWERS_FILE = join(HERE, '..', 'e2e', 'viewers.test.json');
const PASSPHRASE = 'correct horse'; // mom, per viewers.test.json

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-files-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function boot({ baseUrl, dir, logged }) {
  const config = loadConfig({
    NC_BASE_URL: baseUrl,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: TEST_APP_PASSWORD,
    SESSION_SECRET: 'b'.repeat(64),
    VIEWERS_FILE,
    NODE_ENV: 'test',
    DATA_DIR: dir,
  });

  // A logger that only collects, when a test needs to see the warnings.
  const logger = logged
    ? {
        level: 'warn',
        stream: {
          write(line) {
            logged.push(JSON.parse(line));
          },
        },
      }
    : false;

  const app = await buildApp({ config, logger });
  cleanups.push(() => app.close());
  return app;
}

async function bootMock(options) {
  const mock = createMockNextcloud(options);
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();
  return { mock, url };
}

function countPropfinds(mock) {
  return mock.requests.filter((r) => r.method === 'PROPFIND').length;
}

async function login(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `passphrase=${encodeURIComponent(PASSPHRASE)}`,
  });

  assert.equal(response.statusCode, 302, 'the passphrase should have been accepted');
  const cookie = response.headers['set-cookie'];
  return (Array.isArray(cookie) ? cookie : [cookie]).map((c) => c.split(';')[0]).join('; ');
}

function tileNames(body) {
  // Folder tiles link to /files/<encoded path> (see src/lib/tiles.js), and the
  // path is what matters here: a share under a share_folder is mounted at
  // 'Shared/Family', not 'Family'.
  return [...body.matchAll(/href="\/files\/([^"]+)"/g)].map((m) =>
    m[1].split('/').map(decodeURIComponent).join('/')
  );
}

// --- Where the page lives ---------------------------------------------------

test('files: /files is the folder home, and its Back goes to the stream', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const cookie = await login(app);

  const response = await app.inject({ url: '/files', headers: { cookie } });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Folders/);
  assert.match(response.body, /href="\/"[^>]*rel="nofollow"/, 'Back leads to Latest');
  // Files is the section she is in, so that is the toggle option lit up.
  assert.match(response.body, /class="toggle__option is-current" href="\/files"/);
});

test('files: /files/ is the same page, not a redirect loop', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const cookie = await login(app);

  const response = await app.inject({ url: '/files/', headers: { cookie } });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Folders/);
});

test('files: a folder page ends its Back chain at the folder home', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const cookie = await login(app);

  const top = await app.inject({ url: '/files/Biology%20101', headers: { cookie } });
  assert.equal(top.statusCode, 200);
  assert.match(top.body, /class="back" href="\/files"/, 'up one level is Files, not the stream');
  // And the breadcrumb agrees with it: a trail whose root said "Home" and led
  // to a list of recent changes would be a trail lying about its own root.
  assert.match(top.body, /class="crumbs__link" href="\/files">Files</);

  const deep = await app.inject({ url: '/files/Biology%20101/Lectures', headers: { cookie } });
  assert.match(deep.body, /class="back" href="\/files\/Biology%20101"/);
});

test('files: a top-level file goes back to the folder home from the viewer', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const cookie = await login(app);

  const response = await app.inject({ url: '/view/welcome.txt', headers: { cookie } });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /class="back" href="\/files"/);
});

// --- Share-only home --------------------------------------------------------

test('files: only received shares become folder buttons; the account\'s own content does not', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const cookie = await login(app);

  const response = await app.inject({ url: '/files', headers: { cookie } });
  assert.equal(response.statusCode, 200);

  for (const shared of ['Biology 101', 'Math 210', 'Café Notes']) {
    assert.match(response.body, new RegExp(shared));
  }
  for (const skeleton of ['Documents', 'Photos', 'Templates', 'Nextcloud.png', 'Readme.md']) {
    assert.doesNotMatch(response.body, new RegExp(skeleton), `${skeleton} is the account's own content`);
  }
});

test('files: a Nextcloud that sends no share signal at all falls back to showing everything', async () => {
  // shareProps: false -- oc:permissions and oc:owner-id come back 404'd on
  // every entry, the way an old or unusual Nextcloud might. Rather than
  // guessing wrong and hiding real shares, the page must render exactly as it
  // did before this feature existed -- and say so once in the log.
  const dir = dataDir();
  const logged = [];
  const { url } = await bootMock({ shareProps: false });
  const app = await boot({ baseUrl: url, dir, logged });
  const cookie = await login(app);

  const response = await app.inject({ url: '/files', headers: { cookie } });
  assert.equal(response.statusCode, 200);

  for (const name of ['Biology 101', 'Math 210', 'Café Notes', 'Documents', 'Photos', 'Templates']) {
    assert.match(response.body, new RegExp(name), `${name} must still show up with no share signal at all`);
  }

  const warned = () => logged.filter((line) => /no oc:permissions or oc:owner-id/.test(line.msg));
  assert.equal(warned().length, 1);

  // A page refreshed all day must not repeat the same line on every load.
  await app.inject({ url: '/files', headers: { cookie } });
  await app.inject({ url: '/files', headers: { cookie } });
  assert.equal(warned().length, 1, 'once per process, not once per load');
});

test('files: a viewer account with nothing actually shared sees the friendly empty message', async () => {
  const skeletonOnly = Object.fromEntries(
    Object.entries(DEFAULT_TREE).filter(([, node]) => !node.sharedBy)
  );
  assert.ok(Object.keys(skeletonOnly).length > 0, 'the fixture must still have skeleton entries to test with');

  const dir = dataDir();
  const logged = [];
  const { url } = await bootMock({ tree: skeletonOnly });
  const app = await boot({ baseUrl: url, dir, logged });
  const cookie = await login(app);

  const response = await app.inject({ url: '/files', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Nothing has been shared with you yet\./);
  for (const skeleton of Object.keys(skeletonOnly)) {
    assert.doesNotMatch(response.body, new RegExp(skeleton));
  }

  // "Nothing has been shared with you yet" reads like a fact about sharing and
  // gives no hint that a filter was involved, so it is worth one line saying so.
  const warned = () => logged.filter((line) => /every top-level entry was judged/.test(line.msg));
  assert.equal(warned().length, 1);
  await app.inject({ url: '/files', headers: { cookie } });
  assert.equal(warned().length, 1, 'once per process, not once per load');
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

test('files: shares mounted under a share_folder are found, not filtered away', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock({
    tree: SHARE_FOLDER_TREE,
    receivedShares: ['/Shared/Family', '/Shared/Recipes'],
  });
  const app = await boot({ baseUrl: url, dir });

  const cookie = await login(app);
  const response = await app.inject({ url: '/files', headers: { cookie } });

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

test('files: with no share_folder, one PROPFIND still does it', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock(); // DEFAULT_TREE: shares at the top
  const app = await boot({ baseUrl: url, dir });

  const cookie = await login(app);
  const response = await app.inject({ url: '/files', headers: { cookie } });

  assert.equal(response.statusCode, 200);
  assert.ok(tileNames(response.body).length > 0, 'the shared folders should be tiles');
  // The common case must not have got more expensive: the files home is the
  // only share root, so there is nothing extra to list.
  assert.equal(countPropfinds(mock), 1, 'no extra round trip when shares are at the top');
});

test('files: when the share lookup fails, the files home is still listed', async () => {
  const dir = dataDir();
  const logged = [];
  // receivedShares: null makes the OCS endpoint 404, as an instance without
  // files_sharing would -- or a Nextcloud that refuses the request.
  const { url } = await bootMock({ receivedShares: null });
  const app = await boot({ baseUrl: url, dir, logged });

  const cookie = await login(app);
  const response = await app.inject({ url: '/files', headers: { cookie } });

  // Degraded, not broken: shares at the top of the files home still show. Only
  // shares hidden under a share_folder are lost, and the route logs why.
  assert.equal(response.statusCode, 200);
  assert.ok(
    tileNames(response.body).length > 0,
    'a failed share lookup must not empty the page when the shares are reachable anyway'
  );

  const warned = () => logged.filter((line) => /where received shares are mounted/.test(line.msg));
  assert.equal(warned().length, 1);
  await app.inject({ url: '/files', headers: { cookie } });
  assert.equal(warned().length, 1, 'once per process, not once per load');
});

test('files: a share_folder that has gone missing does not fail the page', async () => {
  const dir = dataDir();
  // OCS says the shares live under Shared/, but the tree has no such folder --
  // a share revoked, or the folder renamed, between the two round trips.
  const { url } = await bootMock({ receivedShares: ['/Shared/Family'] });
  const app = await boot({ baseUrl: url, dir });

  const cookie = await login(app);
  const response = await app.inject({ url: '/files', headers: { cookie } });

  assert.equal(response.statusCode, 200, 'one dead root must not take the page down');
  assert.ok(
    tileNames(response.body).length > 0,
    'the shares that are still there should still be listed'
  );
});
