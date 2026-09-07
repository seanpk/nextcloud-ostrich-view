import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  MAX_DOCX_BYTES,
  OfficeConversionError,
  createDocumentCache,
  renderDocx,
  sanitizeHtml,
} from '../../src/lib/office.js';

/**
 * Turning a `.docx` into HTML is the one place in this app where an untrusted
 * file is *parsed* rather than proxied, so this suite is mostly about what
 * happens when the file is hostile rather than merely awkward.
 *
 * Anyone the owner shares a folder with can put a document in it. That makes
 * `sanitizeHtml` a security boundary and not a tidying pass, and the shape of
 * the guarantee matters: it does not filter the converter's HTML, it
 * re-serializes it from an allow-list, escaping every text node itself. So the
 * assertions below are all of the form "the dangerous thing is not in the
 * output at all", never "the dangerous thing was neutralised" -- and the
 * escaped-text ones exist because that escaping is what makes a second parse
 * of our output see the same markup the first parse saw, which is what mXSS
 * needs not to be true.
 *
 * The other half is the sandbox: a document that never finishes converting has
 * to cost one failed page rather than a stalled event loop.
 */

const ASSETS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'mock-nextcloud', 'assets');
const SAMPLE_DOCX = readFileSync(join(ASSETS, 'sample.docx'));

// --- the sanitizer: hostile input ------------------------------------------

test('sanitizeHtml: a script tag leaves nothing behind, source included', () => {
  const html = sanitizeHtml('<p>before</p><script>alert(document.cookie)</script><p>after</p>');

  assert.equal(html, '<p>before</p><p>after</p>');
  assert.ok(!html.includes('script'));
  assert.ok(!html.includes('alert'), 'even escaped, the source of a script is not body copy');
});

test('sanitizeHtml: an event handler is never read, so it can never be emitted', () => {
  const html = sanitizeHtml('<p onclick="steal()" onmouseover=steal()>text</p>');

  assert.equal(html, '<p>text</p>');
  assert.ok(!/on\w+=/i.test(html));
});

test('sanitizeHtml: an img with an onerror keeps neither the handler nor a src', () => {
  const html = sanitizeHtml('<img src="x" onerror="alert(1)">');

  // The src is not a data: image, so the whole element goes -- an <img> we
  // would have to strip the src from is an <img> with nothing to show.
  assert.equal(html, '');
});

test('sanitizeHtml: javascript: and data:text/html hrefs are dropped', () => {
  for (const href of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'jAvAsCrIpT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    const html = sanitizeHtml(`<a href="${href}">tap</a>`);
    assert.equal(html, '<a>tap</a>', href);
    assert.ok(!html.toLowerCase().includes('script'), href);
  }
});

test('sanitizeHtml: a relative href is dropped too -- nothing here is ours to link', () => {
  assert.equal(sanitizeHtml('<a href="/logout">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<a href="../secret">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<a href="#anchor">x</a>'), '<a>x</a>');
});

