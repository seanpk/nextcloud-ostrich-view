/**
 * The OCS Share API -- read side only, and only one question: "what has been
 * shared WITH this account?"
 *
 * Why this exists at all, when ./shares.js can already tell a received share
 * apart from the account's own content: because on an instance with a
 * `share_folder` configured (Nextcloud's default value is `/Shared`), received
 * shares are not mounted at the top of the account's files home. They are
 * mounted inside a folder that the account OWNS -- Nextcloud creates it -- and
 * which therefore carries neither the `S`/`M` permission letters nor a foreign
 * `oc:owner-id`. It is indistinguishable from skeleton content by inspection,
 * so a filter over the root alone drops it and every share underneath it.
 *
 * This endpoint answers where the shares actually are, whatever `share_folder`
 * is set to -- a value the app cannot read for itself, since the viewer account
 * is deliberately not an admin.
 *
 * `?shared_with_me=true` is the INCOMING direction. Note the contrast with
 * `oc:share-types` in ./shares.js, which reports shares the account has
 * created (outgoing) and is empty for a read-only viewer.
 *
 * GET only, so the read-only client in ./client.js needs no new verb.
 */

const SHARES_PATH =
  '/ocs/v2.php/apps/files_sharing/api/v1/shares?shared_with_me=true&format=json';

/**
 * Strip a `file_target` down to a path relative to the files home.
 *
 * `file_target` arrives absolute-looking (`/Shared/Family`) but is relative to
 * the recipient's root, which is exactly what propfind() wants without the
 * leading slash.
 *
 * @param {unknown} target
 * @returns {string|null} null when there is nothing usable here
 */
function toRelPath(target) {
  if (typeof target !== 'string') return null;
  const trimmed = target.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}

/**
 * Where are this account's received shares mounted?
 *
 * Never throws: a missing app, an OCS error envelope, HTML from a login
 * redirect, unparseable JSON -- all of it comes back as `ok: false`, because
 * the home page has a working fallback (filter the root) and must not fail over
 * a lookup that only IMPROVES the answer. The caller logs and carries on.
 *
 * @param {ReturnType<import('./client.js').createClient>} client
 * @param {{ log?: {warn: Function, debug: Function} }} [options]
 * @returns {Promise<{ok: boolean, targets: string[], reason: string|null}>}
 *   `targets` are relative paths ('Shared/Family'), deduplicated, in the order
 *   the server listed them. `ok: false` means "could not determine", which is
 *   NOT the same as `ok: true` with an empty list -- that one means the account
 *   genuinely has no shares.
 */
export async function listReceivedShareTargets(client, { log } = {}) {
  const fail = (reason) => ({ ok: false, targets: [], reason });

  let response;
  try {
    response = await client.request('GET', SHARES_PATH, {
      headers: {
        // Without this Nextcloud answers 401 regardless of credentials: it is
        // the CSRF guard for the OCS endpoints, and its presence is the whole
        // check -- the value is not inspected.
        'OCS-APIRequest': 'true',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    // Includes NC_UNREACHABLE. The root PROPFIND runs concurrently and will
    // raise the same condition in a form the error pages already understand,
    // so this one is only ever a log line.
    return fail(`request failed: ${err.message}`);
  }

  if (response.status !== 200) {
    await response.arrayBuffer().catch(() => {});
    return fail(`HTTP ${response.status}`);
  }

  let json;
  try {
    json = JSON.parse(await response.text());
  } catch (err) {
    // A login redirect body, an error page, a proxy's apology.
    return fail(`unparseable JSON: ${err.message}`);
  }

  // OCS reports its own status inside a 200. 200 and 100 both mean success --
  // v1 of the API used 100 and some builds still answer with it.
  const statusCode = json?.ocs?.meta?.statuscode;
  if (statusCode !== undefined && statusCode !== 200 && statusCode !== 100) {
    return fail(`OCS statuscode ${statusCode}`);
  }

  const data = json?.ocs?.data;
  if (!Array.isArray(data)) return fail('no ocs.data array in the response');

  const targets = [];
  for (const share of data) {
    const relPath = toRelPath(share?.file_target);
    if (relPath !== null && !targets.includes(relPath)) targets.push(relPath);
  }

  log?.debug?.({ shares: data.length, targets: targets.length }, 'received shares (OCS)');
  return { ok: true, targets, reason: null };
}
