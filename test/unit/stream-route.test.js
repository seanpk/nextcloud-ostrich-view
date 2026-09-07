import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createTtlCache } from '../../src/lib/stream.js';
import { WALK_MAX_DEPTH } from '../../src/nextcloud/search.js';
import { clearTaskCache } from '../../src/nextcloud/caldav.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';
import { CALENDAR_FIXTURES } from '../mock-nextcloud/calendars.js';
import {
  DEFAULT_TREE,
  NEWEST_LAST_MODIFIED,
  SHARE_OWNER,
  resolveNode,
} from '../mock-nextcloud/tree.js';

/**
 * The stream route, wired the way it really is: real store, real search, a mock
 * Nextcloud underneath.
 *
 * Things only this level can show. First, that a load which fell over does not
 * spend the baseline -- the store's two-phase API is only worth having if the
 * route actually commits after its fetch. Second, that an unreachable Nextcloud
 * reaches the error pages rather than rendering as an empty stream, which is
 * the one policy that changed when this page stopped being a bonus section and
 * became the app's front door. Third, how much upstream traffic a refresh costs
 * and when the route is willing to ask again: questions about the conversation
 * with Nextcloud, which no pure function can answer.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWERS_FILE = join(HERE, '..', 'e2e', 'viewers.test.json');
const PASSPHRASE = 'correct horse'; // mom, per viewers.test.json

/**
 * The sitting we backdate to: after the fixture tree's baseline stamp, before
 * its two "recent" files, and long enough ago that the next load rotates.
 */
const LAST_VISIT = '2025-08-05T00:00:00.000Z';

/** The two files the fixture stamps after LAST_VISIT, newest first. */
const RECENT_FILES = ['microscope.jpg', 'Week 2 Notes.pdf'];

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

// The todo cache in ../../src/nextcloud/caldav.js is module-level, so it
// outlives an app. Its key carries the base URL and every mock here listens on
// an ephemeral port, which keeps these tests apart by luck rather than by
// design -- and the REPORT-counting assertions below are exactly what that luck
// would break.
beforeEach(() => clearTaskCache());

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-stream-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * An app on the given Nextcloud, sharing whichever data directory it is given.
 * Pass `logged` (an array) when a test needs to read the warnings it wrote.
 */
async function boot({ baseUrl, dir, streamCache, logged }) {
  const config = loadConfig({
    NC_BASE_URL: baseUrl,
    NC_USER: TEST_USER,
    NC_APP_PASSWORD: TEST_APP_PASSWORD,
    SESSION_SECRET: 'b'.repeat(64),
    VIEWERS_FILE,
    NODE_ENV: 'test',
    DATA_DIR: dir,
  });

  // A logger that only collects, when a test needs to see the warnings.
  const logger = logged
    ? {
        level: 'warn',
        stream: {
          write(line) {
            logged.push(JSON.parse(line));
          },
        },
      }
    : false;

  const app = await buildApp({ config, logger, streamCache });
  cleanups.push(() => app.close());
  return app;
}

async function bootMock(options) {
  const mock = createMockNextcloud(options);
  cleanups.push(() => mock.stop());
  const { url } = await mock.start();
  return { mock, url };
}

function countSearches(mock) {
  return mock.requests.filter((r) => r.method === 'SEARCH').length;
}

function countPropfinds(mock) {
  return mock.requests.filter((r) => r.method === 'PROPFIND').length;
}

function countReports(mock) {
  return mock.requests.filter((r) => r.method === 'REPORT').length;
}

/**
 * The fixtures with one chore rewritten, the way the owner editing a task in
 * the Android app rewrites it: a new DTSTAMP, and (because the mock's etags are
 * a hash of the resource) a new ETag with it.
 */
