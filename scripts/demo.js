#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import bcrypt from 'bcryptjs';

import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createMockNextcloud } from '../test/mock-nextcloud/index.js';
import { loadDataset } from '../test/mock-nextcloud/dataset.js';

/**
 * `npm run demo` -- the whole app, with no Nextcloud anywhere.
 *
 * A mock Nextcloud (test/mock-nextcloud/) serves demo/dataset.json on an
 * ephemeral port, and the real `buildApp` is pointed at it. Nothing here is a
 * special "demo mode" inside the app: every route, template, parser and cache
 * is the shipping one, and the only thing that differs from a deployment is
 * which host the WebDAV requests go to.
 *
 * NOTHING IS CONFIGURED, AND NOTHING IS LEFT BEHIND. No `.env`, no
 * config/viewers.json, no ./data. The session secret and the mock's app
 * password are generated per run and discarded; the viewer list, the preview
 * cache and state.json live in a temp directory that is deleted on the way out.
 * A demo that made you edit a config file would be a demo nobody ran, and one
 * that wrote into ./data or config/ could quietly break a real deployment
 * sharing the checkout.
 *
 * THE PRETENDED LAST VISIT. "New since you last looked" compares against the
 * viewer's PREVIOUS sitting, so a brand-new viewer sees no such section at all
 * (see src/store/visits.js -- that is deliberate, not a bug). A demo whose
 * headline feature is invisible is not much of a demo, so state.json is seeded
 * with a sitting two days ago: the first page load rotates it into `previous`,
 * and the dataset's two recently-touched files land above the folders. It is
 * the same code path a returning viewer takes, with the clock pre-wound.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const DEMO_DATASET = join(HERE, '..', 'demo', 'dataset.json');
export const DEMO_PASSPHRASE = 'ostrich';
export const DEMO_VIEWER = { name: 'mom', label: 'Mom' };
export const DEFAULT_DEMO_PORT = 3333;

/** The account the mock expects; only the two processes here ever see it. */
const DEMO_NC_USER = 'ostrich-viewer';

/**
 * bcrypt cost for the throwaway demo hash. The deployment default is 12
 * (scripts/hash-passphrase.js), but bcryptjs is pure JavaScript: 12 costs a
 * couple of seconds at boot *and* on every login, which is a lot of waiting for
 * a passphrase that is printed on the screen next to it.
 */
const BCRYPT_ROUNDS = 10;

/** How long ago the demo pretends the viewer last looked. */
const PRETEND_LAST_VISIT_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Boot the demo stack: mock Nextcloud + the real app, wired together.
 *
 * Shared with test/unit/demo.test.js on purpose -- a demo that has quietly
 * stopped booting is exactly the kind of thing nobody notices until they demo
 * it, so the test boots this same function rather than a copy of its wiring.
 *
 * @param {{ port?: number, host?: string, datasetPath?: string,
 *           passphrase?: string, logger?: object|boolean }} [options]
 *   port: 0 for an ephemeral one (what the test uses).
 * @returns {Promise<{ url: string, port: number, passphrase: string,
 *   viewer: {name: string, label: string}, dataDir: string, mockUrl: string,
 *   app: object, mock: object, stop: () => Promise<void> }>}
 */
