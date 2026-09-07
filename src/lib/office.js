import { Worker } from 'node:worker_threads';

import { parseFragment } from 'parse5';

/**
 * Turning a Word document into something readable on a phone.
 *
 * The bargain: exact layout is given up on purpose, and the words, headings,
 * lists, tables, emphasis and pictures are kept. A `.docx` becomes ordinary
 * HTML that reflows in one column, which is what a phone can actually show --
 * and the viewer page offers the original alongside it for anyone who wants
 * the real thing in Word. No LibreOffice, no Collabora, no page images.
 *
 * Two things in here exist entirely because of who can put a file in a shared
 * folder. Anyone the owner shares with can drop a document in, so a `.docx`
 * arriving at this module is untrusted input in the ordinary web sense:
 *
 *  - **The conversion runs in a worker thread**, with a wall-clock timeout and
 *    a heap ceiling. A zip bomb, a pathological table or a document that
 *    expands to a gigabyte must cost one failed page and nothing else; it must
 *    never stall the event loop that is also serving her photos. `renderDocx`
 *    terminates the worker on timeout rather than hoping it notices.
 *  - **The HTML is re-serialized from an allow-list**, not filtered. `mammoth`
 *    is not a security boundary and does not claim to be: document text can
 *    contain angle brackets, styles can carry names, and a hostile file can aim
 *    all of it at whatever reads the output. So the output is parsed with
 *    parse5 (a spec-compliant HTML tokenizer) and written out again from
 *    scratch -- known tags, known attributes, every text node escaped by us.
 *    Nothing survives that we did not decide to emit, which is what makes the
 *    `| safe` in views/view.njk defensible. See `sanitizeHtml`.
 *
 * The sanitizing happens *inside* the worker (see office-worker.js), so the
 * main thread never parses attacker-controlled HTML at all -- the whole cost
 * of a hostile document, parsing included, sits behind the same timeout.
 */

/** Wall clock a single conversion is allowed. Generous for a real document. */
export const CONVERT_TIMEOUT_MS = 10_000;

/** Heap ceiling for the worker. Enough for a photo-heavy report, not a bomb. */
export const CONVERT_HEAP_MB = 256;

/**
 * Biggest `.docx` we will read at all, in bytes.
 *
 * Checked against `oc:size` before a byte is fetched, so an enormous file
 * costs one PROPFIND rather than a download. Past this the viewer page just
 * offers the download.
 */
export const MAX_DOCX_BYTES = 15 * 1024 * 1024;

/**
 * Biggest HTML we will hand a browser, in bytes.
 *
 * A document with a dozen full-resolution photos in it becomes tens of
 * megabytes of base64, which is a phone running out of memory rather than a
 * page. Past this the pictures are dropped and the text is kept -- see
 * `imagesDropped`, which the page turns into "Pictures were left out".
 */
export const MAX_HTML_BYTES = 6 * 1024 * 1024;

const WORKER_URL = new URL('./office-worker.js', import.meta.url);

/** A conversion that failed for a reason worth logging as `warn`, not `error`. */
export class OfficeConversionError extends Error {
  /** @param {string} message @param {{reason: string, cause?: unknown}} options */
  constructor(message, { reason, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OfficeConversionError';
    /** One of: too-big, timeout, crashed, unconvertible. */
    this.reason = reason ?? 'unconvertible';
  }
}

/**
 * Convert a `.docx` into sanitized, phone-readable HTML.
 *
 * Everything hard happens in the worker; this function is the sandbox around
 * it. It resolves with what the page needs and rejects with an
 * `OfficeConversionError` on anything else -- the route turns that into the
 * calm "we can't show this one" page with a download button, never a 500.
 *
 * The worker is terminated on timeout. Termination is not cooperative: a
 * document that has mammoth spinning inside one synchronous XML parse would
 * ignore any message we sent it, which is exactly the case the timeout exists
 * for.
 *
 * @param {Buffer|Uint8Array} bytes the whole `.docx`
 * @param {{maxHtmlBytes?: number, timeoutMs?: number, heapMb?: number,
 *          workerUrl?: URL}} [options] `workerUrl` is for tests only -- it is
 *   how the timeout path is exercised without a pathological fixture.
 * @returns {Promise<{html: string, warnings: string[], imagesDropped: boolean}>}
 */
export function renderDocx(bytes, options = {}) {
  const {
    maxHtmlBytes = MAX_HTML_BYTES,
    timeoutMs = CONVERT_TIMEOUT_MS,
    heapMb = CONVERT_HEAP_MB,
    workerUrl = WORKER_URL,
  } = options;

  if (!bytes || bytes.length === 0) {
    return Promise.reject(new OfficeConversionError('Empty document.', { reason: 'unconvertible' }));
  }
  if (bytes.length > MAX_DOCX_BYTES) {
    return Promise.reject(
      new OfficeConversionError(`Document is ${bytes.length} bytes.`, { reason: 'too-big' })
    );
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      // A copy, not a transfer: the caller may still want these bytes (the
      // stat memo hands the same buffer to a second, concurrent request), and
      // a detached ArrayBuffer is a far more confusing bug than one memcpy.
      workerData: { bytes: Buffer.from(bytes), maxHtmlBytes },
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    });

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always tear the thread down: on the happy path it has nothing left to
      // do, and on every other path it may have plenty.
      worker.terminate().catch(() => {});
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(
        reject,
        new OfficeConversionError(`Conversion did not finish within ${timeoutMs}ms.`, {
          reason: 'timeout',
        })
      );
    }, timeoutMs);

    worker.on('message', (message) => {
      if (message?.ok) {
        finish(resolve, {
          html: String(message.html ?? ''),
          warnings: Array.isArray(message.warnings) ? message.warnings.map(String) : [],
          imagesDropped: Boolean(message.imagesDropped),
        });
        return;
      }
      finish(
        reject,
        new OfficeConversionError(String(message?.error ?? 'Conversion failed.'), {
          reason: String(message?.reason ?? 'unconvertible'),
        })
      );
    });

    worker.on('error', (err) => {
      // Includes the resourceLimits kill: exceeding the heap ceiling arrives
      // here as an ERR_WORKER_OUT_OF_MEMORY error, not as a silent exit.
      finish(reject, new OfficeConversionError(`Worker failed: ${err.message}`, {
        reason: 'crashed',
        cause: err,
      }));
    });

    worker.on('exit', (code) => {
      finish(
        reject,
        new OfficeConversionError(`Worker exited with code ${code} before answering.`, {
          reason: 'crashed',
        })
      );
    });
  });
}

