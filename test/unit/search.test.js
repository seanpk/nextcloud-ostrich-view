import test from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '../../src/nextcloud/client.js';
import {
  buildSearchBody,
  clearStrategyMemo,
  findChangedSince,
  parseSearchResults,
  searchChangedSince,
  SearchUnsupportedError,
  searchScopeFor,
  toDavDateTime,
  walkChangedSince,
  WALK_MAX_DEPTH,
} from '../../src/nextcloud/search.js';
import { buildMultistatus, buildSearchMultistatus } from '../mock-nextcloud/index.js';
import {
  DEFAULT_TREE,
  FIXED_LAST_MODIFIED,
  NEWEST_LAST_MODIFIED,
  RECENT_LAST_MODIFIED,
  resolveNode,
  walkFiles,
} from '../mock-nextcloud/tree.js';

const DAV_ROOT = '/remote.php/dav/files/ostrich-viewer';
/** Between FIXED and RECENT: exactly two files in DEFAULT_TREE are newer. */
const SINCE = new Date('2025-08-05T00:00:00.000Z');

function client(fetchImpl, { baseUrl = 'http://nextcloud.test' } = {}) {
  return createClient({ baseUrl, user: 'ostrich-viewer', appPassword: 'pw', fetchImpl });
}

function xml(body, status = 207) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/xml' } });
}

/** The mock's SEARCH answer for a `since`, as the real one would compute it. */
function searchAnswer(since, davRoot = DAV_ROOT) {
  const files = walkFiles(DEFAULT_TREE)
    .filter(({ node }) => Date.parse(node.lastModified ?? FIXED_LAST_MODIFIED) > since.getTime())
    .sort(
      (a, b) =>
        Date.parse(b.node.lastModified ?? FIXED_LAST_MODIFIED) -
        Date.parse(a.node.lastModified ?? FIXED_LAST_MODIFIED)
    );
  return buildSearchMultistatus({ davRoot, files });
}

// --- Request building -------------------------------------------------------

test('toDavDateTime: emits ATOM, which is the only shape Nextcloud parses', () => {
  // Not `2026-08-09T14:05:00.000Z` -- ATOM rejects both the milliseconds and Z,
  // and a rejected literal silently becomes "match everything".
  assert.equal(toDavDateTime(new Date('2026-08-09T14:05:00.123Z')), '2026-08-09T14:05:00+00:00');
  assert.throws(() => toDavDateTime('not a date'), TypeError);
});

test('searchScopeFor: the scope is a DAV-endpoint-relative path, not a URL', () => {
  assert.equal(searchScopeFor(client(async () => xml(''))), '/files/ostrich-viewer');
});

test('buildSearchBody: asks for the props a tile needs, at infinite depth', () => {
  const body = buildSearchBody({ scope: '/files/ostrich-viewer', since: SINCE, limit: 50 });

  for (const prop of [
    '<oc:fileid/>',
    '<d:getlastmodified/>',
    '<d:getcontenttype/>',
    '<d:resourcetype/>',
    '<oc:size/>',
    '<d:getetag/>',
  ]) {
    assert.ok(body.includes(prop), `missing ${prop}: a result tile would lose its thumbnail`);
  }

  assert.match(body, /<d:href>\/files\/ostrich-viewer<\/d:href>/);
  assert.match(body, /<d:depth>infinity<\/d:depth>/);
  assert.match(body, /<d:literal>2025-08-05T00:00:00\+00:00<\/d:literal>/);
  assert.match(body, /<d:gt>[\s\S]*<d:getlastmodified\/>[\s\S]*<\/d:gt>/);
  assert.match(body, /<d:descending\/>/);
  assert.match(body, /<d:nresults>50<\/d:nresults>/);
});

test('buildSearchBody: a scope with XML-hostile characters is escaped', () => {
  const body = buildSearchBody({ scope: '/files/a&b<c', since: SINCE });
  assert.ok(body.includes('/files/a&amp;b&lt;c'));
});

// --- Response parsing -------------------------------------------------------

