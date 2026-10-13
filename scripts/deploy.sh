#!/usr/bin/env bash
# Build and (re)start mtg-planner locally, stamping the image with
# VERSION=<package.json version>+<12-char git sha>[.dirty].
#
# Needs docker-compose.override.yml (copy of the .example) so that
# `docker compose up --build` builds from this checkout instead of pulling.
set -euo pipefail

cd "$(dirname "$0")/.."

SERVICE=mtg-planner
CONTAINER=mtg-planner

if [[ ! -f docker-compose.override.yml ]]; then
  echo "docker-compose.override.yml missing - copy docker-compose.override.yml.example first" >&2
  exit 1
fi

semver=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n1)
if [[ -z "$semver" ]]; then
  echo "could not read version from package.json" >&2
  exit 1
fi

if sha=$(git rev-parse --short=12 HEAD 2>/dev/null); then
  VERSION="${semver}+${sha}"
  # Untracked files count too: the image copies all of lib/ and public/.
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    VERSION="${VERSION}.dirty"
  fi
else
  VERSION="${semver}+nogit"
fi
export VERSION

echo "==> Deploying ${SERVICE} ${VERSION}"
docker compose up -d --build "$SERVICE"

echo "==> Waiting for ${CONTAINER} to become healthy"
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing)
  case "$status" in
    healthy) break ;;
    unhealthy|exited|dead|missing)
      echo "container is ${status}; last logs:" >&2
      docker logs --tail 50 "$CONTAINER" >&2 || true
      exit 1 ;;
  esac
  sleep 2
done
if [[ "$status" != healthy ]]; then
  echo "timed out waiting for healthy (status: ${status})" >&2
  docker logs --tail 50 "$CONTAINER" >&2 || true
  exit 1
fi

echo "==> /healthz"
docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8080/healthz').then(r => r.text()).then(t => console.log(t))"
