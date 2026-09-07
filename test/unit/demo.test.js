import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEMO_PASSPHRASE, DEMO_VIEWER, startDemo } from '../../scripts/demo.js';

/**
 * `npm run demo`, end to end.
 *
 * This boots the *same* `startDemo` the script does -- not a copy of its wiring
 * -- because the failure this test exists to catch is the quiet one: a change
 * to config loading, to the mock, or to the dataset that leaves the demo unable
 * to boot or unable to log in. Nobody finds that out until they demo it.
 *
 * It talks over a real socket rather than `app.inject`, since binding a port
 * and setting a non-Secure session cookie over plain HTTP are two of the things
 * the demo has to get right and a deployment deliberately does not.
 */

const demos = [];
after(async () => {
  for (const demo of demos.reverse()) await demo.stop();
});

async function boot() {
  const demo = await startDemo({ port: 0 });
  demos.push(demo);
  // localhost may resolve to ::1, and the demo listens on 127.0.0.1.
  return { demo, base: `http://127.0.0.1:${demo.port}` };
}

/** Log in with the printed passphrase and keep the cookie. */
async function login(base, passphrase) {
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `passphrase=${encodeURIComponent(passphrase)}`,
  });
  const cookies = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  return { response, cookie: cookies.join('; ') };
}

test('demo: the printed passphrase logs in, and the demo folders are there', async () => {
  const { demo, base } = await boot();

  const bad = await login(base, 'not the passphrase');
  assert.equal(bad.response.status, 401, 'a wrong passphrase re-renders the login page');
  assert.match(await bad.response.text(), /passphrase/i);

  const { response, cookie } = await login(base, DEMO_PASSPHRASE);
  assert.equal(response.status, 302, `"${DEMO_PASSPHRASE}" is what the banner tells people to type`);
  assert.equal(response.headers.get('location'), '/');
  assert.ok(cookie.includes('ostrich_session'), 'the session cookie was actually set');
  assert.ok(
    !(response.headers.getSetCookie?.() ?? []).some((c) => /;\s*Secure/i.test(c)),
    'a Secure-only cookie would never come back over plain http://localhost'
  );

  const stream = await fetch(`${base}/`, { headers: { cookie } });
  const streamBody = await stream.text();
  assert.equal(stream.status, 200);
  assert.match(streamBody, new RegExp(DEMO_VIEWER.label));

  // The stream lands first, spanning several days of the dataset's stamps.
  assert.match(streamBody, /pond water sample\.jpg/, 'a recently-stamped file from the dataset');
  assert.match(streamBody, /id="today"/, 'the Today line #3 builds on');
  assert.match(streamBody, /Yesterday/, 'the offsets really do span more than one day');

  // The seeded "last visit" is what puts badges on the page on the very first
  // load instead of never (see scripts/demo.js).
  assert.match(streamBody, /stream__badge/);
  assert.match(streamBody, /You were last here/);

  const filesHome = await fetch(`${base}/files`, { headers: { cookie } });
  const filesBody = await filesHome.text();
  assert.equal(filesHome.status, 200);
  for (const folder of ['Biology 101', 'Math 210', 'Essays']) {
    assert.match(filesBody, new RegExp(folder), `the Files page lists ${folder}`);
  }

  const folder = await fetch(`${base}/files/${encodeURIComponent('Biology 101')}`, {
    headers: { cookie },
  });
  const folderBody = await folder.text();
  assert.equal(folder.status, 200);
  assert.match(folderBody, /Lectures/);
  assert.match(folderBody, /Lab Reports/);
  assert.match(folderBody, /syllabus\.pdf/);

  const tasks = await fetch(`${base}/tasks`, { headers: { cookie } });
  const tasksBody = await tasks.text();
  assert.equal(tasks.status, 200);
  assert.match(tasksBody, /School/);
  assert.match(tasksBody, /Apartment/);

  const list = await fetch(`${base}/tasks/school`, { headers: { cookie } });
  const listBody = await list.text();
  assert.equal(list.status, 200);
  assert.match(listBody, /Finish the Biology lab report/);
  assert.match(listBody, /Collect pond samples/, 'a subtask, nested under its parent');
  assert.match(listBody, /Buy a lab notebook/, 'and a finished one, under Done');

  // The demo must be able to run in a checkout that has a real deployment's
  // config and state sitting next to it, without touching either.
  assert.ok(demo.dataDir.startsWith(tmpdir()), `demo state should be under ${tmpdir()}`);
  assert.ok(existsSync(join(demo.dataDir, 'viewers.json')), 'its viewer list is in there too');
});

test('demo: stopping it leaves nothing running and nothing on disk', async () => {
  const demo = await startDemo({ port: 0 });
  const base = `http://127.0.0.1:${demo.port}`;
  const { dataDir } = demo;

  assert.equal((await fetch(`${base}/healthz`)).status, 200);

  await demo.stop();

  assert.equal(existsSync(dataDir), false, 'the temp data directory is removed');
  await assert.rejects(fetch(`${base}/healthz`), 'the app is no longer listening');
  await assert.rejects(fetch(demo.mockUrl), 'and neither is the mock Nextcloud');
});
