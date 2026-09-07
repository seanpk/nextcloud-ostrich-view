#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { chromium, devices } from '@playwright/test';

import { startDemo } from './demo.js';

/**
 * `npm run screenshots` -- regenerate docs/screenshots/ for the README.
 *
 * It drives the same stack `npm run demo` does, so the pictures in the README
 * cannot drift from the app: a template change that breaks a page breaks the
 * screenshot of it on the next run. Nothing is mocked beyond the Nextcloud the
 * demo already fakes.
 *
 * Phone viewport on purpose -- this is a phone-first app, and a desktop capture
 * would sell the wrong thing. Shots are viewport-sized (uniform, so they line
 * up in the README's table) except the ones marked fullPage, where the whole
 * scroll IS the point: the task list only makes its case for
 * still-to-do-then-done ordering if you can see both halves at once.
 *
 * The demo seeds a sitting two days ago, so the stream's New badges are on the
 * first shot rather than absent (see scripts/demo.js).
 *
 * The stream comes first because it is what she lands on. `files.png` is the
 * folder page behind the Files toggle, which is where every other shot starts.
 */

const OUT = join(fileURLToPath(new URL('..', import.meta.url)), 'docs', 'screenshots');

/** Enough for the fonts to settle; without it the first shot can catch fallback glyphs. */
const SETTLE_MS = 350;

async function main() {
  const demo = await startDemo({ port: 0 });
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL: demo.url });
  const page = await context.newPage();

  const shot = async (name, options = {}) => {
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(OUT, `${name}.png`), ...options });
    process.stdout.write(`  ${name}.png\n`);
  };

  try {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await shot('login');

    // This first load is also what rotates the seeded visit into `previous`,
    // which is what puts the New badges on the shot below.
    await page.getByLabel('Your passphrase').fill(demo.passphrase);
    await page.getByRole('button', { name: 'Enter' }).click();
    await page.waitForURL(`${demo.url}/`);
    await page.waitForLoadState('networkidle');
    await shot('stream');

    await page.goto('/files');
    await page.waitForLoadState('networkidle');
    await shot('files');

    await page.goto('/files/Biology%20101/Lectures');
    await page.waitForLoadState('networkidle');
    await shot('folder');

    // Wait for pdf.js to actually paint: "the iframe exists" would screenshot
    // a blank grey box, which is the failure this shot is meant to disprove.
    await page.goto('/view/Biology%20101/syllabus.pdf');
    await page
      .frameLocator('iframe.viewer__pdf')
      .locator('.pdfViewer .page[data-page-number="1"] canvas')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await shot('pdf');

    await page.goto('/view/Biology%20101/Lectures/cell%20diagram.png');
    await page.waitForLoadState('networkidle');
    await shot('photo');

    await page.goto('/tasks');
    await page.waitForLoadState('networkidle');
    await shot('tasks-home');

    await page.getByRole('link', { name: 'School' }).first().click();
    await page.waitForLoadState('networkidle');
    await shot('tasks');
    await shot('tasks-full', { fullPage: true });
  } finally {
    await browser.close();
    await demo.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