// --- the sanitizer ---------------------------------------------------------

/**
 * Tags that may appear in the output. Everything a `.docx` can reasonably
 * carry into a web page, and nothing that can do anything.
 */
const ALLOWED_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'sup',
  'sub',
  'br',
  'a',
  'img',
  'blockquote',
  'pre',
  'code',
]);

/** Allowed tags that never have children or a closing tag. */
const VOID_TAGS = new Set(['br', 'img']);

/**
 * Tags whose *contents* are dropped along with the tag itself.
 *
 * An unknown tag normally keeps its text -- a `<span>` wrapping a sentence
 * should not eat the sentence. But the text inside these is never prose, and
 * emitting it (escaped, so inert, but visible) would put the source of a
 * script or a stylesheet on the page as body copy. Better gone.
 */
const DROP_SUBTREE = new Set([
  'script',
  'style',
  'noscript',
  'noframes',
  'noembed',
  'template',
  'iframe',
  'object',
  'embed',
  'applet',
  'title',
  'textarea',
  'xmp',
  'plaintext',
  'svg',
  'math',
  'head',
  'link',
  'meta',
  'base',
  'form',
  'button',
  'input',
  'select',
  'option',
  'audio',
  'video',
  'canvas',
  'frame',
  'frameset',
]);

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** Schemes a link in a shared document may point at. */
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * The only `img` sources we emit: mammoth's own inline base64, and nothing
 * else. Anchored, and the character class excludes every whitespace and
 * control character, so there is no newline to hide a second URL behind.
 *
 * `data:` is what our CSP already allows (`img-src 'self' data:`); a remote
 * `src` would be blocked by the browser anyway and would leak that she opened
 * this document to whoever the document names.
 */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A colspan or rowspan a real table might have: 1-99. */
const SMALL_INT = /^[1-9][0-9]?$/;

/** `&`, `<` and `>` are what make a text node stop being a text node. */
function escapeText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** As above, plus the quote that would end the attribute value. */
function escapeAttribute(value) {
  return escapeText(value).replaceAll('"', '&quot;');
}

/**
 * A link target we are willing to emit, or null.
 *
 * Parsed with the URL parser rather than pattern-matched: `java\tscript:` and
 * `JavaScript:` and `javascript:` are all the same URL, and only a real
 * parser reliably says so. A relative or unparseable href is dropped -- there
 * is nothing on this origin a shared document has any business linking to.
 */
