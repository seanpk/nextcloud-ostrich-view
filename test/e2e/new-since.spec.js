import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, login } from './fixtures.js';

/**
 * "New since you last looked", walked as Mom would.
 *
 * Simulating a second visit means reaching into `data/state.json` -- the same
 * file the app writes -- and backdating a viewer's current sitting so the next
 * home load rotates it into `previous`. That is the honest lever: no test-only
 * route, no clock injection, exactly the file an operator would edit. The
 * directory comes from OSTRICH_DATA_DIR, which global-setup exports.
 *
 * The backdated viewer is `nana`, used by nothing else in the suite, so this
 * edit cannot disturb another spec's idea of when it last visited.
 */

const NANA = 'sunny meadow';
/** After the fixture tree's baseline stamp, before its two "recent" files. */
const LAST_VISIT = '2025-08-05T00:00:00.000Z';

/** The two files the fixture marks as touched since LAST_VISIT. */
const NEW_FILES = ['microscope.jpg', 'Week 2 Notes.pdf'];

function statePath() {
  const dir = process.env.OSTRICH_DATA_DIR;
  if (!dir) throw new Error('OSTRICH_DATA_DIR is unset -- did global setup run?');
  return join(dir, 'state.json');
}

/**
 * Backdate one viewer's sitting, leaving every other viewer's record alone.
 * `previousVisitStartedAt` is deliberately left empty: the rotation on the next
 * home load is what has to produce it.
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

test.describe('New since you last looked', () => {
  test('a first-ever visit shows no such section', async ({ page }) => {
    await login(page);

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hello, Mom');
    // Nothing to compare against yet -- and "everything the owner ever shared" is
    // not news, so the section stays away entirely.
    await expect(page.locator('.section--new')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible();
  });

  test('coming back days later shows what changed, with folder labels', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);

    const section = page.locator('.section--new');
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading')).toHaveText('New since you last looked');
    // And when "last time" was, in words.
    // "on Mon, Aug 4" / "on Mon, Aug 4, 2025" -- the day is read in the server's
    // zone, and the year only appears once it differs from this one.
    await expect(section.locator('.section__note')).toContainText(
      /You were last here on \w{3}, Aug \d+/
    );

    for (const name of NEW_FILES) {
      await expect(section.locator('.tile__name', { hasText: name })).toBeVisible();
    }
    // Newest first: the photo was touched after the lecture notes.
    const names = await section.locator('.tile__name').allTextContents();
    expect(names[0]).toBe('microscope.jpg');

    // The muted line says where each file lives, since these tiles are shown
    // out of their folders.
    const photo = section.locator('.tiles__item', { hasText: 'microscope.jpg' });
    await expect(photo.locator('.tile__meta--folder')).toHaveText('in Biology 101 › Lab Reports');
    const notes = section.locator('.tiles__item', { hasText: 'Week 2 Notes.pdf' });
    await expect(notes.locator('.tile__meta--folder')).toHaveText('in Biology 101 › Lectures');

    // The folder buttons are still underneath, unchanged. (Exact: a new-since
    // tile's accessible name now ends with "in Biology 101 › …" too.)
    await expect(page.getByRole('link', { name: 'Biology 101', exact: true })).toBeVisible();

    // Photos/Frog.jpg is stamped just as recently, but it is the account's own
    // skeleton content (see test/mock-nextcloud/tree.js), never a real share --
    // it must not sneak into the one section she is most likely to actually read.
    await expect(section.locator('.tile__name', { hasText: 'Frog.jpg' })).toHaveCount(0);
  });

  test('the new photo shows a real thumbnail, and the PDF its icon', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);

    const section = page.locator('.section--new');
    const preview = section.locator('.tiles__item', { hasText: 'microscope.jpg' }).locator('.tile__preview');

    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('src', /^\/preview\/\d+\?v=/);
    await expect(preview).toHaveAttribute('alt', 'Preview of microscope.jpg');
    // It really loaded, rather than sitting there broken.
    await expect
      .poll(() => preview.evaluate((img) => img.naturalWidth))
      .toBeGreaterThan(0);

    // Nextcloud renders no PDF thumbnails by default; the tile says so calmly.
    const icon = section.locator('.tiles__item', { hasText: 'Week 2 Notes.pdf' }).locator('.tile__icon');
    await expect(icon).toHaveAttribute('src', '/public/icons/pdf.svg');
  });

  test('tapping a new file opens it inline, where it lives', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);

    await page
      .locator('.section--new')
      .getByRole('link', { name: /microscope\.jpg/ })
      .click();

    await expect(page).toHaveURL(/\/view\/Biology%20101\/Lab%20Reports\/microscope\.jpg$/);
    const image = page.locator('.viewer__image');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

    // Back leads into the file's own folder -- she arrived by shortcut, but she
    // is not stranded in one.
    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(/\/files\/Biology%20101\/Lab%20Reports$/);
  });

  test('refreshing mid-sitting does not empty the list', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);
    await expect(page.locator('.section--new')).toBeVisible();

    // The single most likely thing she does next.
    await page.reload();
    await expect(page.locator('.section--new')).toBeVisible();
    await expect(page.locator('.section--new .tile__name').first()).toBeVisible();

    // And again after wandering off into a folder and back.
    await page.getByRole('link', { name: 'Math 210' }).click();
    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page.locator('.section--new')).toBeVisible();
  });

  test('the section fits a phone screen without sideways scrolling', async ({ page }) => {
    backdateVisit('nana', LAST_VISIT);
    await login(page, NANA);
    await expect(page.locator('.section--new')).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // Same 44px floor as everything else she has to hit with a thumb.
    const tiles = page.locator('.section--new a.tile');
    const count = await tiles.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await tiles.nth(i).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });
});
