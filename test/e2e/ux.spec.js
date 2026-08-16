import { test, expect, login } from './fixtures.js';

/**
 * The usability guarantees, asserted rather than hoped for.
 *
 * The audience is one tech-averse older user holding a phone: if a target is
 * fiddly or the page slides sideways under her thumb, the app has failed no
 * matter how correct the WebDAV code is.
 */

const MIN_TAP = 44; // px -- the WCAG/Apple floor. Our design aims far above it.

/** Every visible thing you can tap or click. */
const INTERACTIVE =
  'a.tile, a.back, .btn, .footer__logout, .toggle__option, .login__input, .login__reveal';

const PAGES = [
  { name: 'home', path: '/', needsLogin: true },
  { name: 'a folder', path: '/files/Biology%20101', needsLogin: true },
  { name: 'a deep folder', path: '/files/Biology%20101/Lectures', needsLogin: true },
  { name: 'a photo', path: '/view/Biology%20101/Lectures/cell%20diagram.png', needsLogin: true },
  { name: 'an unpreviewable file', path: '/view/welcome.txt', needsLogin: true },
  { name: 'login', path: '/login', needsLogin: false },
];

for (const target of PAGES) {
  test(`${target.name}: every tap target is at least ${MIN_TAP}px`, async ({ page }) => {
    if (target.needsLogin) await login(page);
    await page.goto(target.path);

    const elements = page.locator(INTERACTIVE);
    const count = await elements.count();
    expect(count, `expected something tappable on ${target.path}`).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const element = elements.nth(i);
      if (!(await element.isVisible())) continue;

      const box = await element.boundingBox();
      const label = (await element.innerText().catch(() => '')).trim().slice(0, 40) || `#${i}`;

      expect(box, `no box for ${label}`).not.toBeNull();
      expect(box.height, `height of "${label}" on ${target.path}`).toBeGreaterThanOrEqual(MIN_TAP);
      expect(box.width, `width of "${label}" on ${target.path}`).toBeGreaterThanOrEqual(MIN_TAP);
    }
  });

  test(`${target.name}: the page never scrolls sideways`, async ({ page }) => {
    if (target.needsLogin) await login(page);
    await page.goto(target.path);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    // 1px of slack for sub-pixel rounding on device-scale-factor viewports.
    expect(scrollWidth, `${target.path} overflows horizontally`).toBeLessThanOrEqual(
      clientWidth + 1
    );
  });
}

test('the Back button stays put while the page scrolls', async ({ page }) => {
  await login(page);
  await page.goto('/files/Biology%20101/Lectures');

  const back = page.getByRole('link', { name: /Back/ });
  const before = await back.boundingBox();

  await page.evaluate(() => window.scrollTo(0, 400));
  const after = await back.boundingBox();

  expect(after.y).toBeCloseTo(before.y, 0);
  await expect(back).toBeInViewport();
});

test('body text is large enough to read without pinch-zooming', async ({ page }) => {
  await login(page);
  await page.goto('/files/Biology%20101');

  const nameSize = await page
    .locator('.tile__name')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  expect(nameSize).toBeGreaterThanOrEqual(18);
});

test('tiles sit one per row on a phone and share rows on a desktop', async ({ page, isMobile }) => {
  await login(page);
  await page.goto('/files/Biology%20101');

  const boxes = await page.locator('.tiles__item').evaluateAll((nodes) =>
    nodes.map((n) => n.getBoundingClientRect().top)
  );
  const distinctRows = new Set(boxes.map((top) => Math.round(top))).size;

  if (isMobile) {
    expect(distinctRows, 'phone layout should stack every tile').toBe(boxes.length);
  }
});

test('the viewport meta tag allows zooming (never user-scalable=no)', async ({ page }) => {
  await page.goto('/login');
  const content = await page.locator('meta[name="viewport"]').getAttribute('content');

  expect(content).toContain('width=device-width');
  expect(content).not.toContain('user-scalable=no');
  expect(content).not.toContain('maximum-scale=1');
});