function editedChores() {
  return CALENDAR_FIXTURES.map((calendar) => {
    if (calendar.uri !== 'chores') return calendar;
    return {
      ...calendar,
      // A moved ctag, or `fetchTodos` would be entitled to serve the old answer.
      ctag: 'http://sabre.io/ns/sync/8',
      todos: calendar.todos.map((blob) =>
        blob.includes('SUMMARY:Empty the dishwasher')
          ? blob
              .replace(/DTSTAMP:[^\r\n]*/, 'DTSTAMP:20250808T173000Z')
              .replace('SUMMARY:Empty the dishwasher', 'SUMMARY:Empty the dishwasher\r\nPRIORITY:2')
          : blob
      ),
    };
  });
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
  return { cookie: (Array.isArray(cookie) ? cookie : [cookie]).map((c) => c.split(';')[0]).join('; ') };
}

function readState(dir) {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
}

/** Backdate mom's sitting, exactly as an operator (or the E2E suite) would. */
function backdate(dir, startedAt) {
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ mom: { currentVisitStartedAt: startedAt, previousVisitStartedAt: null } })
  );
}

/** Every row's name, in the order it appears -- files and tasks alike. */
function rowNames(body) {
  return [...body.matchAll(/<span class="stream__name">([^<]*)<\/span>/g)].map((m) => m[1]);
}

/**
 * The rows BELOW the Today line: the history.
 *
 * The page is one axis now, so a bare list of names starts with what is coming
 * (the open tasks' due dates) and only then reaches what happened. Splitting on
 * the anchor is what keeps the two halves' assertions honest about each other.
 */
function historyNames(body) {
  const line = body.indexOf('id="today"');
  assert.notEqual(line, -1, 'the page always has a Today line');
  return rowNames(body.slice(line));
}

/** The rows ABOVE the Today line: what is coming. */
function upcomingNames(body) {
  const line = body.indexOf('id="today"');
  return rowNames(body.slice(0, line));
}

/** The `label`/`dueLabel` of every row, in order: "Finished", "Was due ...". */
function rowLabels(body) {
  return [...body.matchAll(/<span class="stream__what">([^<]*)<\/span>/g)].map((m) =>
    m[1].trim()
  );
}

/** The names of the rows carrying a New badge -- files and tasks alike. */
function badgedNames(body) {
  return [
    ...body.matchAll(/<li class="stream__item stream__item--new[^"]*">[\s\S]*?<\/li>/g),
  ].flatMap((m) => rowNames(m[0]));
}

/**
 * The badged FILE rows.
 *
 * The badge rule knows nothing about kinds, so a task whose stamp is newer than
 * the sitting is badged too -- which is the point. Tests about which FILES
 * carry a badge say so.
 */
function badgedFileNames(body) {
  return badgedNames(body).filter((name) => /\.[a-z0-9]+$/i.test(name));
}

// --- What the page is -------------------------------------------------------

test('stream: the whole recent history is listed, grouped by day, newest first', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  const names = historyNames(response.body);

  // Not a filtered slice: files far older than any sitting are on the page too.
  assert.ok(names.includes('Week 1 Notes.pdf'), 'and the older history under it');
  assert.ok(names.includes('résumé draft.pdf'));
  // The two recently-touched files lead the file rows.
  const files = names.filter((name) => name.includes('.'));
  assert.deepEqual(files.slice(0, 2), RECENT_FILES, 'newest first');

  // Day headings, and the anchor the toggle and the login redirect point at.
  assert.match(response.body, /<h2[^>]*id="today"[^>]*>Today<\/h2>/);
  assert.match(response.body, /class="stream__day[^"]*"[^>]*>[A-Z]\w\w, \w\w\w \d/);

  // One SEARCH for the files, one PROPFIND for the task lists, one REPORT
  // each. The plan (docs/plans/issue-3-tasks-in-stream.md §3) departs from #2's
  // one-round-trip budget here on purpose: CalDAV has no cross-calendar query.
  assert.equal(countSearches(mock), 1);
  assert.equal(countPropfinds(mock), 1, 'one PROPFIND: the list of task lists');
  assert.equal(countReports(mock), 2, 'and one REPORT per VTODO calendar');
});

