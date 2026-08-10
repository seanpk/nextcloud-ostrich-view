# Nextcloud Ostrich View

> Keep up with something going on with read-only access and no idea how anything works.

## What this is

A tiny, read-only web app that shows the files and to-do lists that have been
**shared to one dedicated Nextcloud account**. The owner shares a course folder or a
Tasks list with `ostrich-viewer` from the normal Nextcloud UI; whatever is
shared is what the app shows. Nothing else is reachable.

It is built for one person who does not want to learn Nextcloud:

- **One passphrase, no username.** Each passphrase maps to a named viewer.
- **Phone first.** Big buttons, one tap per step, a Back button on every page.
- **Nothing downloads.** Images and PDFs open inline, in the page.
- **"New since you last looked"** on the home page, so there is no hunting.
- **Read-only by construction.** The Nextcloud client speaks only `PROPFIND`,
  `SEARCH`, `REPORT` and `GET`; the app registers only `GET` routes plus the
  login/logout `POST`s. The viewer account's app password never reaches the
  browser.

It runs in Docker on the Beelink beside Nextcloud and is published through the
existing Cloudflare tunnel.

See `PLAN.md` for the design and the reasoning behind it.

---

## 1. Nextcloud-side setup

Done once, as a Nextcloud admin plus the owner. Nothing here is app-specific — it is
ordinary Nextcloud sharing.

1. **Create the viewer account.** Settings → Administration → Users → new user
   `ostrich-viewer`. Give it a real password and no admin rights. A small quota
   is fine: it never owns files, it only receives shares.

2. **Log in as `ostrich-viewer` once.** Nextcloud does not finish provisioning
   an account (skeleton files, calendar home) until its first login, and the
   app's task discovery needs the calendar home to exist.

3. **Generate an app password.** While logged in as `ostrich-viewer`:
   Settings → Security → *Devices & sessions* → "Create new app password", name
   it `ostrich-view`. Copy the generated password — it is shown once. This is
   `NC_APP_PASSWORD` in `.env`. The account's real password never goes in a
   config file, and this token can be revoked from that same page without
   touching the account.

4. **Share the folders.** As the owner, share each course folder with
   `ostrich-viewer` and **uncheck "Allow editing"** (older Nextcloud versions
   call it "can edit"). The app cannot write anyway, but a read-only share means
   a bug or a stolen app password still cannot change the owner's files.

5. **Share the task lists.** In the Tasks app, each list is a calendar: open
   its ⋯ menu → Share → share with `ostrich-viewer`, read-only. Shared lists
   show up under the viewer account's CalDAV home, which is what the app
   enumerates.

6. **Optional: PDF thumbnails.** Nextcloud ships with the PDF preview provider
   disabled, so PDFs get a generic PDF icon on the tiles. Opening a PDF works
   regardless — the inline viewer renders the file itself and never asks
   Nextcloud for a preview. To get real PDF thumbnails, an admin adds
   `OC\Preview\PDF` to `enabledPreviewProviders` in `config/config.php`:

   ```php
   'enabledPreviewProviders' => [
     'OC\Preview\PNG',
     'OC\Preview\JPEG',
     'OC\Preview\PDF',
   ],
   ```

   Existing PDFs get thumbnails the first time something asks for one, so no
   regeneration step is needed. Note that this makes Nextcloud rasterise PDFs,
   which costs CPU on a small box — that is why it is off by default and
   optional here.

### Worth checking before the first deploy

- The app reaches Nextcloud over the LAN or docker network, so that hostname
  must be in Nextcloud's `trusted_domains` and must not bounce to an HTTPS
  redirect loop.
- The zone must not have a Cloudflare "Cache Everything" rule; every page here
  is per-viewer and sent `no-store`.

---

## 2. Server setup on the Beelink

Prerequisites: git, and Docker with **Compose v2** — the `docker compose`
subcommand. The standalone `docker-compose` v1 binary will not work here (the
compose file has no `version:` key, which older v1 releases reject), and
`deploy.sh` stops with a message if that is all it finds.

```bash
sudo mkdir -p /opt/ostrich-view
sudo chown "$USER" /opt/ostrich-view
git clone <this repo> /opt/ostrich-view
cd /opt/ostrich-view
mkdir -p data
```

`data/` is the app's only writable directory — `preview-cache/` and
`state.json` live there, bind-mounted to `/app/data`. Create it **now**, before
any `docker compose` command: if Docker has to create a missing bind-mount
source itself it creates it owned by root, and the container runs as uid 1000
and cannot write to it. The container then restart-loops on `EACCES`. `data/`
must be owned by uid 1000 (`sudo chown -R 1000:1000 data` fixes it); creating
it as an ordinary uid-1000 login user gets that for free, and `./deploy.sh`
checks it on every deploy.

