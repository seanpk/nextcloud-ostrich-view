import { test, expect, login } from './fixtures.js';

/**
 * Word documents on the page, and office files offered as themselves.
 *
 * The promise this suite holds to account is the reader's, not the
 * converter's: a `.docx` tile is tappable, tapping it puts the document's
 * words on screen large enough to read, Back still gets her out, and nothing
 * slides sideways under her thumb on a phone. The conversion itself -- and
 * every hostile-input case -- is pinned down in test/unit/office.test.js;
 * repeating that here would only be slower.
 *
 * The download assertions go through `page.request.get` rather than clicking,
 * because what matters is the response: a browser only saves a file when the
 * header says `attachment`, and a click would test Chromium's download
 * manager instead.
 */

const FOLDER = '/files/Biology%20101/Lectures';
const DOCX = '/view/Biology%20101/Lectures/Week%203%20Notes.docx';
const DOCX_BYTES = '/download/Biology%20101/Lectures/Week%203%20Notes.docx';
const XLSX = '/view/Biology%20101/Lectures/marks.xlsx';
const XLSX_BYTES = '/download/Biology%20101/Lectures/marks.xlsx';
const PDF_BYTES = '/download/Biology%20101/syllabus.pdf';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Every visible thing you can tap, as ux.spec.js counts them. */
const INTERACTIVE = 'a.tile, a.back, .btn, .footer__logout, .toggle__option';
const MIN_TAP = 44;

async function horizontalOverflow(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  return scrollWidth - clientWidth;
}

