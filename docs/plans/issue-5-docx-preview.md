# Issue #5 — Viewing DOCX (and downloading office files)

Status: planned 2026-09-07. Implements the DOCX half of #5; PPTX/XLSX get a
download affordance and are left for a follow-up.

## Decisions (made with Sean, 2026-09-07)

- **Render DOCX as readable HTML, not as page images.** Conversion happens
  server-side with `mammoth` (pure JS, no LibreOffice, no Collabora). The page
  reflows on a phone like any web page. Exact layout is lost on purpose; headings,
  lists, tables, bold/italic and embedded pictures survive.
- **Do not depend on the Collabora container**, even though it may be installed.
- **Offer the original for download** on every office-file page, so anyone who
  wants the real layout can open it in Word/Pages/Google Docs. The download button
  appears for office types (DOCX/PPTX/XLSX and their legacy/OpenDocument
  siblings) **and for PDFs** (Sean, 2026-09-07), not for every unviewable file.
- **DOCX only is rendered in this pass.** PPTX and XLSX show the existing calm
  "we can't show this one" page plus the download button. XLSX-as-table is a
  possible follow-up; PPTX has no good pure-JS renderer and stays download-only.

## What changes for the reader

- A `.docx` tile in a folder (or in the stream) becomes tappable, like a PDF.
- Tapping it opens `/view/<path>`: the document's text, large and readable, with
  a **Download the original** button above it. The fixed Back button works as
  everywhere else.
- A `.pptx` / `.xlsx` tile is also tappable now; the page says we can't show it
  on screen and offers the download.
- Nothing else moves. Photos and PDFs behave exactly as before.

## Design

### 1. `src/lib/filetypes.js` — the table grows two columns

Add office types to `TYPES`. Two new per-type fields:

| field | meaning |
|---|---|
| `converts` | `'docx'` when we can turn the bytes into HTML ourselves. Absent otherwise. |
| `download` | `true` when the page should offer the original as a download. |

Rows to add (all `kind: 'document'`, no `serveAs` — `/content/*` keeps serving
them as `application/octet-stream`, exactly as today):

- `application/pdf` — existing row gains `download: true`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` — `converts: 'docx', download: true`
- `application/vnd.openxmlformats-officedocument.presentationml.presentation` — `download: true`
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` — `download: true`
- `application/msword`, `application/vnd.ms-powerpoint`, `application/vnd.ms-excel` — `download: true`
- `application/vnd.oasis.opendocument.text|presentation|spreadsheet` — `download: true`

New helpers, alongside the existing ones:

- `convertsInline(entry)` → `'docx' | null` (from the content type only, never
  the file name — same rule as `rendersInline`).
- `canView(entry)` → `rendersInline(entry) || convertsInline(entry) !== null`.
  This is what a tile's `href` decision moves to (see §4).
- `isDownloadable(entry)` → boolean.
- `downloadContentType(entry)` → the real MIME for downloadable types, else
  `application/octet-stream`. Safe because it is only ever sent with
  `Content-Disposition: attachment` (§3) — a browser never renders an attachment,
  so the XSS argument that keeps HTML/SVG out of `serveAs` does not apply here.

Keep `EXTENSION_KINDS` as the icon-only fallback; add `pptx`, `xlsx`, `ppt`,
`xls`, `odt`, `odp`, `ods`. Optional polish: `spreadsheet` and `slides` kinds
with their own icons — only if cheap; `document` for all office files is
acceptable.

Update the file's header comment: the invariants are now
`renders ⊂ serveAs` (unchanged) and `converts` never coexists with `serveAs`.

### 2. `src/lib/office.js` — DOCX → sanitized HTML (pure, unit-testable)

```js
export async function renderDocx(buffer, { maxHtmlBytes }) → { html, warnings, imagesDropped }
export function sanitizeHtml(html) → string
```