test('stream: a finished task sits among the file rows, in time order', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  const names = historyNames(response.body);

  // The fixture's stamps interleave on purpose (see
  // test/mock-nextcloud/calendars.js): the lab manual was ticked off at 14:00
  // on the 6th, between the Week 2 notes going up that evening and the Week 1
  // notes two days earlier. A task row BETWEEN two file rows is the whole point
  // of merging them onto one axis.
  const week2 = names.indexOf('Week 2 Notes.pdf');
  const manual = names.indexOf('Borrow the lab manual');
  const week1 = names.indexOf('Week 1 Notes.pdf');

  assert.ok(week2 !== -1 && manual !== -1 && week1 !== -1, names.join(', '));
  assert.ok(week2 < manual, 'the notes went up after the task was ticked off');
  assert.ok(manual < week1, 'and the task after the earlier notes');
  // Each task row says what happened and which list it happened in.
  assert.ok(rowLabels(response.body).includes('Finished'));
  assert.match(response.body, /<span class="stream__list-name [^"]*">School Tasks<\/span>/);
  assert.match(response.body, /href="\/tasks\/school-tasks"/);
});

test('stream: what is coming sits above the line, with the overdue against it', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  const coming = upcomingNames(response.body);

  // Fixture dues: the essay (+10d), the lab report (+18d), pond samples (+16d),
  // the bins (+2d) and the plants (-3d, i.e. overdue).
  assert.deepEqual(coming, [
    'Biology lab report',
    'Collect pond samples',
    'Write the Café history essay — 日本語 sources',
    'Take the bins out',
    'Water the plants',
  ]);
  // Furthest away at the top, so the soonest is nearest the line -- and the
  // overdue one is the last thing above it, in red.
  const overdue = response.body.indexOf('stream__day--overdue');
  const today = response.body.indexOf('id="today"');
  assert.ok(overdue !== -1 && overdue < today, 'the Overdue heading is above the Today line');
  assert.match(response.body, /stream__item--overdue/);
  assert.ok(rowLabels(response.body).some((label) => label.startsWith('Was due')));

  // A cancelled chore is dated in the future and still says nothing.
  assert.ok(!coming.includes('Clear out the shed'));
  assert.ok(!rowNames(response.body).includes('Clear out the shed'));
});

test('stream: the tasks with no due date are counted, and link to Tasks', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  // Read chapter 4, Return the library book, Draw the graphs, Empty the
  // dishwasher: four open tasks with nowhere on a time axis to be.
  assert.match(
    response.body,
    /<p class="stream__undated"><a href="\/tasks">Also 4 tasks without a due date<\/a><\/p>/
  );
  // And it sits above the line, where the block above it ends.
  assert.ok(response.body.indexOf('stream__undated') < response.body.indexOf('id="today"'));
});

test('stream: the same task is not announced twice, however often she looks', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir, streamCache: createTtlCache({ ttlMs: 0 }) });
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  const added = historyNames(first.body).filter((name) => name === 'Read chapter 4');
  assert.equal(added.length, 1, 'a first sighting is one Added row');

  // The ledger has it now, and the row is still there, still dated by the
  // task's own stamp -- a row that appeared once and vanished would be worse
  // than no row at all.
  const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.deepEqual(
    historyNames(again.body).filter((name) => name === 'Read chapter 4'),
    ['Read chapter 4']
  );
  assert.deepEqual(historyNames(again.body), historyNames(first.body));

  // And it was written down, not re-derived: one entry per task, keyed by
  // calendar and UID.
  const ledger = JSON.parse(readFileSync(join(dir, 'tasks-seen.json'), 'utf8'));
  assert.ok(ledger['school-tasks|task-read'], Object.keys(ledger).join(', '));
  assert.ok(!('chores|chore-shed' in ledger), 'a cancelled task is not even remembered');
});