test('sanitizeHtml: a real link survives, with rel and nothing else', () => {
  assert.equal(
    sanitizeHtml('<a href="https://example.com/paper" target="_blank" class="x" id="y">Paper</a>'),
    '<a href="https://example.com/paper" rel="noopener noreferrer">Paper</a>'
  );
  assert.match(sanitizeHtml('<a href="mailto:prof@example.edu">Email</a>'), /^<a href="mailto:/);
  assert.match(sanitizeHtml('<a href="http://example.com/">x</a>'), /^<a href="http:\/\//);
});

test('sanitizeHtml: style and class and id are not attributes we know', () => {
  const html = sanitizeHtml(
    '<p style="position:fixed;inset:0;background:#fff" class="topbar" id="main">text</p>'
  );
  assert.equal(html, '<p>text</p>');
});

test('sanitizeHtml: a style element takes its rules with it', () => {
  const html = sanitizeHtml('<style>body{display:none}</style><p>text</p>');
  assert.equal(html, '<p>text</p>');
  assert.ok(!html.includes('display'));
});

test('sanitizeHtml: SVG and MathML are dropped whole, not walked', () => {
  // Foreign content parses by different rules than HTML, which is the seam
  // mutation XSS lives in. No Word document needs either.
  assert.equal(sanitizeHtml('<svg><script>alert(1)</script></svg><p>ok</p>'), '<p>ok</p>');
  assert.equal(sanitizeHtml('<svg onload="alert(1)"><circle r="9"/></svg>'), '');
  assert.equal(sanitizeHtml('<math><mtext><script>alert(1)</script></mtext></math>'), '');
});

test('sanitizeHtml: iframes, objects, embeds and forms do not survive', () => {
  for (const markup of [
    '<iframe src="https://evil.test/"></iframe>',
    '<object data="x.swf"></object>',
    '<embed src="x.swf">',
    '<form action="/logout" method="post"><button>Sign out</button></form>',
    '<input type="password" name="passphrase">',
    '<base href="https://evil.test/">',
    '<link rel="stylesheet" href="https://evil.test/x.css">',
    '<meta http-equiv="refresh" content="0;url=https://evil.test/">',
  ]) {
    assert.equal(sanitizeHtml(markup), '', markup);
  }
});

test('sanitizeHtml: the classic mXSS shapes come out as text, not as markup', () => {
  // Each of these works by making a *second* parse of the output see markup
  // the first parse did not. Re-serializing with every text node escaped is
  // what makes that impossible: there is no `<` in the output we did not write.
  for (const markup of [
    '</textarea><img src=x onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<noembed><img src=x onerror=alert(1)></noembed>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<template><img src=x onerror=alert(1)></template>',
    '<!--<img src=x onerror=alert(1)>-->',
    '<p title="</p><script>alert(1)</script>">hello</p>',
  ]) {
    const html = sanitizeHtml(markup);
    assert.ok(!/<img/i.test(html), `an <img> survived: ${markup} -> ${html}`);
    assert.ok(!/<script/i.test(html), `a <script> survived: ${markup} -> ${html}`);
    assert.ok(!/onerror/i.test(html), `an onerror survived: ${markup} -> ${html}`);
  }
});

test('sanitizeHtml: angle brackets in the document text are escaped, always', () => {
  assert.equal(
    sanitizeHtml('<p>Compare a &lt; b and a &gt; b, and 5 &amp; 6.</p>'),
    '<p>Compare a &lt; b and a &gt; b, and 5 &amp; 6.</p>'
  );
  // Text that was never markup in the first place still cannot become markup.
  assert.equal(
    sanitizeHtml('<p>Then type <script>alert(1)</script> in the box</p>'),
    '<p>Then type  in the box</p>'
  );
});

test('sanitizeHtml: unclosed and mis-nested tags are re-emitted well-formed', () => {
  // parse5 does the tree construction, so we inherit the HTML spec's answer
  // for what the author meant -- and then write out balanced tags.
  assert.equal(sanitizeHtml('<p>one<p>two'), '<p>one</p><p>two</p>');
  assert.equal(sanitizeHtml('<ul><li>one<li>two</ul>'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(sanitizeHtml('<strong>bold<em>both</strong>italic</em>'), '<strong>bold<em>both</em></strong><em>italic</em>');
  // An <a> inside an <a> is closed by the spec's adoption agency, not by us.
  const nested = sanitizeHtml('<a href="https://a.test/">one<a href="https://b.test/">two</a></a>');
  assert.equal(nested.match(/<a /g).length, 2);
  assert.ok(!nested.includes('<a href="https://a.test/">one<a'));
});

test('sanitizeHtml: an unknown wrapper loses the tag and keeps the words', () => {
  assert.equal(sanitizeHtml('<span>kept</span>'), 'kept');
  assert.equal(sanitizeHtml('<div><section><p>kept</p></section></div>'), '<p>kept</p>');
  assert.equal(sanitizeHtml('<marquee>kept</marquee>'), 'kept');
});

test('sanitizeHtml: an empty or absent input is an empty string', () => {
  assert.equal(sanitizeHtml(''), '');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});

// --- the sanitizer: what a real document needs -----------------------------

test('sanitizeHtml: only mammoth-shaped data: images are kept', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(sanitizeHtml(`<img src="${png}" alt="A cell">`), `<img src="${png}" alt="A cell">`);
  // An absent alt becomes an empty one, which is the right thing to tell a
  // screen reader about a picture we know nothing about.
  assert.equal(sanitizeHtml(`<img src="${png}">`), `<img src="${png}" alt="">`);

  for (const src of [
    'https://evil.test/tracker.png',
    '/preview/1?v=x',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,iVBOR!!',
    'data:image/png;base64,iVBOR\ndata:image/png;base64,x',
    'data:image/png;base64,',
  ]) {
    assert.equal(sanitizeHtml(`<img src="${src}">`), '', src);
  }
});

test('sanitizeHtml: alt text is escaped like any other untrusted string', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  // The alt text is the document's own words about the picture, so it is
  // untrusted like the rest of them. A quote in it must not be able to close
  // the attribute and start a new one.
  assert.equal(
    sanitizeHtml(`<img src="${png}" alt='a" onerror="alert(1)'>`),
    `<img src="${png}" alt="a&quot; onerror=&quot;alert(1)">`
  );
  assert.equal(
    sanitizeHtml(`<img src="${png}" alt="a<b & c>d">`),
    `<img src="${png}" alt="a&lt;b &amp; c&gt;d">`
  );
});

test('sanitizeHtml: tables keep their structure and get a scrolling wrapper', () => {
  const html = sanitizeHtml(
    '<table><thead><tr><th colspan="2">Head</th></tr></thead>' +
      '<tbody><tr><td rowspan="2">a</td><td>b</td></tr></tbody></table>'
  );

  assert.match(html, /^<div class="document__table"><table>/);
  assert.match(html, /<\/table><\/div>$/);
  assert.ok(html.includes('<th colspan="2">'));
  assert.ok(html.includes('<td rowspan="2">'));
});

test('sanitizeHtml: a colspan has to look like a colspan', () => {
  for (const value of ['0', '-1', '1000', 'x', '2; drop', '1e3', '']) {
    assert.ok(
      !sanitizeHtml(`<table><tr><td colspan="${value}">a</td></tr></table>`).includes('colspan'),
      value
    );
  }
});

test('sanitizeHtml: the tags a Word document actually uses all survive', () => {
  const markup =
    '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>' +
    '<p><strong>b</strong><em>i</em><u>u</u><s>s</s><sup>2</sup><sub>2</sub><br><code>c</code></p>' +
    '<ul><li>u</li></ul><ol><li>o</li></ol><blockquote><p>q</p></blockquote><pre>pre</pre>';

  assert.equal(sanitizeHtml(markup), markup);
});

// --- the fixture, converted for real ---------------------------------------

test('renderDocx: the fixture arrives as readable HTML', async () => {
  const { html, warnings, imagesDropped } = await renderDocx(SAMPLE_DOCX);

  assert.deepEqual(warnings, [], 'the fixture should convert cleanly');
  assert.equal(imagesDropped, false);

  // A heading, not a bare paragraph: the style map has to have matched.
  assert.match(html, /<h1>Week 3 — Photosynthesis<\/h1>/);
  // Emphasis inside a paragraph.
  assert.ok(html.includes('<strong>blue</strong>'));
  assert.ok(html.includes('<em>red</em>'));
  // A real bullet list, with all three items.
  assert.match(html, /<ul><li>Light reactions/);
  assert.equal(html.match(/<li>/g).length, 3);
  // The embedded picture, inlined as base64 with the document's own alt text.
  assert.match(html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="A chloroplast/);
  // And the 2x2 table, in its scrolling wrapper.
  assert.ok(html.includes('<div class="document__table">'));
  assert.ok(html.includes('Chlorophyll a'));
  assert.ok(html.includes('Blue-violet'));

  // Nothing that could run.
  assert.ok(!/<script|onerror|javascript:/i.test(html));
});

test('renderDocx: over the HTML budget, the words are kept and the pictures go', async () => {
  // Small enough that the fixture's one inlined PNG blows it, large enough
  // that the text alone does not -- so this exercises the second pass rather
  // than the give-up path below it.
  const { html: full } = await renderDocx(SAMPLE_DOCX);
  const textOnly = full.replace(/<img[^>]*>/g, '');
  const budget = Math.floor((Buffer.byteLength(textOnly) + Buffer.byteLength(full)) / 2);

  const result = await renderDocx(SAMPLE_DOCX, { maxHtmlBytes: budget });

  assert.equal(result.imagesDropped, true);
  assert.ok(!result.html.includes('<img'), 'a src-less <img> must not reach the page either');
  assert.match(result.html, /<h1>Week 3 — Photosynthesis<\/h1>/, 'the words are the point');
});

test('renderDocx: a document too big even without pictures is refused', async () => {
  await assert.rejects(
    () => renderDocx(SAMPLE_DOCX, { maxHtmlBytes: 64 }),
    (err) => {
      assert.ok(err instanceof OfficeConversionError);
      assert.equal(err.reason, 'too-big');
      return true;
    }
  );
});

test('renderDocx: something that is not a docx is refused, not crashed into', async () => {
  await assert.rejects(
    () => renderDocx(Buffer.from('this is not a zip file at all', 'utf8')),
    (err) => {
      assert.ok(err instanceof OfficeConversionError);
      assert.equal(err.reason, 'unconvertible');
      return true;
    }
  );

  await assert.rejects(() => renderDocx(Buffer.alloc(0)), OfficeConversionError);
});

test('renderDocx: a file over the input ceiling is refused before a worker starts', async () => {
  await assert.rejects(
    () => renderDocx(Buffer.alloc(MAX_DOCX_BYTES + 1)),
    (err) => {
      assert.equal(err.reason, 'too-big');
      return true;
    }
  );
});

// --- the sandbox -----------------------------------------------------------

test('renderDocx: a conversion that never finishes is timed out and terminated', async () => {
  // A worker that ignores its input and never answers, which is what a zip
  // bomb or a pathological table looks like from out here. `workerUrl` exists
  // for exactly this: the alternative is checking in a fixture built to hang.
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-office-'));
  const stuck = join(dir, 'stuck-worker.mjs');
  writeFileSync(
    stuck,
    // A busy loop, not a sleep: a cooperative worker would notice a message
    // asking it to stop, and the whole point is that this one cannot.
    'for (;;) {}\n'
  );

  try {
    const started = Date.now();
    await assert.rejects(
      () => renderDocx(SAMPLE_DOCX, { timeoutMs: 300, workerUrl: new URL(`file://${stuck}`) }),
      (err) => {
        assert.ok(err instanceof OfficeConversionError);
        assert.equal(err.reason, 'timeout');
        return true;
      }
    );
    // It really was the clock that ended it, and the clock was ours.
    assert.ok(Date.now() - started < 5_000, 'the timeout, not the event loop, ended this');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderDocx: a worker that dies is a rejection, never a hang', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostrich-office-'));
  const dying = join(dir, 'dying-worker.mjs');
  writeFileSync(dying, 'process.exit(3);\n');

  try {
    await assert.rejects(
      () => renderDocx(SAMPLE_DOCX, { workerUrl: new URL(`file://${dying}`) }),
      (err) => {
        assert.equal(err.reason, 'crashed');
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderDocx: the event loop keeps answering while a document converts', async () => {
  // The reason any of this runs in a worker. A timer scheduled before the
  // conversion has to fire while it is still going -- which it cannot if the
  // parsing happens on this thread.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 2);

  try {
    await renderDocx(SAMPLE_DOCX);
  } finally {
    clearInterval(timer);
  }

  assert.ok(ticks > 0, 'the event loop was blocked for the whole conversion');
});

// --- the result cache ------------------------------------------------------

test('documentCache: tapping the same document twice converts it once', async () => {
  const cache = createDocumentCache();
  let conversions = 0;
  const load = async () => {
    conversions += 1;
    return { html: '<p>x</p>' };
  };

  await cache.get('12-abc', load);
  await cache.get('12-abc', load);

  assert.equal(conversions, 1);
});

test('documentCache: an edited document is a different key, so never stale', async () => {
  const cache = createDocumentCache();
  const first = await cache.get('12-abc', async () => ({ html: '<p>old</p>' }));
  const second = await cache.get('12-def', async () => ({ html: '<p>new</p>' }));

  assert.equal(first.html, '<p>old</p>');
  assert.equal(second.html, '<p>new</p>');
});

test('documentCache: an entry expires', async () => {
  const cache = createDocumentCache({ ttlMs: 1000 });
  let conversions = 0;
  const load = async () => {
    conversions += 1;
    return { html: `<p>${conversions}</p>` };
  };

  assert.equal((await cache.get('k', load, 0)).html, '<p>1</p>');
  assert.equal((await cache.get('k', load, 999)).html, '<p>1</p>');
  assert.equal((await cache.get('k', load, 1001)).html, '<p>2</p>');
});

test('documentCache: it stays bounded by count and by bytes', async () => {
  const byCount = createDocumentCache({ maxEntries: 3 });
  for (let i = 0; i < 20; i += 1) await byCount.get(`k${i}`, async () => ({ html: '<p>x</p>' }));
  assert.ok(byCount.size <= 3, `expected <= 3 entries, got ${byCount.size}`);

  const byBytes = createDocumentCache({ maxEntries: 100, maxBytes: 4096 });
  for (let i = 0; i < 20; i += 1) {
    await byBytes.get(`k${i}`, async () => ({ html: 'x'.repeat(1000) }));
  }
  assert.ok(byBytes.bytes <= 4096, `expected <= 4096 bytes, got ${byBytes.bytes}`);
});

test('documentCache: one enormous document is served and forgotten', async () => {
  const cache = createDocumentCache({ maxBytes: 100 });
  const value = await cache.get('k', async () => ({ html: 'x'.repeat(1000) }));

  assert.equal(value.html.length, 1000, 'it is still returned');
  assert.equal(cache.size, 0, 'but it did not evict the cache to get in');
  assert.equal(cache.bytes, 0);
});

test('documentCache: a failed conversion is never remembered', async () => {
  const cache = createDocumentCache();
  let attempts = 0;
  const load = async () => {
    attempts += 1;
    if (attempts === 1) throw new OfficeConversionError('nope', { reason: 'timeout' });
    return { html: '<p>ok</p>' };
  };

  await assert.rejects(() => cache.get('k', load));
  assert.equal(cache.size, 0);
  assert.equal((await cache.get('k', load)).html, '<p>ok</p>');
});
