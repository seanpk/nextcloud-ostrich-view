import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, login } from './fixtures.js';

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

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hello, Mom');

    // The whole recent history, not a slice of it: the two recently-touched
    // files lead, and the older ones are underneath rather than hidden.
    const names = await page.locator('.stream__name').allTextContents();
    expect(names.slice(0, 2)).toEqual(NEW_FILES);
    expect(names).toContain('Week 1 Notes.pdf');
    expect(names.length).toBeGreaterThan(NEW_FILES.length);

    // Grouped by day, with the Today line that /#today points at.
    await expect(page.locator('#today')).toHaveText('Today');
    const days = await page.locator('.stream__day').allTextContents();
    expect(days[0]).toBe('Today');
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

    const badged = page.locator('.stream__item--new');
    await expect(badged).toHaveCount(NEW_FILES.length);
    expect(await badged.locator('.stream__name').allTextContents()).toEqual(NEW_FILES);
    for (const row of await badged.all()) {
      await expect(row.locator('.stream__badge')).toHaveText('New');
    }

    // And the rest of the history is right there, just unmarked.
    const plain = page.locator('.stream__item:not(.stream__item--new)');
    expect(await plain.count()).toBeGreaterThan(0);
    await expect(plain.locator('.stream__badge')).toHaveCount(0);
  });

  test('refreshing mid-sitting keeps the badges exactly where they were', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);
    await expect(page.locator('.stream__item--new')).toHaveCount(NEW_FILES.length);

    // The single most likely thing she does next.
    await page.reload();
    await expect(page.locator('.stream__item--new')).toHaveCount(NEW_FILES.length);

    // And again after wandering off into Files and back.
    await page.locator('.toggle').getByRole('link', { name: 'Files' }).click();
    await page.getByRole('link', { name: 'Math 210' }).click();
    await page.locator('.toggle').getByRole('link', { name: 'Latest' }).click();
    await expect(page.locator('.stream__item--new')).toHaveCount(NEW_FILES.length);
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