test('stream: editing a task turns into one Changed row on the next load', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();
  const app = await boot({ baseUrl: url, dir, streamCache: createTtlCache({ ttlMs: 0 }) });
  const session = await login(app);

  await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.ok(!rowLabels((await app.inject({ url: '/', headers: { cookie: session.cookie } })).body).includes('Changed'));

  // The owner rewrites a task in the Android app: the resource's bytes change,
  // so its ETag moves and its DTSTAMP is bumped.
  mock.setCalendars(editedChores());
  clearTaskCache();

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  const labels = rowLabels(response.body);
  assert.equal(labels.filter((label) => label === 'Changed').length, 1, labels.join(', '));
  assert.match(response.body, /<span class="stream__name">Empty the dishwasher<\/span>/);
});

// --- The task half is best-effort ------------------------------------------

test('stream: one unreadable task list costs that list, and says so once', async () => {
  const dir = dataDir();
  const logged = [];
  const { url } = await bootMock({ failCalendar: 'chores' });
  const app = await boot({ baseUrl: url, dir, streamCache: createTtlCache({ ttlMs: 0 }), logged });
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(first.statusCode, 200, 'a broken list is not a broken page');
  const names = rowNames(first.body);
  assert.ok(names.includes('microscope.jpg'), 'the files are all there');
  assert.ok(names.includes('Write the Café history essay — 日本語 sources'), 'and so is the list that works');
  assert.ok(!names.includes('Take the bins out'), 'the one that does not is simply absent');
  // No caveat line: we know what lists exist, and all but one answered.
  assert.doesNotMatch(first.body, /Tasks couldn’t be checked/);

  // She reloads. The complaint is not repeated -- one broken list must not
  // write a line into the log on every page load for a week.
  await app.inject({ url: '/', headers: { cookie: session.cookie } });
  const complaints = logged.filter((line) => /could not read a task list/.test(line.msg));
  assert.equal(complaints.length, 1, `logged once, not ${complaints.length} times`);
  assert.equal(complaints[0].list, 'chores', 'and it names the list');
});

test('stream: no task lists at all leaves a quiet line, not an error page', async () => {
  const dir = dataDir();
  // The calendar home itself refuses: an upgrade in progress, a broken
  // files_sharing, anything. We do not even know what lists exist.
  const { url } = await bootMock({ calendarHomeStatus: 500 });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Tasks couldn’t be checked just now\./);
  assert.ok(rowNames(response.body).includes('microscope.jpg'), 'the file half is untouched');
  // And nothing was written down about tasks we never saw.
  assert.equal(existsSync(join(dir, 'tasks-seen.json')), false);
});

test('stream: skeleton content never reaches the page, however recently it changed', async () => {
  // Photos/Frog.jpg is stamped as recently as the newest real share, on purpose.
  // With no date filter left to hide behind, ownership is the only thing keeping
  // the viewer account's own content off the page she reads first.
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  for (const skeleton of ['Frog.jpg', 'Example.md', 'Letter.odt', 'Nextcloud Manual.pdf']) {
    assert.ok(!rowNames(response.body).includes(skeleton), `${skeleton} is not a share`);
  }
});

test('stream: a file we cannot open inline is a row, but not a link', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.ok(rowNames(response.body).includes('welcome.txt'));
  assert.match(response.body, /stream__row--static/);
  // And a scripted SVG is never linked from here either -- same rule as a tile.
  assert.doesNotMatch(response.body, /href="\/view\/[^"]*mitosis\.svg"/);
});

// --- Badges -----------------------------------------------------------------

test('stream: a first-ever visit gets the list, with nothing badged and no note', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.ok(rowNames(response.body).length > 3, 'the list is the point of the page');
  assert.deepEqual(badgedNames(response.body), [], 'nothing to compare against yet');
  assert.doesNotMatch(response.body, /You were last here/);
});

