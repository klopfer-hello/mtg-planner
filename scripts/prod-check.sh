#!/usr/bin/env bash
# Read-only check of the deployed mtg-planner: /healthz version, a few pages and
# API answers (status + size), and the error lines in the last minutes of logs.
#
# Why: one command for "what runs there and does it answer" that never changes
# the target, so it is safe right after a deploy or before tagging a release.
# Settings: DEPLOY_HOST as in scripts/deploy.sh (empty = this machine).
#
# Usage: scripts/prod-check.sh [--version]   --version prints only the version
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -f scripts/deploy.local.env ]]; then
  . scripts/deploy.local.env
fi
DEPLOY_HOST=${DEPLOY_HOST-}
export MSYS_NO_PATHCONV=1

mode=full
[[ "${1:-}" == --version ]] && mode=version

check='
container=mtg-planner
get() { docker exec "$container" node -e "fetch(\"http://127.0.0.1:8080$1\").then(async r => console.log(r.status, (await r.text()).length))"; }
docker exec "$container" node -e "fetch(\"http://127.0.0.1:8080/healthz\").then(r => r.json()).then(h => console.log(h.version + (h.ok ? \"\" : \" (ok=false)\")))"
[[ "$1" == version ]] && exit 0
for p in / /ui/core.jsx /api/decks /api/binders /api/stats; do printf "%s " "$p"; get "$p"; done
printf "log errors (5 min): "; docker logs --since 5m "$container" 2>&1 | grep -ci error || true
'
if [[ -n "$DEPLOY_HOST" ]]; then
  ssh -o BatchMode=yes "$DEPLOY_HOST" bash -s -- "$mode" <<<"$check"
else
  bash -s -- "$mode" <<<"$check"
fi
