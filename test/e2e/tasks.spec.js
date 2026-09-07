import { test, expect, login } from './fixtures.js';
import { ESSAY_DUE_YMD } from '../mock-nextcloud/calendars.js';

/**
 * The Tasks half of the acceptance walk: toggle across from Files, pick a list,
 * read what is still to do, then see what has been finished lately.
 *
 * Ordering is asserted by comparing the actual sequence of task titles on the
 * page, not by looking for individual items -- "uncompleted first, then
 * completed newest-first" is the whole point of the page.
 */

const SCHOOL = '/tasks/school-tasks';

test.describe('Latest / Files / Tasks toggle', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('the landing page offers all three sections, with Latest as the one you are on', async ({ page }) => {
    const toggle = page.locator('.toggle');
    await expect(toggle).toBeVisible();
    for (const section of ['Latest', 'Files', 'Tasks']) {
      await expect(toggle.getByRole('link', { name: section })).toBeVisible();
    }
    await expect(page.locator('.toggle__option.is-current')).toHaveText('Latest');
  });

  test('tapping Tasks shows the shared task lists and nothing else', async ({ page }) => {
    await page.locator('.toggle').getByRole('link', { name: 'Tasks' }).click();

    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.locator('.toggle__option.is-current')).toHaveText('Tasks');

    await expect(page.getByRole('link', { name: 'School Tasks' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chores' })).toBeVisible();

    // A VEVENT-only calendar is a diary, not a task list.
    await expect(page.getByText('Class Schedule')).toHaveCount(0);
    await expect(page.locator('.tiles__item')).toHaveCount(2);
  });

  test('and tapping Files gets the folders, from the task side', async ({ page }) => {
    await page.goto('/tasks');
    await page.locator('.toggle').getByRole('link', { name: 'Files' }).click();

    await expect(page).toHaveURL(/\/files$/);
    await expect(page.getByRole('link', { name: 'Biology 101' })).toBeVisible();
  });

  test('and tapping Latest comes back to the stream, from anywhere', async ({ page }) => {
    for (const path of ['/files', '/files/Biology%20101', '/tasks', '/tasks/school-tasks']) {
      await page.goto(path);
      await page.locator('.toggle').getByRole('link', { name: 'Latest' }).click();
      await expect(page, `Latest from ${path}`).toHaveURL(/\/$/);
      await expect(page.locator('#today')).toHaveText('Today');
    }
  });

  /**
   * Deep inside Files is exactly where she is when she remembers the tasks, so
   * the toggle has to be there too -- alongside Back, on a phone, without the
   * top bar spilling off the side.
   */
  for (const [name, path] of [
    ['the files page', '/files'],
    ['a folder', '/files/Biology%20101'],
    ['a deep folder', '/files/Biology%20101/Lectures'],
    ['the file viewer', '/view/Biology%20101/Lectures/cell%20diagram.png'],
  ]) {
    test(`${name} keeps the toggle, next to Back`, async ({ page }) => {
      await page.goto(path);

      await expect(page.locator('.toggle')).toBeVisible();
      await expect(page.locator('.toggle__option.is-current')).toHaveText('Files');
      await expect(page.getByRole('link', { name: /Back/ })).toBeVisible();

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${path} overflows horizontally`).toBeLessThanOrEqual(clientWidth + 1);

      await page.locator('.toggle').getByRole('link', { name: 'Tasks' }).click();
      await expect(page).toHaveURL(/\/tasks$/);
    });
  }
});

test.describe('A task list', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto(SCHOOL);
  });

  test('shows what is still to do, then what is done, in that order', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('School Tasks');

    const todo = await page.locator('.section--todo .task__title').allTextContents();
    expect(todo).toEqual([
      'Write the Café history essay — 日本語 sources', // due soonest (+10d)
      'Biology lab report', // due later (+18d)…
      'Collect pond samples', // …with its two subtasks nested under it
      'Draw the graphs',
      'Read chapter 4', // undated tasks come last
      'Return the library book',
    ]);

    const done = await page.locator('.section--done .task__title').allTextContents();
    expect(done).toEqual([
      'Buy a lab notebook', // finished Aug 7
      'Borrow the lab manual', // Aug 6
      'Email Professor Ruiz', // Aug 4
      'Hand in the permission slip', // Aug 1
    ]);

    // And the whole "still to do" block sits above the whole "done" block.
    const todoBottom = (await page.locator('.section--todo').boundingBox()).y;
    const doneTop = (await page.locator('.section--done').boundingBox()).y;
    expect(doneTop).toBeGreaterThan(todoBottom);
  });

  test('an unfinished task is shown in full: when it is due, and the owner’s note', async ({ page }) => {
    const essay = page.locator('.task', { hasText: 'Café history essay' }).first();

    await expect(essay.locator('.task__due')).toContainText(/Due /);
    // The fixture's due date is a dynamic offset (see calendars.js); compute
    // the same "Mon D" the app renders (date-only dues are formatted in UTC).
    const dueDay = new Date(
      Date.UTC(
        Number(ESSAY_DUE_YMD.slice(0, 4)),
        Number(ESSAY_DUE_YMD.slice(4, 6)) - 1,
        Number(ESSAY_DUE_YMD.slice(6, 8))
      )
    );
    const expected = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(dueDay);
    await expect(essay.locator('.task__due')).toContainText(expected);

    const note = essay.locator('.task__note');
    await expect(note).toContainText('Outline the argument');
    // The line breaks the owner typed are part of the note, not decoration.
    await expect(note).toContainText('Proofread it out loud');
    expect(await note.innerText()).toContain('\n');

    await expect(essay.locator('.task__flag').first()).toHaveText('Important');
  });

  test('subtasks are indented under the task they belong to', async ({ page }) => {
    const parent = page.locator('.task', { hasText: 'Biology lab report' }).first();
    const child = parent.locator('.tasks--sub .task__title', { hasText: 'Collect pond samples' });

    await expect(child).toBeVisible();

    const parentBox = await parent.locator('.task__card').first().boundingBox();
    const childBox = await child.boundingBox();
    expect(childBox.x, 'a subtask should sit to the right of its parent').toBeGreaterThan(
      parentBox.x
    );
  });

  test('finished work is visible but quieter than the work that is left', async ({ page }) => {
    const doneTitle = page.locator('.section--done .task__title').first();
    const todoTitle = page.locator('.section--todo .task__title').first();

    await expect(page.locator('.section--done .task__done-at').first()).toContainText('Finished');

    const sizeOf = (locator) =>
      locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(await sizeOf(doneTitle)).toBeLessThan(await sizeOf(todoTitle));
  });

  test('task text is large enough to read without pinch-zooming', async ({ page }) => {
    const size = await page
      .locator('.task__title')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    expect(size).toBeGreaterThanOrEqual(18);
  });

  test('a recurring chore reads as done once its latest occurrence is ticked off', async ({
    page,
  }) => {
    await page.goto('/tasks/chores');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chores');
    expect(await page.locator('.section--todo .task__title').allTextContents()).toEqual([
      'Take the bins out',
      'Empty the dishwasher',
    ]);
    // The recycling master is still NEEDS-ACTION; only its override says done.
    expect(await page.locator('.section--done .task__title').allTextContents()).toEqual([
      'Vacuum the stairs',
      'Put the recycling out',
    ]);
    // A cancelled chore is neither outstanding nor finished: it is not shown.
    await expect(page.getByText('Clear out the shed')).toHaveCount(0);
  });
});

test.describe('Getting around', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Back walks a task list -> the lists -> the stream', async ({ page }) => {
    await page.goto('/tasks');
    await page.getByRole('link', { name: 'School Tasks' }).click();
    await expect(page).toHaveURL(/\/tasks\/school-tasks$/);

    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(/\/tasks$/);

    await page.getByRole('link', { name: /Back/ }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('a task list that is not shared gives a calm message', async ({ page }) => {
    const response = await page.goto('/tasks/not-a-real-list');

    expect(response.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found');
    await expect(page.locator('body')).not.toContainText(/at Object|node_modules|Error:/);
  });
});

test.describe('Tasks pages on a phone', () => {
  for (const path of ['/tasks', SCHOOL]) {
    test(`${path}: every tap target is big enough and the page never scrolls sideways`, async ({
      page,
    }) => {
      await login(page);
      await page.goto(path);

      const targets = page.locator('a.tile, a.back, .toggle__option');
      const count = await targets.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i += 1) {
        const box = await targets.nth(i).boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  }
});

test.describe('Without a session', () => {
  test('/tasks redirects to login', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Your passphrase')).toBeVisible();
  });

  test('a deep task-list URL redirects to login too', async ({ page }) => {
    await page.goto(SCHOOL);
    await expect(page).toHaveURL(/\/login$/);
  });
});