test('parseSearchResults: files only, newest first', () => {
  const entries = parseSearchResults(searchAnswer(SINCE), { davRoot: DAV_ROOT, since: SINCE });

  assert.deepEqual(entries.map((e) => e.path), [
    'Biology 101/Lab Reports/microscope.jpg',
    'Biology 101/Lectures/Week 2 Notes.pdf',
  ]);
  assert.ok(entries.every((e) => !e.isFolder));
  assert.equal(entries[0].lastModified.toISOString(), new Date(NEWEST_LAST_MODIFIED).toISOString());
  // The props a tile needs came through.
  assert.ok(Number.isInteger(entries[0].fileId));
  assert.match(entries[0].etag, /^[a-z0-9]+$/);
  assert.equal(entries[0].contentType, 'image/jpeg');
});

test('parseSearchResults: an empty multistatus is "nothing changed", not a broken response', () => {
  // What Nextcloud sends on the most ordinary day there is.
  for (const body of [
    '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:"/>',
    '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:">\n</d:multistatus>',
  ]) {
    assert.deepEqual(parseSearchResults(body, { davRoot: DAV_ROOT, since: SINCE }), []);
  }
});

test('parseSearchResults: results outside the DAV home are dropped', () => {
  const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/someone-else/secret.pdf</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getlastmodified>${NEWEST_LAST_MODIFIED}</d:getlastmodified>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

  assert.deepEqual(parseSearchResults(body, { davRoot: DAV_ROOT, since: SINCE }), []);
});

test('parseSearchResults: folders never appear, however recently they changed', () => {
  const body = buildMultistatus({
    davRoot: DAV_ROOT,
    relPath: 'Biology 101',
    node: resolveNode(DEFAULT_TREE, 'Biology 101'),
  });
  const entries = parseSearchResults(body, { davRoot: DAV_ROOT, since: new Date(0) });

  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => !e.isFolder), 'a folder mtime changes whenever anything inside does');
});

test('parseSearchResults: re-applies the date filter rather than trusting the server', () => {
  // A server that mis-parsed our literal answers with the whole tree.
  const everything = searchAnswer(new Date(0));
  const entries = parseSearchResults(everything, { davRoot: DAV_ROOT, since: SINCE });

  assert.equal(entries.length, 2, 'only genuinely newer files may reach the page');
});

test('parseSearchResults: honours the limit', () => {
  const entries = parseSearchResults(searchAnswer(new Date(0)), {
    davRoot: DAV_ROOT,
    since: new Date(0),
    limit: 3,
  });
  assert.equal(entries.length, 3);
});

test('searchChangedSince: one SEARCH on the DAV endpoint, with base-path hrefs handled', async () => {
  const seen = [];
  const prefixedRoot = `/nextcloud${DAV_ROOT}`;
  const nc = client(
    async (url, init) => {
      seen.push({ url, method: init.method, body: init.body });
      return xml(searchAnswer(SINCE, prefixedRoot));
    },
    { baseUrl: 'http://nextcloud.test/nextcloud' }
  );

  const entries = await searchChangedSince(nc, SINCE);

  assert.equal(seen.length, 1, 'the home page budget for this feature is exactly one request');
  assert.equal(seen[0].method, 'SEARCH');
  assert.equal(seen[0].url, 'http://nextcloud.test/nextcloud/remote.php/dav/');
  assert.deepEqual(entries.map((e) => e.path), [
    'Biology 101/Lab Reports/microscope.jpg',
    'Biology 101/Lectures/Week 2 Notes.pdf',
  ]);
});

test('searchChangedSince: an empty multistatus is still zero results, not a failure', async () => {
  // `propfind` now REFUSES a 207 that describes no resource, because a folder
  // listing must describe its folder. SEARCH is the other half of that rule:
  // a bodyless multistatus is its ordinary "nothing has changed" answer, and
  // must keep sailing straight through.
  for (const body of [
    '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:"/>',
    '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:">\n</d:multistatus>',
  ]) {
    const nc = client(async () => xml(body));
    assert.deepEqual(await searchChangedSince(nc, SINCE), []);
  }
});

