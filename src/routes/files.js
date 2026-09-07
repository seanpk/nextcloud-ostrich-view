import { propfind, sortEntries } from '../nextcloud/webdav.js';
import { selectReceivedShares, shareListingRoots } from '../nextcloud/shares.js';
import { listReceivedShareTargets } from '../nextcloud/ocs.js';
import { toTiles } from '../lib/tiles.js';
import { breadcrumbs, encodePath, normalizeRelPath, parentPath } from '../lib/paths.js';

/**
 * Files: the folder home, and every folder under it.
 *
 * `/files` is the big-button grid of everything shared with the viewer
 * account -- what used to be the app's home page, before the stream took that
 * spot. `/files/*` is a folder listing. Every path from the URL goes through
 * `normalizeRelPath` before it is used for anything; that helper is the single
 * choke point for traversal safety.
 *
 * "The top level of everything SHARED with the viewer account" is both LOCATED
 * and filtered, not assumed:
 *
 *  - Located, because an instance with a `share_folder` set (Nextcloud's
 *    default is `/Shared`) mounts received shares one level down, inside a
 *    folder the account itself owns. ../nextcloud/ocs.js asks where they are.
 *  - Filtered, because the account's files home also holds whatever Nextcloud
 *    seeded it with on first login (README §1 step 2 requires that login), and
 *    the viewer must never see that. ../nextcloud/shares.js tells a received
 *    share apart from the account's own content.
 *
 * Both are needed. Filtering alone shows an empty page whenever a share_folder
 * is configured; locating alone would let skeleton files through.
 *
 * NOTHING HERE ADVANCES A VISIT. Wandering through folders must not spend the
 * baseline the stream's New badges are measured against -- see
 * ../store/visits.js and ./stream.js.
 */
export default async function registerFileRoutes(app) {
  // Each logged at most once per process: a page refreshed all day must not
  // repeat the same warning on every load.
  let warnedNoShareSignal = false;
  let warnedNoShareLookup = false;
  let warnedFilteredEverything = false;

  /**
   * List every folder that can hold a received share, and return their entries
   * pooled together.
   *
   * The files home is always one of them, so the common single-PROPFIND case is
   * unchanged. A share_folder instance adds exactly one more.
   *
   * A root that fails is logged and skipped rather than failing the page -- a
   * share_folder can be renamed or a share revoked between the OCS answer and
   * the listing. If they ALL fail the first error is rethrown, so a genuinely
   * unreachable Nextcloud still reaches the "taking a break" page instead of
   * rendering as an empty one.
   */
  async function listShareRoots(request, rootEntries, roots) {
    if (roots.length === 1) return rootEntries; // just the files home

    const extraRoots = roots.filter((root) => root !== '');
    const settled = await Promise.allSettled(
      extraRoots.map((root) => propfind(app.nextcloud, root))
    );

    const pooled = [...rootEntries];
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        pooled.push(...result.value);
      } else {
        request.log.warn(
          { err: result.reason, root: extraRoots[index] },
          'could not list a share-folder root; its shares will be missing from the files page'
        );
      }
    }
    return pooled;
  }

  /** The folder home: one tile per thing the owner has shared. */
  async function renderFilesHome(request, reply) {
    // Concurrent on purpose: the folder listing and the share lookup are
    // independent, and on a phone the difference between one round trip and
    // two is felt. The files home is listed unconditionally because it is a
    // share root whatever the OCS answer turns out to be.
    const [rootEntries, received] = await Promise.all([
      propfind(app.nextcloud, ''),
      listReceivedShareTargets(app.nextcloud, { log: request.log }),
    ]);

    if (!received.ok && !warnedNoShareLookup) {
      warnedNoShareLookup = true;
      request.log.warn(
        { reason: received.reason },
        'could not ask Nextcloud where received shares are mounted; falling back to ' +
          'the files home alone. If this instance sets share_folder, shares live one ' +
          'level down and the page will look empty.'
      );
    }

    const roots = shareListingRoots(received.targets);
    const entries = await listShareRoots(request, rootEntries, roots);

    // Only these top levels are filtered: a sub-folder is inside a share by
    // construction, so there is nothing left to tell apart once you're in one.
    // `sawSignal` false means Nextcloud sent neither oc:permissions nor
    // oc:owner-id on ANY entry -- an odd or very old server -- in which case
    // every entry survived unfiltered and the page is exactly what it was
    // before this existed, aside from the one warning below.
    const { entries: shared, sawSignal } = selectReceivedShares(entries, {
      user: app.nextcloud.user,
    });
    if (!sawSignal && entries.length > 0 && !warnedNoShareSignal) {
      warnedNoShareSignal = true;
      request.log.warn(
        'Nextcloud returned no oc:permissions or oc:owner-id for the files home; ' +
          'showing every top-level entry, skeleton content included.'
      );
    }

    // Filtering away EVERYTHING is almost always a bug rather than an empty
    // account, and it renders as "Nothing has been shared with you yet" -- a
    // sentence that reads like a fact about sharing and gives no hint that a
    // filter was involved. Worth one line in the log saying so.
    if (shared.length === 0 && entries.length > 0 && !warnedFilteredEverything) {
      warnedFilteredEverything = true;
      request.log.warn(
        { listed: entries.length, roots },
        'every top-level entry was judged to be the viewer account\'s own content, so ' +
          'the files page is empty. If this instance sets share_folder and the OCS share ' +
          'lookup failed, the shares are one level down and were never listed.'
      );
    }

    return reply.view('files-home', {
      title: 'Shared files',
      viewer: request.viewer,
      tiles: toTiles(sortEntries(shared)),
      showToggle: true,
      section: 'files',
      // Back goes to the stream: Files is a section now, not the root of the
      // app, and she should never be stranded in it.
      showBack: true,
      backHref: '/',
      breadcrumbs: [],
    });
  }

  async function renderFolder(request, reply, rawPath) {
    // Fastify already percent-decoded the wildcard; normalize + validate here.
    const path = normalizeRelPath(rawPath);

    // `/files/` is the folder home under another name.
    if (path === '') return renderFilesHome(request, reply);

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
      // Up one level, and the chain ends at the folder home rather than at the
      // stream: backing out of Biology 101 should leave her among the folders.
      backHref: parent === '' ? '/files' : `/files/${encodePath(parent)}`,
      // The toggle rides along on every page: finding Latest or Tasks must
      // never depend on backing out to the top first.
      showToggle: true,
      section: 'files',
    });
  }

  app.get('/files', async (request, reply) => renderFilesHome(request, reply));

  app.get('/files/*', async (request, reply) =>
    renderFolder(request, reply, request.params['*'])
  );
}
