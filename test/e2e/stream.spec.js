import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { test, expect, login } from './fixtures.js';
import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createMockNextcloud, TEST_APP_PASSWORD, TEST_USER } from '../mock-nextcloud/index.js';

/**
 * Latest -- the page she lands on -- walked as Mom would.
 *
 * Simulating a second visit means reaching into `data/state.json` -- the same
 * file the app writes -- and backdating a viewer's current sitting so the next
 * stream load rotates it into `previous`. That is the honest lever: no
 * test-only route, no clock injection, exactly the file an operator would edit.
 * The directory comes from OSTRICH_DATA_DIR, which global-setup exports.
 *
 * The backdated viewer is `nana`, used by nothing else in the suite, so this
 * edit cannot disturb another spec's idea of when it last visited.
 */

const NANA = 'sunny meadow';
/** After the fixture tree's baseline stamp, before its two "recent" files. */
const LAST_VISIT = '2025-08-05T00:00:00.000Z';

/** The two files the fixture marks as touched since LAST_VISIT, newest first. */
const NEW_FILES = ['microscope.jpg', 'Week 2 Notes.pdf'];

/** File rows only -- the page's rows are files and tasks now. */
const FILE_ROW = '.stream__row:not(.stream__row--task)';

/** Where a row (or a heading) sits down the page. */
async function topOf(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('that row is not on the page');
  return box.y;
}

function statePath() {
  const dir = process.env.OSTRICH_DATA_DIR;
  if (!dir) throw new Error('OSTRICH_DATA_DIR is unset -- did global setup run?');
  return join(dir, 'state.json');
}

/**
 * Backdate one viewer's sitting, leaving every other viewer's record alone.
 * `previousVisitStartedAt` is deliberately left empty: the rotation on the next
 * stream load is what has to produce it.
 */
function backdateVisit(viewerName, startedAt) {
  const path = statePath();

  let state = {};
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // No file yet (or mid-write): starting from an empty object is correct.
  }

  state[viewerName] = { currentVisitStartedAt: startedAt, previousVisitStartedAt: null };
  writeFileSync(path, JSON.stringify(state, null, 2));
}

