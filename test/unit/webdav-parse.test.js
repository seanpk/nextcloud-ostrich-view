import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  parseMultistatus,
  parsePropfind,
  propfind,
  sortEntries,
  statFile,
} from '../../src/nextcloud/webdav.js';
import { createClient, NC_UNREACHABLE, NextcloudError } from '../../src/nextcloud/client.js';
import { buildMultistatus } from '../mock-nextcloud/index.js';
import { DEFAULT_TREE, resolveNode } from '../mock-nextcloud/tree.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DAV_ROOT = '/remote.php/dav/files/ostrich-viewer';

const fixture = readFileSync(join(HERE, 'fixtures', 'propfind-folder.xml'), 'utf8');

function parseFixture() {
  return parsePropfind(fixture, { davRoot: DAV_ROOT, requestPath: 'Biology 101' });
}

test('parsePropfind: skips the self entry (the folder that was asked about)', () => {
  const entries = parseFixture();
  assert.equal(entries.length, 4);
  assert.ok(
    !entries.some((e) => e.path === 'Biology 101'),
    'the requested folder must not appear among its own children'
  );
});

test('parsePropfind: distinguishes folders from files', () => {
  const entries = parseFixture();
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

  assert.equal(byName.Lectures.isFolder, true);
  assert.equal(byName['cell diagram.png'].isFolder, false);
  assert.equal(byName['Café résumé.pdf'].isFolder, false);
});

test('parsePropfind: decodes percent-escaped and unicode names', () => {
  const entries = parseFixture();
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['Café résumé.pdf', 'Lectures', 'cell diagram.png', '日本語.txt'].sort());
});

test('parsePropfind: paths are relative to the DAV root', () => {
  const entries = parseFixture();
  assert.deepEqual(
    entries.map((e) => e.path).sort(),
    [
      'Biology 101/Café résumé.pdf',
      'Biology 101/Lectures',
      'Biology 101/cell diagram.png',
      'Biology 101/日本語.txt',
    ].sort()
  );
});

test('parsePropfind: maps every requested property onto the entry', () => {
  const entries = parseFixture();
  const png = entries.find((e) => e.name === 'cell diagram.png');

  assert.deepEqual(
    { ...png, lastModified: png.lastModified.toISOString() },
    {
      name: 'cell diagram.png',
      path: 'Biology 101/cell diagram.png',
      isFolder: false,
      fileId: 110004,
      etag: 'abc123', // W/ prefix and quotes stripped
      lastModified: '2025-08-07T14:45:12.000Z',
      contentType: 'image/png',
      size: 44210,
    }
  );
});

test('parsePropfind: folders report no content type even when the server 404s the prop', () => {
  const entries = parseFixture();
  const lectures = entries.find((e) => e.name === 'Lectures');

  assert.equal(lectures.contentType, null);
  assert.equal(lectures.fileId, 110002);
  assert.equal(lectures.size, 8192);
  assert.equal(lectures.etag, '68a1c1cafe01');
  // The 404 propstat block must not wipe out the 200 block's values.
  assert.equal(lectures.lastModified.toISOString(), '2025-08-05T11:00:00.000Z');
});

test('parsePropfind: handles the root listing, where the self entry is the root itself', () => {
  const xml = buildMultistatus({
    davRoot: DAV_ROOT,
    relPath: '',
    node: { type: 'folder', children: DEFAULT_TREE },
  });
  const entries = parsePropfind(xml, { davRoot: DAV_ROOT, requestPath: '' });

  assert.equal(entries.length, Object.keys(DEFAULT_TREE).length);
  assert.ok(entries.every((e) => !e.path.includes('/')), 'root children are single-segment paths');
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    ['Biology 101', 'Café Notes', 'Math 210', 'welcome.txt'].sort()
  );
});

test('parsePropfind: a single-child folder still parses (fast-xml-parser scalar case)', () => {
  const node = resolveNode(DEFAULT_TREE, 'Math 210/Problem Sets');
  const xml = buildMultistatus({ davRoot: DAV_ROOT, relPath: 'Math 210/Problem Sets', node });
  const entries = parsePropfind(xml, { davRoot: DAV_ROOT, requestPath: 'Math 210/Problem Sets' });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Set 1.pdf');
  assert.equal(entries[0].isFolder, false);
});

