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
  ],
});
