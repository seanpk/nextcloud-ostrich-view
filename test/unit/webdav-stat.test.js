import test from 'node:test';
import assert from 'node:assert/strict';

import { statFile } from '../../src/nextcloud/webdav.js';
import { createClient, NextcloudError } from '../../src/nextcloud/client.js';
import { InvalidPathError } from '../../src/lib/paths.js';
import { buildMultistatus } from '../mock-nextcloud/index.js';
import { DEFAULT_TREE, resolveNode } from '../mock-nextcloud/tree.js';

/**
 * `statFile` is what stands between a URL and a byte stream: /view/, /content/
 * and the preview key all start from the metadata it returns, so it has to be
 * exact about what exists, what is a folder, and what it asked for.
 */

const DAV_ROOT = '/remote.php/dav/files/ostrich-viewer';

function clientFor(responder) {
  const calls = [];
  const client = createClient({
    baseUrl: 'http://nextcloud.test',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, depth: options.headers.Depth });
      return responder(url, options);
    },
  });
  return { client, calls };
}

/** Answer a Depth-0 PROPFIND from the fixture tree. */
function treeClient() {
  return clientFor((url) => {
    const relPath = decodeURIComponent(new URL(url).pathname.slice(DAV_ROOT.length + 1));
    const node = resolveNode(DEFAULT_TREE, relPath);
    if (!node) return new Response('', { status: 404 });
    return new Response(
      buildMultistatus({ davRoot: DAV_ROOT, relPath, node: { ...node, children: {} } }),
      { status: 207, headers: { 'Content-Type': 'application/xml' } }
    );
  });
}

test('statFile: returns the file itself, with the properties the viewer needs', async () => {
  const { client } = treeClient();
  const entry = await statFile(client, 'Biology 101/Lectures/cell diagram.png');

  assert.equal(entry.name, 'cell diagram.png');
  assert.equal(entry.path, 'Biology 101/Lectures/cell diagram.png');
  assert.equal(entry.isFolder, false);
  assert.equal(entry.contentType, 'image/png');
  assert.equal(typeof entry.fileId, 'number');
  assert.match(entry.etag, /^[A-Za-z0-9]+$/, 'the etag must survive as a clean cache key');
  assert.ok(entry.size > 0);
});

test('statFile: asks for Depth 0 -- a folder listing is not its job', async () => {
  const { client, calls } = treeClient();
  await statFile(client, 'welcome.txt');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PROPFIND');
  assert.equal(calls[0].depth, '0');
});

test('statFile: percent-encodes spaces and accents on the way out', async () => {
  const { client, calls } = treeClient();
  await statFile(client, 'Café Notes/résumé draft.pdf');

  assert.ok(
    calls[0].url.endsWith('/Caf%C3%A9%20Notes/r%C3%A9sum%C3%A9%20draft.pdf'),
    `unexpected upstream URL: ${calls[0].url}`
  );
});

test('statFile: reports folders as folders rather than pretending they are files', async () => {
  const { client } = treeClient();
  const entry = await statFile(client, 'Biology 101');

  assert.equal(entry.isFolder, true);
  assert.equal(entry.name, 'Biology 101');
});

test('statFile: a missing file is a 404, not a 502', async () => {
  const { client } = treeClient();

  await assert.rejects(() => statFile(client, 'Biology 101/nope.png'), (err) => {
    assert.ok(err instanceof NextcloudError);
    assert.equal(err.statusCode, 404);
    return true;
  });
});

test('statFile: the files root is not a file', async () => {
  const { client, calls } = treeClient();

  await assert.rejects(() => statFile(client, ''), (err) => {
    assert.equal(err.statusCode, 404);
    return true;
  });
  assert.equal(calls.length, 0, 'and it never asks Nextcloud about it');
});

test('statFile: traversal is rejected before any request is made', async () => {
  const { client, calls } = treeClient();

  await assert.rejects(() => statFile(client, '../../etc/passwd'), InvalidPathError);
  assert.equal(calls.length, 0);
});

