import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { computeAssetVersion } from '../../src/lib/asset-version.js';
import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

/**
 * The `?v=` on every `/public/` asset.
 *
 * The regression this exists to prevent: `/public/` is cached for a week in
 * production, the version used to be `package.json`'s (which had not moved
 * since the first commit), and so the deploy that landed the stream served new
 * HTML to a phone still holding the previous stylesheet. The version has to
 * follow the BYTES, and the template has to actually emit it -- one test each.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', 'public');
const VIEWERS_FILE = join(HERE, '..', 'e2e', 'viewers.test.json');

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** A throwaway `public/`-shaped tree: a couple of assets and an icons/ dir. */
function fakePublic({ css = 'body { color: red }', icon = '<svg/>' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-assets-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'styles.css'), css);
  mkdirSync(join(dir, 'icons'));
  writeFileSync(join(dir, 'icons', 'task-due.svg'), icon);
  return [dir, join(dir, 'icons')];
}

test('the same asset bytes always give the same version', () => {
  const a = computeAssetVersion(fakePublic());
  const b = computeAssetVersion(fakePublic());

  assert.equal(a, b, 'two identical trees must be indistinguishable, or the cache never holds');
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('changing a stylesheet by one byte changes the version', () => {
  const before = computeAssetVersion(fakePublic({ css: 'body { color: red }' }));
  const after = computeAssetVersion(fakePublic({ css: 'body { color: red }\n' }));

  assert.notEqual(before, after);
});

test('changing an icon changes the version too', () => {
  const before = computeAssetVersion(fakePublic({ icon: '<svg viewBox="0 0 48 48"/>' }));
  const after = computeAssetVersion(
    fakePublic({ icon: '<svg width="48" height="48" viewBox="0 0 48 48"/>' })
  );

  assert.notEqual(before, after);
});

test('renaming a file changes the version, even with the same bytes', () => {
  const [dir] = fakePublic();
  const [other] = fakePublic();
  rmSync(join(other, 'styles.css'));
  writeFileSync(join(other, 'main.css'), 'body { color: red }');

  assert.notEqual(computeAssetVersion([dir]), computeAssetVersion([other]));
});

test('an unreadable directory falls back to something that still busts the cache', () => {
  const version = computeAssetVersion([join(tmpdir(), 'ostrich-nope-' + Math.random())]);

  // A timestamp, not an empty string and not a throw: a boot that cannot read
  // its own assets must still serve pages, and must not serve them under a
  // version that another boot might reuse.
  assert.match(version, /^\d{13,}$/);
});

test('the layout emits the asset version on every /public/ link', async () => {
  const app = await buildApp({
    config: loadConfig({
      NC_BASE_URL: 'http://127.0.0.1:1/nowhere',
      NC_USER: 'ostrich-viewer',
      NC_APP_PASSWORD: 'not-used-here',
      SESSION_SECRET: 'd'.repeat(64),
      PORT: '0',
      HOST: '127.0.0.1',
      VIEWERS_FILE,
      NODE_ENV: 'test',
      DATA_DIR: mkdtempSync(join(tmpdir(), 'ostrich-assets-app-')),
    }),
    logger: false,
  });
  cleanups.push(() => app.close());

  // /login needs no session, and carries both a stylesheet and a script.
  const response = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(response.statusCode, 200);

  const expected = computeAssetVersion([PUBLIC_DIR, join(PUBLIC_DIR, 'icons')]);
  assert.match(expected, /^[0-9a-f]{12}$/, 'the real public/ tree must hash, not fall back');
  assert.ok(response.body.includes(`/public/styles.css?v=${expected}`));
  assert.ok(response.body.includes(`/public/login.js?v=${expected}`));

  // The thing that actually went wrong: a `?v=` that is a hand-maintained
  // number cannot be trusted to change when the assets do.
  assert.ok(!response.body.includes('?v=0.'), 'the version must not be package.json’s');
});