test('searchChangedSince: a 405 is SearchUnsupportedError, not a page-breaking failure', async () => {
  const nc = client(async () => new Response('nope', { status: 405 }));

  await assert.rejects(() => searchChangedSince(nc, SINCE), (err) => {
    assert.ok(err instanceof SearchUnsupportedError);
    assert.equal(err.status, 405);
    return true;
  });
});

// --- The walk fallback ------------------------------------------------------

/** A client that answers PROPFIND from the fixture tree, counting requests. */
function walkingClient(tree = DEFAULT_TREE, { onRequest } = {}) {
  return client(async (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname.slice(DAV_ROOT.length + 1));
    onRequest?.(path, init);
    const node = resolveNode(tree, path);
    if (!node) return new Response('', { status: 404 });
    return xml(buildMultistatus({ davRoot: DAV_ROOT, relPath: path, node }));
  });
}

test('walkChangedSince: finds the same files SEARCH would, newest first', async () => {
  const { entries, truncated } = await walkChangedSince(walkingClient(), SINCE);

  assert.deepEqual(entries.map((e) => e.path), [
    'Biology 101/Lab Reports/microscope.jpg',
    'Biology 101/Lectures/Week 2 Notes.pdf',
  ]);
  assert.equal(truncated, false, 'the whole fixture fits inside the bounds');
});

test('walkChangedSince: visits every folder in the fixture exactly once', async () => {
  const visited = [];
  await walkChangedSince(walkingClient(DEFAULT_TREE, { onRequest: (p) => visited.push(p) }), SINCE);

  assert.deepEqual(
    [...visited].sort(),
    [
      '',
      'Biology 101',
      'Biology 101/Lab Reports',
      'Biology 101/Lectures',
      'Café Notes',
      'Math 210',
      'Math 210/Problem Sets',
    ].sort()
  );
  assert.equal(new Set(visited).size, visited.length, 'no folder should be listed twice');
});

test('walkChangedSince: stops at maxFolders instead of walking a huge share', async () => {
  const visited = [];
  const { entries, truncated } = await walkChangedSince(
    walkingClient(DEFAULT_TREE, { onRequest: (p) => visited.push(p) }),
    SINCE,
    { maxFolders: 2 }
  );

  assert.ok(visited.length <= 2, `expected at most 2 listings, saw ${visited.length}`);
  // A partial answer is still an answer; the folder buttons are underneath it.
  assert.ok(Array.isArray(entries));
  assert.equal(truncated, true, 'folders were left unvisited, and the page has to say so');
});

test('walkChangedSince: stops descending at maxDepth', async () => {
  const visited = [];
  await walkChangedSince(
    walkingClient(DEFAULT_TREE, { onRequest: (p) => visited.push(p) }),
    SINCE,
    { maxDepth: 1 }
  );

  assert.ok(
    visited.every((path) => path.split('/').filter(Boolean).length <= 1),
    `depth 1 means the root and its children only, saw ${visited.join(', ')}`
  );
});

test('walkChangedSince: the default depth cap is a real bound', async () => {
  // level1/level2/.../levelN/buried.png, with N past the cap.
  let children = {
    'buried.png': {
      type: 'file',
      contentType: 'image/png',
      size: 1,
      lastModified: RECENT_LAST_MODIFIED,
    },
  };
  for (let depth = WALK_MAX_DEPTH + 2; depth > 0; depth -= 1) {
    children = { [`level${depth}`]: { type: 'folder', children } };
  }

  const { entries, truncated } = await walkChangedSince(walkingClient(children), SINCE);
  assert.deepEqual(entries, [], 'anything past the cap is out of reach by design');
  assert.equal(truncated, true, 'a depth we refused to descend is still a subtree unseen');
});