test('statFile: a 207 that describes something else is an upstream failure, not a 404', async () => {
  // A response whose only href is a *different* resource must not be mistaken
  // for the file that was asked about -- and it is not a missing file either.
  // "It may have been moved or unshared" is a claim about the owner's folder; the
  // truth is that the server answered badly, which is what `propfind` has
  // always said about the identical answer. One fault, one story.
  const node = resolveNode(DEFAULT_TREE, 'welcome.txt');
  const { client } = clientFor(
    () =>
      new Response(
        buildMultistatus({ davRoot: DAV_ROOT, relPath: 'welcome.txt', node }),
        { status: 207, headers: { 'Content-Type': 'application/xml' } }
      )
  );

  await assert.rejects(() => statFile(client, 'Biology 101/syllabus.pdf'), (err) => {
    assert.ok(err instanceof NextcloudError);
    assert.equal(err.status, undefined, 'no upstream status: the 207 itself was the problem');
    assert.equal(err.statusCode, 502);
    return true;
  });
});

test('statFile: a genuine upstream 404 is still the only route to "we could not find that"', async () => {
  // The other half of the test above: narrowing the self-less 207 to an upstream
  // failure must not cost a really-missing file its calm 404 page.
  const { client } = clientFor(() => new Response('nope', { status: 404 }));

  await assert.rejects(() => statFile(client, 'Biology 101/gone.pdf'), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.statusCode, 404);
    return true;
  });
});

test('statFile: follows a single same-origin redirect, exactly as propfind does', async () => {
  // Both depths go through one helper precisely so this cannot be true of a
  // folder listing and false of the file the viewer is about to open.
  const seen = [];
  const node = resolveNode(DEFAULT_TREE, 'Biology 101');
  const { client } = clientFor((url) => {
    seen.push(url);
    if (!url.endsWith('/')) return new Response('', { status: 301, headers: { Location: `${url}/` } });
    return new Response(buildMultistatus({ davRoot: DAV_ROOT, relPath: 'Biology 101', node: { ...node, children: {} } }), {
      status: 207,
      headers: { 'Content-Type': 'application/xml' },
    });
  });

  const entry = await statFile(client, 'Biology 101');
  assert.equal(seen.length, 2);
  assert.ok(seen[1].endsWith('/Biology%20101/'));
  assert.equal(entry.isFolder, true);
});

test('statFile: refuses to follow a redirect off the Nextcloud origin', async () => {
  const { client, calls } = clientFor(
    () => new Response('', { status: 302, headers: { Location: 'http://evil.test/steal' } })
  );

  await assert.rejects(() => statFile(client, 'welcome.txt'), (err) => {
    assert.equal(err.statusCode, 502);
    return true;
  });
  assert.equal(calls.length, 1, 'the redirect is never chased');
});

test('statFile: an unexpected status surfaces as a bad-gateway error', async () => {
  const { client } = clientFor(() => new Response('boom', { status: 500 }));

  await assert.rejects(() => statFile(client, 'welcome.txt'), (err) => {
    assert.ok(err instanceof NextcloudError);
    assert.equal(err.status, 500);
    assert.equal(err.statusCode, 502);
    return true;
  });
});

test('statFile: works on an instance served under a base path', async () => {
  const prefixedRoot = `/nextcloud${DAV_ROOT}`;
  const node = resolveNode(DEFAULT_TREE, 'welcome.txt');
  const client = createClient({
    baseUrl: 'http://nextcloud.test/nextcloud',
    user: 'ostrich-viewer',
    appPassword: 'pw',
    fetchImpl: async (url) => {
      assert.ok(url.startsWith('http://nextcloud.test/nextcloud/remote.php/'), url);
      return new Response(
        buildMultistatus({ davRoot: prefixedRoot, relPath: 'welcome.txt', node }),
        { status: 207, headers: { 'Content-Type': 'application/xml' } }
      );
    },
  });

  const entry = await statFile(client, 'welcome.txt');
  assert.equal(entry.path, 'welcome.txt');
  assert.equal(entry.isFolder, false);
});
