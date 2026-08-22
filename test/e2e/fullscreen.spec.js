import { test, expect, login } from './fixtures.js';

/**
 * The full-screen viewer: `is-immersive` on <body> (see public/viewer.js and
 * the comment on .is-immersive in styles.css) plus tap-to-toggle chrome.
 *
 * `requestFullscreen()` itself is never asserted on -- it needs a user
 * gesture Playwright's synthetic clicks don't always satisfy, and on iOS
 * Safari it frequently isn't available for a non-video element at all. Every
 * assertion here is about `is-immersive`, which is the class the whole
 * feature is actually built on.
 */

const PHOTO = '/view/Biology%20101/Lectures/cell%20diagram.png';
const PDF = '/view/Biology%20101/syllabus.pdf';

/** Wait for pdf.js to paint at least the first page. */
async function pdfFrame(page) {
  const frame = page.frameLocator('iframe.viewer__pdf');
  await expect(frame.locator('.pdfViewer .page[data-page-number="1"] canvas')).toBeVisible({
    timeout: 30_000,
  });
  return frame;
}

test('the full-screen button is hidden with JS disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('/login');
    await page.getByLabel('Your passphrase').fill('correct horse');
    await page.getByRole('button', { name: 'Enter' }).click();
    await page.goto(PHOTO);

    await expect(page.locator('.viewer__image')).toBeVisible();
    await expect(page.getByRole('link', { name: /Back/ })).toBeVisible();
    await expect(page.locator('.viewer__fs')).toBeHidden();
  } finally {
    await context.close();
  }
});

test.describe('Signed in', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('the button is visible and starts unpressed', async ({ page }) => {
    await page.goto(PHOTO);
    const button = page.getByRole('button', { name: 'Full screen' });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  test('entering full screen fills the viewport and hides the page chrome', async ({ page }) => {
    await page.goto(PHOTO);
    const viewport = page.viewportSize();

    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('body')).toHaveClass(/is-immersive/);

    const box = await page.locator('.viewer__image').boundingBox();
    expect(box.height).toBeGreaterThan(viewport.height * 0.9);

    // The heading stays in the DOM (screen readers, and the document title)
    // but is visually clipped to 1x1px -- which Playwright's toBeVisible()
    // does not treat as "invisible" the way display:none does, so check the
    // class the CSS keys off instead.
    await expect(page.locator('.page__title')).toHaveClass(/visually-hidden/);
    await expect(page.locator('.footer')).toHaveCount(0);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test('tapping the photo hides the chrome, tapping again brings it back', async ({ page }) => {
    await page.goto(PHOTO);
    const enterButton = page.getByRole('button', { name: 'Full screen' });
    await enterButton.click();
    const exitButton = page.getByRole('button', { name: 'Exit full screen' });
    // A tap moves focus off the button it started on; a Playwright click
    // leaves it there, so blur to match what an actual tap does.
    await exitButton.evaluate((el) => el.blur());

    await page.locator('.viewer__image').click();
    await expect(page.locator('body')).toHaveClass(/is-chrome-hidden/);
    await expect(exitButton).toBeHidden();

    await page.locator('.viewer__image').click();
    await expect(page.locator('body')).not.toHaveClass(/is-chrome-hidden/);
    await expect(exitButton).toBeVisible();
  });

  test('a tap inside the PDF iframe toggles the chrome too', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(PDF);
    const frame = await pdfFrame(page);

    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('body')).toHaveClass(/is-immersive/);

    // force: true -- pdf.js overlays a text-selection layer on top of the
    // canvas, which genuinely receives the pointer event in the real app too
    // (our tap listener is on the whole #viewerContainer, not the canvas
    // specifically); Playwright's actionability check just doesn't know that.
    await frame.locator('.page[data-page-number="1"] canvas').click({ force: true });
    await expect(page.locator('body')).toHaveClass(/is-chrome-hidden/);
  });

  test('Escape exits full screen from the parent page', async ({ page }) => {
    await page.goto(PHOTO);
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('body')).toHaveClass(/is-immersive/);

    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/is-immersive/);
  });

  test('Escape exits full screen even when focus is inside the PDF frame', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(PDF);
    const frame = await pdfFrame(page);

    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('body')).toHaveClass(/is-immersive/);

    // Clicking into the frame moves focus there -- the parent's own keydown
    // listener would never see this Escape without the iframe forwarding it.
    // force: true -- see the previous test for why.
    await frame.locator('.page[data-page-number="1"] canvas').click({ force: true });
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/is-immersive/);
  });

  test('the phone Back gesture leaves full screen before leaving the page', async ({ page }) => {
    await page.goto(PHOTO);
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('body')).toHaveClass(/is-immersive/);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(PHOTO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(page.locator('body')).not.toHaveClass(/is-immersive/);
  });

  test('the chrome auto-hides, but not while a control inside it is focused', async ({ page }) => {
    await page.goto(PHOTO);
    const button = page.getByRole('button', { name: 'Full screen' });
    await button.click();
    const exitButton = page.getByRole('button', { name: 'Exit full screen' });

    // A touch tap does not retain focus the way a desktop click does; blur
    // explicitly so this test observes the auto-hide timer rather than the
    // focus guard that (correctly) suppresses it for a keyboard user.
    await exitButton.evaluate((el) => el.blur());
    await expect(page.locator('body')).toHaveClass(/is-chrome-hidden/, { timeout: 5_000 });

    // The negative case: a focused control must never be hidden out from
    // under a keyboard user.
    await page.locator('.viewer__image').click(); // bring the chrome back
    await exitButton.focus();
    await page.waitForTimeout(3_500);
    await expect(exitButton).toBeVisible();
  });

  test('no download affordance exists while in full screen', async ({ page }) => {
    await page.goto(PHOTO);
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('[download]')).toHaveCount(0);
  });

  test('toggling still works with reduced motion requested', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(PHOTO);
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('body')).toHaveClass(/is-immersive/);

    await page.locator('.viewer__image').click();
    await expect(page.locator('body')).toHaveClass(/is-chrome-hidden/);
  });

  test('outside full screen, the PDF still fills nearly all of the screen below the bars', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto(PDF);
    await pdfFrame(page);
    const viewport = page.viewportSize();

    const box = await page.locator('.viewer--pdf').boundingBox();
    // --viewer-chrome reserves topbar-h + viewer-bar-h + 1.6rem, ~191px at
    // this app's 18px root -- notably less than the old formula's
    // topbar-h + a hardcoded 9rem (243px), because the title and footer no
    // longer take up their own space on this page at all. 220px leaves
    // comfortable rounding slack while still catching a real regression back
    // toward the old, cramped layout.
    expect(box.height).toBeGreaterThan(viewport.height - 220);
  });
});
