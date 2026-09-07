# Issue #2 — From "new since you last looked" to a stream

Status: planned 2026-09-07. Files-only in this issue; tasks and due dates join
the stream in #3, which is designed alongside this and depends on it.

## Decisions (made with Sean, 2026-09-07)

- **The stream is its own view and the default.** `/` becomes the stream
  ("Latest"). The folder buttons move to `/files`. The header toggle becomes
  three-way: **Latest / Files / Tasks**.
- **The stream is a highlight, not a filter.** It always shows the recent
  history of changes, newest first. Items newer than the viewer's *previous
  sitting* are marked **New**. Nothing is ever hidden by a timestamp; a wrong
  stamp costs a badge, not the list.
- **Sitting window: 1 hour** of idle time (was 6). Morning and lunchtime checks
  become separate sittings, so the badges are accurate. The old reason for a
  long window — the list emptying mid-read — no longer exists.
- **One bounded page.** One WebDAV `SEARCH` (newest 50 files, `SEARCH_LIMIT`),
  no paging. When the list is full or the walk was truncated, an honest line at
  the bottom: "Older changes aren't listed here."
- **The page is built as a single time axis** so #3 can put upcoming tasks above
  a "Today" line and the history below it. In this issue there is nothing above
  the line; the anchor is created now so #3 does not restructure the page.

## What changes for the reader

- After signing in she lands on **Latest**: a list of what has changed, grouped
  by day ("Today", "Yesterday", "Fri, Aug 8"), newest first. Each row: a small
  thumbnail or icon, the file name, "in Biology 101 › Lectures", and the time.
  Rows newer than her previous sitting carry a **New** badge and a soft tint.
- A quiet note under the heading: "You were last here yesterday. Newer things
  are marked New." On a first-ever visit there is no note and no badges — but
  the list is there, which is the whole point.
- The top bar's toggle now reads **Latest · Files · Tasks** on every page.
- **Files** is the old home page: the big folder buttons. Its Back button goes
  to Latest. Folder pages' breadcrumbs and Back chain end at Files, not Latest.
- An empty stream says "Nothing has changed yet." That is a claim we can now
  make honestly; it is no longer the same rendering as "the lookup failed".

## Design

### 1. Routes

