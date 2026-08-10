import { test, expect, login } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test.describe('Browsing folders', () => {
  test('tapping a folder shows what is inside it', async ({ page }) => {
    await page.getByRole('link', { name: 'Biology 101' }).click();

    await expect(page).toHaveURL(/\/files\/Biology%20101$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Biology 101');

    await expect(page.getByRole('link', { name: 'Lectures' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Lab Reports' })).toBeVisible();
    // M2: a PDF is something you can open, so its tile is a link now.
    await expect(page.getByRole('link', { name: /syllabus\.pdf/ })).toBeVisible();
  });

  test('the Back button returns to where you came from', async ({ page }) => {
    await page.getByRole('link', { name: 'Biology 101' }).click();
    await page.getByRole('link', { name: 'Lectures' }).click();

    await expect(page).toHaveURL(/\/files\/Biology%20101\/Lectures$/);
    await expect(page.locator('.tile__name').first()).toBeVisible();

    // Back goes up one level, not out of the app.
    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(/\/files\/Biology%20101$/);

    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('the Back button is present on every folder page and absent on home', async ({ page }) => {
    await expect(page.locator('.back'), 'no Back on home').toHaveCount(0);

    await page.getByRole('link', { name: 'Math 210' }).click();
    await expect(page.getByRole('link', { name: /Back/ })).toBeVisible();

    await page.getByRole('link', { name: 'Problem Sets' }).click();
    await expect(page.getByRole('link', { name: /Back/ })).toBeVisible();
  });

  test('a deep path shows the full breadcrumb, quietly', async ({ page }) => {
    await page.goto('/files/Biology%20101/Lectures');

    const crumbs = page.locator('.crumbs');
    await expect(crumbs).toBeVisible();
    await expect(crumbs).toContainText('Home');
    await expect(crumbs).toContainText('Biology 101');
    await expect(crumbs).toContainText('Lectures');

    // Crumbs are a hint, not a headline: smaller than the page title.
    const crumbSize = await crumbs.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const titleSize = await page
      .locator('.page__title')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(crumbSize).toBeLessThan(titleSize);

    // A crumb jumps straight up the tree.
    await crumbs.getByRole('link', { name: 'Biology 101' }).click();
    await expect(page).toHaveURL(/\/files\/Biology%20101$/);
  });

  test('home has no breadcrumb at all', async ({ page }) => {
    await expect(page.locator('.crumbs')).toHaveCount(0);
  });

  test('folders with spaces and accents work end to end', async ({ page }) => {
    await page.getByRole('link', { name: 'Café Notes' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Café Notes');
    await expect(page.getByRole('link', { name: /résumé draft\.pdf/ })).toBeVisible();
  });

  test('PDFs show an icon, not a thumbnail (Nextcloud renders no PDF previews)', async ({ page }) => {
    await page.getByRole('link', { name: 'Biology 101' }).click();

    const tile = page.locator('.tiles__item', { hasText: 'syllabus.pdf' });
    const icon = tile.locator('.tile__icon');

    await expect(icon).toHaveAttribute('src', '/public/icons/pdf.svg');
    // Decorative: the name next to it is what gets read out.
    await expect(icon).toHaveAttribute('alt', '');
    await expect(tile.locator('.tile__preview')).toHaveCount(0);
  });

  test('a file we cannot open inline stays a plain label, not a button', async ({ page }) => {
    const tile = page.locator('.tiles__item', { hasText: 'welcome.txt' });

    await expect(tile.locator('.tile--static')).toBeVisible();
    await expect(tile.locator('a')).toHaveCount(0);
  });

  test('a folder that does not exist gives a calm message, not a stack trace', async ({ page }) => {
    const response = await page.goto('/files/Not%20A%20Real%20Folder');

    expect(response.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found');
    await expect(page.locator('body')).not.toContainText(/at Object|node_modules|Error:/);
  });

  test('a traversal attempt is rejected rather than served', async ({ page }) => {
    const response = await page.goto('/files/..%2F..%2Fetc%2Fpasswd');

    expect(response.status()).toBeGreaterThanOrEqual(400);
    await expect(page.locator('body')).not.toContainText('root:');
  });

  test('/files with no path is just home', async ({ page }) => {
    await page.goto('/files');
    await expect(page).toHaveURL(/\/$/);
  });
});
