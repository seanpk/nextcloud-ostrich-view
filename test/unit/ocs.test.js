import test from 'node:test';
import assert from 'node:assert/strict';

import { listReceivedShareTargets } from '../../src/nextcloud/ocs.js';
import { createClient, NC_UNREACHABLE } from '../../src/nextcloud/client.js';

/**
 * Asking Nextcloud where received shares are mounted.
 *
 * This lookup only ever IMPROVES the home page -- there is a working fallback
 * behind it -- so the contract that matters most is that nothing here throws.
 * Most of these cases are therefore about garbage in, `ok: false` out.
 */

/** A client whose fetch is a single canned answer, plus the recorded call. */
function clientReturning(response) {
  const calls = [];
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { client, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const okEnvelope = (data) => ({
  ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data },
});

test('listReceivedShareTargets: returns file_target paths, relative to the files home', async () => {
  const { client } = clientReturning(
    jsonResponse(okEnvelope([{ file_target: '/Shared/Family' }, { file_target: '/Shared/Photos' }]))
  );

  const result = await listReceivedShareTargets(client);

  assert.deepEqual(result, {
    ok: true,
    targets: ['Shared/Family', 'Shared/Photos'],
    reason: null,
  });
});

test('listReceivedShareTargets: sends the OCS-APIRequest header, which the API requires', async () => {
  const { client, calls } = clientReturning(jsonResponse(okEnvelope([])));

  await listReceivedShareTargets(client);

  // Without this, real Nextcloud answers 401 whatever the credentials say --
  // the one header this whole module depends on.
  assert.equal(calls[0].init.headers['OCS-APIRequest'], 'true');
  assert.match(calls[0].url, /shared_with_me=true/);
  assert.equal(calls[0].init.method, 'GET');
});

test('listReceivedShareTargets: no shares is a confident empty list, not a failure', async () => {
  const { client } = clientReturning(jsonResponse(okEnvelope([])));

  const result = await listReceivedShareTargets(client);

  // The distinction the caller relies on: ok means "asked and answered", so an
  // empty list means the account really has nothing, and no warning is due.
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, []);
});

test('listReceivedShareTargets: deduplicates repeated targets', async () => {
  const { client } = clientReturning(
    jsonResponse(okEnvelope([{ file_target: '/Shared/Family' }, { file_target: '/Shared/Family/' }]))
  );

  const result = await listReceivedShareTargets(client);

  assert.deepEqual(result.targets, ['Shared/Family']);
});

test('listReceivedShareTargets: skips entries with no usable file_target', async () => {
  const { client } = clientReturning(
    jsonResponse(
      okEnvelope([
        { file_target: '/Shared/Family' },
        { file_target: '' },
        { file_target: '/' },
        { file_target: null },
        {},
        { file_target: 42 },
      ])
    )
  );

  const result = await listReceivedShareTargets(client);

  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ['Shared/Family']);
});

test('listReceivedShareTargets: a 404 from the endpoint is "could not determine"', async () => {
  const { client } = clientReturning(new Response('Not found', { status: 404 }));

  const result = await listReceivedShareTargets(client);

  assert.equal(result.ok, false);
  assert.deepEqual(result.targets, []);
  assert.match(result.reason, /404/);
});

test('listReceivedShareTargets: an OCS error envelope inside a 200 is not success', async () => {
  const { client } = clientReturning(
    jsonResponse({ ocs: { meta: { status: 'failure', statuscode: 997 }, data: [] } })
  );

  const result = await listReceivedShareTargets(client);

  // 997 is OCS for "unauthorised". The HTTP status was 200, so only the
  // envelope gives this away.
  assert.equal(result.ok, false);
  assert.match(result.reason, /997/);
});

test('listReceivedShareTargets: accepts the older statuscode 100 as success', async () => {
  const { client } = clientReturning(
    jsonResponse({
      ocs: { meta: { status: 'ok', statuscode: 100 }, data: [{ file_target: '/Shared/Family' }] },
    })
  );

  const result = await listReceivedShareTargets(client);

  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ['Shared/Family']);
});

test('listReceivedShareTargets: an HTML login page is not mistaken for an answer', async () => {
  const { client } = clientReturning(
    new Response('<!DOCTYPE html><title>Log in</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
  );

  const result = await listReceivedShareTargets(client);

  assert.equal(result.ok, false);
  assert.match(result.reason, /JSON/);
});

test('listReceivedShareTargets: valid JSON of the wrong shape is not an answer', async () => {
  const { client } = clientReturning(jsonResponse({ ocs: { meta: {}, data: { nope: true } } }));

  const result = await listReceivedShareTargets(client);

  assert.equal(result.ok, false);
  assert.match(result.reason, /ocs\.data/);
});

test('listReceivedShareTargets: an unreachable Nextcloud is reported, never thrown', async () => {
  const { client } = clientReturning(new Error('ECONNREFUSED'));

  // The point: the home page runs this concurrently with a PROPFIND that will
  // raise unreachability properly. This must not be a second, competing throw.
  const result = await listReceivedShareTargets(client);

  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);
  assert.notEqual(result.reason, NC_UNREACHABLE);
});