test('stream: after a few days away, the badges land on what changed since', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(badgedFileNames(response.body), RECENT_FILES);
  assert.match(response.body, /You were last here on \w{3}, Aug \d/);
  assert.match(response.body, /Newer things are marked New/);
  // The rest of the history is there, unbadged.
  assert.ok(rowNames(response.body).length > RECENT_FILES.length);

  // The badge rule reads `at` and nothing else, so a task ticked off since that
  // sitting is badged exactly like a file touched since it -- and one finished
  // the day before it is not.
  const badged = badgedNames(response.body);
  assert.ok(badged.includes('Buy a lab notebook'), 'finished on the 7th, after the sitting');
  assert.ok(!badged.includes('Hand in the permission slip'), 'finished on the 1st, before it');
});

test('stream: refreshing mid-sitting leaves the badges exactly where they were', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.deepEqual(badgedFileNames(first.body), RECENT_FILES);

  // The single most likely thing she does next. The baseline must not move --
  // that is the whole reason a visit is a sitting rather than a page load.
  for (let i = 0; i < 2; i += 1) {
    const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
    assert.deepEqual(badgedFileNames(again.body), RECENT_FILES, `refresh ${i + 1}`);
  }
  assert.equal(readState(dir).mom.previousVisitStartedAt, LAST_VISIT);
});

test('stream: browsing files or tasks does not spend the baseline', async () => {
  const dir = dataDir();
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });

  backdate(dir, LAST_VISIT);
  const session = await login(app);

  await app.inject({ url: '/', headers: { cookie: session.cookie } });
  const rotated = readState(dir).mom.currentVisitStartedAt;

  for (const path of ['/files', '/files/Biology%20101', '/tasks']) {
    const response = await app.inject({ url: path, headers: { cookie: session.cookie } });
    assert.equal(response.statusCode, 200, path);
  }

  const state = readState(dir);
  assert.equal(state.mom.previousVisitStartedAt, LAST_VISIT, 'still the same baseline');
  assert.equal(state.mom.currentVisitStartedAt, rotated, 'and the same sitting');
});

// --- Failure policy ---------------------------------------------------------

test('stream: an unreachable Nextcloud reaches the error page, not an empty list', async () => {
  const dir = dataDir();
  const { url } = await bootMock();

  const working = await boot({ baseUrl: url, dir });
  // Nothing is listening here, so every upstream request fails immediately.
  const broken = await boot({ baseUrl: 'http://127.0.0.1:1', dir });

  // She has been away for days: this is the sitting the badges will be measured
  // against, and the one a failed load must not throw away.
  backdate(dir, LAST_VISIT);

  const brokenSession = await login(broken);
  const failed = await broken.inject({ url: '/', headers: { cookie: brokenSession.cookie } });

  // 503 + the "file server is taking a break" page. The policy this asserts is
  // the one that changed with the stream: rendering an empty page would tell her
  // nothing had happened, about a lookup that never happened.
  assert.equal(failed.statusCode, 503);
  assert.match(failed.body, /taking a break/);
  assert.doesNotMatch(failed.body, /Nothing has changed yet/);
  assert.equal(
    readState(dir).mom.currentVisitStartedAt,
    LAST_VISIT,
    'a load that rendered nothing must leave state.json exactly as it was'
  );

  // She tries again when the network is back, and the badges are still right.
  const session = await login(working);
  const ok = await working.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(ok.statusCode, 200);
  assert.deepEqual(badgedFileNames(ok.body), RECENT_FILES);
  assert.equal(
    readState(dir).mom.previousVisitStartedAt,
    LAST_VISIT,
    'the successful load is the one that rotates'
  );
});

