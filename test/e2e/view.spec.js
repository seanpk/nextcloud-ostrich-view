import { test, expect, login } from './fixtures.js';

/**
 * The M2 acceptance path: a folder of coursework shows real thumbnails, a
 * photo opens inline, a PDF opens inline *and actually renders*, and the Back
 * button gets her out of both. Plus the two things that must never work:
 * reaching a file without signing in, and climbing out of the shared tree.
 *
 * The PDF assertions deliberately reach inside the pdf.js iframe and look for
 * painted pages and extracted text. "The iframe exists" would pass with a
 * blank grey box, which is exactly the failure this milestone risks.
 */

const IMAGE = '/view/Biology%20101/Lectures/cell%20diagram.png';
const PDF = '/view/Biology%20101/syllabus.pdf';
const PDF_BYTES = '/content/Biology%20101/syllabus.pdf';

/** Wait for pdf.js to paint at least the first page. */
async function pdfFrame(page) {
  const frame = page.frameLocator('iframe.viewer__pdf');
  await expect(frame.locator('.pdfViewer .page[data-page-number="1"] canvas')).toBeVisible({
    timeout: 30_000,
  });
  return frame;
}

test.describe('Signed in', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // --- thumbnails ----------------------------------------------------------

  test('a folder of coursework shows real thumbnails for the photos', async ({ page }) => {
    await page.goto('/files/Biology%20101/Lectures');

    const thumb = page.locator('.tiles__item', { hasText: 'cell diagram.png' }).locator('.tile__preview');

    await expect(thumb).toHaveAttribute('src', /^\/preview\/\d+\?v=[A-Za-z0-9]+/);
    // Previews are content, not decoration: they get described.
    await expect(thumb).toHaveAttribute('alt', 'Preview of cell diagram.png');

    // ...and the bytes really arrived, rather than a broken-image icon.
    await thumb.scrollIntoViewIfNeeded();
    await expect
      .poll(() => thumb.evaluate((img) => img.naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });

  test('a thumbnail may be cached by the browser for a day', async ({ page }) => {
    await page.goto('/files/Biology%20101/Lectures');
    const src = await page.locator('.tile__preview').first().getAttribute('src');

    const response = await page.request.get(src);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^image\//);
    // Private, because it is one household's coursework behind one passphrase.
    expect(response.headers()['cache-control']).toBe('private, max-age=86400');
  });

  test('a file with no thumbnail falls back to an icon instead of breaking', async ({ page }) => {
    // fileId 1 is not in the fixture tree, so the mock answers 404 the way a
    // stock Nextcloud does for a type with no preview provider.
    const response = await page.request.get('/preview/1?v=deadbeef&k=pdf', { maxRedirects: 0 });

    expect(response.status()).toBe(302);
    expect(response.headers().location).toBe('/public/icons/pdf.svg');
  });

  // --- images --------------------------------------------------------------

  test('tapping a photo opens it on the page, and Back returns to the folder', async ({ page }) => {
    await page.goto('/files/Biology%20101/Lectures');
    await page.getByRole('link', { name: /cell diagram\.png/ }).click();

    await expect(page).toHaveURL(new RegExp(`${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('cell diagram.png');

    const image = page.locator('.viewer__image');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', '/content/Biology%20101/Lectures/cell%20diagram.png');
    await expect(image).toHaveAttribute('alt', 'cell diagram.png');
    await expect
      .poll(() => image.evaluate((img) => img.naturalWidth), { timeout: 10_000 })
      .toBe(480);

    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(/\/files\/Biology%20101\/Lectures$/);
  });

  test('the photo fits the screen instead of pushing the page sideways', async ({ page }) => {
    await page.goto(IMAGE);
    await expect(page.locator('.viewer__image')).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  // --- PDFs ----------------------------------------------------------------

  test('tapping a PDF renders the document itself, not just a frame', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/files/Biology%20101');
    await page.getByRole('link', { name: /syllabus\.pdf/ }).click();
    await expect(page).toHaveURL(/\/view\/Biology%20101\/syllabus\.pdf$/);

    const frame = await pdfFrame(page);

    // Both pages of the fixture made it into the viewer...
    await expect(frame.locator('.pdfViewer .page')).toHaveCount(2);

    // ...page one was painted at a real size...
    const canvas = frame.locator('.page[data-page-number="1"] canvas');
    const box = await canvas.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);

    // ...and pdf.js extracted the document's actual words, which it could only
    // do by parsing the bytes our proxy served.
    await expect(frame.locator('.page[data-page-number="1"] .textLayer')).toContainText(
      'Ostrich Test Document'
    );
  });

  test('the pdf.js toolbar offers no way to print or open another file', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(PDF);
    const frame = await pdfFrame(page);

    // pdf.js's own chrome is stripped: its download and print buttons would
    // reach the bytes through a URL of its choosing, and "open file" would
    // let it read anything at all.
    await expect(
      frame.locator('#download, #print, #openFile, #secondaryToolbarToggle, #secondaryToolbar, [download]')
    ).toHaveCount(0);

    // Our own bar around it offers exactly one thing, deliberately: the file,
    // through our own /download/ route. See documents.spec.js.
    const ours = page.locator('.viewer__bar a');
    await expect(ours).toHaveCount(1);
    await expect(ours).toHaveAttribute('href', '/download/Biology%20101/syllabus.pdf');
  });

  test('the PDF page still leaves Back reachable and does not scroll sideways', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(PDF);
    await pdfFrame(page);

    await expect(page.getByRole('link', { name: /Back/ })).toBeInViewport();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(/\/files\/Biology%20101$/);
  });

  test('the pdf.js page refuses to open anything outside our proxy', async ({ page }) => {
    await page.goto('/public/pdfjs/web/viewer.html?file=https%3A%2F%2Fevil.test%2Fx.pdf');

    await expect(page.locator('#status')).toHaveText("We couldn't show this document.");
    await expect(page.locator('.pdfViewer .page')).toHaveCount(0);
  });

  // --- raw bytes -----------------------------------------------------------

  test('/content streams the file inline, and never as a download', async ({ page }) => {
    const response = await page.request.get(PDF_BYTES);

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/pdf');
    expect(response.headers()['content-disposition']).toMatch(/^inline;/);
    // Revalidate every time, but don't re-download every time.
    expect(response.headers()['cache-control']).toBe('private, no-cache');
    expect(response.headers()['etag']).toMatch(/^"[A-Za-z0-9]+"$/);
    expect(response.headers()['accept-ranges']).toBe('bytes');
  });

  test('/content answers a revisit with 304 instead of the file again', async ({ page }) => {
    const first = await page.request.get(PDF_BYTES);
    const etag = first.headers()['etag'];
    expect((await first.body()).length).toBeGreaterThan(1000);

    const second = await page.request.get(PDF_BYTES, { headers: { 'If-None-Match': etag } });

    expect(second.status()).toBe(304);
    expect((await second.body()).length).toBe(0);
    expect(second.headers()['etag']).toBe(etag);

    // A different version still sends the bytes.
    const changed = await page.request.get(PDF_BYTES, {
      headers: { 'If-None-Match': '"something-else"' },
    });
    expect(changed.status()).toBe(200);
  });

  test('/content declares exactly as many bytes as it streams', async ({ page }) => {
    // undici asks upstream for gzip by default and decompresses transparently,
    // while Content-Length keeps describing the compressed body. Proxying that
    // header would truncate the response behind any gzipping front end.
    const response = await page.request.get(PDF_BYTES);
    const body = await response.body();

    expect(Number(response.headers()['content-length'])).toBe(body.length);
  });

  test('/content answers a byte range with 206 -- this is what makes PDFs open fast', async ({ page }) => {
    const response = await page.request.get(PDF_BYTES, { headers: { Range: 'bytes=0-1023' } });

    expect(response.status()).toBe(206);
    expect(response.headers()['content-range']).toMatch(/^bytes 0-1023\/\d+$/);
    expect((await response.body()).length).toBe(1024);
  });

  test('/content refuses folders', async ({ page }) => {
    const response = await page.request.get('/content/Biology%20101');
    expect(response.status()).toBe(404);
  });

  test('/content rejects a path that tries to climb out of the shared tree', async ({ page }) => {
    for (const path of ['/content/..%2F..%2Fetc%2Fpasswd', '/content/Biology%20101/..%2F..%2F..%2Fetc%2Fpasswd']) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBeGreaterThanOrEqual(400);
      expect(response.status(), path).toBeLessThan(500);
      expect(await response.text()).not.toContain('root:');
    }
  });

  // --- everything else -----------------------------------------------------

  test('a file we cannot show says so calmly, with a way back', async ({ page }) => {
    await page.goto('/view/welcome.txt');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('welcome.txt');
    await expect(page.locator('.viewer--plain')).toContainText('We can’t show this one');
    await expect(page.getByRole('link', { name: 'Back to the folder' })).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    // A .txt is not an office file, so nothing new is offered for it.
    await expect(page.getByRole('link', { name: /^Download/ })).toHaveCount(0);
  });

  test('an SVG is never offered inline, and never served as one', async ({ page }) => {
    // image/* is not the same question as "will a browser paint this safely".
    // An SVG served inline from our own origin is script on our own origin.
    await page.goto('/files/Biology%20101/Lectures');
    const tile = page.locator('.tiles__item', { hasText: 'mitosis.svg' });
    await expect(tile.locator('.tile--static')).toBeVisible();
    await expect(tile.locator('a')).toHaveCount(0);

    const bytes = await page.request.get('/content/Biology%20101/Lectures/mitosis.svg');
    expect(bytes.headers()['content-type']).toBe('application/octet-stream');

    // And arriving by URL gets the calm page rather than a broken picture.
    await page.goto('/view/Biology%20101/Lectures/mitosis.svg');
    await expect(page.locator('.viewer--plain')).toContainText('We can’t show this one');
    await expect(page.locator('.viewer__image')).toHaveCount(0);
  });

  test('a /view path that does not exist gives the calm not-found page', async ({ page }) => {
    const response = await page.goto('/view/Biology%20101/nope.png');

    expect(response.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found');
  });

  test('/view on a folder sends her to the folder listing', async ({ page }) => {
    await page.goto('/view/Biology%20101');
    await expect(page).toHaveURL(/\/files\/Biology%20101$/);
  });
});

test.describe('Not signed in', () => {
  test('file bytes and thumbnails are not served without a passphrase', async ({ request }) => {
    for (const path of ['/content/welcome.txt', '/preview/908603?v=000ddd3babcd', PDF]) {
      const response = await request.get(path, { maxRedirects: 0 });

      expect(response.status(), path).toBe(302);
      expect(response.headers().location, path).toBe('/login');
    }
  });
});
