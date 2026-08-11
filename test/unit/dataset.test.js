// A dataset's day offsets are about the reader's calendar, not Greenwich's, so
// the suite pins a zone that is NOT UTC before anything reads a Date -- east of
// it, so that a UTC-flavoured "today" lands on yesterday for part of every
// morning, which is the bug the offsets used to have. (Node re-reads TZ on the
// next date operation, and no Intl formatter has been built yet.)
process.env.TZ = 'Asia/Tokyo';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { toSlug } from '../../src/nextcloud/caldav.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';
import { DatasetError, contentTypeFor, loadDataset } from '../mock-nextcloud/dataset.js';

/**
 * The JSON-backed dataset loader.
 *
 * Two things are worth testing here and nothing else really is. First, that a
 * dataset file becomes the exact in-memory shapes the mock already understands
 * -- because the whole point of the loader is that nothing downstream has to
 * know a JSON file was involved. Second, that a broken dataset says what is
 * broken and where: this is a file people hand-edit to try things out, and a
 * stack trace from `readFileSync` is not an error message.
 *
 * The last test closes the loop by serving a loaded dataset through the mock,
 * which is the only way to show that "inline text file" really does arrive as
 * the right bytes under the right content type.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..');
const SAMPLE_PNG = join(REPO, 'test', 'mock-nextcloud', 'assets', 'sample.png');

/** A fixed clock, so an assertion about a DUE date can name the day. */
const NOW = Date.parse('2026-08-10T12:00:00Z');

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/**
 * Write a dataset to a throwaway directory and hand back the path to its JSON,
 * exactly as somebody experimenting with `demo/` would have on disk.
 *
 * @param {object} data
 * @param {{assets?: Record<string, string>}} [options] assets: relative path ->
 *   file to copy there.
 */
function writeDataset(data, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-dataset-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));

  for (const [relPath, from] of Object.entries(options.assets ?? {})) {
    const target = join(dir, relPath);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(from, target);
  }

  const jsonPath = join(dir, 'dataset.json');
  writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  return jsonPath;
}

/** Load a dataset built from `data`, on the fixed clock. */
function load(data, options = {}) {
  return loadDataset(writeDataset(data, options), { now: NOW });
}

/** The DatasetError message a bad dataset produces. */
function messageFrom(data, options = {}) {
  try {
    load(data, options);
  } catch (err) {
    assert.ok(err instanceof DatasetError, `expected a DatasetError, got ${err?.name}: ${err?.message}`);
    return err.message;
  }
  return assert.fail('the dataset was accepted, and should not have been');
}