test('walkChangedSince: a folder that vanishes mid-walk does not lose the section', async () => {
  const nc = client(async (url) => {
    const path = decodeURIComponent(new URL(url).pathname.slice(DAV_ROOT.length + 1));
    if (path === 'Biology 101/Lectures') return new Response('gone', { status: 404 });
    const node = resolveNode(DEFAULT_TREE, path);
    if (!node) return new Response('', { status: 404 });
    return xml(buildMultistatus({ davRoot: DAV_ROOT, relPath: path, node }));
  });

  const { entries } = await walkChangedSince(nc, SINCE);
  assert.deepEqual(entries.map((e) => e.path), ['Biology 101/Lab Reports/microscope.jpg']);
});

test('walkChangedSince: a root that will not list is a real failure', async () => {
  const nc = client(async () => new Response('', { status: 404 }));
  await assert.rejects(() => walkChangedSince(nc, SINCE));
});

// --- Strategy selection -----------------------------------------------------

test('findChangedSince: uses SEARCH when it works, and remembers that', async () => {
  const memo = new Map();
  const methods = [];
  const nc = client(async (url, init) => {
    methods.push(init.method);
    return xml(searchAnswer(SINCE));
  });

  const first = await findChangedSince(nc, SINCE, { memo });
  const second = await findChangedSince(nc, SINCE, { memo });

  assert.equal(first.strategy, 'search');
  assert.equal(second.strategy, 'search');
  assert.deepEqual(methods, ['SEARCH', 'SEARCH'], 'no PROPFIND walk should ever be attempted');
  assert.equal(first.entries.length, 2);
});

test('findChangedSince: falls back to the walk, and never re-probes SEARCH', async () => {
  const memo = new Map();
  const methods = [];
  const nc = client(async (url, init) => {
    methods.push(init.method);
    if (init.method === 'SEARCH') return new Response('no', { status: 405 });
    const path = decodeURIComponent(new URL(url).pathname.slice(DAV_ROOT.length + 1));
    const node = resolveNode(DEFAULT_TREE, path);
    return node ? xml(buildMultistatus({ davRoot: DAV_ROOT, relPath: path, node })) : new Response('', { status: 404 });
  });

  const first = await findChangedSince(nc, SINCE, { memo });
  const second = await findChangedSince(nc, SINCE, { memo });

  assert.equal(first.strategy, 'walk');
  assert.equal(second.strategy, 'walk');
  assert.deepEqual(first.entries.map((e) => e.path), second.entries.map((e) => e.path));
  assert.equal(
    methods.filter((m) => m === 'SEARCH').length,
    1,
    'the failed probe is paid once per process, not once per home load'
  );
});

/** A client whose SEARCH fails one way, and whose PROPFINDs answer normally. */
function failingSearchClient(failure) {
  return client(async (url, init) => {
    if (init.method === 'SEARCH') return failure();
    const path = decodeURIComponent(new URL(url).pathname.slice(DAV_ROOT.length + 1));
    const node = resolveNode(DEFAULT_TREE, path);
    return node ? xml(buildMultistatus({ davRoot: DAV_ROOT, relPath: path, node })) : new Response('', { status: 404 });
  });
}

test('findChangedSince: a structural refusal is remembered for good', async () => {
  // The statuses that mean "this server does not do SEARCH", not "not today".
  for (const status of [400, 404, 405, 501]) {
    const memo = new Map();
    const nc = failingSearchClient(() => new Response('no', { status }));

    const { strategy, entries } = await findChangedSince(nc, SINCE, { memo });
    assert.equal(strategy, 'walk');
    assert.equal(entries.length, 2);
    assert.equal(memo.get(nc.baseUrl), 'walk', `${status} should demote this instance`);
  }
});

test('findChangedSince: a login page in front of SEARCH is a refusal, not a bad minute', async () => {
  // The deployment this exists for: something (a reverse proxy, an SSO front
  // end, Nextcloud's own login flow) answers SEARCH with a redirect or an HTML
  // page instead of routing it. That will never become a 207, so re-probing it
  // costs a doomed request and a warning line on EVERY home load, forever.
  for (const [status, what] of [
    [302, 'a redirect to a login page'],
    [303, 'a see-other to a login page'],
    [200, 'an HTML login page served with a 200'],
    [403, 'a front end that refuses SEARCH outright'],
  ]) {
    const memo = new Map();
    const nc = failingSearchClient(() => new Response('<html>Sign in</html>', { status }));

    const { strategy, entries } = await findChangedSince(nc, SINCE, { memo });
    assert.equal(strategy, 'walk');
    assert.equal(entries.length, 2, 'the page still gets its section');
    assert.equal(memo.get(nc.baseUrl), 'walk', `${status} (${what}) should demote this instance`);
  }
});

