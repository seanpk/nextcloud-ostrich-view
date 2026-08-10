#!/usr/bin/env bash
#
# Deploy Nextcloud Ostrich View on the Beelink.
#
#   ssh beelink
#   cd /opt/ostrich-view && ./deploy.sh
#
# Pull, rebuild, restart, then prove the thing is actually answering before
# saying so. Deploys are hand-triggered on purpose: there is no CI runner on
# the far side of the tunnel, and this is a one-machine app.

set -euo pipefail

# Always operate on the checkout this script lives in, however it was invoked.
cd "$(dirname "$(readlink -f "$0")")"

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
# Docker Compose v2 is a `docker` subcommand; older installs have the standalone
# v1 binary. Support both rather than making the deploy depend on which one the
# Beelink happens to have.
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  fail "docker compose is not available. Install Docker Compose and re-run."
fi

# --- preflight --------------------------------------------------------------
# Both of these are gitignored, so a fresh clone has neither. Checking here
# turns "container restart-loops and nobody notices" into a one-line message.
step "Checking configuration"

[ -f .env ] || fail ".env is missing. Copy .env.example to .env and fill it in (see README.md)."
[ -f config/viewers.json ] || fail "config/viewers.json is missing. Create it with \`npm run hash\` (see README.md)."

# The container runs as uid 1000 and writes only here. If this directory does
# not exist, Docker creates it root-owned and the app cannot write its preview
# cache; creating it as the deploying user avoids that.
mkdir -p data

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
if command -v curl >/dev/null 2>&1; then
  probe() { curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; }
else
  # No curl on the host: ask the container's own Node to make the request.
  probe() {
    compose exec -T ostrich-view node -e \
      "fetch('$HEALTH_URL').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
      >/dev/null 2>&1
  }
fi

healthy=0
for _ in $(seq 1 "$HEALTH_TIMEOUT_SECONDS"); do
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