test('dataset: a valid file becomes the tree and calendars the mock takes', () => {
  const { tree, calendars } = load(
    {
      files: {
        'Biology 101': {
          children: {
            'cell diagram.png': { asset: 'assets/sample.png', lastModified: '-3h' },
            'reading list.txt': { text: 'Chapter 4\n' },
            'syllabus.pdf': { asset: 'assets/sample.png', contentType: 'application/pdf' },
          },
        },
        'welcome.txt': { text: 'Hello\n', lastModified: '2026-08-04T09:15:00Z' },
      },
      tasks: [
        {
          displayName: 'School work',
          color: '#1c4f8b',
          tasks: [
            {
              summary: 'Lab report',
              description: 'Two parts:\nmethod; then results',
              due: '+2d',
              priority: 1,
              percent: 40,
              subtasks: [{ summary: 'Collect pond samples', due: '2026-08-18' }],
            },
            { summary: 'Email Professor Ruiz', completed: '2026-08-09T08:15:00Z' },
          ],
        },
      ],
    },
    { assets: { 'assets/sample.png': SAMPLE_PNG } }
  );

  // --- files ---------------------------------------------------------------
  const png = readFileSync(SAMPLE_PNG);
  const folder = tree['Biology 101'];
  assert.equal(folder.type, 'folder');

  const diagram = folder.children['cell diagram.png'];
  assert.deepEqual(
    { type: diagram.type, contentType: diagram.contentType, size: diagram.size },
    { type: 'file', contentType: 'image/png', size: png.length },
    'an asset entry carries the real bytes, typed by its extension'
  );
  assert.ok(diagram.bytes.equals(png), 'the bytes are the file on disk, not a placeholder');
  assert.equal(
    diagram.lastModified,
    new Date(NOW - 3 * 3600_000).toUTCString(),
    'an offset is measured from now and stored as an HTTP-date'
  );

  assert.deepEqual(
    { ...folder.children['reading list.txt'], bytes: undefined },
    { type: 'file', contentType: 'text/plain', size: 10, bytes: undefined },
    'an inline file is sized from its own bytes'
  );

  assert.equal(
    folder.children['syllabus.pdf'].contentType,
    'application/pdf',
    'an explicit contentType beats the extension'
  );
  assert.equal(
    tree['welcome.txt'].lastModified,
    'Tue, 04 Aug 2026 09:15:00 GMT',
    'an absolute stamp is converted, not passed through'
  );

  // --- tasks ---------------------------------------------------------------
  assert.equal(calendars.length, 1);
  const [calendar] = calendars;
  assert.deepEqual(
    { uri: calendar.uri, displayName: calendar.displayName, color: calendar.color, components: calendar.components },
    { uri: 'school-work', displayName: 'School work', color: '#1c4f8b', components: ['VTODO'] },
    'the display name becomes a URL-safe list id'
  );
  assert.equal(calendar.todos.length, 3, 'subtasks are resources of their own, as CalDAV stores them');

  const [parent, child, done] = calendar.todos;

  assert.match(parent, /^UID:school-work-lab-report$/m);
  assert.match(parent, /^DUE;VALUE=DATE:20260812$/m, '"+2d" is a calendar day, not an instant');
  assert.match(parent, /^PRIORITY:1$/m);
  assert.match(parent, /^PERCENT-COMPLETE:40$/m);
  assert.match(parent, /^STATUS:NEEDS-ACTION$/m, 'a task with no completion is open');
  assert.match(
    parent,
    /^DESCRIPTION:Two parts:\\nmethod\\; then results$/m,
    'newlines and semicolons are escaped the way RFC 5545 asks'
  );

  assert.match(
    child,
    /^RELATED-TO:school-work-lab-report$/m,
    'nesting in JSON becomes a RELATED-TO pointer, which is all CalDAV has'
  );
  assert.match(child, /^DUE;VALUE=DATE:20260818$/m);

  assert.match(done, /^STATUS:COMPLETED$/m, '"completed" says the task is done without repeating yourself');
  assert.match(done, /^COMPLETED:20260809T081500Z$/m);
  assert.match(done, /^PERCENT-COMPLETE:100$/m);
});

test('dataset: a missing asset names the entry, the path and where it looked', () => {
  const message = messageFrom({
    files: { 'Biology 101': { children: { 'syllabus.pdf': { asset: 'assets/nope.pdf' } } } },
  });

  assert.match(message, /"Biology 101"\.children\."syllabus\.pdf"/, 'the entry that is wrong');
  assert.match(message, /assets\/nope\.pdf/, 'the asset it asked for');
  assert.match(message, /looked in .*assets\/nope\.pdf/, 'and where it actually looked');
});