test('findChangedSince: a transient failure walks this once, and re-probes next time', async () => {
  // A proxy restarting, a gateway hiccup, a dropped socket, a body that parsed
  // into nothing usable: none of these say anything about SEARCH support, and
  // demoting on one of them would cost the fast path until the next restart.
  //
  // 408 and 429 are the two that are transient DESPITE being under 500, which is
  // otherwise the line between "answered us on purpose" and "bad minute". Both
  // are the server saying "not now": it gave up waiting for our request, or we
  // are asking too often -- which a pull-to-refresh burst on the home page, or a
  // rate limiter in front of Nextcloud, genuinely produces. Reading either as
  // "this server has no SEARCH" would trade one busy moment for a permanent walk.
  for (const failure of [
    () => new Response('boom', { status: 500 }),
    () => new Response('bad gateway', { status: 502 }),
    () => new Response('gateway timeout', { status: 504 }),
    () => new Response('request timeout', { status: 408 }),
    () => new Response('slow down', { status: 429 }),
    () => xml('<html>Login</html>'),
    () => {
      throw new Error('ECONNRESET');
    },
  ]) {
    const memo = new Map();
    const nc = failingSearchClient(failure);

    const { strategy, entries } = await findChangedSince(nc, SINCE, { memo });
    assert.equal(strategy, 'walk');
    assert.equal(entries.length, 2);
    assert.equal(memo.has(nc.baseUrl), false, 'the next home load must try SEARCH again');
  }
});

test('findChangedSince: SEARCH recovering after a bad minute is used again', async () => {
  const memo = new Map();
  let firstTry = true;
  const nc = client(async (url, init) => {
    if (init.method === 'SEARCH') {
      if (firstTry) {
        firstTry = false;
        return new Response('bad gateway', { status: 502 });
      }
      return xml(searchAnswer(SINCE));
    }
    const path = decodeURIComponent(new URL(url).pathname.slice(DAV_ROOT.length + 1));
    const node = resolveNode(DEFAULT_TREE, path);
    return node ? xml(buildMultistatus({ davRoot: DAV_ROOT, relPath: path, node })) : new Response('', { status: 404 });
  });

  assert.equal((await findChangedSince(nc, SINCE, { memo })).strategy, 'walk');
  assert.equal((await findChangedSince(nc, SINCE, { memo })).strategy, 'search');
});

test('findChangedSince: nothing changed is an answer, not a reason to give up on SEARCH', async () => {
  // The commonest case of all: a 207 with an empty multistatus. Reading it as a
  // failure would demote the instance to the walk on the quietest possible day.
  const memo = new Map();
  const methods = [];
  const nc = client(async (url, init) => {
    methods.push(init.method);
    return xml('<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:"/>');
  });

  const first = await findChangedSince(nc, SINCE, { memo });
  const second = await findChangedSince(nc, SINCE, { memo });

  assert.deepEqual(first.entries, []);
  assert.equal(first.strategy, 'search');
  assert.equal(second.strategy, 'search');
  assert.deepEqual(methods, ['SEARCH', 'SEARCH'], 'an empty result must not start a walk');
});

test('findChangedSince: the memo is per instance, and clearable', async () => {
  const memo = new Map();
  const a = client(async () => new Response('no', { status: 405 }), {
    baseUrl: 'http://a.test',
  });
  const b = client(async () => xml(searchAnswer(SINCE)), { baseUrl: 'http://b.test' });

  await findChangedSince(a, SINCE, { memo }).catch(() => {});
  assert.equal((await findChangedSince(b, SINCE, { memo })).strategy, 'search');

  clearStrategyMemo(memo);
  assert.equal(memo.size, 0);
});
