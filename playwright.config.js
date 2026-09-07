import { defineConfig, devices } from '@playwright/test';

/**
 * Phone is the primary device, so the Pixel 7 project is not an afterthought:
 * every spec runs on both, and the layout assertions in ux.spec.js are what
 * keep the phone experience honest.
 *
 * The app and the mock Nextcloud are booted by global-setup on ephemeral ports;
 * `baseURL` is supplied per test by the fixture in fixtures.js.
 */
export default defineConfig({
  testDir: './test/e2e',
  globalSetup: './test/e2e/global-setup.js',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'pixel-7',
      use: { ...devices['Pixel 7'] },
    },
    {
      /*
       * A phone that is not Chromium.
       *
       * "The icons look enormous on mobile" was reported from a real phone and
       * could not be reproduced in Chromium at any viewport -- which left an
       * engine difference as the leading suspect, and left us with no way to
       * see one. WebKit is the engine every iPhone browser is, so it is the one
       * that has to be in the suite; it is also close enough to Android's
       * ancestry to catch the class of bug this was (a replaced element sized
       * from something other than the CSS that pins it).
       *
       * Two spec files, not the whole suite: `ux.spec.js` is the layout
       * contract (tap targets, no sideways scroll, artwork that stays inside
       * its box) and `stream.spec.js` is the page the report was about. Running
       * the WebDAV and pdf.js paths a third time would buy nothing and cost CI
       * several minutes.
       */
      name: 'webkit-iphone',
      use: { ...devices['iPhone 14'] },
      testMatch: /(ux|stream)\.spec\.js/,
    },
  ],
});