test('dataset: the shapes it refuses, and what it says about them', () => {
  assert.match(messageFrom({ files: [] }), /files: expected an object, got an array/);

  assert.match(
    messageFrom({ files: { 'notes.txt': { text: 42 } } }),
    /"notes\.txt"\.text: expected a string, got number/
  );

  assert.match(
    messageFrom({ files: { 'mystery.pdf': {} } }),
    /"mystery\.pdf": needs one of "children" .* "text" .* "asset"/s,
    'an entry that is neither a folder nor a file is named, with the way out'
  );

  assert.match(
    messageFrom({ files: { 'both.txt': { text: 'hi', asset: 'assets/sample.png' } } }),
    /"both\.txt": has "text" and "asset"; pick one\./
  );

  assert.match(
    messageFrom({ files: { 'a/b.txt': { text: 'hi' } } }),
    /"a\/b\.txt" is not a usable name/,
    'paths are not names: the tree\'s own nesting is the only nesting'
  );

  assert.match(
    messageFrom({ files: { 'notes.txt': { text: 'hi', lastModified: 'last tuesday' } } }),
    /lastModified: could not read "last tuesday" as a date/
  );

  assert.match(messageFrom({ tasks: {} }), /tasks: expected an array of task lists, got object/);

  assert.match(
    messageFrom({ tasks: [{ tasks: [] }] }),
    /tasks\[0\]: needs a non-empty "displayName"/
  );

  assert.match(
    messageFrom({ tasks: [{ displayName: 'School', color: 'blue', tasks: [] }] }),
    /tasks\[0\]\.color: expected "#rrggbb", got "blue"/
  );

  assert.match(
    messageFrom({ tasks: [{ displayName: 'School', tasks: [{ due: '+1d' }] }] }),
    /tasks\[0\]\.tasks\[0\]: needs a non-empty "summary"/
  );

  assert.match(
    messageFrom({ tasks: [{ displayName: 'School', tasks: [{ summary: 'x', status: 'maybe' }] }] }),
    /tasks\[0\]\.tasks\[0\]\.status: expected one of/
  );

  assert.match(
    messageFrom({ tasks: [{ displayName: 'School', tasks: [{ summary: 'x', percent: 140 }] }] }),
    /percent: expected a whole number between 0 and 100, got 140/
  );

  assert.match(
    messageFrom({ files: { 'x.pdf': { asset: '/etc/passwd' } } }),
    /asset paths must be relative to the dataset file/,
    'an absolute asset path would make the dataset unmovable'
  );

  assert.match(messageFrom({}), /has neither "files" nor "tasks"/);
});

test('dataset: an inline text file is served with its own bytes and its inferred type', async () => {
  const text = 'Prof. Ruiz — Tuesdays 2-4pm, Kemper 318.\n';
  const { tree } = load(
    {
      files: {
        'Math 210': {
          children: {
            'office hours.txt': { text },
            'graph sketch.png': { asset: 'assets/sample.png' },
          },
        },
      },
    },
    { assets: { 'assets/sample.png': SAMPLE_PNG } }
  );

  const mock = createMockNextcloud({ tree });
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();

  const auth = `Basic ${Buffer.from(`${TEST_USER}:${TEST_APP_PASSWORD}`).toString('base64')}`;
  const davRoot = `${url}/remote.php/dav/files/${TEST_USER}`;

  const notes = await fetch(`${davRoot}/Math%20210/office%20hours.txt`, { headers: { authorization: auth } });
  assert.equal(notes.status, 200);
  assert.equal(notes.headers.get('content-type'), 'text/plain');
  assert.equal(await notes.text(), text, 'unicode included: the bytes are UTF-8, and length is bytes');

  const propfind = await fetch(`${davRoot}/Math%20210`, {
    method: 'PROPFIND',
    headers: { authorization: auth, depth: '1' },
  });
  const xml = await propfind.text();
  // 41 characters, 43 bytes: the em dash is three of them.
  assert.match(
    xml,
    new RegExp(`<oc:size>${Buffer.byteLength(text)}</oc:size>`),
    'oc:size counts bytes, not characters'
  );
  assert.match(xml, /<d:getcontenttype>image\/png<\/d:getcontenttype>/);

  const image = await fetch(`${davRoot}/Math%20210/graph%20sketch.png`, { headers: { authorization: auth } });
  const bytes = Buffer.from(await image.arrayBuffer());
  assert.ok(bytes.equals(readFileSync(SAMPLE_PNG)), 'an asset is served back byte for byte');
});

test('dataset: a day offset is the reader\'s calendar day, not Greenwich\'s', () => {
  // 01:00 on the 11th in Tokyo, which is still the 10th in UTC. A task list is
  // made of calendar days and the app judges "overdue" against the local one
  // (src/lib/dates.js), so a "+0d" read in UTC would open the demo with today's
  // task already red -- every morning, for everyone east of Greenwich, until
  // the clock caught up.
  const morning = Date.parse('2026-08-10T16:00:00Z');
  const { tree, calendars } = loadDataset(
    writeDataset({
      files: { 'today.txt': { text: 'hi', lastModified: '+0d' } },
      tasks: [
        {
          displayName: 'Apartment',
          tasks: [
            { summary: 'Take the bins out', due: '+0d' },
            { summary: 'Pay the internet bill', due: '+2d' },
          ],
        },
      ],
    }),
    { now: morning }
  );

  const [today, later] = calendars[0].todos;
  assert.match(today, /^DUE;VALUE=DATE:20260811$/m, '"+0d" is today where the reader is');
  assert.match(later, /^DUE;VALUE=DATE:20260813$/m, 'and "+2d" counts on from that same day');
  assert.equal(
    tree['today.txt'].lastModified,
    new Date(Date.UTC(2026, 7, 11)).toUTCString(),
    'a file stamped "+0d" is pinned to the same day'
  );
});