export async function startDemo(options = {}) {
  const {
    port = DEFAULT_DEMO_PORT,
    host = '127.0.0.1',
    datasetPath = DEMO_DATASET,
    passphrase = DEMO_PASSPHRASE,
    logger = false,
  } = options;

  const { tree, calendars } = loadDataset(datasetPath);

  // Generated per run: there is no value in a fixed one, and a fixed one is the
  // sort of thing that gets copied into a real deployment.
  const appPassword = randomBytes(18).toString('hex');
  const mock = createMockNextcloud({ tree, calendars, user: DEMO_NC_USER, password: appPassword });
  const { url: mockUrl } = await mock.start();

  // Everything this run writes -- viewers.json, state.json, the preview cache.
  const dataDir = mkdtempSync(join(tmpdir(), 'ostrich-demo-'));

  /**
   * Unwind whatever is already up, so a failed boot leaves nothing running.
   * Takes the app rather than closing over it: it is called once from the boot
   * failure path (where `app` may not exist yet) and once from `stop()`.
   */
  const cleanup = async (started) => {
    if (started) await started.close().catch(() => {});
    await mock.stop().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  };

  let app;
  try {
    const viewersFile = join(dataDir, 'viewers.json');
    writeFileSync(
      viewersFile,
      `${JSON.stringify(
        [{ ...DEMO_VIEWER, passphraseHash: await bcrypt.hash(passphrase, BCRYPT_ROUNDS) }],
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    // The sitting the home page will compare against. `previousVisitStartedAt`
    // is deliberately null: this is a *last* visit, and the first load is what
    // rotates it into place.
    const lastVisit = new Date(Date.now() - PRETEND_LAST_VISIT_MS).toISOString();
    writeFileSync(
      join(dataDir, 'state.json'),
      `${JSON.stringify(
        {
          [DEMO_VIEWER.name]: {
            currentVisitStartedAt: lastVisit,
            previousVisitStartedAt: null,
            lastSeenAt: lastVisit,
          },
        },
        null,
        2
      )}\n`
    );

    const config = loadConfig({
      NC_BASE_URL: mockUrl,
      NC_USER: DEMO_NC_USER,
      NC_APP_PASSWORD: appPassword,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      PORT: String(port),
      HOST: host,
      VIEWERS_FILE: viewersFile,
      // Not production: the session cookie must not be Secure-only, or logging
      // in over plain http://localhost silently fails to keep you logged in.
      NODE_ENV: 'development',
      DATA_DIR: dataDir,
    });

    app = await buildApp({ config, logger });
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    await cleanup(app);
    throw err;
  }

  const boundPort = app.server.address().port;

  return {
    app,
    mock,
    mockUrl,
    dataDir,
    port: boundPort,
    // For a human to click: `host` is 127.0.0.1, but localhost is what people
    // type and what the cookie is happy with over plain HTTP.
    url: `http://localhost:${boundPort}`,
    passphrase,
    viewer: DEMO_VIEWER,
    stop: () => cleanup(app),
  };
}

// --- CLI -------------------------------------------------------------------

function banner(demo, datasetPath) {
  return [
    '',
    '  Nextcloud Ostrich View — demo',
    '',
    `  Open this:    ${demo.url}`,
    `  Passphrase:   ${demo.passphrase}`,
    '',
    '  There is no real Nextcloud behind it: a mock server is reading',
    `  ${datasetPath}`,
    '  Edit that file and restart to change what you see.',
    '',
    '  The demo pretends you last looked two days ago, so the home page opens',
    '  with "New since you last looked" already filled in.',
    '',
    '  Nothing is written to ./data or config/viewers.json — this run keeps its',
    `  state in ${demo.dataDir}, and deletes it on the way out.`,
    '',
    '  Press Ctrl-C to stop.',
    '',
  ].join('\n');
}

async function main() {
  const rawPort = process.env.DEMO_PORT ?? String(DEFAULT_DEMO_PORT);
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`DEMO_PORT must be a port number, got ${JSON.stringify(rawPort)}`);
    process.exit(1);
  }

  let demo;
  try {
    demo = await startDemo({ port });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${port} is already in use.\n` +
          `Try another one:  DEMO_PORT=${port + 1} npm run demo\n`
      );
      process.exit(1);
    }
    console.error(`\nThe demo could not start:\n\n${err?.message ?? err}\n`);
    process.exit(1);
  }

  console.log(banner(demo, DEMO_DATASET));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping the demo…');
    await demo.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** Only run the server when this file *is* the command, not when imported. */
const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export default startDemo;
