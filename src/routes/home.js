import { propfind, sortEntries } from '../nextcloud/webdav.js';
import { toTiles } from '../lib/tiles.js';

/**
 * Home.
 *
 * M1: the top level of everything shared with the viewer account, as big
 * buttons.
 *
 * SEAMS for later milestones:
 *  - M4 fills `newSince` (tiles for files changed since the viewer's previous
 *    visit) and `lastVisitedAt`; the template already has the section, hidden
 *    while the list is empty.
 *  - M3 turns on the Files/Tasks toggle in the layout's nav area by passing
 *    `section: 'files' | 'tasks'` and setting `showToggle: true`.
 */
export default async function registerHomeRoutes(app) {
  app.get('/', async (request, reply) => {
    const entries = await propfind(app.nextcloud, '');
    const tiles = toTiles(sortEntries(entries));

    return reply.view('home', {
      title: 'Shared files',
      viewer: request.viewer,
      tiles,
      // M4 seam.
      newSince: [],
      lastVisitedAt: null,
      // M3 seam.
      showToggle: false,
      section: 'files',
      showBack: false,
      breadcrumbs: [],
    });
  });
}