- `renderDocx` runs mammoth `convertToHtml({ buffer })`. Images come out as
  `data:` URIs (mammoth's default), which our CSP already allows (`img-src 'self' data:`).
  If the HTML exceeds `maxHtmlBytes` (suggest 6 MB), convert again with images
  dropped (`mammoth.images.imgElement(() => ({}))`-style no-op converter) and set
  `imagesDropped: true` so the page can say "Pictures were left out; download to
  see them."
- `sanitizeHtml` is an **allow-list re-serializer** built on `parse5`
  (spec-compliant tokenizer; we re-emit escaped text, so mXSS tricks in the input
  cannot survive). Allowed tags: `p h1 h2 h3 h4 h5 h6 ul ol li table thead tbody
  tr td th strong em b i u s sup sub br a img blockquote pre code`. Allowed
  attributes: `a[href]` only when the URL parses as `http:`, `https:` or
  `mailto:` (always add `rel="noopener noreferrer"`); `img[src]` only when it
  matches `^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$`, plus
  `img[alt]`; `td/th[colspan|rowspan]` as small integers. Everything else —
  `style`, `class`, `id`, `on*`, unknown tags — is dropped (unknown tags keep
  their text content). Output is wrapped in nothing; the template supplies the
  container.
- **Conversion runs in a `worker_threads` Worker** (`src/lib/office-worker.js`)
  with a wall-clock timeout (suggest 10 s) and `resourceLimits` (suggest
  `maxOldGenerationSizeMb: 256`). Anyone the owner shares a folder with can put a
  file there; a zip bomb or a pathological document must cost one failed page,
  never a stalled event loop. On timeout/crash: terminate the worker and reject;
  the route falls back to the "can't show this" page with the download button.
- Input cap: refuse to convert files over 15 MB (`oc:size` from the stat) —
  offer the download instead.
- A small in-memory result cache keyed by `${fileId}-${etag}` (bounded: ~20
  entries or ~32 MB total, 10 min TTL) so Back-and-forth on a phone does not
  re-convert. Same shape as `createStatCache` in `routes/media.js`; consider
  generalizing that helper rather than writing a third cache.

### 3. `src/routes/media.js` — `/view/*` gains a mode, `/download/*` is new

- Factor the upstream GET + header copying out of `/content/*` into a local
  `proxyFile(request, reply, entry, path, { disposition, contentType, range })`
  so `/download/*` reuses it verbatim rather than copy-pasting the stream code.
- **`GET /download/*`**: normalize path → `stats.get` (same memo as `/content/*`)
  → 404 if folder or `!isDownloadable(entry)` (the route exists for office files
  and PDFs only; everything else stays exactly as reachable as before) → proxy with
  `Content-Disposition: attachment; filename=…` (reuse `contentDisposition`, add
  an `attachment` variant), `Content-Type: downloadContentType(entry)`,
  `Cache-Control: private, no-store`. No Range forwarding needed.
- **`GET /view/*`**: `mode` becomes
  `rendersInline ? kind : convertsInline ? 'docx' : 'unsupported'`. For `'docx'`:
  fetch the bytes (full GET through the client, capped by the size rule), call
  `renderDocx`, pass `documentHtml`, `imagesDropped` to the view. Any failure →
  log at `warn` and render `'unsupported'` with `downloadHref` — never a 500.
  Pass `downloadHref: isDownloadable(entry) ? '/download/<encoded>' : null` in
  every mode.
- `immersive` stays `mode === 'image' || mode === 'pdf'`. A document is an
  ordinary scrolling page with the top bar visible.
- **PDF pages get the download button too.** It sits in the existing
  `.viewer__bar` next to "Full screen" (a plain `<a class="btn btn--quiet">`,
  not hidden behind JS), so the layout `public/viewer.js` manages in full-screen
  mode keeps one bar. Check that `fullscreen.spec.js` still passes with two
  controls in the bar.

### 4. `src/lib/tiles.js`

`href` for files: `canView(entry) ? '/view/…' : null`. Nothing else changes;
`PREVIEWABLE_KINDS` stays `image, pdf` (Nextcloud has no office thumbnail
provider without Collabora, and `/preview` would just 404 into the icon anyway).

### 5. `src/views/view.njk` + `public/styles.css`

- New `{% elif mode == 'docx' %}` branch: a `.viewer viewer--document` container,
  a `.viewer__actions` row with the download button (`btn btn--primary`), an
  optional note when `imagesDropped`, then `{{ documentHtml | safe }}` inside
  `<article class="document">`. The `safe` filter is used ONLY here and only on
  sanitizer output — say so in a template comment.
- The `'unsupported'` branch: wording becomes "Photos, PDFs and Word documents
  open right here." and shows the download button when `downloadHref` is set
  ("Download {{ name }}"), above the existing "Back to the folder" button.
- CSS for `.document`: readable measure (max-width ~40em, centered), 1.15–1.2rem
  base size, generous line height, `img { max-width: 100% }`, tables inside an
  `overflow-x: auto` wrapper (the sanitizer can wrap each `<table>` in
  `<div class="document__table">` to make this possible without JS), `pre`
  wrapping. No horizontal page scroll on a phone — `test/e2e/ux.spec.js` already
  asserts this for other pages; extend it to the document page.

### 6. Mock Nextcloud, demo, fixtures

- Add `test/mock-nextcloud/assets/sample.docx` (small, a heading + paragraph +
  bullet list + one tiny PNG image + a 2×2 table) and reference it from
  `tree.js` inside a shared folder. Generate it once with a throwaway script
  (python `zipfile` writing the minimal OOXML parts, or the `docx` npm package
  via `npx`), check in the binary, do not add the generator as a dependency.
  Also add a `sample.pptx` or `.xlsx` stub (a valid empty one) for the
  download-only path.
- `test/mock-nextcloud/dataset.js` / `tree.js`: make sure the extension →
  content-type inference knows `docx`, `pptx`, `xlsx` (it currently only knows
  what `filetypes.js` knows). Add a DOCX to `demo/dataset.json` so `npm run demo`
  shows the feature.
- Mock `GET` on DAV paths already serves bytes; nothing new to speak.

### 7. Tests

Unit (`node --test`):
- `filetypes.test.js`: table invariants (`converts` ⇒ no `serveAs`; `download`
  types have a real `downloadContentType`; `canView` truth table).
- `office.test.js`: sanitizer against hostile inputs (`<script>`, `javascript:`
  hrefs, `onerror`, `style`, `<svg>`, `<iframe>`, `data:text/html` img, nested
  `<a>` in `<a>`, unclosed tags, `</textarea>`/`<noscript>` mXSS shapes); the
  fixture converts and contains the expected heading/list/table text; oversize
  → images dropped; worker timeout path (inject a tiny sleep-forever module in the
  test) rejects and is terminated.
- `media.test.js`: `/download/*` sets `attachment` disposition and the office
  MIME; works for a PDF (`application/pdf`, attachment); 404 for a
  non-downloadable type (txt, png) and for folders; `/view/*` of the docx
  returns 200 with the article and the download link; when conversion throws,
  `/view/*` still 200s with the unsupported page + download link; `tiles`: docx
  gets an href, txt does not.

E2E (Playwright, desktop + phone project):
- Open the DOCX from a folder; the heading text from the fixture is visible; the
  Back button is present; the page has no horizontal overflow; tap targets ≥ 44px.
- The download link responds with `Content-Disposition: attachment` (check via
  `page.request.get`); the PDF viewer page shows a download button that does
  the same.
- Open the PPTX stub: "can't show" wording + download button.

### 8. Docs

- README "What this is" / feature list: Word documents open as readable text;
  office files can be downloaded.
- A short note in README §7 on how the conversion is sandboxed (worker, caps).
- `filetypes.js` header comment updated (it is the canonical explanation of the
  serve/render rules and is referenced from several places).

### 9. Dependencies

- `mammoth` (runtime). Check its transitive tree once (`npm ls mammoth`) and note
  it in the commit message; it is pure JS, so the Dockerfile needs no change.
- `parse5` (runtime, for the sanitizer).

## Out of scope (say so in the PR)

- XLSX / PPTX rendering (follow-up issue; XLSX-as-table is feasible).
- Office thumbnails on tiles (needs a Nextcloud preview provider we don't run).
- Any change to the stream/home (issue #2 runs in parallel; keep `media.js`
  edits confined to the view/download routes and the shared proxy helper so the
  merge is clean).

## Acceptance

- `npm test` and `npm run test:e2e` green; CI green; `docker build` succeeds.
- Manually: a real `.docx` shared to `ostrich-viewer` opens readably on a phone
  over the tunnel; its download opens in the phone's document app; a `.pptx`
  offers the download and nothing else.

## Process

- Work on a branch (`feat/docx-preview`), commits with both trailers
  (`Co-Authored-By: Liam <penguinf1ipper@users.noreply.github.com>` per
  PLAN.md, plus the Claude trailer). Sub-agent work is reviewed before merge.
