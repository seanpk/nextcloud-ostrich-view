import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';
import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

/**
 * Boots the whole stack for the E2E run: mock Nextcloud + the real app, both on
 * ephemeral ports so parallel runs (and CI) never collide.
 *
 * The app's base URL is handed to the workers through OSTRICH_BASE_URL, which
 * the fixture in fixtures.js turns into Playwright's `baseURL`. (Config-level
 * `use.baseURL` can't be used: the config is evaluated before this runs.)
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

// Obviously fake: 32 bytes of hex that nobody would ever ship.
const TEST_SESSION_SECRET = 'a'.repeat(64);

export default async function globalSetup() {
  // The suite deliberately fails logins (wrong-passphrase and per-IP
  // rate-limit specs) across two browser projects; the production global cap
  // of 30 failures/minute would trip mid-run.
  process.env.LOGIN_GLOBAL_LIMIT = '10000';

  const mock = createMockNextcloud();
  const { url: mockUrl } = await mock.start();

  // Runtime state (the preview cache and state.json) goes to a throwaway
  // directory: the run starts from a cold cache every time, and nothing lands
  // in the working tree.
  const dataDir = mkdtempSync(join(tmpdir(), 'ostrich-e2e-'));

  const config = loadConfig({
    NC_BASE_URL: mockUrl,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: TEST_APP_PASSWORD,
    SESSION_SECRET: TEST_SESSION_SECRET,
    PORT: '0',
    VIEWERS_FILE: join(HERE, 'viewers.test.json'),
    // Not production: the session cookie must not be Secure-only, because the
    // tests speak plain HTTP to 127.0.0.1.
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
  });

  const app = await buildApp({ config, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const { port } = app.server.address();
  process.env.OSTRICH_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OSTRICH_MOCK_URL = mockUrl;
  // Exported so a spec can reach into `state.json` and pretend a viewer was
  // last here days ago -- the only way to exercise the stream's New badges
  // without waiting out the visit window. See stream.spec.js.
  process.env.OSTRICH_DATA_DIR = dataDir;

  // Returned function runs as global teardown.
  return async () => {
    await app.close();
    await mock.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
