import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';

/**
 * What Mom sees when Nextcloud is not co-operating.
 *
 * The app never contacts Nextcloud at boot, so it stays up through a Nextcloud
 * reboot, a revoked app password, or a Beelink that came back before its
 * neighbour did. That was never the hard part. The hard part is the page: a
 * tech-averse reader shown "Something went wrong on our end" learns nothing,
 * suspects herself, and phones someone. So the two situations she can actually
 * be in are told apart and named:
 *
 *  - nothing is answering  -> wait, it will come back, and the page will check;
 *  - something is answering and refusing us -> waiting will NOT fix this, and
 *    the one line about it is addressed to whoever runs the site.
 *
 * Which of the two a failure is depends on whether an answer ARRIVED, and
 * nothing else. That is decided at the one place that can know it -- the client's
 * catch around `fetch`, which marks the error `NC_UNREACHABLE` -- rather than by
 * the absence of an HTTP status, which half a dozen parse errors also produce for
 * responses that arrived perfectly well. Telling those apart is the difference
 * between a misconfiguration that shows a self-refreshing "back shortly" page
 * forever and one that says, once, that it needs a person.
 *
 * These are route-level (`app.inject`) rather than browser tests: every claim
 * here is about a status code, a header, or the words on the page.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWERS_FILE = join(HERE, '..', 'e2e', 'viewers.test.json');
const PASSPHRASE = 'correct horse'; // mom, per viewers.test.json

/** Nothing is listening here, so every upstream request fails immediately. */
const NOWHERE = 'http://127.0.0.1:1';

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-upstream-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * An app pointed at `baseUrl`, with its log captured.
 * @param {{baseUrl: string, appPassword?: string}} options
 */
async function boot({ baseUrl, appPassword = TEST_APP_PASSWORD }) {
  const config = loadConfig({
    NC_BASE_URL: baseUrl,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: appPassword,
    SESSION_SECRET: 'c'.repeat(64),
    VIEWERS_FILE,
    NODE_ENV: 'test',
    DATA_DIR: dataDir(),
  });

  const logged = [];
  const app = await buildApp({
    config,
    logger: {
      level: 'error',
      stream: {
        write(line) {
          logged.push(JSON.parse(line));
        },
      },
    },
  });
  cleanups.push(() => app.close());
  return { app, logged };
}

/**
 * A stand-in upstream that answers every request the same way, for the
 * deployments the mock Nextcloud cannot impersonate: something that is not
 * Nextcloud, and something that is but says no.
 *
 * @param {(res: import('node:http').ServerResponse) => void} respond
 * @returns {Promise<string>} its base URL
 */
async function stubUpstream(respond) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => respond(res));
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
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
  return (Array.isArray(cookie) ? cookie : [cookie]).map((c) => c.split(';')[0]).join('; ');
}

// --- Nothing is answering ---------------------------------------------------

test('unreachable Nextcloud: the files home says so kindly, and retries itself', async () => {
  const { app } = await boot({ baseUrl: NOWHERE });
  const cookie = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie } });

  assert.equal(response.statusCode, 503, 'this is "come back shortly", not "we are broken"');
  assert.equal(response.headers['retry-after'], '60');
  // An idle tab left open recovers by itself once Nextcloud is back.
  assert.match(response.body, /<meta http-equiv="refresh" content="60"/);

  assert.match(response.body, /taking a break/);
  assert.match(response.body, /another computer/, 'it says where her files actually are');
  assert.match(response.body, /Nothing you did caused this/);
  assert.doesNotMatch(response.body, /Something went wrong on our end/);
});

test('unreachable Nextcloud: the tasks section gets the same page, pointing at tasks', async () => {
  const { app } = await boot({ baseUrl: NOWHERE });
  const cookie = await login(app);

  const response = await app.inject({ url: '/tasks', headers: { cookie } });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '60');
  assert.match(response.body, /taking a break/);
  // She backed into this from the task lists, so that is where the button goes.
  assert.match(response.body, /href="\/tasks"/);
});

test('unreachable Nextcloud: a file page too, and the way out is still there', async () => {
  const { app } = await boot({ baseUrl: NOWHERE });
  const cookie = await login(app);

  const response = await app.inject({ url: '/files/Biology%20101', headers: { cookie } });

  assert.equal(response.statusCode, 503);
  assert.match(response.body, /taking a break/);
  assert.match(response.body, /href="\/"/, 'there is always a way back to the start');
});