test.describe('Latest', () => {
  test('landing on it shows the recent history, newest first', async ({ page }) => {
    await login(page);

    await expect(page).toHaveURL(/\/#today$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hello, Mom');

    // The whole recent history, not a slice of it: the two recently-touched
    // files lead the file rows, and the older ones are underneath rather than
    // hidden.
    const names = await page.locator(`${FILE_ROW} .stream__name`).allTextContents();
    expect(names.slice(0, 2)).toEqual(NEW_FILES);
    expect(names).toContain('Week 1 Notes.pdf');
    expect(names.length).toBeGreaterThan(NEW_FILES.length);

    // Grouped by day, with the Today line that /#today points at -- and, since
    // the household has tasks due, day groups above it as well.
    await expect(page.locator('#today')).toHaveText('Today');
    const days = await page.locator('.stream__day').allTextContents();
    expect(days).toContain('Today');
    expect(days.length).toBeGreaterThan(1);

    // Each row says where the file lives and when it changed.
    const photo = page.locator('.stream__item', { hasText: 'microscope.jpg' });
    await expect(photo.locator('.stream__where')).toHaveText('in Biology 101 › Lab Reports');
    await expect(photo.locator('.stream__time')).toHaveText(/^\d{1,2}:\d{2} (AM|PM)$/);

    // Photos/Frog.jpg is stamped just as recently, but it is the account's own
    // skeleton content (see test/mock-nextcloud/tree.js), never a real share --
    // and with no date filter left, ownership is the only thing keeping it off
    // the page she reads first.
    expect(names).not.toContain('Frog.jpg');
  });

  test('a first-ever visit gets the list, with no badges and no note', async ({ page }) => {
    await login(page);

    // Nothing to compare against yet -- and forty New badges on a first load is
    // noise, not news. The list is still the list, which is the whole change.
    await expect(page.locator('.stream__badge')).toHaveCount(0);
    await expect(page.getByText('You were last here')).toHaveCount(0);
    await expect(page.locator('.stream__name').first()).toBeVisible();
  });

  test('coming back days later badges what changed since, and says when that was', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);

    // "on Mon, Aug 4" / "on Mon, Aug 4, 2025" -- the day is read in the
    // server's zone, and the year only appears once it differs from this one.
    await expect(page.locator('.section__note')).toContainText(
      /You were last here on \w{3}, Aug \d+/
    );
    await expect(page.locator('.section__note')).toContainText('Newer things are marked New');

    const badgedFiles = page.locator(`.stream__item--new ${FILE_ROW}`);
    await expect(badgedFiles).toHaveCount(NEW_FILES.length);
    expect(await badgedFiles.locator('.stream__name').allTextContents()).toEqual(NEW_FILES);
    for (const row of await badgedFiles.all()) {
      await expect(row.locator('.stream__badge')).toHaveText('New');
    }

    // The badge rule reads a row's time and nothing else, so a task ticked off
    // since that sitting is badged just like a file touched since it.
    const notebook = page.locator('.stream__item', { hasText: 'Buy a lab notebook' });
    await expect(notebook).toHaveClass(/stream__item--new/);

    // And the rest of the history is right there, just unmarked.
    const plain = page.locator('.stream__item:not(.stream__item--new)');
    expect(await plain.count()).toBeGreaterThan(0);
    await expect(plain.locator('.stream__badge')).toHaveCount(0);
  });

  test('refreshing mid-sitting keeps the badges exactly where they were', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);
    const badgedFiles = page.locator(`.stream__item--new ${FILE_ROW}`);
    await expect(badgedFiles).toHaveCount(NEW_FILES.length);

    // The single most likely thing she does next.
    await page.reload();
    await expect(badgedFiles).toHaveCount(NEW_FILES.length);

    // And again after wandering off into Files and back.
    await page.locator('.toggle').getByRole('link', { name: 'Files' }).click();
    await page.getByRole('link', { name: 'Math 210' }).click();
    await page.locator('.toggle').getByRole('link', { name: 'Latest' }).click();
    await expect(badgedFiles).toHaveCount(NEW_FILES.length);
  });

  test('the new photo and the new PDF both show a real thumbnail', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);

    for (const name of NEW_FILES) {
      const preview = page.locator('.stream__item', { hasText: name }).locator('.stream__preview');

      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute('src', /^\/preview\/\d+\?v=/);
      await expect(preview).toHaveAttribute('alt', `Preview of ${name}`);
      // It really loaded, rather than sitting there broken. This E2E run's
      // mock doesn't simulate Imaginary (see browse.spec.js), so the PDF's
      // "real thumbnail" here is the icon it was redirected to -- the point
      // of this test is that BOTH kinds ask for a preview and BOTH end up
      // showing something, not that the bytes came from a PDF rasterizer.
      await preview.scrollIntoViewIfNeeded();
      await expect
        .poll(() => preview.evaluate((img) => img.naturalWidth), { timeout: 10_000 })
        .toBeGreaterThan(0);
    }
  });

  test('a file we cannot open inline is a row, not a button', async ({ page }) => {
    await login(page);

    const row = page.locator('.stream__item', { hasText: 'welcome.txt' });
    await expect(row.locator('.stream__row--static')).toBeVisible();
    await expect(row.locator('a')).toHaveCount(0);
  });

  test('tapping a row opens the file inline, where it lives', async ({ page }) => {
    await login(page);

    await page.getByRole('link', { name: /microscope\.jpg/ }).click();

    await expect(page).toHaveURL(/\/view\/Biology%20101\/Lab%20Reports\/microscope\.jpg$/);
    const image = page.locator('.viewer__image');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

    // Back leads into the file's own folder -- she arrived by shortcut, but she
    // is not stranded in one.
    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(/\/files\/Biology%20101\/Lab%20Reports$/);
  });

  test('there is nowhere to go back to, and no breadcrumb', async ({ page }) => {
    await login(page);

    await expect(page.locator('.back')).toHaveCount(0);
    await expect(page.locator('.crumbs')).toHaveCount(0);
  });

  test('a finished task is a row between the file rows, in time order', async ({ page }) => {
    await login(page);

    // The fixture puts the lab manual's completion at 14:00 on the 6th, between
    // the Week 2 notes that evening and the Week 1 notes two days earlier (see
    // test/mock-nextcloud/calendars.js). One axis, two sources.
    const week2 = page.locator('.stream__item', { hasText: 'Week 2 Notes.pdf' });
    // The manual has two rows of its own -- it was added on the 3rd and
    // finished on the 6th, which is two things that happened -- so the label
    // picks out the one this test is about.
    const manual = page
      .locator('.stream__item', { hasText: 'Borrow the lab manual' })
      .filter({ hasText: 'Finished' });
    const week1 = page.locator('.stream__item', { hasText: 'Week 1 Notes.pdf' });

    expect(await topOf(week2)).toBeLessThan(await topOf(manual));
    expect(await topOf(manual)).toBeLessThan(await topOf(week1));

    // It says what happened, which list it happened in, and what time.
    await expect(manual.locator('.stream__what')).toHaveText('Finished');
    await expect(manual.locator('.stream__list-name')).toHaveText('School Tasks');
    await expect(manual.locator('.stream__time')).toHaveText(/^\d{1,2}:\d{2} (AM|PM)$/);
    // And tapping it opens the list, the only place a task is shown in full.
    await manual.locator('a').click();
    await expect(page).toHaveURL(/\/tasks\/school-tasks$/);
  });

  test('what is coming sits above Today, with the overdue right against the line', async ({
    page,
  }) => {
    await login(page);

    const line = await topOf(page.locator('#today'));
    const soonest = page.locator('.stream__item', { hasText: 'Take the bins out' }).first();
    const furthest = page.locator('.stream__item', { hasText: 'Biology lab report' }).first();
    const overdue = page.locator('.stream__item--overdue').first();

    // Furthest away at the top, soonest nearest the line, late against it.
    expect(await topOf(furthest)).toBeLessThan(await topOf(soonest));
    expect(await topOf(soonest)).toBeLessThan(await topOf(overdue));
    expect(await topOf(overdue)).toBeLessThan(line);

    // Overdue in red -- and saying so in words, which is what carries the
    // meaning for anyone who cannot see the colour.
    await expect(overdue.locator('.stream__what')).toHaveText(/^Was due /);
    const heading = page.locator('.stream__day--overdue');
    await expect(heading).toHaveText('Overdue');
    // Polled rather than read once: a computed colour is only the real one once
    // the stylesheet has actually applied, and nothing else on the page waits
    // for that.
    await expect
      .poll(async () => {
        const ink = await heading.evaluate((el) => getComputedStyle(el).color);
        const [r, g, b] = ink.match(/\d+/g).map(Number);
        return r > g + 40 && r > b + 40;
      })
      .toBe(true);

    // A cancelled chore is dated in the future and still says nothing.
    await expect(page.getByText('Clear out the shed')).toHaveCount(0);
  });

  test('the tasks with no due date are one line, and it goes to Tasks', async ({ page }) => {
    await login(page);

    const undated = page.locator('.stream__undated a');
    await expect(undated).toHaveText(/^Also \d+ tasks? without a due date$/);
    // Immediately above the line: they are not on the axis, so this is as close
    // to "now" as they can honestly get.
    expect(await topOf(undated)).toBeLessThan(await topOf(page.locator('#today')));

    await undated.click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole('link', { name: 'School Tasks' })).toBeVisible();
  });

  test('#today is not hidden under the fixed top bar', async ({ page }) => {
    // The anchor is the whole mechanism -- there is no JavaScript on this page
    // -- so the one thing that can break it is scroll-margin-top.
    await login(page);
    await page.goto('/#today');

    const today = page.locator('#today');
    await expect(today).toBeInViewport();

    const clear = await page.evaluate(() => {
      const heading = document.querySelector('#today');
      const bar = document.querySelector('.topbar');
      return heading.getBoundingClientRect().top - bar.getBoundingClientRect().bottom;
    });
    expect(clear, 'the Today line must sit below the fixed bar, not under it').toBeGreaterThanOrEqual(0);
  });

  test('the page fits a phone screen, with rows you can hit with a thumb', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);
    await expect(page.locator('.stream__name').first()).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // Same 44px floor as everything else she has to hit with a thumb.
    const rows = page.locator('a.stream__row');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await rows.nth(i).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });
});

