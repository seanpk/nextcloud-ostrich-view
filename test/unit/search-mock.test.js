import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '../../src/nextcloud/client.js';
import { findChangedSince, findRecent } from '../../src/nextcloud/search.js';
import {
  createMockNextcloud,
  TEST_APP_PASSWORD,
  TEST_USER,
} from '../mock-nextcloud/index.js';

/**
 * Both strategies against a server, rather than against a hand-written fetch
 * stub: this is what catches a request the mock (and by extension a real
 * Nextcloud) would reject -- a wrong endpoint, a wrong scope, or a date literal
 * in a format PHP silently reads as "the beginning of time".
 *
 * The 405 half is deliberately here and not in the Playwright run: the E2E
 * suite boots one server for the whole run, and the walk fallback needs a
 * server that refuses SEARCH.
 */

const SINCE = new Date('2025-08-05T00:00:00.000Z');
const EXPECTED = [
  'Biology 101/Lab Reports/microscope.jpg',
  'Biology 101/Lectures/Week 2 Notes.pdf',
];

const running = [];
after(async () => {
  await Promise.all(running.map((mock) => mock.stop()));
});

async function boot(options) {
  const mock = createMockNextcloud(options);
  running.push(mock);
  const { url } = await mock.start();
  const client = createClient({
    baseUrl: url,
    user: TEST_USER,
    appPassword: TEST_APP_PASSWORD,
  });
  return { mock, client };
}

test('against a SEARCH-capable server: one request, the right files, newest first', async () => {
  const { mock, client } = await boot();

  const { entries, strategy } = await findChangedSince(client, SINCE, { memo: new Map() });

  assert.equal(strategy, 'search');
  assert.deepEqual(entries.map((e) => e.path), EXPECTED);
  assert.deepEqual(
    mock.requests.map((r) => r.method),
    ['SEARCH'],
    'the home page may spend exactly one upstream request on this feature'
  );
});

test('against a SEARCH-capable server: an old-enough visit sees the whole tree', async () => {
  const { client } = await boot();

  const { entries } = await findChangedSince(client, new Date(0), { memo: new Map() });
  assert.ok(entries.length > EXPECTED.length);
  assert.ok(entries.every((e) => !e.isFolder));
});

test('against a SEARCH-capable server: a visit after everything finds nothing', async () => {
  const { mock, client } = await boot();
  const memo = new Map();

  const { entries, strategy } = await findChangedSince(client, new Date('2030-01-01T00:00:00Z'), {
    memo,
  });

  assert.deepEqual(entries, []);
  // The commonest case of all: nothing has changed. An empty multistatus is a
  // real answer, so it must neither start a walk nor demote the instance.
  assert.equal(strategy, 'search');
  assert.equal(memo.get(client.baseUrl), 'search');
  assert.deepEqual(mock.requests.map((r) => r.method), ['SEARCH']);
});

test('findRecent against a SEARCH-capable server: the newest files, no date sent', async () => {
  // The stream's request: one SEARCH with no <d:where> at all. The mock is
  // strict about a malformed date literal, so this passing is also proof the
  // app sent no literal rather than a bad one.
  const { mock, client } = await boot();

  const { entries, strategy, truncated } = await findRecent(client, { memo: new Map() });

  assert.equal(strategy, 'search');
  assert.equal(truncated, false);
  assert.deepEqual(mock.requests.map((r) => r.method), ['SEARCH']);

  const paths = entries.map((e) => e.path);
  assert.deepEqual(paths.slice(0, 2), EXPECTED, 'the two recent files still lead');
  assert.ok(paths.includes('Biology 101/Lectures/Week 1 Notes.pdf'), 'and the older ones follow');
  assert.ok(
    !paths.some((path) => path.startsWith('Photos/')),
    "the account's own skeleton content is filtered by ownership, not by date"
  );
});

test('findRecent against a server that refuses SEARCH: the walk answers the same way', async () => {
  const { mock, client } = await boot({ searchStatus: 405 });

  const { entries, strategy } = await findRecent(client, { memo: new Map() });

  assert.equal(strategy, 'walk');
  assert.deepEqual(entries.map((e) => e.path).slice(0, 2), EXPECTED);
  assert.ok(entries.length > EXPECTED.length, 'a walk with no lower bound keeps the old files too');
  assert.equal(mock.requests[0].method, 'SEARCH', 'SEARCH is tried once before giving up on it');
});

test('with no date given, the limit is what bounds the answer -- server-side', async () => {
  // There is no <d:where> to bound an unfiltered search, so `nresults` is the
  // only thing standing between the stream and the whole tree. The mock honours
  // it the way Nextcloud does: it slices the newest `limit` and hands those
  // over, and the share filter runs afterwards -- so asking for 3 can legitimately
  // yield 2 when one of the newest is the account's own skeleton content
  // (Photos/Frog.jpg is stamped recent for exactly this reason).
  const { client } = await boot();

  const { entries } = await findRecent(client, { memo: new Map(), limit: 3 });

  assert.ok(entries.length <= 3, 'never more than we asked for');
  assert.deepEqual(entries.map((e) => e.path), EXPECTED);
});

test('against a server that refuses SEARCH: the walk finds the same files', async () => {
  const { mock, client } = await boot({ searchStatus: 405 });

  const { entries, strategy } = await findChangedSince(client, SINCE, { memo: new Map() });

  assert.equal(strategy, 'walk');
  assert.deepEqual(entries.map((e) => e.path), EXPECTED);

  const methods = mock.requests.map((r) => r.method);
  assert.equal(methods[0], 'SEARCH', 'SEARCH is tried once before giving up on it');
  assert.ok(methods.slice(1).every((m) => m === 'PROPFIND'));
});

test('against a server that refuses SEARCH: the memo stops the second probe', async () => {
  const { mock, client } = await boot({ searchStatus: 405 });
  const memo = new Map();

  await findChangedSince(client, SINCE, { memo });
  const before = mock.requests.length;
  await findChangedSince(client, SINCE, { memo });

  const searches = mock.requests.filter((r) => r.method === 'SEARCH');
  assert.equal(searches.length, 1);
  assert.ok(mock.requests.length > before, 'the second call still did the walk');
});

test('the mock rejects a search scope outside the account, as a real server would', async () => {
  const { client } = await boot();

  const response = await client.request('SEARCH', '/remote.php/dav/', {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: `<?xml version="1.0"?>
<d:searchrequest xmlns:d="DAV:"><d:basicsearch>
  <d:from><d:scope><d:href>/files/someone-else</d:href><d:depth>infinity</d:depth></d:scope></d:from>
  <d:where><d:gt><d:prop><d:getlastmodified/></d:prop><d:literal>2025-08-05T00:00:00+00:00</d:literal></d:gt></d:where>
</d:basicsearch></d:searchrequest>`,
  });

  assert.equal(response.status, 400);
});
