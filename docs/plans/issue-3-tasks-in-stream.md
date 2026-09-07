# Issue #3 — Tasks in the stream (changes, and what's coming up)

Status: planned 2026-09-07. Depends on #2 (the stream). Starts after #2 merges.

## Decisions (made with Sean, 2026-09-07)

- **Task events in the stream:** *added* (from `CREATED`), *finished* (from
  `COMPLETED`), *changed* (from `LAST-MODIFIED`, when it isn't the same moment as
  created/finished). **Deleted tasks are deliberately not surfaced** — they can't
  be derived from the VTODOs we fetch, and a per-list snapshot in `state.json` is
  not worth it for the value.
- **Upcoming tasks live in the same timeline.** The page is one time axis: open
  tasks by due date **above** a "Today" line (furthest future at the top, soonest
  just above the line, overdue ones in red right above it), the change history
  **below** it, newest first. `/` lands on the line via the `#today` anchor —
  no JavaScript; scroll up is the future, scroll down is the past.
- **Every dated open task** appears above the line, however far out. Undated
  open tasks are not on a timeline; a line just above Today says
  **"Also 17 tasks without a due date"** and links to them.
- The undated link goes to `/tasks` for now. Sean's follow-on idea — **all tasks
  together, with the lists as filters** — is a real change to the Tasks side and
  is filed as its own issue, to be designed together with #4 (task cards). When
  that lands, this link points at it.

**Superseded 2026-09-07 — the undated line is now a twisty, not a link.** The
link out was the wrong answer, and the reason is what this whole page is for:
Latest is already the cross-list view. Every dated open task is above the line,
every finished one is in the history below it — so the undated bucket was the
one thing on the page a reader had to leave the page to see, and where it sent
her was a grid of list buttons rather than the four chores she was after. It is
now a JS-free `<details>`: the same wording as the summary ("Also 3 tasks
without a due date", singular handled), closed by default, and the tasks
themselves as ordinary `task_item` rows inside it — same icon as a due row,
"No due date" where the due row names a day, sorted by list then A-Z, each
opening its list page. Files and Tasks remain the places for browsing by
structure, and the "all tasks together" issue is unaffected: when it lands it
is a Tasks-side view, not this page's escape hatch.

**Amended after a day on the owner's phone — the twisty moved UNDER the Today
heading.** It first went where the old link had been, immediately above the
line, and that inherited the link's mistake in a second form. Two things were
wrong with it, and they are the same thing twice:

- **An undated task is not later.** The block above the line is what is coming,
  ordered by how far off it is. A chore with no date has no place in that
  ordering at all; what it is, is part of the state of *today*.
- **Above the line is off screen on arrival.** `#today` scrolls the heading to
  the top of the viewport, so everything above it is behind her — and a mention
  she has to scroll back to find is barely a mention, which is the one thing
  this block cannot afford to be.

So `day_group(day, undated)` renders it inside today's group: directly under
the heading, before the day's history rows, and before the "Nothing has changed
yet" line. Still closed by default — opening it pushes the history down and
moves nothing above it, so the line she landed on stays put.

## What changes for the reader

- Opening the app lands on **Today**. Above it, what's coming: "Due Tue, Aug 12 —
  Lab report · School". Overdue tasks sit right above the line in red. Below it,
  what happened: "Finished — Email the professor · School · 4:12 PM" between the
  file rows, in time order.
- Rows newer than her previous sitting carry the same **New** badge as files.
- Tapping a task row opens its list page (`/tasks/<slug>`), the only place a task
  is shown in full.
- If the task side is unreachable but files are fine, the history still shows
  files and a quiet line says tasks couldn't be checked. The page never fails
  because of tasks.

## Design

### 1. CalDAV parsing: `src/nextcloud/caldav.js`

**What the real server has (probed 2026-09-07, 11 VTODOs across 7 shared
lists, two of them empty):** the writer is `PRODID:-//Nextcloud Tasks Android//EN`.
Every task carries `DTSTAMP` and `STATUS`; completed ones carry `COMPLETED`
(and `DTSTAMP` is bumped to the same instant); some carry `DUE`, one carries
`PERCENT-COMPLETE`. **None carries `CREATED`, `LAST-MODIFIED` or `SEQUENCE`.**
So the original assumption ("added" from `CREATED`) is false for this
household's client, and the design below does not depend on it. Each item does
come with a `getetag`, which is the cheapest "did it change" signal we have.

Two smaller facts from the sample, to keep in mind:
- `DUE:20260909T130000` — a **floating** local time, no zone. `toDate` already
  reads it via `toJSDate()` in the process zone, which is the household's (TZ in
  `.env`), so no change; but a fixture with a floating DUE belongs in the tests.