test('parsePropfind: an empty folder yields no entries', () => {
  const xml = buildMultistatus({
    davRoot: DAV_ROOT,
    relPath: 'Empty',
    node: { type: 'folder', children: {} },
  });
  assert.deepEqual(parsePropfind(xml, { davRoot: DAV_ROOT, requestPath: 'Empty' }), []);
});

test('parsePropfind: ignores hrefs outside the DAV root', () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/ostrich-viewer/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/someone-else/secret.pdf</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
  assert.deepEqual(parsePropfind(xml, { davRoot: DAV_ROOT, requestPath: '' }), []);
});

test('parsePropfind: rejects junk instead of returning half a listing', () => {
  assert.throws(() => parsePropfind('', { davRoot: DAV_ROOT }), NextcloudError);
  assert.throws(() => parsePropfind('   ', { davRoot: DAV_ROOT }), NextcloudError);
  assert.throws(
    () => parsePropfind('<?xml version="1.0"?><html><body>Login</body></html>', { davRoot: DAV_ROOT }),
    NextcloudError
  );
});

test('parseMultistatus: an empty multistatus is zero results, not a broken response', () => {
  // A SEARCH that matched nothing answers 207 with exactly this, and it is the
  // commonest answer there is: nothing has changed since she last looked.
  for (const xml of [
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>',
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">\n  \n</d:multistatus>',
  ]) {
    assert.deepEqual(
      parseMultistatus(xml, { davRoot: DAV_ROOT, requestPath: '' }),
      { self: null, entries: [] },
      `should have parsed as empty: ${xml}`
    );
  }

  // A multistatus that is present but holds something other than responses is
  // still junk, and still throws.
  assert.throws(
    () => parseMultistatus('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">boom</d:multistatus>', {
      davRoot: DAV_ROOT,
    }),
    NextcloudError
  );
});

test('sortEntries: folders first, then files, each A-Z case-insensitively', () => {
  const entries = [
    { name: 'zebra.pdf', isFolder: false },
    { name: 'Apples', isFolder: true },
    { name: 'apple.png', isFolder: false },
    { name: 'bananas', isFolder: true },
    { name: 'Beta.txt', isFolder: false },
  ];

  assert.deepEqual(
    sortEntries(entries).map((e) => e.name),
    ['Apples', 'bananas', 'apple.png', 'Beta.txt', 'zebra.pdf']
  );
});

test('sortEntries does not mutate its input', () => {
  const entries = [
    { name: 'b.pdf', isFolder: false },
    { name: 'a', isFolder: true },
  ];
  const snapshot = entries.map((e) => e.name);
  sortEntries(entries);
  assert.deepEqual(entries.map((e) => e.name), snapshot);
});

test('propfind: encodes spaces and unicode in the request URL', async () => {
  const seen = [];
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init.method, depth: init.headers.Depth });
      const node = resolveNode(DEFAULT_TREE, 'Café Notes');
      return new Response(
        buildMultistatus({ davRoot: DAV_ROOT, relPath: 'Café Notes', node }),
        { status: 207, headers: { 'Content-Type': 'application/xml' } }
      );
    },
  });

  const entries = await propfind(client, 'Café Notes');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'PROPFIND');
  assert.equal(seen[0].depth, '1');
  assert.equal(seen[0].url, 'http://nextcloud.test/remote.php/dav/files/ostrich-viewer/Caf%C3%A9%20Notes');
  assert.deepEqual(entries.map((e) => e.name), ['résumé draft.pdf']);
});

test('propfind: a 404 upstream becomes a 404 NextcloudError', async () => {
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async () => new Response('nope', { status: 404 }),
  });

  await assert.rejects(() => propfind(client, 'Missing'), (err) => {
    assert.ok(err instanceof NextcloudError);
    assert.equal(err.status, 404);
    assert.equal(err.statusCode, 404);
    return true;
  });
});

test('client: refuses to issue write methods', async () => {
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async () => new Response('', { status: 200 }),
  });

  for (const method of ['PUT', 'POST', 'DELETE', 'MKCOL', 'MOVE', 'COPY', 'PROPPATCH']) {
    await assert.rejects(
      () => client.request(method, '/remote.php/dav/files/ostrich-viewer/x'),
      /read-only/,
      `${method} should be refused`
    );
  }
});