test('dataset: a date-shaped string that is not a real day is refused, not silently moved', () => {
  // "2026-13-01" parses to NaN -- which used to reach ical.js as
  // "DUE;VALUE=DATE:NaNNaNNaN" and the mock as an "Invalid Date" Last-Modified,
  // both of which fail somewhere far away from the typo that caused them.
  assert.match(
    messageFrom({ tasks: [{ displayName: 'School', tasks: [{ summary: 'x', due: '2026-13-01' }] }] }),
    /tasks\[0\]\.tasks\[0\]\.due: "2026-13-01" is not a real calendar day/
  );

  // And "2026-02-30" is worse than an error: it parses, as March 2nd. A dataset
  // that says the 30th and serves the 2nd is a demo that lies quietly.
  assert.match(
    messageFrom({ files: { 'notes.txt': { text: 'hi', lastModified: '2026-02-30' } } }),
    /"notes\.txt"\.lastModified: "2026-02-30" is not a real calendar day/
  );

  assert.match(
    messageFrom({ tasks: [{ displayName: 'School', tasks: [{ summary: 'x', completed: '2026-04-31' }] }] }),
    /completed: "2026-04-31" is not a real calendar day/
  );

  // The days that DO exist keep working, leap day included.
  const { calendars } = load({
    tasks: [{ displayName: 'School', tasks: [{ summary: 'x', due: '2028-02-29' }] }],
  });
  assert.match(calendars[0].todos[0], /^DUE;VALUE=DATE:20280229$/m);
});

test('dataset: a name JavaScript reserves is refused rather than quietly vanishing', () => {
  // "__proto__" as a key does not land in a plain object, it moves its
  // prototype: the entry disappears from every listing while the dataset still
  // says it is there. Refusing it by name is the only version of this anyone
  // can debug.
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    assert.match(
      messageFrom({ files: { [name]: { text: 'hi' } } }),
      new RegExp(`"${name}" is not a usable name`),
      `${name} should be refused as a file name`
    );
  }

  // A computed key, deliberately: a bare `__proto__:` in a JavaScript object
  // literal sets the prototype instead of defining a property, so it would
  // never survive as far as JSON. `JSON.parse` does define it, which is exactly
  // how a hand-edited dataset gets one.
  assert.match(
    messageFrom({ files: { Notes: { children: { ['__proto__']: { text: 'hi' } } } } }),
    /"Notes"\.children: "__proto__" is not a usable name/,
    'nested, too -- and the message says where'
  );

  // Nothing was polluted on the way to that error, either.
  assert.equal(Object.prototype.polluted, undefined);
});

test('dataset: a key nobody reads is a typo, and is named as one', () => {
  // The two this schema invites. Ignoring either takes a feature out of the
  // demo -- the subtasks, the list colour -- while the file on disk still says
  // it is there, which is the kind of bug you look for everywhere except the
  // dataset.
  assert.match(
    messageFrom({
      tasks: [
        {
          displayName: 'School',
          tasks: [{ summary: 'Lab report', subTasks: [{ summary: 'Collect samples' }] }],
        },
      ],
    }),
    /tasks\[0\]\.tasks\[0\]: unknown key "subTasks"\. Did you mean "subtasks"\?/
  );

  const colour = messageFrom({ tasks: [{ displayName: 'School', colour: '#1c4f8b', tasks: [] }] });
  assert.match(colour, /tasks\[0\]: unknown key "colour"\./);
  assert.match(colour, /Allowed here: "displayName", "uri", "color", "tasks"\./, 'no bad guess, just the list');

  assert.match(
    messageFrom({ files: { 'notes.txt': { text: 'hi', modified: '-1d' } } }),
    /"notes\.txt": unknown key "modified"\.[\s\S]*"lastModified"/
  );

  assert.match(messageFrom({ files: {}, calendars: [] }), /unknown key "calendars"/);

  // An underscore is how a dataset writes a comment, and demo/dataset.json opens
  // with one -- so those are not typos and must survive.
  const { tree } = load({
    _comment: 'what this dataset is for',
    files: { 'notes.txt': { _why: 'a note about this file', text: 'hi' } },
  });
  assert.deepEqual(Object.keys(tree), ['notes.txt']);
});