test('stream: an unreadable state file costs the badges and nothing else', async () => {
  const dir = dataDir();
  // A directory where state.json should be: every read AND write fails, which
  // no amount of retrying will fix.
  writeFileSync(join(dir, 'state.json.keep'), '');
  const { url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  // The store already survives an unreadable file by starting fresh, so the
  // observable promise is the simpler one: the list is never withheld because a
  // timestamp could not be read.
  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.ok(rowNames(response.body).length > 3);
});

// --- Cost of a refresh ------------------------------------------------------

test('stream: a burst of refreshes asks Nextcloud nothing new', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.ok(rowNames(first.body).includes('microscope.jpg'));
  assert.equal(countSearches(mock), 1);

  // Pull-to-refresh, twice, inside the cache window -- which is what the window
  // is for. The page must still be there, at no upstream cost.
  for (let i = 0; i < 2; i += 1) {
    const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
    assert.equal(again.statusCode, 200);
    assert.ok(rowNames(again.body).includes('microscope.jpg'));
  }

  assert.equal(
    countSearches(mock),
    1,
    'the same question, asked twice in a second, should not travel twice'
  );
});

test('stream: once the cache window passes, a fresh upload turns up', async () => {
  const dir = dataDir();
  const { mock, url } = await bootMock();

  // The question the stream asks never changes, so only the TTL can let a new
  // file through -- which is exactly the bug a keyed-but-never-expiring cache
  // would have: the first answer of the process would be the last one anybody
  // ever saw.
  let clock = 0;
  const app = await boot({
    baseUrl: url,
    dir,
    streamCache: createTtlCache({ ttlMs: 60_000, now: () => clock }),
  });
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.ok(!rowNames(first.body).includes('lab notebook.png'));
  assert.equal(countSearches(mock), 1);

  // The owner uploads something while she is still sitting there.
  const graph = resolveNode(DEFAULT_TREE, 'Math 210/graph sketch.png');
  mock.setTree({
    ...DEFAULT_TREE,
    'Math 210': {
      ...DEFAULT_TREE['Math 210'],
      children: {
        ...DEFAULT_TREE['Math 210'].children,
        'lab notebook.png': { ...graph, lastModified: NEWEST_LAST_MODIFIED },
      },
    },
  });

  // Still inside the window: she gets the remembered answer, upload and all.
  clock += 59_000;
  const stale = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.ok(!rowNames(stale.body).includes('lab notebook.png'));
  assert.equal(countSearches(mock), 1);

  // A minute later, the reload really asks again.
  clock += 1_000;
  const fresh = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(fresh.statusCode, 200);
  assert.equal(countSearches(mock), 2, 'the window expired, so the question is asked again');
  assert.ok(rowNames(fresh.body).includes('lab notebook.png'), 'and the new file is on the page');
});

// --- The walk fallback ------------------------------------------------------

/**
 * DEFAULT_TREE plus a branch buried deeper than the walk will ever descend, so
 * a fallback walk comes back `truncated` while SEARCH (depth infinity) does not.
 */
function treeWithBuriedUpload() {
  const pdf = resolveNode(DEFAULT_TREE, 'Biology 101/Lectures/Week 1 Notes.pdf');
  let node = {
    type: 'folder',
    children: { 'buried notes.pdf': { ...pdf, lastModified: NEWEST_LAST_MODIFIED } },
  };
  for (let i = 0; i < WALK_MAX_DEPTH; i += 1) {
    node = { type: 'folder', children: { [`level ${i}`]: node } };
  }
  // Marked as shared like every other real top-level entry -- otherwise the
  // walk fallback prunes it as skeleton content before ever reaching the
  // depth this test exists to hit. See src/nextcloud/shares.js.
  return { ...DEFAULT_TREE, Deep: { ...node, sharedBy: SHARE_OWNER } };
}

