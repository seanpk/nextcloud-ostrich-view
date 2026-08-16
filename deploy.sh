#!/usr/bin/env bash
#
# Deploy Nextcloud Ostrich View on the Beelink.
#
#   ssh beelink
#   cd ~/git-repos/nextcloud-ostrich-view && ./deploy.sh
#
# Pull, rebuild, restart, then prove the thing is actually answering before
# saying so. Deploys are hand-triggered on purpose: there is no CI runner on
# the far side of the tunnel, and this is a one-machine app.

set -euo pipefail

# Always operate on the checkout this script lives in, however it was invoked.
cd "$(dirname "$(readlink -f "$0")")"

# The host side of the published port is always 3000 (docker-compose.yml maps
# 127.0.0.1:3000 to whatever PORT the container listens on), so this URL is
# right regardless of PORT.
HEALTH_URL="http://127.0.0.1:3000/healthz"
HEALTH_TIMEOUT_SECONDS=30

# --- output helpers ---------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=""; GREEN=""; RED=""; RESET=""
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
fail() { printf '\n%sFAIL: %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

# --- compose command --------------------------------------------------------
# Compose v2 only. The standalone v1 binary is not a fallback here: this
# project's docker-compose.yml has no `version:` key, and pre-1.27 v1 refuses to
# parse such a file. Failing with a sentence beats failing with v1's error.
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
else
  fail "Docker Compose v2 is required (\`docker compose\`). Install the docker-compose-plugin package (the standalone \`docker-compose\` v1 binary will not work) and re-run."
fi

# --- preflight --------------------------------------------------------------
# Both of these are gitignored, so a fresh clone has neither. Checking here
# turns "container restart-loops and nobody notices" into a one-line message.
step "Checking configuration"

[ -f .env ] || fail ".env is missing. Copy .env.example to .env and fill it in (see README.md)."
[ -f config/viewers.json ] || fail "config/viewers.json is missing. Create it with \`npm run hash\` (see README.md)."

# The container runs as uid 1000 (the image's `node` user) and writes only
# here. If this directory does not exist, Docker creates it root-owned; if it
# exists but belongs to anyone other than uid 1000, the app dies with EACCES the
# first time it writes and the container restart-loops. Neither failure is
# obvious from the outside, so check it here where it costs one line.
#
# ./config needs no such check: it is mounted read-only.
mkdir -p data
data_uid=$(stat -c %u data)
if [ "$data_uid" != "1000" ]; then
  if [ "$(id -u)" = "0" ]; then
    chown -R 1000:1000 data
    printf '  data/ re-owned to uid 1000\n'
  else
    fail "data/ is owned by uid $data_uid, but the container runs as uid 1000 and could not write to it. Fix it with: sudo chown -R 1000:1000 data"
  fi
fi

printf '  .env, config/viewers.json, data/ all present\n'

# --- update -----------------------------------------------------------------
step "Pulling latest code"
# --ff-only: if the checkout has local commits or edits, stop and let a human
# look, rather than starting a merge on a production box.
git pull --ff-only

step "Building and restarting"
compose up -d --build

# --- health check -----------------------------------------------------------
step "Waiting for $HEALTH_URL (up to ${HEALTH_TIMEOUT_SECONDS}s)"

# /healthz needs no session and does not touch Nextcloud, so a pass here means
# "the process booted and config validated", which is exactly the failure this
# script exists to catch.
#
# Either probe has its own bounded timeout, and the loop below is a wall-clock
# deadline rather than a count of iterations -- so the "up to 30s" printed above
# is the real ceiling no matter how long an individual attempt takes.
if command -v curl >/dev/null 2>&1; then
  probe() { curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; }
else
  # No curl on the host: run the container's own health probe, which reads the
  # container's PORT rather than assuming the published one.
  probe() {
    compose exec -T ostrich-view node scripts/healthcheck.js >/dev/null 2>&1
  }
fi

healthy=0
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while ((SECONDS < deadline)); do
  if probe; then
    healthy=1
    break
  fi
  printf '.'
  sleep 1
done
printf '\n'

if [ "$healthy" -ne 1 ]; then
  printf '\n%sLast 50 lines of container output:%s\n' "$BOLD" "$RESET" >&2
  compose logs --tail 50 ostrich-view >&2 || true
  fail "the app did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s."
fi

printf '\n%sPASS: ostrich-view is up and healthy at %s%s\n' "$GREEN" "$HEALTH_URL" "$RESET"
compose ps
exit 0
