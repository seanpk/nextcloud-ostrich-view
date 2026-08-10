import { propfind, sortEntries } from '../nextcloud/webdav.js';
import { toTiles } from '../lib/tiles.js';
import { breadcrumbs, encodePath, normalizeRelPath, parentPath } from '../lib/paths.js';

/**
 * Folder browsing.
 *
 * Every path from the URL goes through `normalizeRelPath` before it is used
 * for anything -- that helper is the single choke point for traversal safety.
 *
 * SEAM for M2: file tiles gain thumbnails and a `/view/<path>` destination via
 * `toTile()` in src/lib/tiles.js; nothing in this route needs to change.
 */
export default async function registerFileRoutes(app) {
  async function renderFolder(request, reply, rawPath) {
    // Fastify already percent-decoded the wildcard; normalize + validate here.
    const path = normalizeRelPath(rawPath);

    if (path === '') {
      // `/files/` is just the home listing under another name.
      return reply.redirect('/', 302);
    }

    const entries = await propfind(app.nextcloud, path);
    const tiles = toTiles(sortEntries(entries));
    const trail = breadcrumbs(path);
    const parent = parentPath(path);

    return reply.view('folder', {
      title: trail[trail.length - 1].name,
      viewer: request.viewer,
      path,
      tiles,
      breadcrumbs: trail,
      showBack: true,
      backHref: parent === '' ? '/' : `/files/${encodePath(parent)}`,
      // The toggle rides along on every page: finding Tasks must never depend
      // on backing out to the home screen first.
      showToggle: true,
      section: 'files',
    });
  }

  app.get('/files', async (request, reply) => reply.redirect('/', 302));

  app.get('/files/*', async (request, reply) =>
    renderFolder(request, reply, request.params['*'])
  );
}