- Completing a task rewrites `DTSTAMP` to the `COMPLETED` instant, which is why
  the 60 s dedupe below matters: without it every completion is two rows.

`parseTodoBlob` adds:

| field | source |
|---|---|
| `createdAt` | `CREATED` when present (other clients write it), else null |
| `stampAt` | `LAST-MODIFIED`, else `DTSTAMP` — "when this object was last revised" (RFC 5545 §3.8.7.2 for objects without METHOD) |
| `etag` | the item's `getetag` from the REPORT (already requested, currently discarded) |

The route attaches `list: { slug, displayName, color }`.

### 1b. A small ledger of tasks we have seen: `data/tasks-seen.json`

Without `CREATED`, "added" has to come from *us* noticing a UID for the first
time. One process-wide file (not per viewer), written by the same
temp-file-and-rename store pattern as `state.json`:

```json
{ "<calendar uri>|<uid>": { "firstSeenAt": "...", "stampAt": "...", "etag": "..." } }
```

Rules, applied whenever the stream route has a fresh set of todos for a list:
- UID not in the ledger → record it; emit **Added** at `createdAt ?? stampAt`
  (for a never-edited task `DTSTAMP` *is* its creation time).
- UID known and `etag`/`stampAt` moved → update; **Changed** at the new
  `stampAt`.
