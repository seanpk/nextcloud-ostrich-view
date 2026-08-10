# Nextcloud Ostrich View — Implementation Plan

## Context

The owner keeps their college-course files in self-hosted Nextcloud (cloud.example.com) and their to-dos in Nextcloud Tasks. Their mother wants to follow their progress but is tech-averse — she won't log into Nextcloud. We're building a tiny read-only web app with big buttons, inline previews (PNG/JPG/PDF), a Tasks view, and a "New since you last looked" section, running in Docker on the same Beelink and exposed via the existing Cloudflare tunnel.

**Decisions already made with Sean:**
- **Visibility = a dedicated Nextcloud account** (`ostrich-viewer`). The owner shares folders and task lists with it from the normal Nextcloud/Tasks UI; whatever is shared is what the app shows. The app holds that account's app-password server-side — Mom never touches Nextcloud credentials.
- **Auth = a few named passphrases** (one field, no username). Each passphrase maps to a viewer name; this identifies the person for "new since your last visit".
- **Mobile-first** (phone primary, desktop must also work).
- **Stack = Node.js, server-rendered**, minimal client JS.

**Commits: include `Co-Authored-By: Liam <penguinf1ipper@users.noreply.github.com>` on every commit in this project (in addition to the standard Claude trailer).**

**First commit:** copy this plan into the repo as `PLAN.md` and commit it before any code.

## Execution process (per Sean)

- **Delegate to sub-agents wherever it makes sense**, picking the model by task weight:
  - **Sonnet** — mechanical/well-specified work: scaffolding, copying the pdfjs-dist viewer, fixture data, CSS polish passes, README/checklist writing.
  - **Opus** — standard implementation work: route handlers, WebDAV/CalDAV clients and parsers, Playwright specs, CI workflow.
  - **Fable (me/inherit)** — integration-heavy or subtle pieces: visit-rotation semantics, security-sensitive proxy/path-normalization code, debugging against the real Nextcloud, and final wiring.
  - Parallelize independent milestones (e.g., M3 tasks work alongside M2 files work) with concurrent agents when practical.
- **Every change gets a non-author review**: sub-agent work is reviewed by me (or `/code-review`); anything I implement directly gets reviewed by a separate review sub-agent before it's committed. Findings are fixed before the milestone commit.

## Stack

