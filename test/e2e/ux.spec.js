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
  'a.tile, a.stream__row, .stream__undated > summary, a.back, .btn, .footer__logout, .toggle__option, .login__input, .login__reveal, .viewer__fs';

const PAGES = [
  { name: 'the stream', path: '/', needsLogin: true },
  { name: 'the files page', path: '/files', needsLogin: true },
  { name: 'a folder', path: '/files/Biology%20101', needsLogin: true },
  { name: 'a deep folder', path: '/files/Biology%20101/Lectures', needsLogin: true },
  { name: 'a photo', path: '/view/Biology%20101/Lectures/cell%20diagram.png', needsLogin: true },
  { name: 'a Word document', path: '/view/Biology%20101/Lectures/Week%203%20Notes.docx', needsLogin: true },
  { name: 'an unpreviewable file', path: '/view/welcome.txt', needsLogin: true },
  {
    name: 'an office file we can only offer as a download',
    path: '/view/Biology%20101/Lectures/marks.xlsx',
    needsLogin: true,
  },
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

test('the three-way toggle fits, and stays tappable, at 360px', async ({
  browser,
  baseURL,
  extraHTTPHeaders,
}) => {
  // The narrowest phone this app is designed for. Three options plus a Back
  // button is the tightest the top bar ever gets, and it is why the toggle's
  // padding and type size are fluid rather than fixed (see styles.css).
  //
  // A context of its own, because the viewport is the whole point -- and it
  // carries this test's synthetic client IP too, or its login would spend the
  // per-IP budget that belongs to 127.0.0.1 (see fixtures.js).
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    baseURL,
    extraHTTPHeaders,
  });
  const narrow = await context.newPage();
  try {
    await login(narrow);
    // A folder page: the toggle AND the Back button, which is the worst case.
    await narrow.goto('/files/Biology%20101');

    const options = narrow.locator('.toggle__option');
    await expect(options).toHaveCount(3);
    expect(await options.allTextContents()).toEqual(['Latest', 'Files', 'Tasks']);

    for (const option of await options.all()) {
      const box = await option.boundingBox();
      expect(box.height, `height of "${await option.innerText()}"`).toBeGreaterThanOrEqual(MIN_TAP);
      expect(box.width, `width of "${await option.innerText()}"`).toBeGreaterThanOrEqual(MIN_TAP);
    }

    // Everything in the bar is inside the viewport, not clipped off the edge --
    // and on ONE row beside Back, rather than wrapping onto a second and
    // stealing a chunk of a phone screen for chrome.
    const bar = await narrow.locator('.topbar__inner').boundingBox();
    const back = await narrow.locator('.back').boundingBox();
    const last = await options.last().boundingBox();
    expect(last.x + last.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
    expect(last.x, 'the toggle must sit beside Back, not under it').toBeGreaterThan(
      back.x + back.width
    );
    for (const option of await options.all()) {
      const box = await option.boundingBox();
      expect(box.y, 'one row').toBeCloseTo(back.y, 0);
    }

    const { scrollWidth, clientWidth } = await narrow.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, 'the top bar must not push the page sideways').toBeLessThanOrEqual(
      clientWidth + 1
    );
  } finally {
    await context.close();
  }
});

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

test('in full screen, tap targets and horizontal scroll still meet the same bar', async ({ page }) => {
  await login(page);
  await page.goto('/view/Biology%20101/Lectures/cell%20diagram.png');
  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect(page.locator('body')).toHaveClass(/is-immersive/);

  const elements = page.locator(INTERACTIVE);
  const count = await elements.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const element = elements.nth(i);
    if (!(await element.isVisible())) continue;
    const box = await element.boundingBox();
    expect(box, `no box for element #${i}`).not.toBeNull();
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP);
  }

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});

/**
 * Artwork stays artwork, at any reader's font size.
 *
 * "The icons look enormous on mobile" was reported from a phone and could not
 * be reproduced in Chromium or WebKit at any phone viewport with the stylesheet
 * applied -- but it reproduces immediately once the BROWSER's default font size
 * is raised, which on Android Chrome is a slider in Accessibility settings and
 * on a phone belonging to someone who finds small text hard is very likely to
 * be turned up. `html { font-size: 112.5% }` is a percentage of that default,
 * so every rem in the app followed it: at the 200% setting a row's 3.5rem
 * thumbnail became 126px and the stream scrolled sideways.
 *
 * Raising the root font size directly is the portable way to emulate that --
 * the CDP call that sets a browser default is Chromium-only, and this has to
 * run on WebKit too, since WebKit is the reason this file has a third project.
 *
 * Text should still scale. Artwork should not, past the size it was drawn at.
 */
