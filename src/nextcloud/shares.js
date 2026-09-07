/**
 * Telling a received share apart from the viewer account's own content.
 *
 * Nextcloud seeds a brand-new account with skeleton files (`Documents`,
 * `Photos`, `Templates`, a welcome PDF) the first time it logs in -- and the
 * app's setup requires exactly that login (README §1 step 2). Left alone,
 * those skeleton entries sit at the top level indistinguishable from the
 * folders the owner actually shared. This module is the filter.
 *
 * Pure, no I/O, no client -- same shape as ../lib/stream.js. The route
 * decides what to do with the verdicts; this only produces them.
 */

/**
 * Does one root-level PROPFIND entry look like a received share?
 *
 * Two independent signals, read off `oc:permissions` and `oc:owner-id`
 * (requested by PROPFIND_BODY in ./webdav.js and carried on the entry by
 * `toEntry`). A positive from either is enough -- they are OR'd, not
 * AND'd, so a Nextcloud version that only fills in one of them still works:
 *
 *  - `permissions` containing `S` (Shared) or `M` (Mounted, e.g. a group
 *    folder) marks a received share and everything under it. The account's
 *    own storage carries neither letter.
 *  - `ownerId` differing from the configured account (case-insensitively --
 *    Nextcloud logins are case-insensitive on several backends) marks a file
 *    or folder whose owner is not us, i.e. also a received share.
 *
 * `oc:share-types` is deliberately not used: it reports shares the account
 * has CREATED (outgoing), and a read-only viewer creates none -- it would be
 * empty for every entry and filter everything away.
 *
 * @param {{permissions: string|null, ownerId: string|null}} entry
 * @param {{user: string}} options the configured NC_USER
 * @returns {true|false|null} true = share, false = the account's own
 *   content, null = the server offered no signal for this entry at all
 */
export function shareSignal(entry, { user }) {
  const permissions = entry?.permissions;
  const ownerId = entry?.ownerId;

  let verdict = null;

  if (typeof permissions === 'string' && permissions !== '') {
    if (/[SM]/.test(permissions)) return true;
    verdict = false;
  }

  if (typeof ownerId === 'string' && ownerId !== '') {
    if (ownerId.toLowerCase() !== String(user).toLowerCase()) return true;
    verdict = verdict === null ? false : verdict;
  }

  return verdict;
}

/**
 * Filter root-level entries down to received shares.
 *
 * An entry with an unknown verdict (`shareSignal` returned null) is KEPT,
 * not dropped -- this is what makes the fallback safe. If a Nextcloud
 * version omits both properties from every response, every verdict is
 * null, nothing is filtered, and the page renders exactly as it did before
 * this module existed, aside from one warning the caller can log via
 * `sawSignal`.
 *
 * @param {Array<object>} entries root-level entries from propfind()
 * @param {{user: string}} options
 * @returns {{entries: Array<object>, dropped: number, sawSignal: boolean}}
 */
export function selectReceivedShares(entries, { user }) {
  const list = entries ?? [];
  let sawSignal = false;

  const kept = list.filter((entry) => {
    const verdict = shareSignal(entry, { user });
    if (verdict !== null) sawSignal = true;
    return verdict !== false;
  });

  return { entries: kept, dropped: list.length - kept.length, sawSignal };
}

/**
 * Which folders must be listed to show every received share as a tile?
 *
 * Always includes the files home (`''`). Received shares that ARE mounted at
 * the top show up there, and so do things the OCS Share API never reports at
 * all -- a group folder arrives as a `M`-flagged mount rather than a share, and
 * `selectReceivedShares` is what catches it.
 *
 * Then one entry per distinct PARENT of a share target. With
 * `share_folder = /Shared`, targets look like `Shared/Family`, the parent is
 * `Shared`, and listing it yields the shares as its children -- each carrying
 * `S` and a foreign owner, so the filter passes them through. The container
 * folder itself is dropped from the root listing by that same filter, since the
 * account owns it, which is exactly right: its children are listed separately
 * and would otherwise appear twice.
 *
 * A parent that sits INSIDE another target is skipped. Listing it would spill
 * one share's contents onto the home page as if they were shares themselves.
 * Nextcloud does not normally nest a mount inside another mount, but the cost
 * of being wrong here is a confusing home page, and the guard is one line.
 *
 * @param {string[]} targets relative paths from listReceivedShareTargets()
 * @returns {string[]} relative folder paths to PROPFIND, `''` first
 */
export function shareListingRoots(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const roots = [''];

  const isInsideATarget = (path) =>
    list.some((target) => path === target || path.startsWith(`${target}/`));

  for (const target of list) {
    const slash = target.lastIndexOf('/');
    if (slash < 0) continue; // mounted at the top; '' already covers it
    const parent = target.slice(0, slash);
    if (parent === '' || roots.includes(parent) || isInsideATarget(parent)) continue;
    roots.push(parent);
  }

  return roots;
}
