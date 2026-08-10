import { buildTaskTree, fetchTodos, listTaskCalendars } from '../nextcloud/caldav.js';
import { accentClassFor, toTaskViews } from '../lib/tasks.js';

/**
 * Task lists.
 *
 * `/tasks` is the same big-button grid as the folder pages, one tile per shared
 * task list. `/tasks/:slug` is the only page in the app that shows detail
 * rather than a list of destinations: unfinished tasks in full, then a calmer
 * "Done" section.
 *
 * The slug is always checked against the calendars Nextcloud actually reports,
 * so nothing from the URL is ever concatenated into a DAV request path.
 */
export default async function registerTaskRoutes(app) {
  app.get('/tasks', async (request, reply) => {
    const calendars = await listTaskCalendars(app.nextcloud);

    return reply.view('tasks-home', {
      title: 'Tasks',
      viewer: request.viewer,
      lists: calendars.map((calendar) => ({
        slug: calendar.slug,
        displayName: calendar.displayName,
        href: `/tasks/${encodeURIComponent(calendar.slug)}`,
        accentClass: accentClassFor(calendar.color),
      })),
      showToggle: true,
      section: 'tasks',
      showBack: true,
      backHref: '/',
      breadcrumbs: [],
    });
  });

  app.get('/tasks/:slug', async (request, reply) => {
    const calendars = await listTaskCalendars(app.nextcloud);
    const calendar = calendars.find((c) => c.slug === request.params.slug);

    if (!calendar) {
      // Unshared, renamed, or simply mistyped -- all the same to Mom.
      reply.code(404);
      return reply.view('error', {
        viewer: request.viewer,
        title: 'Not found',
        message: "We couldn't find that task list. It may have been unshared.",
        showBack: true,
        backHref: '/tasks',
      });
    }

    // The calendars we just listed carry the ctag the cache is keyed by; passing
    // them in keeps this page to one PROPFIND plus (at most) one REPORT.
    const todos = await fetchTodos(app.nextcloud, calendar.slug, { calendars });
    const { open, done } = buildTaskTree(todos);
    const now = new Date();

    return reply.view('task-list', {
      title: calendar.displayName,
      viewer: request.viewer,
      accentClass: accentClassFor(calendar.color),
      open: toTaskViews(open, { now }),
      done: toTaskViews(done, { now }),
      showToggle: true,
      section: 'tasks',
      showBack: true,
      backHref: '/tasks',
      breadcrumbs: [],
    });
  });
}