| Route | Before | After |
|---|---|---|
| `GET /` | folders + new-since section | **the stream** (`src/routes/stream.js`, new) |
| `GET /files` | redirect → `/` | **folder buttons** (the old home, moved into `src/routes/files.js`) |
| `GET /files/` | redirect → `/` | same as `/files` |
| `GET /files/*` | folder listing | unchanged, but `backHref`/breadcrumbs root at `/files` |
| `GET /view/*` | back to parent or `/` | back to parent or `/files` |
| `GET /tasks` | back → `/` | unchanged (`/` is still home) |
| `POST /login` | redirect → `/` | unchanged (in #3 this becomes `/#today`) |

`src/routes/home.js` is renamed/replaced: the share-root discovery and skeleton
filtering (`listShareRoots`, `selectReceivedShares`, the three once-per-process
warnings) move to `files.js` unchanged; the new-since half is rewritten as the
stream route. Keep the git history readable: `git mv home.js stream.js`, then
move the folder code out.

### 2. Data: `src/nextcloud/search.js`

- `buildSearchBody({ scope, since, limit })`: make `since` **optional**. With no
  `since` the `<d:where>` block is omitted (newest `limit` files, ordered by
  `getlastmodified` descending). `parseSearchResults` and `walkChangedSince`
  likewise treat an absent `since` as "everything". `toDavDateTime` untouched.
- `findChangedSince(client, since, …)` gains a sibling `findRecent(client, …)`
  that calls the same machinery with no `since`. Same strategy memo, same
  fallback walk, same `truncated` semantics. (Alternative: `findChangedSince`
  with `since = null`; pick whichever keeps the doc comments honest.)
- Nothing else in this module changes; the share filtering
  (`shareSignal !== false`) still applies.

### 3. Pure view-model: `src/lib/stream.js` (replaces `src/lib/new-since.js`)

```js
export function fileEvents(entries)                    // parseMultistatus entries → events
export function buildStream(events, { previousVisitAt, now, limit, fetchLimit, truncated })
  → { days: [{ label, items: [...] }], newCount, moreLabel }
export function formatVisitLabel(...)                  // kept as-is
export function folderLabelFor(path)                   // kept as-is
export function createTtlCache(...)                    // createNewSinceCache, generalized
```

- An **event** is `{ kind: 'file', at: Date, isNew: boolean, tile, folderLabel,
  timeLabel }`. `tile` is `toTile(entry)` so thumbnail/href/icon behave exactly
  like a folder tile. #3 adds `kind: 'task-*'` events with the same `at`/`isNew`
  contract, so keep the file-specific bits under `tile`.
- `isNew` = `at > previousVisitAt`; always `false` when `previousVisitAt` is null.
- Day grouping uses `dayDelta`/`dayName` from `lib/dates.js` (the same words the
  task page uses). `timeLabel` = `formatTime(at)` ("3:40 PM").
- `moreLabel` = "Older changes aren't listed here." when `truncated` or
  `events.length >= fetchLimit`; otherwise null. The precise "…and N more." form
  goes away — there is no cap to overflow anymore, only the fetch bound.
- The cache: the answer no longer depends on the viewer or on `since`, so key it
  on a constant. Rename `createNewSinceCache` → `createTtlCache` (same TTL/max
  logic and the same "SHORT ON PURPOSE" reasoning — pull-to-refresh
  deduplication). Update `server.js` (`app.newSinceCache` → `app.streamCache`).

### 4. Visits: `src/store/visits.js`

- `VISIT_WINDOW_MS = 60 * 60 * 1000`.
- Rewrite the header comment's *consequences*, not its mechanism: the two-stamp
  design stays (refreshing must not move the baseline), but the cost of a wrong
  rotation is now "badges drop" rather than "the list empties". The idle-time
  rule and `lastSeenAt` stay.
- `startVisit` is called from the **stream** route only (it was the home route).
  Files, folders, tasks never advance a sitting — same rule as before, new home.

### 5. Stream route: `src/routes/stream.js`

```
GET /
  visit  = app.visits.startVisit(viewer)      // decide, persist after render
  found  = streamCache.get() ?? findRecent(app.nextcloud, { limit: SEARCH_LIMIT, log })
  events = fileEvents(found.entries)
  model  = buildStream(events, { previousVisitAt, now, limit: SEARCH_LIMIT, fetchLimit, truncated })
  await visit.commit()
  render 'stream'
```

- Failure policy changes: the stream is the page now, so an unreachable
  Nextcloud must reach the existing "taking a break" / "needs attention" error
  pages, not render an empty stream. Let `NextcloudError`s propagate
  (the global handler already does the right thing). A **truncated** walk is
  not a failure; it renders with the "Older changes" line.
- Cache only `!truncated || settled` results (same rule and same comment as
  today's `loadNewSince`).
- Visit state failures (`state.json` unreadable) degrade to "no highlights",
  logged once — the store already never throws on write.

### 6. Templates and CSS

- `src/views/stream.njk` (new) and `src/views/_stream.njk` (macro `stream_item`):
  rows, not the big-button grid. Each row is an `<a>` (or a `<div>` when the tile
  has no `href`) with a 64px thumbnail, name, muted folder label, time, and the
  **New** badge. `<h2 id="today">` heads the first (today) group — or a bare
  `<h2 id="today" class="stream__today">Today</h2>` divider when nothing changed
  today — so `/#today` is meaningful now and #3 can build above it. Add
  `scroll-margin-top` equal to the fixed top bar's height on `#today`.
- `src/views/files-home.njk` (renamed from `home.njk`): greeting + Folders grid;
  the new-since block is gone.
- `layout.njk`: three toggle options; `section` accepts `'latest'`. Keep the
  toggle's tap targets ≥ 44px at phone width — three options must still fit at
  360px; shrink the brand text or drop it at narrow widths if needed (check
  `ux.spec.js`).
- `styles.css`: `.stream`, `.stream__day`, `.stream__item`, `.stream__badge`,
  `.stream__item--new` tint; keep the existing tile styles intact for Files.

### 7. Login redirect and the "Back" chain

- `routes/auth.js`: after login, redirect to `/` (unchanged for now).
- `routes/files.js`: `/files` renders the folder home (`showBack: true,
  backHref: '/'`); folder pages compute `backHref` with `/files` as the root;
  `breadcrumbs()` in `lib/paths.js` currently emits a root crumb
  `{ name: 'Home', href: '/' }`; change it to `{ name: 'Files', href: '/files' }`
  and update `paths.test.js`. `folderLabelFor` (top-level files say "Home")
  should say "Files" too, for the same reason.
- `routes/media.js`: top-level files go back to `/files` (this is the one line
  #5 also edits; keep the change minimal).
- `server.js` error handler: `backHref` for non-task errors stays `/`.

### 8. Mock, demo, screenshots

- Mock `SEARCH` must accept a body **without** `<d:where>` and return the newest
  `nresults` files. Today `test/mock-nextcloud/index.js` answers 400
  "Unparseable date literal" when no `<d:literal>` is present (deliberately, to
  catch a malformed date); keep that strictness when a `where` IS present and
  treat its absence as "no lower bound".
- `demo/dataset.json` already stamps relative `lastModified`s; add two or three
  more so the demo stream spans "Today / Yesterday / last week".
- `scripts/screenshots.js`: add the stream (phone) as the first screenshot;
  regenerate `docs/screenshots/*` and update the README image references.

### 9. Tests

Unit:
- `stream.test.js` (from `new-since.test.js`): event building, `isNew` with and
  without a previous visit, day grouping across a midnight boundary in the
  process TZ, `moreLabel` rules, `createTtlCache` expiry.
- `search.test.js`: body without `where`; `parseSearchResults` with no `since`.
- `visits.test.js`: window is 1h; rotation semantics unchanged.
- `stream-route.test.js` (from `home-route.test.js`): renders rows; first visit
  → no badges but rows present; backdated previous visit → badges on the right
  rows; SEARCH refused → walk → still renders; Nextcloud down → 503 page.
- `files-route` test: `/files` renders folders; share filtering warnings still
  fire once.

E2E (`stream.spec.js` replacing `new-since.spec.js`, plus edits to `browse`,
`ux`, `login`):
- Login lands on Latest with rows and the three-way toggle; toggle reaches
  Files and Tasks from every page type (folder, viewer, task list).
- Backdate `nana` in `state.json` (existing lever) → the two "recent" fixture
  files carry New; the older ones don't; refresh keeps the badges.
- First visit → rows, no badges, no "You were last here" note.
- `/files` shows Folders; Back from `/files` goes to `/`; Back from a top-level
  folder goes to `/files`.
- Phone viewport: no horizontal overflow; row tap targets ≥ 44px; toggle fits.

### 10. Docs

- README: "What this is", "What it looks like" (new screenshots), the §7 demo
  section, and any mention of "new since you last looked" → the stream.
- `.env.example` mentions `state.json` as "who last looked" — still true.
- Leave `PLAN.md` and `Project_Goal.md` as the historical brief.

## Out of scope here (in #3)

- Task events, upcoming/overdue tasks above the Today line, `/#today` as the
  toggle/login target, the "Also N tasks without a due date" line.

## Acceptance

- `npm test`, `npm run test:e2e`, CI, `docker build` all green.
- On the phone over the tunnel: Latest opens fast (one SEARCH), rows open the
  right files, New badges match reality after an hour away, Files/Tasks are one
  tap from anywhere.

## Real usage (checked 2026-09-07)

The deployment lives at `~/git-repos/nextcloud-ostrich-view` on the Beelink
(not `/opt`), data volume at `./data`. `state.json` has two viewers:

| viewer | previous sitting | current sitting |
|---|---|---|
| mom | Aug 30 | Sep 2 |
| dad | Sep 4 | Sep 7 |

Home-page loads run 2–21 a day over the last month (the count includes
unauthenticated hits and bots, so real reads are fewer). Sittings are **days**
apart, not hours: the 6-hour vs 1-hour question hardly arises in practice, and
1 hour is safe. It also confirms the stream shape — a reader who comes back
every few days wants the history, not a section that only compares two stamps.

## Process

- Branch `feat/stream`; commits carry both trailers (Liam + Claude, per PLAN.md).
- Runs in parallel with #5 (branch `feat/docx-preview`). Overlap is limited to
  `routes/media.js` (one `backHref` line), `styles.css` (append sections),
  and README; resolve at merge.