test('dataset: list ids are minted with the app\'s own slug rule, not a second one', () => {
  // The uri a dataset writes is what the app slugifies into `/tasks/<slug>`
  // (src/nextcloud/caldav.js). A second slugifier here meant "Café" became
  // `caf` in the dataset and `cafe` in the app, so the demo's own task list
  // 404'd -- on the one dataset most likely to be hand-edited.
  const { calendars } = load({
    tasks: [
      { displayName: 'Café notes', tasks: [{ summary: 'Deux sources de plus' }] },
      { displayName: 'Café notes', tasks: [] },
    ],
  });

  assert.deepEqual(calendars.map((c) => c.uri), ['cafe-notes', 'cafe-notes-2']);
  for (const { uri } of calendars) {
    assert.equal(toSlug(uri), uri, 'the app must not rename a uri this dataset handed out');
  }
  assert.match(calendars[0].todos[0], /^UID:cafe-notes-deux-sources-de-plus$/m);
});

test('dataset: one buffer per asset, however many entries point at it', () => {
  // The demo aims eight entries at the same sample PDF. Reading it eight times
  // is eight copies held for the life of the process, for one file.
  const { tree } = load(
    {
      files: {
        'a.png': { asset: 'assets/sample.png' },
        'b.png': { asset: 'assets/sample.png' },
        Nested: { children: { 'c.png': { asset: 'assets/sample.png' } } },
      },
    },
    { assets: { 'assets/sample.png': SAMPLE_PNG } }
  );

  const { bytes } = tree['a.png'];
  assert.ok(bytes.equals(readFileSync(SAMPLE_PNG)), 'and it is still the real file');
  assert.equal(tree['b.png'].bytes, bytes, 'the same buffer, not an equal one');
  assert.equal(tree.Nested.children['c.png'].bytes, bytes);
});

test('dataset: content types are inferred from the extension, case and all', () => {
  assert.equal(contentTypeFor('cell diagram.PNG'), 'image/png');
  assert.equal(contentTypeFor('Week 2 — Mitosis.pdf'), 'application/pdf');
  assert.equal(contentTypeFor('photo.jpeg'), 'image/jpeg');
  assert.equal(contentTypeFor('notes.txt'), 'text/plain');
  assert.equal(contentTypeFor('archive.tar.gz'), 'application/octet-stream');
  assert.equal(contentTypeFor('LICENSE'), 'application/octet-stream', 'no extension at all');
});

test('dataset: the demo dataset that ships with the repo is one of the valid ones', () => {
  const { tree, calendars } = loadDataset(join(REPO, 'demo', 'dataset.json'));

  assert.deepEqual(Object.keys(tree).sort(), ['Biology 101', 'Essays', 'Math 210']);
  assert.deepEqual(
    calendars.map((c) => c.displayName),
    ['School', 'Apartment']
  );

  // "New since you last looked" is the demo's headline, and it has something to
  // show only if the dataset stamps a couple of files inside the window the
  // demo pretends she was away for (scripts/demo.js: two days).
  const twoDaysAgo = Date.now() - 2 * 24 * 3600_000;
  const recent = [];
  const walk = (children, prefix) => {
    for (const [name, node] of Object.entries(children)) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (node.type === 'folder') walk(node.children, path);
      else if (node.lastModified && Date.parse(node.lastModified) > twoDaysAgo) recent.push(path);
    }
  };
  walk(tree, '');

  assert.ok(
    recent.length >= 2,
    `expected a couple of recently-touched files, found ${JSON.stringify(recent)}`
  );
});
