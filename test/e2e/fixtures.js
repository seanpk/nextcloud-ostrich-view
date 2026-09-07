import { test as base, expect } from '@playwright/test';

/**
 * Shared E2E fixtures.
 *
 * Two things happen here:
 *  1. `baseURL` comes from the ephemeral port global-setup bound.
 *  2. Every test RUN gets its own synthetic CF-Connecting-IP. The login route
 *     is rate-limited to 5 attempts/minute per client IP, and without this the
 *     whole suite would share 127.0.0.1 and start tripping the limit. It also
 *     means the Cloudflare header path is what the tests actually exercise,
 *     which is what production uses.
 *
 *     RUN, not test: the repeat index and the retry number go into the hash
 *     alongside the title. `--repeat-each 5` is how a suspected flake is
 *     hunted, and with the title alone those five runs share one IP and one
 *     five-attempt budget -- so the fifth login is refused and the spec fails
 *     for a reason that has nothing to do with what it asserts. (That is not
 *     hypothetical: it is what `--repeat-each 5` did to ux.spec.js before this
 *     line.) A retry gets its own for the same reason.
 */

function syntheticIp(testId) {
  let hash = 2166136261;
  for (let i = 0; i < testId.length; i += 1) {
    hash ^= testId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash >>>= 0;
  return `10.${(hash >> 16) & 255}.${(hash >> 8) & 255}.${hash & 255}`;
}

export const test = base.extend({
  baseURL: async ({}, use) => {
    const url = process.env.OSTRICH_BASE_URL;
    if (!url) throw new Error('OSTRICH_BASE_URL is unset -- did global setup run?');
    await use(url);
  },

  extraHTTPHeaders: async ({}, use, testInfo) => {
    const run = `${testInfo.titlePath.join('>')}#${testInfo.repeatEachIndex}.${testInfo.retry}`;
    await use({ 'CF-Connecting-IP': syntheticIp(run) });
  },
});

/**
 * Sign in as the given viewer and land on the home page.
 *
 * IT WAITS FOR THE LANDING, which the click alone does not. A good passphrase
 * is a POST that answers `302 /#today`, and the browser then fetches that page
 * -- so a `page.goto(somewhere)` on the line after the click races the redirect
 * it started. Most specs hide the race behind an auto-retrying `expect`; the
 * ones that read a `locator.count()` straight after navigating do not, and see
 * an empty page ("expected artwork on /files") for no reason of their own.
 *
 * A WRONG passphrase re-renders /login with a 200 and no redirect, and callers
 * testing that case assert on the page themselves -- so this waits on the POST
 * response and only follows through when it was actually a redirect.
 */
export async function login(page, passphrase = 'correct horse') {
  await page.goto('/login');
  await page.getByLabel('Your passphrase').fill(passphrase);

  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/login')
  );
  await page.getByRole('button', { name: 'Enter' }).click();
  const response = await submitted;

  if (response.status() === 302) await page.waitForURL(/#today$/);
}

export { expect, syntheticIp };