Fastify + Nunjucks (`@fastify/view`), `@fastify/secure-session` (encrypted stateless cookie), `@fastify/rate-limit`, `@fastify/static`. Nextcloud via **raw `fetch` + `fast-xml-parser`** (we need `oc:` props, the `SEARCH` verb, and CalDAV `REPORT` — the `webdav` npm package covers none of that well). `ical.js` for VTODO parsing, `bcryptjs` for passphrase hashes, `pdfjs-dist` prebuilt viewer for PDFs (iOS Safari can't scroll embedded PDFs, and phone is the primary device — this is the one exception to "minimal client JS"). Last-visit state in a flat `data/state.json` (atomic temp-file+rename writes).

## Routes

| Route | Purpose |
|---|---|
| `GET/POST /login`, `POST /logout` | One passphrase field; bcrypt-compare against all viewers; rate-limited (5/min/IP via `CF-Connecting-IP`) |
| `GET /` | Home: "New since you last looked" tiles + top-level folder buttons + Files/Tasks toggle |
| `GET /files/*` | Folder listing: tiles with preview + name; folders first |
| `GET /view/*` | Inline viewer page (our chrome + always-visible Back button) wrapping `<img>` or the PDF.js iframe |
| `GET /content/*` | Proxied raw file bytes (forward `Range` for PDF.js) |
| `GET /preview/:fileId` | Proxied thumbnail, disk-cached at `data/preview-cache/<fileId>-<etag>-512.png`, SVG icon fallback |
| `GET /tasks`, `GET /tasks/:slug` | Task-list buttons; then uncompleted tasks in full (sorted by due), followed by completed sorted most-recent first |
| `GET /healthz` | Unauthenticated liveness |

Global `onRequest` hook redirects unauthenticated requests to `/login`. Normalize every path param; reject `..`/root-escapes.

## Nextcloud integration

- **Listing**: `PROPFIND remote.php/dav/files/ostrich-viewer/<path>`, `Depth: 1`, props `oc:fileid`, `d:getlastmodified`, `d:getcontenttype`, `d:resourcetype`, `oc:size`, `d:getetag`. Received shares appear under this root automatically.
- **Previews**: `GET /index.php/core/preview?fileId=N&x=512&y=512&a=1` with app-password Basic auth, streamed through our proxy; browser never sees Nextcloud auth.
- **Tasks**: `PROPFIND remote.php/dav/calendars/ostrich-viewer/` `Depth: 1`, keep calendars whose component set includes VTODO; per-calendar CalDAV `REPORT calendar-query` filtered to VTODO; parse with ical.js (SUMMARY, DESCRIPTION, DUE, STATUS, COMPLETED, RELATED-TO for subtasks). Cache per-calendar by `getctag` for ~60s.
- **New since last visit**: WebDAV `SEARCH` (`d:basicsearch`, `d:gt` on `getlastmodified` vs the viewer's previous-visit timestamp), scoped to `/files/ostrich-viewer`. Fallback if SEARCH is unavailable: bounded recursive `Depth: 1` walk (tree is small). Tiles show preview + name + muted containing-folder label; cap ~20.
- **Visit rotation** (so refreshing doesn't empty the "new" list): on home load, if `now − currentVisitStartedAt > 6h`, rotate current→previous and stamp a new current. "New" always compares against `previousVisitStartedAt`.

## Config & secrets

- `.env` (gitignored; `.env.example` committed): `NC_BASE_URL` (LAN/docker-network address, **not** the public URL — don't round-trip previews through Cloudflare), `NC_USER`, `NC_APP_PASSWORD`, `SESSION_SECRET`, `PORT`.
- `config/viewers.json` (gitignored; example committed): `[{ "name": "mom", "label": "Mom", "passphraseHash": "$2b$..." }]`, generated by `scripts/hash-passphrase.js`.
- Cookies: HttpOnly, Secure, SameSite=Lax, ~90-day maxAge so she rarely re-enters the passphrase.
- Read-only by construction: the Nextcloud client module exposes only PROPFIND/SEARCH/REPORT/GET; app registers only GET routes plus login/logout POSTs. Also share to `ostrich-viewer` with "Allow editing" unchecked.
- Headers: `no-store` on HTML, `private, max-age` on previews, nosniff, minimal CSP.

## Testing strategy

- **Unit tests (Node's built-in `node:test`, no extra framework):** the pure logic — WebDAV/CalDAV XML response parsing, VTODO parsing/sorting (uncompleted-by-due, completed-newest-first), visit-rotation logic, path normalization/traversal rejection, passphrase matching. These run in milliseconds and need no network.
- **Mock Nextcloud fixture (`test/mock-nextcloud/`):** a tiny HTTP server speaking just enough PROPFIND/REPORT/SEARCH/preview/GET with canned XML fixtures and sample files (a real small PNG/JPG/PDF). Both integration and Playwright tests point `NC_BASE_URL` at it, so tests never need the real server.
- **Playwright E2E (`@playwright/test`, `test/e2e/`):** boot the app against the mock, then walk the acceptance path as Mom would: login (wrong passphrase → friendly error + rate limit; right passphrase → home), tap through folders, open an image and a PDF inline, Back button present and working on every page, Files↔Tasks toggle, task ordering, "new since you last looked" appears after simulating a later visit. Run in Chromium desktop **and** a phone viewport (e.g. `devices['Pixel 7']`) since phone is primary. Include basic UX assertions: tap targets ≥ 44px, no horizontal overflow on mobile, previews have alt text.
- **GitHub Actions (`.github/workflows/ci.yml`):** on push/PR — `npm ci` → unit tests → `npx playwright install --with-deps chromium` → E2E → `docker build .` as a smoke check. Cache npm and Playwright browsers. CI is added in M1 and every later milestone lands with its tests.

## Deployment process (manual, but one command)

CI tests; deploys are hand-triggered on the Beelink (no automation across the tunnel). Keep it to:

```
ssh beelink
cd /opt/ostrich-view && git pull && docker compose up -d --build
```

Wrapped in a committed `deploy.sh` (pull, build, restart, then curl `/healthz` and print pass/fail). First-time setup (clone, `.env`, `viewers.json`, tunnel hostname) documented step-by-step in the README.

## Repo structure

```
package.json  .env.example  .gitignore  Dockerfile  docker-compose.yml
PLAN.md  deploy.sh
.github/workflows/ci.yml
scripts/hash-passphrase.js
config/viewers.example.json
src/
  server.js  config.js
  routes/{auth,home,files,media,tasks}.js
  nextcloud/{client,webdav,caldav,previews}.js
  store/visits.js
  views/*.njk   # layout with persistent Back button + Files/Tasks toggle
public/styles.css  public/pdfjs/   # pdfjs-dist prebuilt viewer, copied at build
test/
  unit/           # node:test suites for parsers, rotation, path safety
  mock-nextcloud/ # fixture server + canned XML/sample files
  e2e/            # Playwright specs (desktop + phone viewport)
data/            # runtime: state.json, preview-cache/ (gitignored)
```

## Milestones (each demoable and tested; commit per milestone with Liam as co-author)

0. **M0 — Plan commit**: add `PLAN.md` (this document) to the repo; first commit.
1. **M1 — Login + folder browsing**: scaffold, sessions, hash script, `/login`, PROPFIND listing, `/files/*` with big name-only tiles, layout + mobile-first CSS, Back button. Also lands the test skeleton: mock-Nextcloud fixture, first unit tests (path safety, PROPFIND parsing), first Playwright specs (login flow, folder navigation), and the CI workflow. *Demo: Mom's passphrase logs in on a phone and taps through real shared folders; CI is green.*
2. **M2 — Previews + inline viewer**: preview proxy + disk cache + icon fallback, image viewer, PDF.js + `/content/*` with Range passthrough. Tests: preview caching unit tests; E2E opens an image and a PDF inline on desktop + phone viewport.
3. **M3 — Tasks**: Files/Tasks toggle, calendar discovery, VTODO fetch/parse, task pages with completed-ordering. Tests: VTODO parsing/sorting units; E2E for toggle and task ordering.
4. **M4 — New since you last looked**: visits store + rotation, SEARCH (or walk fallback), home-page section. Tests: rotation-logic units; E2E simulating a second visit.
5. **M5 — Deploy**: Dockerfile (node:22-alpine, non-root), compose with `./data` and `./config` volumes, `deploy.sh`, join Nextcloud's docker network or LAN address, Cloudflare tunnel hostname (e.g. `ostrich.example.com`), README checklist for Nextcloud-side setup (create user, app password, share folders/lists) and first-time server setup.

## Verify early (5-minute curl tests, before the milestone that depends on each)

1. Preview endpoint works for files *shared to* the account (before M2).
2. PDF tile previews: Nextcloud disables the PDF preview provider by default — default plan is a PDF icon on tiles (the PDF.js viewer itself doesn't need it); enabling `OC\Preview\PDF` is an optional admin tweak.
3. Sharing a Tasks list with `ostrich-viewer` actually surfaces it under its CalDAV home (before M3).
4. WebDAV SEARCH works on this instance (before M4); else use the walk fallback.
5. LAN access: internal hostname in `trusted_domains`, no HTTPS-redirect loop (before M5).
6. No Cloudflare "Cache Everything" rule on the zone; app-password permits DAV reads.

## Verification (end-to-end)

- Run locally with `.env` pointed at the real Nextcloud over LAN; log in with a test passphrase on a phone browser via LAN IP.
- Walk the acceptance path from Project_Goal.md: login → home buttons → folder → sub-folder (parent shown unobtrusively) → tap file → inline image and inline PDF render without download → Back button reachable at every step → Tasks toggle → task category → uncompleted with details, completed newest-first → return next day (or fake the timestamp in `data/state.json`) → "New since you last looked" shows the file added meanwhile with its folder label.
- After M5: repeat the walk over `https://ostrich.example.com` on a phone, confirm rate limit trips after 5 bad passphrases, and confirm the container restarts cleanly (`docker compose restart`) with session and last-visit state surviving.