test('unreachable Nextcloud: the login page does not need Nextcloud, and never did', async () => {
  // This is the one page that must work while everything else cannot: nothing
  // in the login path talks to Nextcloud, and this is what says so out loud.
  const { app } = await boot({ baseUrl: NOWHERE });

  const page = await app.inject({ url: '/login' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /passphrase/i);

  // And the passphrase is still checked, against viewers.json alone.
  const accepted = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `passphrase=${encodeURIComponent(PASSPHRASE)}`,
  });
  assert.equal(accepted.statusCode, 302);

  const refused = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'passphrase=wrong+phrase+entirely',
  });
  assert.equal(refused.statusCode, 401);
});

test('unreachable Nextcloud: /healthz stays green, because it is about THIS app', async () => {
  // Docker restarts a container whose health check fails. If /healthz probed
  // Nextcloud, a Nextcloud reboot would restart-loop the viewer and take down
  // the very pages above.
  const { app } = await boot({ baseUrl: NOWHERE });

  const response = await app.inject({ url: '/healthz' });

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).status, 'ok');
});

// --- Something is answering, and refusing us --------------------------------

/** The mock enforces Basic auth, so a wrong app password really does 401. */
async function bootAgainst401() {
  const mock = createMockNextcloud();
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();
  return boot({ baseUrl: url, appPassword: 'this-app-password-was-revoked' });
}

test('revoked app password: a separate, calm page that does not blame the reader', async () => {
  const { app } = await bootAgainst401();
  const cookie = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie } });

  assert.equal(response.statusCode, 502, 'waiting will not fix this one');
  assert.equal(response.headers['retry-after'], undefined, 'and there is no point auto-retrying');
  assert.doesNotMatch(response.body, /<meta http-equiv="refresh"/);

  assert.match(response.body, /needs attention/);
  assert.match(response.body, /Nothing you did caused this/);
  assert.doesNotMatch(response.body, /taking a break/, 'this is not the "come back later" page');
  assert.doesNotMatch(response.body, /Something went wrong on our end/);
});

test('revoked app password: exactly one line for whoever runs the site, and no detail', async () => {
  const { app } = await bootAgainst401();
  const cookie = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie } });

  assert.match(response.body, /Whoever runs this site needs to check the app’s Nextcloud app-password/);

  // Anyone holding a passphrase can reach this page, so it must give away
  // nothing about the deployment. The log is where the detail belongs.
  for (const secret of ['this-app-password-was-revoked', '127.0.0.1', 'remote.php', '401']) {
    assert.ok(!response.body.includes(secret), `the page must not mention ${secret}`);
  }
});

test('revoked app password: the real detail is logged, at error level', async () => {
  const { app, logged } = await bootAgainst401();
  const cookie = await login(app);

  await app.inject({ url: '/', headers: { cookie } });

  const line = logged.find((entry) => entry.msg === 'nextcloud request failed');
  assert.ok(line, `expected an error log line, saw: ${JSON.stringify(logged)}`);
  assert.equal(line.level, 50, 'error level: this one needs a person, not a shrug');
  assert.match(line.err.message, /401/, 'and the status is in the log, where it is useful');
});

test('revoked app password: the tasks section is classified the same way', async () => {
  const { app } = await bootAgainst401();
  const cookie = await login(app);

  const response = await app.inject({ url: '/tasks', headers: { cookie } });

  assert.equal(response.statusCode, 502);
  assert.match(response.body, /needs attention/);
  assert.match(response.body, /href="\/tasks"/);
});

test('a 403 does not accuse the app password, which may be perfectly good', async () => {
  // 401 and 403 are not the same fault. A 403 is an authenticated request being
  // refused *this* resource -- a share, a group folder, a file-access rule --
  // so sending whoever runs the site off to regenerate credentials that were
  // never wrong is an evening spent on the wrong thing.
  const baseUrl = await stubUpstream((res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
  });
  const { app } = await boot({ baseUrl });
  const cookie = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie } });

  assert.equal(response.statusCode, 502);
  assert.match(response.body, /needs attention/, 'the reader is told the same calm thing');
  assert.match(response.body, /check the app’s Nextcloud access/);
  assert.match(response.body, /then any file-access rules/, 'and where to look after the password');
  assert.doesNotMatch(
    response.body,
    /needs to check the app’s Nextcloud app-password\./,
    'the 401 line asserts the password IS the problem, and here it may not be'
  );
});

// --- Something answered, and it was gibberish -------------------------------