test('stream: a truncated walk still renders, and says the history goes further back', async () => {
  const dir = dataDir();
  // 405 is the honest "we do not do SEARCH": structural, remembered for good.
  // From here on the walk is not a fallback, it is the strategy -- and on a
  // share deep enough to hit its bounds, EVERY answer it can give is truncated.
  // Refusing to remember those means the cache is never used at all on exactly
  // the instances that can least afford it: a whole tree walk on every
  // pull-to-refresh, for the page she opens the app on.
  const { mock, url } = await bootMock({ tree: treeWithBuriedUpload(), searchStatus: 405 });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const first = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(first.statusCode, 200, 'a walk that gave up early is not a failed page');
  assert.ok(rowNames(first.body).includes('microscope.jpg'), 'the walk found what it could reach');
  assert.match(first.body, /Older changes aren’t listed here\./);
  const walked = countPropfinds(mock);
  assert.ok(walked > 2, `the first load really walked the tree (${walked} PROPFINDs)`);

  const again = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(again.statusCode, 200);
  assert.ok(rowNames(again.body).includes('microscope.jpg'), 'the page is still there');
  assert.equal(
    countPropfinds(mock) - walked,
    0,
    'and it cost nothing: the answer was remembered, and the stream needs no folder listing'
  );
  assert.equal(countSearches(mock), 1, 'a settled instance never probes SEARCH again either');
});

test('stream: a truncated answer from a one-off walk is not cached, so SEARCH replaces it', async () => {
  const dir = dataDir();
  // The other half of the pair. SEARCH is having a bad minute -- transient, so
  // the instance is NOT demoted and the next load tries it again. The walk here
  // is a stand-in, not the strategy, so its half-answer must not be held on to.
  const { mock, url } = await bootMock({ tree: treeWithBuriedUpload(), searchStatus: 502 });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const degraded = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(degraded.statusCode, 200);
  assert.ok(rowNames(degraded.body).includes('microscope.jpg'), 'the walk finds what it can reach');
  assert.ok(!rowNames(degraded.body).includes('buried notes.pdf'), 'and gives up before the deep branch');
  assert.match(degraded.body, /Older changes aren/, 'a truncated list says so');

  // SEARCH recovers. Had the half-answer been cached, this load would have
  // served it from memory and the deep file would stay invisible for the rest
  // of the window -- for exactly as long as it is worth re-asking.
  mock.setSearchStatus(null);

  const healthy = await app.inject({ url: '/', headers: { cookie: session.cookie } });
  assert.equal(healthy.statusCode, 200);
  assert.ok(rowNames(healthy.body).includes('buried notes.pdf'), 'the full answer replaces the degraded one');
  assert.doesNotMatch(healthy.body, /Older changes aren/);
});

test('stream: a truncated walk that found nothing does not claim nothing changed', async () => {
  // The two lines contradict each other, and only one of them is a claim this
  // lookup can make: whole subtrees went unvisited, so "nothing has changed
  // yet" is exactly what we do not know.
  const skeletonOnly = Object.fromEntries(
    Object.entries(DEFAULT_TREE).filter(([, node]) => !node.sharedBy)
  );
  const buried = { type: 'folder', children: {} };
  let node = buried;
  for (let i = 0; i < WALK_MAX_DEPTH + 1; i += 1) {
    node = { type: 'folder', children: { [`level ${i}`]: node } };
  }

  const dir = dataDir();
  const { url } = await bootMock({
    tree: { ...skeletonOnly, Deep: { ...node, sharedBy: SHARE_OWNER } },
    searchStatus: 405,
  });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Older changes aren’t listed here\./);
  assert.doesNotMatch(response.body, /Nothing has changed yet/);
});

// --- The empty case ---------------------------------------------------------

test('stream: an account with nothing shared says nothing has changed, and means it', async () => {
  const skeletonOnly = Object.fromEntries(
    Object.entries(DEFAULT_TREE).filter(([, node]) => !node.sharedBy)
  );

  const dir = dataDir();
  // Nothing shared at all: no folders, and no task lists either. With a list
  // shared there would be task rows, and "nothing has changed" would be false.
  const { url } = await bootMock({ tree: skeletonOnly, calendars: [] });
  const app = await boot({ baseUrl: url, dir });
  const session = await login(app);

  const response = await app.inject({ url: '/', headers: { cookie: session.cookie } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(rowNames(response.body), []);
  assert.match(response.body, /Nothing has changed yet/);
  // Still a Today line, so the page has a shape and an anchor either way.
  assert.match(response.body, /id="today"/);
});