test.describe('Signed in', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // --- reading one --------------------------------------------------------

  test('tapping a Word document puts its words on the page', async ({ page }) => {
    await page.goto(FOLDER);
    await page.getByRole('link', { name: /Week 3 Notes\.docx/ }).click();

    await expect(page).toHaveURL(new RegExp(`${DOCX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    // The page's own title is the file name, as on every other viewer page.
    // The document's headings are preserved as the document wrote them, so
    // this page has the file name at the top and the document's own heading
    // structure underneath it.
    await expect(page.locator('h1.page__title')).toHaveText('Week 3 Notes.docx');

    const article = page.locator('article.document');
    await expect(article).toBeVisible();
    // The document's own heading, converted from the .docx rather than named
    // by us -- the one assertion that could only pass if mammoth really ran.
    await expect(article.getByRole('heading', { name: 'Week 3 — Photosynthesis' })).toBeVisible();
    await expect(article).toContainText('The Calvin cycle happens in the stroma');
    await expect(article.locator('li')).toHaveCount(3);
    await expect(article.locator('table td').first()).toHaveText('Pigment');

    // The embedded picture arrived as an inline data: URI and really decoded.
    const picture = article.locator('img');
    await expect(picture).toHaveAttribute('alt', /chloroplast/);
    await expect.poll(() => picture.evaluate((img) => img.naturalWidth)).toBe(8);

    // ...and nothing scripted came with it.
    await expect(page.locator('article.document script, article.document iframe')).toHaveCount(0);
  });

  test('the document page keeps Back reachable and never scrolls sideways', async ({ page }) => {
    await page.goto(DOCX);
    await expect(page.locator('article.document')).toBeVisible();

    await expect(page.getByRole('link', { name: /Back/ })).toBeInViewport();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(new RegExp(`${FOLDER}$`));
  });

  test('the document is a scrolling page, not the full-screen viewer', async ({ page }) => {
    await page.goto(DOCX);

    // A photo or a PDF clears the chrome away; a document is read the way any
    // web page is, with the top bar and the section toggle still there.
    await expect(page.locator('body')).not.toHaveClass(/is-viewer/);
    await expect(page.locator('.viewer__fs')).toHaveCount(0);
    await expect(page.locator('.toggle')).toBeVisible();
  });

  test('the document text is large enough to read without pinch-zooming', async ({ page }) => {
    await page.goto(DOCX);

    const size = await page
      .locator('article.document p')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    expect(size).toBeGreaterThanOrEqual(18);
  });

  test('a wide table scrolls inside its own box, not the whole page', async ({ page }) => {
    await page.goto(DOCX);

    const wrapper = page.locator('.document__table');
    await expect(wrapper).toBeVisible();
    await expect(wrapper).toHaveCSS('overflow-x', 'auto');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('every tap target on the document page clears the 44px floor', async ({ page }) => {
    await page.goto(DOCX);

    const elements = page.locator(INTERACTIVE);
    const count = await elements.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const element = elements.nth(i);
      if (!(await element.isVisible())) continue;
      const box = await element.boundingBox();
      const label = (await element.innerText().catch(() => '')).trim().slice(0, 40) || `#${i}`;
      expect(box, `no box for ${label}`).not.toBeNull();
      expect(box.height, `height of "${label}"`).toBeGreaterThanOrEqual(MIN_TAP);
      expect(box.width, `width of "${label}"`).toBeGreaterThanOrEqual(MIN_TAP);
    }
  });

  // --- keeping one --------------------------------------------------------

  test('the document page offers the original, as a real attachment', async ({ page }) => {
    await page.goto(DOCX);

    const link = page.getByRole('link', { name: 'Download the original' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', DOCX_BYTES);

    const response = await page.request.get(DOCX_BYTES);
    expect(response.status()).toBe(200);
    // The real MIME type, which is what makes a phone open it in Word.
    expect(response.headers()['content-type']).toBe(DOCX_TYPE);
    expect(response.headers()['content-disposition']).toMatch(/^attachment;/);
    expect(response.headers()['content-disposition']).toContain('Week 3 Notes.docx');
    expect(response.headers()['cache-control']).toBe('private, no-store');
    // A .docx is a zip, so the bytes start "PK" -- they came through whole.
    const body = await response.body();
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(body.length).toBeGreaterThan(1000);
  });

  test('the PDF viewer page offers the same download, without JavaScript', async ({ browser }) => {
    // A plain link, so this works in a context with scripting turned off --
    // unlike the full-screen button, which is progressive enhancement.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto('/login');
      await page.getByLabel('Your passphrase').fill('correct horse');
      await page.getByRole('button', { name: 'Enter' }).click();
      await page.goto('/view/Biology%20101/syllabus.pdf');

      const link = page.locator('.viewer__bar').getByRole('link', { name: 'Download' });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', PDF_BYTES);

      const response = await page.request.get(PDF_BYTES);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toBe('application/pdf');
      expect(response.headers()['content-disposition']).toMatch(/^attachment;/);
    } finally {
      await context.close();
    }
  });

  test('an office file we cannot show says so, and offers the original', async ({ page }) => {
    await page.goto(XLSX);

    await expect(page.locator('h1.page__title')).toHaveText('marks.xlsx');
    await expect(page.locator('.viewer--plain')).toContainText('We can’t show this one');
    await expect(page.locator('.viewer--plain')).toContainText(
      'Photos, PDFs and Word documents open right here'
    );
    await expect(page.locator('article.document')).toHaveCount(0);

    const link = page.getByRole('link', { name: 'Download marks.xlsx' });
    await expect(link).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the folder' })).toBeVisible();

    const response = await page.request.get(XLSX_BYTES);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe(XLSX_TYPE);
    expect(response.headers()['content-disposition']).toMatch(/^attachment;/);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('a file we neither show nor offer gains no download button', async ({ page }) => {
    // Anyone the owner shares a folder with can put a file in it; a .txt, a
    // scripted SVG and an unknown binary all stay exactly as unreachable as
    // they were before /download/* existed.
    for (const path of ['/view/welcome.txt', '/view/Biology%20101/Lectures/mitosis.svg']) {
      await page.goto(path);
      await expect(page.locator('.viewer--plain')).toContainText('We can’t show this one');
      await expect(page.getByRole('link', { name: /^Download/ })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Back to the folder' })).toBeVisible();
    }

    for (const bytes of ['/download/welcome.txt', '/download/Biology%20101/Lectures/mitosis.svg']) {
      const response = await page.request.get(bytes);
      expect(response.status(), bytes).toBe(404);
    }
  });

  // --- the tile grid ------------------------------------------------------

  test('a Word document is tappable; an office file we cannot render is not', async ({ page }) => {
    await page.goto(FOLDER);

    const docx = page.locator('.tiles__item', { hasText: 'Week 3 Notes.docx' });
    await expect(docx.locator('a.tile')).toHaveAttribute('href', DOCX);

    // marks.xlsx has no page worth opening, so the grid gives it no link --
    // the same visual language as a .txt. (It still answers by URL, with the
    // download; the test above walks that path.)
    const xlsx = page.locator('.tiles__item', { hasText: 'marks.xlsx' });
    await expect(xlsx.locator('.tile--static')).toBeVisible();
    await expect(xlsx.locator('a')).toHaveCount(0);
  });
});

test.describe('Not signed in', () => {
  test('a download is not served without a passphrase', async ({ request }) => {
    for (const path of [DOCX_BYTES, PDF_BYTES, DOCX]) {
      const response = await request.get(path, { maxRedirects: 0 });

      expect(response.status(), path).toBe(302);
      expect(response.headers().location, path).toBe('/login');
    }
  });
});
