import { test, expect, login } from './fixtures.js';

test.describe('Signing in', () => {
  test('the login page asks for one thing and offers one big button', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByLabel('Your passphrase')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enter' })).toBeVisible();

    // Nothing to go "back" to from here.
    await expect(page.locator('.back')).toHaveCount(0);
    // No username field to confuse anyone.
    await expect(page.locator('input[name="username"]')).toHaveCount(0);
  });

  test('a wrong passphrase shows a friendly message and stays on /login', async ({ page }) => {
    await login(page, 'definitely not the passphrase');

    await expect(page).toHaveURL(/\/login$/);

    const notice = page.getByRole('alert');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/didn.t match/i);
    // Calm and non-technical: no jargon, no blame.
    await expect(notice).not.toContainText(/error|invalid|unauthori[sz]ed|401/i);

    // The form is still there, ready for another go.
    await expect(page.getByLabel('Your passphrase')).toBeVisible();
  });

  test('the correct passphrase lands on Latest, with the three-way toggle', async ({ page }) => {
    await login(page);

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hello, Mom');

    // The stream, not the folders: what has changed is what she came for.
    await expect(page.locator('.stream__name').first()).toBeVisible();
    await expect(page.locator('#today')).toHaveText('Today');
    await expect(page.locator('.toggle__option.is-current')).toHaveText('Latest');
  });

  test('and Files is one tap away, with the shared folders as buttons', async ({ page }) => {
    await login(page);
    await page.locator('.toggle').getByRole('link', { name: 'Files' }).click();

    await expect(page).toHaveURL(/\/files$/);
    for (const folder of ['Biology 101', 'Math 210', 'Café Notes']) {
      await expect(page.getByRole('link', { name: folder })).toBeVisible();
    }

    // Folders come before files, and a file we cannot open is a plain label.
    const tileNames = await page.locator('.tile__name').allTextContents();
    assertFoldersFirst(tileNames, ['Biology 101', 'Café Notes', 'Math 210']);
    await expect(page.locator('.tile--static', { hasText: 'welcome.txt' })).toBeVisible();
  });

  test('a second viewer gets their own greeting', async ({ page }) => {
    await login(page, 'battery staple');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hello, Gran');
  });

  test('signing out returns to the login page and the session is gone', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('visiting /login while already signed in goes straight to Latest', async ({ page }) => {
    await login(page);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('Show/hide passphrase', () => {
  test('the reveal button is hidden with JS disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto('/login');
      await expect(page.getByLabel('Your passphrase')).toBeVisible();
      await expect(page.locator('.login__reveal')).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test('clicking it reveals the typed passphrase, then hides it again', async ({ page }) => {
    await page.goto('/login');

    const input = page.getByLabel('Your passphrase');
    const reveal = page.getByRole('button', { name: 'Show' });

    await expect(reveal).toBeVisible();
    await expect(input).toHaveAttribute('type', 'password');
    await expect(reveal).toHaveAttribute('aria-pressed', 'false');

    await input.fill('a secret');
    await reveal.click();

    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveValue('a secret');
    await expect(page.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Hide' }).click();
    await expect(input).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Show' })).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Without a session', () => {
  test('a deep /files URL redirects to /login', async ({ page }) => {
    await page.goto('/files/Biology%20101/Lectures');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Your passphrase')).toBeVisible();
  });

  test('the stream redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('/healthz answers without a session', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  test('static assets are reachable without a session', async ({ request }) => {
    const response = await request.get('/public/styles.css');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/css');
  });

  test('the login page script is reachable without a session', async ({ request }) => {
    const response = await request.get('/public/login.js');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('javascript');
  });
});

test.describe('Security headers', () => {
  test('HTML pages are no-store, nosniff, framed only by us', async ({ page }) => {
    const response = await page.goto('/login');
    const headers = response.headers();

    expect(headers['cache-control']).toContain('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
  });

  test('the session cookie is HttpOnly and SameSite=Lax', async ({ page, context }) => {
    await login(page);
    const cookie = (await context.cookies()).find((c) => c.name === 'ostrich_session');

    expect(cookie, 'expected an ostrich_session cookie').toBeTruthy();
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
  });
});

function assertFoldersFirst(tileNames, folderNames) {
  const lastFolderIndex = Math.max(...folderNames.map((n) => tileNames.indexOf(n)));
  const fileIndexes = tileNames
    .map((name, i) => (folderNames.includes(name) ? -1 : i))
    .filter((i) => i !== -1);
  for (const index of fileIndexes) {
    expect(index, `"${tileNames[index]}" should sort after every folder`).toBeGreaterThan(
      lastFolderIndex
    );
  }
}