test('client: a fetch that never answered is marked unreachable, and only that one', async () => {
  // The marker is what the "file server is taking a break" page keys on, and
  // that page promises the fault will pass. So it is set at the ONE place that
  // can know nothing answered -- here, where `fetch` itself threw -- and never
  // inferred downstream from a missing status, which a malformed 207 also has.
  const dead = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
  });

  await assert.rejects(() => propfind(dead, ''), (err) => {
    assert.ok(err instanceof NextcloudError);
    assert.equal(err.code, NC_UNREACHABLE);
    assert.equal(err.status, undefined);
    return true;
  });

  // A real, closed port: the same verdict, through undici rather than a stub.
  const refused = createClient({
    baseUrl: 'http://127.0.0.1:1',
    user: 'ostrich-viewer',
    appPassword: 'pw',
  });
  await assert.rejects(() => propfind(refused, ''), (err) => {
    assert.equal(err.code, NC_UNREACHABLE);
    return true;
  });

  // Whereas an answer that arrived and made no sense is NOT unreachable, even
  // though it too has no status.
  const garbled = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async () => new Response('<html>Sign in</html>', { status: 207 }),
  });
  await assert.rejects(() => propfind(garbled, ''), (err) => {
    assert.ok(err instanceof NextcloudError);
    assert.equal(err.code, null, 'received-but-garbled must never reach the self-healing page');
    return true;
  });
});

test('client: sends Basic auth built from the app password', async () => {
  let authHeader = null;
  const client = createClient({
    baseUrl: 'http://nextcloud.test/',
    user: 'ostrich-viewer',
    appPassword: 's3cret',
    fetchImpl: async (url, init) => {
      authHeader = init.headers.Authorization;
      return new Response('', { status: 200 });
    },
  });

  await client.request('GET', '/healthz');
  assert.equal(
    authHeader,
    'Basic ' + Buffer.from('ostrich-viewer:s3cret').toString('base64')
  );
  // Trailing slash on the base URL must not produce a double slash.
  assert.equal(client.baseUrl, 'http://nextcloud.test');
});

test('parseMultistatus: surfaces the self entry alongside the children', () => {
  const { self, entries } = parseMultistatus(fixture, {
    davRoot: DAV_ROOT,
    requestPath: 'Biology 101',
  });

  assert.ok(self, 'the requested folder should be reported as self');
  assert.equal(self.isFolder, true);
  assert.equal(self.path, 'Biology 101');
  assert.equal(entries.length, 4);
});

test('parseMultistatus: a Depth-1 PROPFIND on a plain file is self-only, not a folder', () => {
  const node = resolveNode(DEFAULT_TREE, 'welcome.txt');
  const xml = buildMultistatus({ davRoot: DAV_ROOT, relPath: 'welcome.txt', node });
  const { self, entries } = parseMultistatus(xml, { davRoot: DAV_ROOT, requestPath: 'welcome.txt' });

  assert.ok(self);
  assert.equal(self.isFolder, false);
  assert.equal(self.name, 'welcome.txt');
  assert.deepEqual(entries, []);
});

test('propfind: a file path is a 404, never an empty folder', async () => {
  const node = resolveNode(DEFAULT_TREE, 'welcome.txt');
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async () =>
      new Response(buildMultistatus({ davRoot: DAV_ROOT, relPath: 'welcome.txt', node }), {
        status: 207,
        headers: { 'Content-Type': 'application/xml' },
      }),
  });

  await assert.rejects(() => propfind(client, 'welcome.txt'), (err) => {
    assert.ok(err instanceof NextcloudError);
    assert.equal(err.statusCode, 404);
    assert.match(err.message, /Not a folder/);
    return true;
  });
});

