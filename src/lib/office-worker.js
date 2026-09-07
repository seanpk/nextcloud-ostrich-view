import { parentPort, workerData } from 'node:worker_threads';

import mammoth from 'mammoth';

import { sanitizeHtml } from './office.js';

/**
 * The inside of the DOCX sandbox. One document per thread, one message back,
 * then the thread is torn down by `renderDocx` (src/lib/office.js) -- which is
 * also what enforces the timeout and the heap ceiling this file relies on.
 *
 * Everything expensive lives here on purpose: unzipping, XML parsing, base64
 * encoding of embedded pictures, and the sanitizing re-serialize. A document
 * built to be expensive to read therefore burns a thread with a stopwatch on
 * it rather than the event loop that is serving the rest of the app.
 *
 * The one contract with the parent: post exactly one message, shaped either
 * `{ok: true, html, warnings, imagesDropped}` or `{ok: false, error, reason}`.
 * Never throw past this file -- an uncaught throw reaches the parent as a
 * worker `error` event, which is handled, but says less about what happened.
 */

/**
 * An image converter that emits nothing, for the second pass.
 *
 * mammoth's default inlines every picture as a base64 `data:` URI, which is
 * what makes pictures work at all without a second proxied route -- and what
 * makes a photo-heavy document enormous. When the first pass blows the HTML
 * budget we convert again with this, keeping the words and losing the
 * pictures; the page then says so.
 *
 * mammoth still emits an `<img>` for each one, just without a `src`; the
 * sanitizer drops an `img` whose src it will not accept, so none of them
 * reaches the page.
 */
const noImages = mammoth.images.imgElement(() => ({}));

async function convert() {
  const { bytes, maxHtmlBytes } = workerData;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const first = await mammoth.convertToHtml({ buffer });
  let html = first.value;
  let messages = first.messages;
  let imagesDropped = false;

  if (Buffer.byteLength(html) > maxHtmlBytes) {
    const second = await mammoth.convertToHtml({ buffer }, { convertImage: noImages });
    html = second.value;
    messages = second.messages;
    imagesDropped = true;

    // Still too big with the pictures gone: this is a document we cannot put
    // in front of a phone browser at all, so say so and let the page offer the
    // download instead of shipping something that will crash the tab.
    if (Buffer.byteLength(html) > maxHtmlBytes) {
      return {
        ok: false,
        reason: 'too-big',
        error: `Converted HTML is over ${maxHtmlBytes} bytes even without images.`,
      };
    }
  }

  return {
    ok: true,
    // Sanitized here rather than in the parent, so the parent never parses
    // HTML that came out of an untrusted document. See office.js.
    html: sanitizeHtml(html),
    warnings: messages.filter((m) => m.type === 'warning').map((m) => String(m.message)),
    imagesDropped,
  };
}

convert()
  .then((result) => parentPort.postMessage(result))
  .catch((err) =>
    parentPort.postMessage({
      ok: false,
      reason: 'unconvertible',
      // The message only ever reaches a log line; the page says something calm
      // of its own. mammoth's own failures ("Can't find end of central
      // directory") are the useful half of this.
      error: String(err?.message ?? err),
    })
  );