/**
 * Landing on the line, with no JavaScript at all.
 *
 * `/#today` is not a nicety: the page has the future above the line and the
 * history below it, so arriving anywhere else means arriving on next month's
 * chores. The anchor is the whole mechanism -- there is no script on this page
 * -- and this is the test that says so, by turning JavaScript off and checking
 * she still lands on Today.
 */
test.describe('Arriving on Today', () => {
  test.use({ javaScriptEnabled: false });

  test('signing in puts the Today line in the viewport, script or no script', async ({ page }) => {
    await login(page);

    await expect(page).toHaveURL(/\/#today$/);
    const today = page.locator('#today');
    await expect(today).toHaveText('Today');
    await expect(today).toBeInViewport();

    // There really is a page above it to have scrolled past: the block of
    // what is coming.
    const line = (await today.boundingBox()).y;
    const first = (await page.locator('.stream__item').first().boundingBox()).y;
    expect(first, 'the future block sits above the line she landed on').toBeLessThan(line);

    // And the fixed bar is not sitting on top of the line (scroll-margin-top).
    // Measured with boundingBox rather than page.evaluate: running script in
    // the page would be an odd way to test the page that has none.
    const bar = await page.locator('.topbar').boundingBox();
    expect(line).toBeGreaterThanOrEqual(bar.y + bar.height);
  });
});

/**
 * One task list that will not answer.
 *
 * The stream is the app's front door, so a broken share, a Nextcloud mid-
 * upgrade or a calendar Sabre trips over must cost that list and nothing else.
 * It needs its own Nextcloud (the suite's mock answers everything), so this
 * block boots a second stack of its own -- the real app, the real templates,
 * one REPORT wired to fail.
 */
test.describe('When a task list is broken', () => {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  let mock;
  let app;
  let dataDir;
  let base;

  test.beforeAll(async () => {
    mock = createMockNextcloud({ failCalendar: 'chores' });
    const { url: mockUrl } = await mock.start();
    dataDir = mkdtempSync(join(tmpdir(), 'ostrich-e2e-broken-'));

    app = await buildApp({
      config: loadConfig({
        NC_BASE_URL: mockUrl,
        NC_USER: TEST_USER,
        NC_APP_PASSWORD: TEST_APP_PASSWORD,
        SESSION_SECRET: 'c'.repeat(64),
        PORT: '0',
        HOST: '127.0.0.1',
        VIEWERS_FILE: join(HERE, 'viewers.test.json'),
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
      }),
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${app.server.address().port}`;
  });

  test.afterAll(async () => {
    await app?.close();
    await mock?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('the page still comes up, with the files and the lists that do answer', async ({ page }) => {
    await page.goto(`${base}/login`);
    await page.getByLabel('Your passphrase').fill('correct horse');
    await page.getByRole('button', { name: 'Enter' }).click();

    await expect(page).toHaveURL(/\/#today$/);
    await expect(page.locator('#today')).toHaveText('Today');

    // The files are all there, and so is the list that works.
    await expect(page.locator('.stream__item', { hasText: 'microscope.jpg' })).toBeVisible();
    await expect(
      page.locator('.stream__list-name', { hasText: 'School Tasks' }).first()
    ).toBeVisible();

    // The broken one is simply absent -- no error page, no half-rendered row.
    await expect(page.getByText('Take the bins out')).toHaveCount(0);
    await expect(page.locator('.stream__list-name', { hasText: 'Chores' })).toHaveCount(0);
    // And no caveat line: we know which lists exist, and all but one answered.
    await expect(page.getByText('Tasks couldn’t be checked')).toHaveCount(0);
  });
});