### 2.1 `.env`

```bash
cp .env.example .env
$EDITOR .env
```

| Variable | Required | What it is |
|---|---|---|
| `NC_BASE_URL` | yes | Where the app finds Nextcloud. **LAN or docker-network address, not the public Cloudflare hostname.** |
| `NC_USER` | yes | The dedicated viewer account, e.g. `ostrich-viewer`. |
| `NC_APP_PASSWORD` | yes | The app password from step 3 above. Not the account password. |
| `SESSION_SECRET` | yes | 64 hex characters (32 bytes). Encrypts the session cookie. |
| `PORT` | no (3000) | Port inside the container. `docker-compose.yml` and the health check both read it, so changing it here is enough; the app stays published on the host at `127.0.0.1:3000`. |
| `HOST` | no (`0.0.0.0`) | Bind address. The default is right for a container; the loopback-only exposure is the compose port mapping's job. |
| `DATA_DIR` | no (`/app/data` in the image) | Writable runtime directory: `preview-cache/` and `state.json`. Mounted from `./data`. |
| `VIEWERS_FILE` | no (`config/viewers.json`) | Path to the viewer list. |
| `LOG_LEVEL` | no (`info`) | `trace`…`fatal`. |

`NODE_ENV` is not in `.env` — `docker-compose.yml` sets it to `production`,
which is what makes the session cookie `Secure`-only.

**Why `NC_BASE_URL` must be internal:** every preview thumbnail and every byte
of every file is proxied through this app. Pointing it at
`https://cloud.example.com` would send that traffic out to Cloudflare and
back in for no reason, on a home upload link. Use the LAN address (or a docker
container name, see below). The catch is that Nextcloud checks the `Host`
header: whatever hostname you use here has to appear in Nextcloud's
`trusted_domains` array in `config/config.php`, or Nextcloud answers with its
"untrusted domain" page instead of your files.

Generate the session secret:

```bash
openssl rand -hex 32
# or, if node is installed on the host:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2.2 `config/viewers.json`

The viewer list — who can log in, and under which name their "new since you
last looked" is tracked. It is gitignored; only the example is committed.

```bash
cp config/viewers.example.json config/viewers.json
npm run hash          # or: node scripts/hash-passphrase.js
```

The script prompts for a passphrase (echo hidden), bcrypt-hashes it, and prints
a ready-to-paste JSON object. Paste it into the array in
`config/viewers.json`, replacing the placeholder entry:

```json
[
  { "name": "mom", "label": "Mom", "passphraseHash": "$2b$12$..." }
]
```

If the Beelink has no Node installed, run the script inside the image instead
(this needs `.env` to exist already, because compose reads it):

```bash
docker compose run --rm --entrypoint node ostrich-view scripts/hash-passphrase.js
```

Pick a passphrase that is easy to say and type on a phone keyboard — several
words, no punctuation gymnastics. Login is rate-limited to 5 attempts per
minute per IP, plus a 30-failures-per-minute cap across everyone, so length
beats punctuation here.

### 2.3 First run

```bash
docker compose up -d --build
curl http://127.0.0.1:3000/healthz     # {"status":"ok",...}
docker compose logs -f ostrich-view    # Ctrl-C to stop following
```

(`data/` should already exist from the setup step above. If it does not, create
it before this command, not after — see the note there.)

The container publishes on `127.0.0.1:3000` only — nothing on the LAN can reach
it directly. That is deliberate; the tunnel is the front door.

---

## 3. Cloudflare tunnel

The Beelink already runs a `cloudflared` tunnel managed from the Cloudflare
dashboard, so this is a dashboard change, not a config file:

1. Zero Trust → Networks → Tunnels → the Beelink's tunnel → **Configure** →
   *Public Hostnames* → **Add a public hostname**.
2. Subdomain `ostrich`, domain `example.com`.
3. Service: **HTTP**, URL `localhost:3000`.
4. Save. Cloudflare creates the DNS record itself.

`localhost:3000` is correct only if `cloudflared` runs on the host — a systemd
service, or a container with `network_mode: host`. If `cloudflared` runs in a
container on a bridge network, its `localhost` is its own container, and it
cannot reach this app on the host's loopback either: the compose port mapping
publishes on `127.0.0.1` only, and `host.docker.internal` resolves to the
host's *bridge* address, which nothing is listening on. Two arrangements work
in that case:

- Put both containers on the same docker network and use
  `http://ostrich-view:3000` (the container port, i.e. `PORT`) — no host
  publishing involved at all.