test('a garbled answer needs attention; it is not the self-healing page', async () => {
  // The regression this exists for. A bodyless `<d:multistatus/>` is a fine
  // SEARCH result and no kind of PROPFIND answer, so webdav.js throws a
  // NextcloudError with no HTTP status -- which used to be the very signal that
  // meant "nothing answered". A wrong NC_BASE_URL, or a proxy rewriting the
  // reply, would therefore promise her the file server was "taking a break" and
  // re-check every 60 seconds, forever, for a fault that needs a person.
  //
  // ASKED OF /files, NOT /. A PROPFIND is what can tell the difference: the
  // stream's SEARCH treats a bodyless multistatus as its ordinary "nothing
  // matched" answer (see parseSearchResults), and with no date filter that now
  // means "there are no files in the shared tree" -- which is an odd thing to
  // be told, but not a thing this code can distinguish from a genuinely empty
  // share. The classification being tested here is the error handler's, and it
  // is the same handler either way.
  const baseUrl = await stubUpstream((res) => {
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
  });
  const { app } = await boot({ baseUrl });
  const cookie = await login(app);

  const response = await app.inject({ url: '/files', headers: { cookie } });

  assert.equal(response.statusCode, 502, 'something answered: waiting will not mend it');
  assert.equal(response.headers['retry-after'], undefined);
  assert.doesNotMatch(response.body, /<meta http-equiv="refresh"/, 'and it must not re-check forever');
  assert.doesNotMatch(response.body, /taking a break/);

  assert.match(response.body, /needs attention/);
  assert.match(response.body, /NC_BASE_URL points at Nextcloud itself/, 'the owner line points at the cause');
  assert.match(response.body, /rewriting the answer/);
});

test('a garbled answer: still nothing about the deployment beyond the one setting', async () => {
  const baseUrl = await stubUpstream((res) => {
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
  });
  const { app } = await boot({ baseUrl });
  const cookie = await login(app);

  const response = await app.inject({ url: '/files', headers: { cookie } });

  // NC_BASE_URL is the name of a setting, which is the actionable part. Its
  // value, the account, and the DAV paths are not.
  for (const secret of [TEST_APP_PASSWORD, '127.0.0.1', 'remote.php', 'multistatus']) {
    assert.ok(!response.body.includes(secret), `the page must not mention ${secret}`);
  }
});

test('a stream whose SEARCH found nothing says so, rather than crying failure', async () => {
  // The other side of the coin, and why the two tests above ask /files. An
  // empty multistatus IS a legitimate SEARCH answer, so the stream renders its
  // empty state -- a claim it can make honestly now that a lookup which
  // actually failed reaches an error page instead of rendering as this.
  const baseUrl = await stubUpstream((res) => {
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
  });
  const { app } = await boot({ baseUrl });
  const cookie = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie } });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Nothing has changed yet/);
  assert.doesNotMatch(response.body, /taking a break|needs attention/);
});

// --- Everything else is unchanged -------------------------------------------

test('a working Nextcloud still 404s a missing folder, section-aware as before', async () => {
  const mock = createMockNextcloud();
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();
  const { app } = await boot({ baseUrl: url });
  const cookie = await login(app);

  const folder = await app.inject({ url: '/files/Nope', headers: { cookie } });
  assert.equal(folder.statusCode, 404);
  // Nunjucks escapes the apostrophe, hence the loose match.
  assert.match(folder.body, /find that folder/);
  assert.doesNotMatch(folder.body, /taking a break/);

  const list = await app.inject({ url: '/tasks/nope', headers: { cookie } });
  assert.equal(list.statusCode, 404);
  assert.match(list.body, /find that task list/);
});

test('a query string does not move a page out of the task section', async () => {
  // "Which section is this?" is a question about the path, and `request.url`
  // carries the query too. A link with a tracking parameter on it -- which is
  // how a link arrives when it has been through a messaging app -- used to be
  // told her folder had been unshared, and handed a button back to the files
  // home she never came from.
  const mock = createMockNextcloud();
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();
  const { app } = await boot({ baseUrl: url });
  const cookie = await login(app);

  const response = await app.inject({ url: '/tasks/nope?utm_source=whatsapp', headers: { cookie } });

  assert.equal(response.statusCode, 404);
  assert.match(response.body, /find that task list/, 'still the task-list wording');
  assert.doesNotMatch(response.body, /find that folder/);
  assert.match(response.body, /href="\/tasks"/, 'and still the way back to the task lists');
});
