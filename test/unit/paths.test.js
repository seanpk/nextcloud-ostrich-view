import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InvalidPathError,
  breadcrumbs,
  encodePath,
  joinPath,
  normalizeRelPath,
  parentPath,
  pathSegments,
} from '../../src/lib/paths.js';

test('normalizeRelPath: accepts ordinary paths unchanged', () => {
  assert.equal(normalizeRelPath('Biology 101'), 'Biology 101');
  assert.equal(normalizeRelPath('Biology 101/Lectures'), 'Biology 101/Lectures');
  assert.equal(normalizeRelPath('Café Notes/résumé draft.pdf'), 'Café Notes/résumé draft.pdf');
});

test('normalizeRelPath: treats empty-ish input as the root', () => {
  assert.equal(normalizeRelPath(''), '');
  assert.equal(normalizeRelPath('/'), '');
  assert.equal(normalizeRelPath('///'), '');
  assert.equal(normalizeRelPath(undefined), '');
  assert.equal(normalizeRelPath(null), '');
  assert.equal(normalizeRelPath('.'), '');
});

test('normalizeRelPath: collapses redundant separators and dot segments', () => {
  assert.equal(normalizeRelPath('/Biology 101/'), 'Biology 101');
  assert.equal(normalizeRelPath('Biology 101//Lectures'), 'Biology 101/Lectures');
  assert.equal(normalizeRelPath('./Biology 101/./Lectures/'), 'Biology 101/Lectures');
});

test('normalizeRelPath: rejects every flavour of traversal', () => {
  const attempts = [
    '..',
    '../',
    '../etc/passwd',
    'Biology 101/../../etc/passwd',
    'Biology 101/..',
    'a/b/../../..',
    '/../secrets',
    './../secrets',
    'foo/./../../bar',
  ];
  for (const attempt of attempts) {
    assert.throws(
      () => normalizeRelPath(attempt),
      InvalidPathError,
      `expected ${JSON.stringify(attempt)} to be rejected`
    );
  }
});

test('normalizeRelPath: rejects drive letters', () => {
  for (const attempt of ['C:/Windows', 'c:\\temp']) {
    assert.throws(() => normalizeRelPath(attempt), InvalidPathError, attempt);
  }
});

test('normalizeRelPath: backslash is an ordinary name character, never traversal', () => {
  // Legal in Nextcloud names; segments split on '/' only, so none of these
  // can climb anywhere.
  assert.equal(normalizeRelPath('Physics\\Notes'), 'Physics\\Notes');
  assert.equal(normalizeRelPath('a\\b'), 'a\\b');
  assert.equal(normalizeRelPath('..\\..\\windows'), '..\\..\\windows');
  // A real '/'-delimited '..' is still traversal, backslashes or not.
  assert.throws(() => normalizeRelPath('a\\b/../c'), InvalidPathError);
});

test('normalizeRelPath: rejects null bytes and control characters', () => {
  for (const attempt of ['a\u0000b', 'notes\u0000.pdf', 'a\nb', 'a\rb', 'a\u007fb']) {
    assert.throws(() => normalizeRelPath(attempt), InvalidPathError, JSON.stringify(attempt));
  }
});

test('normalizeRelPath: rejects non-strings', () => {
  assert.throws(() => normalizeRelPath(42), InvalidPathError);
  assert.throws(() => normalizeRelPath({}), InvalidPathError);
  assert.throws(() => normalizeRelPath(['a']), InvalidPathError);
});

test('normalizeRelPath: does NOT double-decode (percent stays literal by default)', () => {
  // Fastify already decoded the param. A file genuinely named "%2e%2e" must
  // survive as a name, not become traversal.
  assert.equal(normalizeRelPath('%2e%2e'), '%2e%2e');
  assert.equal(normalizeRelPath('100%25 done.pdf'), '100%25 done.pdf');
});

test('normalizeRelPath: with decode:true, decodes once and then still rejects traversal', () => {
  assert.equal(normalizeRelPath('Biology%20101', { decode: true }), 'Biology 101');
  assert.throws(() => normalizeRelPath('%2e%2e/secrets', { decode: true }), InvalidPathError);
  assert.throws(() => normalizeRelPath('..%2fsecrets', { decode: true }), InvalidPathError);
  assert.throws(() => normalizeRelPath('%00', { decode: true }), InvalidPathError);
  assert.throws(() => normalizeRelPath('%zz', { decode: true }), InvalidPathError);
});

test('normalizeRelPath: an encoded backslash decodes to an ordinary character', () => {
  assert.equal(normalizeRelPath('%5c%5c', { decode: true }), '\\\\');
});

test('InvalidPathError carries a 400 status for the error handler', () => {
  try {
    normalizeRelPath('../x');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.equal(err.name, 'InvalidPathError');
  }
});

test('pathSegments splits, with the root as an empty list', () => {
  assert.deepEqual(pathSegments(''), []);
  assert.deepEqual(pathSegments('a'), ['a']);
  assert.deepEqual(pathSegments('a/b/c'), ['a', 'b', 'c']);
});

test('encodePath escapes per segment and keeps slashes', () => {
  assert.equal(encodePath('Biology 101/Lectures'), 'Biology%20101/Lectures');
  assert.equal(encodePath('Café Notes/résumé draft.pdf'), 'Caf%C3%A9%20Notes/r%C3%A9sum%C3%A9%20draft.pdf');
  assert.equal(encodePath(''), '');
  assert.equal(encodePath('a&b/c?d'), 'a%26b/c%3Fd');
});

test('encodePath output round-trips back through normalizeRelPath with decode', () => {
  const original = 'Café Notes/a b&c/日本語.pdf';
  assert.equal(normalizeRelPath(encodePath(original), { decode: true }), original);
});

test('parentPath climbs one level and stops at the root', () => {
  assert.equal(parentPath('a/b/c'), 'a/b');
  assert.equal(parentPath('a'), '');
  assert.equal(parentPath(''), '');
});

test('joinPath appends a child and rejects a malicious "name"', () => {
  assert.equal(joinPath('', 'Biology 101'), 'Biology 101');
  assert.equal(joinPath('Biology 101', 'Lectures'), 'Biology 101/Lectures');
  assert.throws(() => joinPath('Biology 101', '..'), InvalidPathError);
  assert.throws(() => joinPath('Biology 101', '../../etc'), InvalidPathError);
});

test('breadcrumbs start at Home and encode each href', () => {
  assert.deepEqual(breadcrumbs(''), [{ name: 'Home', path: '', href: '/' }]);

  assert.deepEqual(breadcrumbs('Biology 101/Lectures'), [
    { name: 'Home', path: '', href: '/' },
    { name: 'Biology 101', path: 'Biology 101', href: '/files/Biology%20101' },
    {
      name: 'Lectures',
      path: 'Biology 101/Lectures',
      href: '/files/Biology%20101/Lectures',
    },
  ]);
});
