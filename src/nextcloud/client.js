/**
 * Thin fetch wrapper around one Nextcloud instance.
 *
 * READ-ONLY BY CONSTRUCTION: this module deliberately exposes no way to issue
 * PUT / POST / DELETE / MKCOL / MOVE / COPY / PROPPATCH. The allow-list below
 * is the only set of verbs that can leave the process, so no amount of
 * downstream carelessness can turn the app into a writer. It is now complete:
 * PROPFIND lists, REPORT reads tasks, SEARCH finds what changed, GET/HEAD
 * fetch bytes. Nothing else is ever added here.
 */

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'PROPFIND', 'REPORT', 'SEARCH', 'OPTIONS']);

export class NextcloudError extends Error {
  constructor(message, { status, method, url, body } = {}) {
    super(message);
    this.name = 'NextcloudError';
    this.status = status;
    this.method = method;
    this.url = url;
    this.body = body;
    // 401/403/404 upstream shouldn't surface as our own auth failures.
    this.statusCode = status === 404 ? 404 : 502;
  }
}

export function createClient({ baseUrl, user, appPassword, fetchImpl = globalThis.fetch }) {
  if (!baseUrl) throw new Error('createClient: baseUrl is required');
  if (!user) throw new Error('createClient: user is required');

  const root = String(baseUrl).replace(/\/+$/, '');
  const authorization = 'Basic ' + Buffer.from(`${user}:${appPassword}`, 'utf8').toString('base64');

  /**
   * @param {string} method one of READ_ONLY_METHODS
   * @param {string} path absolute path on the instance, already percent-encoded,
   *                      e.g. `/remote.php/dav/files/ostrich-viewer/Biology%20101`
   * @param {{ headers?: Record<string,string>, body?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<Response>}
   */
  async function request(method, path, options = {}) {
    const verb = String(method).toUpperCase();
    if (!READ_ONLY_METHODS.has(verb)) {
      // Programmer error, not a runtime condition: fail hard and early.
      throw new Error(`Refusing to issue non-read method ${verb}; this client is read-only.`);
    }

    const url = `${root}${path.startsWith('/') ? '' : '/'}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: verb,
        headers: {
          Authorization: authorization,
          'User-Agent': 'ostrich-view/1.0 (+read-only)',
          ...options.headers,
          // Last, so no caller can undo it. undici asks for gzip by default
          // and decompresses transparently, but leaves Content-Length
          // describing the *compressed* body -- and /content/* relays that
          // header while streaming the decoded bytes. Asking for identity
          // keeps the two in agreement at the one place every request passes
          // through. The bodies we proxy are photos and PDFs, already
          // compressed; the XML is small and local.
          'Accept-Encoding': 'identity',
        },
        body: options.body,
        signal: options.signal,
        redirect: 'manual',
      });
    } catch (err) {
      throw new NextcloudError(`Could not reach Nextcloud (${verb} ${url}): ${err.message}`, {
        method: verb,
        url,
      });
    }
    return response;
  }

  const filesRoot = `/remote.php/dav/files/${encodeURIComponent(user)}`;
  // Multistatus hrefs include the instance's base path (e.g. /nextcloud when
  // NC_BASE_URL=https://host/nextcloud), so the decoded comparison root must
  // include it too -- filesRoot alone would silently drop every entry.
  const basePath = new URL(root).pathname.replace(/\/+$/, '');

  return {
    baseUrl: root,
    user,
    request,
    /** WebDAV files home for the configured account, percent-safe. */
    filesRoot,
    /** Decoded href prefix as it appears in multistatus responses. */
    davRoot: decodeURIComponent(`${basePath}${filesRoot}`),
  };
}