test('propfind: a 207 that describes no folder at all is an upstream failure', async () => {
  // A bodyless `<d:multistatus/>` is a perfectly good SEARCH answer -- and no
  // kind of folder listing. A Depth-1 PROPFIND must describe the collection it
  // was asked about, even an empty one, so accepting this would render as
  // "Nothing has been shared with you yet": a confident, wrong sentence about
  // somebody's files.
  for (const body of [
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>',
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
  ]) {
    const client = createClient({
      baseUrl: 'http://nextcloud.test',
      user: 'ostrich-viewer',
      appPassword: 'pw',
      fetchImpl: async () =>
        new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml' } }),
    });

    await assert.rejects(() => propfind(client, ''), (err) => {
      assert.ok(err instanceof NextcloudError);
      assert.match(err.message, /did not describe/);
      // Not a 404: the folder is not missing, the answer is. 404 would tell her
      // it had been unshared; this must reach the upstream-failure page.
      assert.equal(err.status, undefined);
      assert.equal(err.statusCode, 502);
      // And not the "taking a break" page either: something DID answer, so
      // waiting will not mend it. See NC_UNREACHABLE.
      assert.equal(err.code, null);
      return true;
    });
  }
});

test('propfind and statFile agree about a 207 that describes nothing', async () => {
  // One fault, one story. These two used to disagree: a folder listing called
  // this an upstream failure while a file stat called the very same answer a
  // 404 -- so the same broken deployment told the reader "the file server needs
  // attention" on one page and "it may have been moved or unshared" on the
  // next. The verdict now lives in the one place both go through.
  const body = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>';
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async () =>
      new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml' } }),
  });

  const verdicts = [];
  for (const attempt of [() => propfind(client, 'Biology 101'), () => statFile(client, 'welcome.txt')]) {
    await assert.rejects(attempt, (err) => {
      verdicts.push({ status: err.status, statusCode: err.statusCode, code: err.code });
      return err instanceof NextcloudError;
    });
  }

  assert.deepEqual(verdicts[0], verdicts[1], 'both callers must classify it the same way');
  assert.deepEqual(verdicts[0], { status: undefined, statusCode: 502, code: null });
});

test('propfind: an empty folder is still a folder, and still lists nothing', async () => {
  // The distinction the check above turns on: a real empty folder DOES describe
  // itself, so it must keep coming back as zero children rather than an error.
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async () =>
      new Response(
        buildMultistatus({ davRoot: DAV_ROOT, relPath: 'Empty', node: { type: 'folder', children: {} } }),
        { status: 207, headers: { 'Content-Type': 'application/xml' } }
      ),
  });

  assert.deepEqual(await propfind(client, 'Empty'), []);
});

test('propfind: follows a single same-origin redirect to the slash-terminated form', async () => {
  const seen = [];
  const node = resolveNode(DEFAULT_TREE, 'Math 210');
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async (url) => {
      seen.push(url);
      if (!url.endsWith('/')) {
        return new Response('', {
          status: 301,
          headers: { Location: `${url}/` },
        });
      }
      return new Response(buildMultistatus({ davRoot: DAV_ROOT, relPath: 'Math 210', node }), {
        status: 207,
        headers: { 'Content-Type': 'application/xml' },
      });
    },
  });

  const entries = await propfind(client, 'Math 210');
  assert.equal(seen.length, 2);
  assert.ok(seen[1].endsWith('/Math%20210/'));
  assert.ok(entries.length > 0);
});

test('propfind: refuses to follow a redirect off the Nextcloud origin', async () => {
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async () =>
      new Response('', { status: 301, headers: { Location: 'http://evil.test/steal' } }),
  });

  await assert.rejects(() => propfind(client, 'Math 210'), (err) => {
    assert.ok(err instanceof NextcloudError);
    assert.equal(err.status, 301);
    return true;
  });
});

test('propfind: an instance served under a base path still lists entries', async () => {
  // NC_BASE_URL=http://host/nextcloud -> hrefs come back /nextcloud-prefixed.
  const node = resolveNode(DEFAULT_TREE, 'Math 210');
  const prefixedRoot = '/nextcloud' + DAV_ROOT;
  const client = createClient({
    baseUrl: 'http://nextcloud.test/nextcloud',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async (url) => {
      assert.ok(
        url.startsWith('http://nextcloud.test/nextcloud/remote.php/'),
        `request must include the base path, got ${url}`
      );
      return new Response(
        buildMultistatus({ davRoot: prefixedRoot, relPath: 'Math 210', node }),
        { status: 207, headers: { 'Content-Type': 'application/xml' } }
      );
    },
  });

  const entries = await propfind(client, 'Math 210');
  assert.ok(entries.length > 0, 'entries must survive the base-path prefix');
  assert.ok(entries.every((e) => !e.path.startsWith('nextcloud/')), 'paths stay relative to the files home');
});
