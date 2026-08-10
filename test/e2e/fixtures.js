import { test as base, expect } from '@playwright/test';

/**
 * Shared E2E fixtures.
 *
 * Two things happen here:
 *  1. `baseURL` comes from the ephemeral port global-setup bound.
 *  2. Every test gets its own synthetic CF-Connecting-IP. The login route is
 *     rate-limited to 5 attempts/minute per client IP, and without this the
 *     whole suite would share 127.0.0.1 and start tripping the limit. It also
 *     means the Cloudflare header path is what the tests actually exercise,
 *     which is what production uses.
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
    await use({ 'CF-Connecting-IP': syntheticIp(`${testInfo.titlePath.join('>')}`) });
  },
});

/** Sign in as the given viewer and land on the home page. */
export async function login(page, passphrase = 'correct horse') {
  await page.goto('/login');
  await page.getByLabel('Your passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Enter' }).click();
}

export { expect, syntheticIp };