- UID known, unchanged → nothing new.
- UID in the ledger but missing from the list → keep the record for now (a
  "Removed" event becomes possible later; deliberately not surfaced in #3).

First run after deploy: every existing task is "first seen", so it would appear
as Added at its `DTSTAMP`. That is acceptable (those stamps are real), and the
60 s dedupe below stops a finished task from showing both Added and Finished
at the same minute. The ledger is bounded by the number of tasks ever shared
(hundreds at most); prune entries missing for 90 days.

This is the "new persistent state" the issue warned about. It is one small
file, it is not per viewer, losing it only costs a burst of "Added" rows, and
it is what makes "added" honest with the data this client actually writes.

### 2. Task events: `src/lib/stream-tasks.js` (pure)

```js
export function taskEvents(todos, list, ledger, { now })  // → history events + ledger updates
export function upcomingTasks(todos, list, { now })   // → dated open tasks
export function undatedTasks(todos, list)             // → undated open tasks, as rows
export function sortUndated(rows)                     // → by list, then A-Z
```

(`undatedTasks` takes no clock: an undated row has no date to read against one,
which is the whole difference between it and `upcomingTasks`. It was
`undatedOpenCount(todos) → number` until the twisty replaced the link.)

Event rules (history, below the line), fed by the todos plus the ledger:
- `task-added` at `createdAt ?? stampAt`, on first sighting (§1b).
- `task-finished` at `completedAt` when `isCompleted`.
- `task-changed` at `stampAt` when the ledger says the item moved since last
  sighting, **and** it is more than 60 s after the Added stamp **and** not
  within 60 s of `completedAt` (ticking a task off bumps `DTSTAMP` too; that is
  one event, "Finished", not two). One Changed per task (the latest), so a
  much-edited task is one row, not ten.
- Cancelled tasks emit nothing (the Tasks page hides them too; say so).
- Recurring tasks: use the occurrence `parseCalendarQuery` already picked.
- Each event: `{ kind, at, isNew, task: { summary, listName, slug, accentClass,
  href: '/tasks/<slug>' }, label }` with `label` already worded: "Added",
  "Finished", "Changed". `isNew` follows the same `at > previousVisitAt` rule as
  files (`buildStream` sets it).

Upcoming (above the line):
- Open, not cancelled, `due` present. Sorted by due **descending** (furthest
  first) so the soonest sits just above the line. Overdue (`isOverdue` from
  `lib/tasks.js`) rows come last in that block — i.e. directly above Today —
  flagged `overdue: true` for the red style, labelled "Was due …" via
  `formatDueLabel`.
- Grouped by day like the history ("Tomorrow", "Tue, Aug 12"), using the
  date-only UTC rule `lib/tasks.js` already applies to DUEs.
- No cap beyond the overall stream limit; household lists are small. If the
  block would exceed the limit, keep the soonest and add "Later tasks are in
  Tasks." at the top.

### 3. Fetching: the route's task half

`src/routes/stream.js`:

```
[found, calendars] = await Promise.all([ files as in #2, listTaskCalendars(...) ])
todosByList = await Promise.allSettled(calendars.map(c => fetchTodos(client, c.slug, { calendars })))
```
- One `PROPFIND` for the calendar list plus **one `REPORT` per list**, cached by
  ctag with the existing 60 s TTL (`fetchTodos`). This departs from the
  one-round-trip budget deliberately: N is the number of shared lists (a
  handful), the REPORTs run concurrently, and the cache means a refresh burst
  costs nothing. Write that trade-off down in the route's header comment.
- **Best-effort per list**: a rejected list is logged (`warn`, once per process
  per list) and skipped; a page with files and three of four lists is better
  than no page. If the calendar PROPFIND itself fails, `tasksUnavailable: true`
  → the template shows "Tasks couldn't be checked just now." above the history.
  A `NC_UNREACHABLE` on the files half still reaches the error page as in #2.

### 4. Merge: `src/lib/stream.js`

- `buildStream(events, …)` accepts mixed `file`/`task-*` events; sorts by `at`
  desc; applies the overall limit (drop the oldest); day-groups; sets `isNew`.
- New: `buildTimeline({ upcoming, history, undated, tasksUnavailable })` →
  the template model `{ future: [...days], today: {...}, past: [...days],
  undated, moreLabel }`. `undated` is `{label, rows}` — the label is "Also 1
  task without a due date" / "Also 17 tasks without a due date" (pluralized) —
  or null when there are none. A twisty row is badged **New** when the same
  task's Added row below the line is: the badge rule reads `at`, which an
  undated row has not got, so rather than invent a second rule the timeline
  reads the answer the history already came to, matched by list slug and UID.

### 5. Templates and CSS

- `stream.njk`: future groups, then `<h2 id="today">` with the undated twisty
  directly under it (see the amendment above),
  then the history. `_stream.njk` gains `task_item(event)` (icon by kind: a
  check for finished, a plus for added, a pencil for changed, a small calendar
  for due; four tiny SVGs in `public/icons/`), the list name with its accent
  class (reuse `accentClassFor`), the New badge, `--overdue` modifier.
- `layout.njk`: the Latest toggle links to `/#today`. `routes/auth.js`: login
  redirects to `/#today`. `#today { scroll-margin-top: <topbar height> }` so the
  line is not hidden under the fixed bar. Verify in Playwright that on a phone
  viewport with future items the Today heading is inside the viewport on load
  (`toBeInViewport()`), with JavaScript disabled in that test.
- When there is nothing above the line, the page opens at the top as in #2; the
  anchor is harmless.

### 6. Mock and demo

- `calendars.js`: add tasks dated in the future (`+2d`, `+10d`), overdue
  (`-3d`), undated, a completed one with `COMPLETED`, and stamps as in §1.
  `createMockNextcloud({ failCalendar: '<uri>' })` to make one list's REPORT
  500, for the best-effort test.
- `demo/dataset.json`: a few due dates ahead and behind so the demo's Today
  line has things on both sides.

### 7. Tests

Unit: `stream-tasks.test.js` (event rules, 60 s tolerance, cancelled skipped,
fallbacks when stamps are missing, upcoming order with overdue at the bottom,
undated rows, their by-list-then-A-Z order, pluralization, empty → null),
`stream.test.js` (mixed merge order, limit drops
the oldest), `stream-route.test.js` (one list failing → page still renders and
the warning logs once; calendar PROPFIND failing → `tasksUnavailable` line).

E2E: a finished task appears between file rows in time order with its list name;
future tasks above Today, overdue in red just above the line; the "Also N tasks
without a due date" summary sits under the Today heading, is in the viewport on
landing (plain `/`, script on, phone viewport) and ≥44px, with its rows hidden
until it is tapped, after which they are visible and link to `/tasks/<slug>`,
at the normal root font and at a doubled one, with no horizontal overflow
either way; landing on `/#today` puts Today in view on the phone with JS off; the
failing-list mock still renders the page.

### 8. Docs

README: the Latest page description gains tasks and upcoming; a sentence on
what "changed" means and that deletions are not shown.

## New issue to open (not part of #3)

**"All tasks together, lists as filters"** — a `/tasks/all` view merging every
shared list, sortable by due date, with the list names as filter chips. Design
with #4 (task cards), since it decides how a task row looks. (It no longer has
to rescue the undated line: that now opens in place on Latest.)

## Acceptance

- `npm test`, `npm run test:e2e`, CI, `docker build` green.
- On the phone: the app opens on Today; upcoming tasks read correctly against
  the Tasks pages; ticking a task off in the Android app shows up as "Finished"
  within a minute; a list unshared mid-session does not break the page.

## Process

- Branch `feat/tasks-in-stream`, after `feat/stream` merges. Both commit
  trailers (Liam + Claude, per PLAN.md). Reviewed before merge.