function safeHref(value) {
  try {
    const url = new URL(String(value));
    return LINK_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The attributes one allowed tag may keep, already escaped and ready to emit.
 * Anything not named here -- `style`, `class`, `id`, every `on*` -- is simply
 * not read.
 */
function attributesFor(tagName, attrs) {
  const get = (name) => attrs.find((attr) => attr.name === name && !attr.prefix)?.value;
  const out = [];

  if (tagName === 'a') {
    const href = safeHref(get('href') ?? '');
    if (!href) return []; // an <a> with nothing safe to point at is just text
    out.push(`href="${escapeAttribute(href)}"`);
    // The document is someone else's; the tab it opens is not ours to lend.
    out.push('rel="noopener noreferrer"');
    return out;
  }

  if (tagName === 'img') {
    const src = String(get('src') ?? '');
    if (!DATA_IMAGE.test(src)) return null; // drop the element, not just the src
    out.push(`src="${escapeAttribute(src)}"`);
    // Alt text comes from the document's own description of the picture; it is
    // escaped like any other untrusted string. An absent one becomes `alt=""`,
    // which is the correct thing to tell a screen reader about a decoration we
    // know nothing about.
    out.push(`alt="${escapeAttribute(get('alt') ?? '')}"`);
    return out;
  }

  if (tagName === 'td' || tagName === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const value = String(get(name) ?? '');
      if (SMALL_INT.test(value)) out.push(`${name}="${value}"`);
    }
    return out;
  }

  return out;
}

/**
 * Re-serialize HTML from an allow-list.
 *
 * Not a filter and not a rewriter: the input is parsed into a tree and a new
 * document is written from it, tag by tag, with every text node escaped on the
 * way out. That is what defeats mutation XSS -- the classic
 * `</textarea><img onerror>` and `<svg><p>` tricks work by making a *second*
 * parse of the output see different markup than the first parse did, and there
 * is no markup here that we did not write ourselves.
 *
 * Tables come out wrapped in `<div class="document__table">` so the stylesheet
 * can let a wide table scroll inside its own box instead of pushing the whole
 * page sideways on a phone. That is the one element this function adds.
 *
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  const fragment = parseFragment(String(html ?? ''));
  const out = [];

  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      const name = node.nodeName;

      if (name === '#text') {
        out.push(escapeText(node.value ?? ''));
        continue;
      }
      // Comments, doctypes and parse5's own document nodes carry nothing we
      // want; a comment in particular is a favourite mXSS vehicle.
      if (name.startsWith('#')) continue;

      const tagName = String(node.tagName ?? '').toLowerCase();

      // Foreign content (SVG, MathML) is dropped wholesale rather than
      // walked: its parsing rules differ from HTML's, which is precisely the
      // seam mXSS lives in, and no Word document needs it.
      if (node.namespaceURI && node.namespaceURI !== HTML_NS) continue;
      if (DROP_SUBTREE.has(tagName)) continue;

      if (!ALLOWED_TAGS.has(tagName)) {
        // An unknown wrapper loses the tag and keeps the words.
        walk(node.childNodes);
        continue;
      }

      const attributes = attributesFor(tagName, node.attrs ?? []);
      if (attributes === null) continue; // e.g. an <img> with a src we refuse

      const open = attributes.length > 0 ? `<${tagName} ${attributes.join(' ')}>` : `<${tagName}>`;

      if (VOID_TAGS.has(tagName)) {
        out.push(open);
        continue;
      }

      if (tagName === 'table') out.push('<div class="document__table">');
      out.push(open);
      walk(node.childNodes);
      out.push(`</${tagName}>`);
      if (tagName === 'table') out.push('</div>');
    }
  };

  walk(fragment.childNodes);
  return out.join('');
}

// --- the result cache ------------------------------------------------------

/**
 * A small, bounded memo of converted documents.
 *
 * Converting is expensive enough that backing out of a document and tapping it
 * again should not pay for it twice -- which is exactly what she does on a
 * phone. Keyed by `fileId-etag`, so an edited document is a different key and
 * a stale render is impossible rather than merely unlikely.
 *
 * Bounded three ways, because the values here are whole documents rather than
 * the few hundred bytes `createStatCache` in routes/media.js holds: a total
 * byte budget, an entry count, and a TTL. That byte budget is why this is a
 * separate cache and not that one generalized -- and when the budget is spent
 * the map is cleared outright, the same deliberately-not-an-LRU trade as
 * there: the working set is one household's coursework, and re-converting one
 * document occasionally is cheaper than tracking recency.
 *
 * @param {{ttlMs?: number, maxEntries?: number, maxBytes?: number}} [options]
 */
export function createDocumentCache({
  ttlMs = 10 * 60_000,
  maxEntries = 20,
  maxBytes = 32 * 1024 * 1024,
} = {}) {
  const entries = new Map();
  let bytes = 0;

  const drop = (key) => {
    const hit = entries.get(key);
    if (!hit) return;
    bytes -= hit.bytes;
    entries.delete(key);
  };

  return {
    /**
     * The cached render for `key`, or `load()`'s result, remembered.
     *
     * A failure is never cached: a document that could not be converted
     * because Nextcloud hiccupped should be retried, and one that cannot be
     * converted at all is cheap to refuse again.
     *
     * @param {string} key `${fileId}-${etag}`
     * @param {() => Promise<{html: string}>} load
     */
    async get(key, load, now = Date.now()) {
      const hit = entries.get(key);
      if (hit) {
        if (hit.expires > now) return hit.value;
        drop(key);
      }

      const value = await load();
      const size = typeof value?.html === 'string' ? Buffer.byteLength(value.html) : 0;

      // One document larger than the whole budget is not worth evicting
      // everything for; it is served and forgotten.
      if (size <= maxBytes) {
        if (entries.size >= maxEntries || bytes + size > maxBytes) {
          entries.clear();
          bytes = 0;
        }
        entries.set(key, { value, bytes: size, expires: now + ttlMs });
        bytes += size;
      }

      return value;
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
