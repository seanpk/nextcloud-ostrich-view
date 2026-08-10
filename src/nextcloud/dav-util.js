/**
 * The shape-agnostic half of multistatus handling, shared by webdav.js (files)
 * and caldav.js (calendars).
 *
 * The two modules configure fast-xml-parser differently -- caldav.js keeps
 * attributes because `<cal:comp name="VTODO"/>` is nothing but an attribute --
 * but these walkers only ever look at `propstat`/`prop`/`href`, which parse the
 * same either way. Keeping one copy is what stops the two status checks from
 * drifting apart again.
 */

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Merge every `propstat` block that carries a 2xx status. Nextcloud splits
 * found and not-found properties into separate blocks, and the not-found one
 * would otherwise clobber real values with empty strings.
 *
 * The status match is deliberately permissive: servers write the line as
 * `HTTP/1.1 200 OK`, `HTTP/2 200`, or (rarely) a bare `200`, and a block we
 * fail to recognise as successful silently drops every property in it.
 */
export function collectProps(response) {
  const merged = {};
  for (const propstat of asArray(response.propstat)) {
    const status = String(propstat?.status ?? '');
    if (!/\s2\d\d\s/.test(` ${status} `) && !/HTTP\/[\d.]+\s+2\d\d/.test(status)) continue;
    Object.assign(merged, propstat.prop ?? {});
  }
  return merged;
}

/**
 * An `<d:href>` as a decoded path. It may arrive as a full URL (some servers)
 * or as an absolute path (Nextcloud), and a percent sequence that isn't valid
 * UTF-8 must not throw the whole listing away.
 */
export function decodeHref(href) {
  const raw = String(href ?? '');
  const pathOnly = /^https?:\/\//i.test(raw) ? new URL(raw).pathname : raw.split('?')[0];
  try {
    return decodeURIComponent(pathOnly);
  } catch {
    return pathOnly;
  }
}

export function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}