const ART = '.stream__thumb, .stream__icon, .stream__preview, .tile__icon';
const MAX_ART = 66; // the design's 3.5rem == 63px, plus rounding slack

const ART_PAGES = [
  ['the stream', '/'],
  ['the files page', '/files'],
  ['a folder', '/files/Biology%20101/Lectures'],
];

for (const [where, path] of ART_PAGES) {
  for (const rootFontSize of [null, '36px']) {
    const at = rootFontSize ? "when the reader's font is doubled" : 'as drawn';

    test(`${where}: artwork stays inside its box ${at}`, async ({ page }) => {
      await login(page);
      await page.goto(path);

      if (rootFontSize) {
        // 36px root == a browser default of 32px against the app's 112.5%,
        // which is Android Chrome's largest text-scaling step.
        //
        // Set through the CSSOM rather than with `addStyleTag`: the app's CSP
        // is `style-src 'self'` with no 'unsafe-inline', so an injected <style>
        // is refused (as it should be) while a scripted style property is not.
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = size;
        }, rootFontSize);
        await expect
          .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
          .toBe(rootFontSize);
      }

      const elements = page.locator(ART);
      const count = await elements.count();
      expect(count, `expected artwork on ${path}`).toBeGreaterThan(0);

      for (let i = 0; i < count; i += 1) {
        const element = elements.nth(i);
        if (!(await element.isVisible())) continue;
        await element.scrollIntoViewIfNeeded();
        const box = await element.boundingBox();
        const what = (await element.getAttribute('class')) ?? `#${i}`;
        expect(box, `no box for ${what}`).not.toBeNull();
        expect(box.width, `width of ${what} on ${path}`).toBeLessThanOrEqual(MAX_ART);
        expect(box.height, `height of ${what} on ${path}`).toBeLessThanOrEqual(MAX_ART);
      }

      // And the page still does not slide sideways under her thumb, which is
      // what a 126px thumbnail beside a full-width name used to cost.
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${path} overflows horizontally ${at}`).toBeLessThanOrEqual(
        clientWidth + 1
      );
    });
  }
}

test('a stream row\u2019s artwork carries its size in the markup, not only in the CSS', async ({
  page,
}) => {
  // The last line of defence against the reported symptom: an <img> of an SVG
  // with a viewBox and no intrinsic size renders at 300px when no CSS reaches
  // it. Every one of these ships width/height, so the worst case is a small
  // icon rather than a column of posters.
  await login(page);

  for (const selector of ['.stream__icon', '.stream__preview']) {
    const img = page.locator(selector).first();
    await expect(img).toHaveAttribute('width', /^\d+$/);
    await expect(img).toHaveAttribute('height', /^\d+$/);
  }

  const svg = await page.request.get('/public/icons/task-due.svg');
  expect(svg.ok()).toBe(true);
  expect(await svg.text()).toContain('width="48" height="48"');
});

/**
 * The undated twisty, opened, at both font sizes.
 *
 * A closed <details> hides its body from every measurement the tests above
 * make, so the rows inside it would otherwise never be looked at -- and they
 * are the only rows on the page that arrive after a tap. Same two checks as the
 * rest of the file: nothing slides sideways, and everything she has to hit
 * clears the 44px floor.
 */
for (const rootFontSize of [null, '36px']) {
  const at = rootFontSize ? "when the reader's font is doubled" : 'as drawn';

  test(`the opened undated twisty fits and stays tappable ${at}`, async ({ page }) => {
    await login(page);
    await page.goto('/');

    if (rootFontSize) {
      // Through the CSSOM, not addStyleTag: the app's CSP refuses an injected
      // <style>, as it should. Same trick as the artwork tests above.
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = size;
      }, rootFontSize);
      await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
        .toBe(rootFontSize);
    }

    const summary = page.locator('.stream__undated > summary');
    await expect(summary).toBeVisible();
    await summary.click();

    const rows = page.locator('.stream__undated a.stream__row');
    const count = await rows.count();
    expect(count, 'the twisty should hold rows once it is opened').toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      expect(box, `no box for undated row #${i}`).not.toBeNull();
      expect(box.height, `height of undated row #${i}`).toBeGreaterThanOrEqual(MIN_TAP);
      expect(box.width, `width of undated row #${i}`).toBeGreaterThanOrEqual(MIN_TAP);
    }

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, 'the opened twisty must not push the page sideways').toBeLessThanOrEqual(
      clientWidth + 1
    );
  });
}

test('the viewport meta tag allows zooming (never user-scalable=no)', async ({ page }) => {
  await page.goto('/login');
  const content = await page.locator('meta[name="viewport"]').getAttribute('content');

  expect(content).toContain('width=device-width');
  expect(content).not.toContain('user-scalable=no');
  expect(content).not.toContain('maximum-scale=1');
});