- Run `cloudflared` on the host instead (systemd service or `network_mode:
  host`) and keep `http://localhost:3000`.

`https://ostrich.example.com` should now show the login page. TLS is
terminated by Cloudflare. The app sets `trustProxy`, which only affects
`req.ip` — what shows up in the logs — not rate limiting: the login limiter
keys directly on the `CF-Connecting-IP` header (5 attempts/minute), which is
forgeable by anything that can reach the origin without going through
Cloudflare, so it is backstopped by a global 30-failed-logins-per-minute window
that counts every failure regardless of claimed origin and cannot be dodged by
rotating that header.

Do not add a "Cache Everything" page rule for this hostname.

---

## 4. Deploying updates

```bash
ssh beelink
cd /opt/ostrich-view && ./deploy.sh
```

`deploy.sh` is deliberately small and does exactly this:

1. Refuses to start if `.env` or `config/viewers.json` is missing, requires
   Compose v2, creates `./data` if it does not exist, and checks that `./data`
   is owned by uid 1000 — fixing it when run as root, otherwise stopping with
   the `chown` command to run.
2. `git pull --ff-only` — if the checkout has drifted it stops and asks for a
   human rather than starting a merge on a live box.
3. `docker compose up -d --build`.
4. Polls `http://127.0.0.1:3000/healthz` (or, with no `curl` on the host, runs
   `scripts/healthcheck.js` inside the container) against a 30-second
   wall-clock deadline, then prints **PASS** (exit 0) or **FAIL** with the last
   50 lines of container output (exit 1).

`/healthz` does not touch Nextcloud, so a PASS means "the process booted and
its configuration validated" — not "Nextcloud is reachable". If pages 500 after
a green deploy, check `NC_BASE_URL` and the app password:
`docker compose logs ostrich-view`.

Deploys are hand-triggered on purpose. CI tests every push, but nothing pushes
back across the tunnel.

### Where the data lives

`./data` on the host, mounted at `/app/data`:

- `preview-cache/` — thumbnails fetched from Nextcloud, keyed by file id and
  etag. Safe to delete; it refills on demand.
- `state.json` — each viewer's current and previous visit timestamps, which is
  what "new since you last looked" compares against. Deleting it resets
  everyone's baseline to now, so the section will look empty until something
  changes.

Both survive `docker compose restart`, rebuilds and reboots. `./config` is
mounted read-only; the container cannot rewrite its own auth config.

---

## 5. Adding or removing a viewer

1. `npm run hash` (or the `docker compose run` form above) to generate an entry.
2. Add it to — or delete it from — the array in `config/viewers.json`.
3. `docker compose restart ostrich-view`.

`viewers.json` is read at boot, so a restart is what picks up the change.
Removing a viewer also invalidates their session: the auth hook re-checks every
request's cookie against the loaded viewer list, so a removed viewer is bounced
to the login page at the next restart rather than living out the cookie's
90-day expiry. Their entry in `state.json` is simply ignored.

---

## 6. Development

```bash
npm install          # also builds public/pdfjs/ via the `prepare` script
cp .env.example .env # point NC_BASE_URL at the real Nextcloud over LAN
npm run dev          # NODE_ENV=development, --watch, reads .env directly
```

`npm run dev` sets `NODE_ENV=development`, which drops `Secure` from the session
cookie so you can log in over plain HTTP from a phone on the LAN. `npm start`
does not do that: a bare start behaves as production.

### Tests

```bash
npm test        # node:test units: parsers, sorting, visit rotation, path safety
npm run test:e2e   # Playwright, desktop Chromium + Pixel 7 viewport
```

Neither needs the real Nextcloud. `test/mock-nextcloud/` is a small HTTP server
that speaks just enough `PROPFIND` / `REPORT` / `SEARCH` / preview / `GET`, with
canned XML and real sample PNG/JPG/PDF files. The Playwright global setup boots
that mock and the app together on ephemeral ports, with a throwaway `DATA_DIR`,
so a run always starts from a cold cache and leaves nothing behind.

CI (`.github/workflows/ci.yml`) runs the units, the E2E suite, a
`docker build`, and a boot smoke test of the built image against dummy
environment values and `config/viewers.example.json`.

### Other scripts

| Command | What it does |
|---|---|
| `npm run hash` | Generate a bcrypt passphrase entry for `config/viewers.json`. |
| `npm run pdfjs` | Rebuild `public/pdfjs/` from the installed `pdfjs-dist`. |

`public/pdfjs/` is generated, gitignored, and rebuilt from scratch each time.
Do not edit it; the viewer page it contains comes from
`scripts/pdfjs-viewer/`.
