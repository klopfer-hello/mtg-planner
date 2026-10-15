#!/usr/bin/env bash
# Build the mtg-planner image on this machine, test it, and switch a compose
# deployment (local, or a remote Docker host over SSH) to it.
#
# Why: the build and the test suite run where the CPU is, the target only
# loads the finished image, and what runs is exactly what was tested. Nothing
# is pulled from a registry; releases are tagged after the deployed build was
# tried. The image is tagged mtg-planner:<semver>-<12-char sha>[.dirty] and
# stamped VERSION=<semver>+<sha>[.dirty] (shown by /healthz).
#
# The target's docker-compose.override.yml must select the image by variable:
#   image: ${MTG_PLANNER_IMAGE:?set by scripts/deploy.sh}
#   pull_policy: never
# The script stores MTG_PLANNER_IMAGE in the target's .env, so a plain
# `docker compose up -d` there keeps running the deployed build.
#
# Settings come from the environment; scripts/deploy.local.env (gitignored) may
# supply defaults, written as `: "${DEPLOY_HOST=user@host}"` so the environment
# still wins (an empty DEPLOY_HOST= means this machine):
#   DEPLOY_HOST            ssh target such as user@host; empty = this machine
#   DEPLOY_DIR             compose directory on the target, absolute or relative
#                          to the ssh login directory (default: this checkout)
#   DEPLOY_KEEP            local images kept on the target for rollback (3)
#   DEPLOY_HEALTH_TIMEOUT  seconds to wait for healthy (360: a fresh /claude
#                          volume installs the Claude Code CLI first)
#
# Usage:
#   scripts/deploy.sh                  build, test, ship, switch
#   scripts/deploy.sh --image <tag>    switch to an image already on the target (rollback)
#   options: --skip-tests  --allow-dirty
# Backups stay a manual step (Settings tab), on purpose: a deploy takes none.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$PWD
if [[ -f scripts/deploy.local.env ]]; then
  . scripts/deploy.local.env
fi

SERVICE=mtg-planner
CONTAINER=mtg-planner
DEPLOY_HOST=${DEPLOY_HOST-}
DEPLOY_DIR=${DEPLOY_DIR:-$REPO}
DEPLOY_KEEP=${DEPLOY_KEEP:-3}
DEPLOY_HEALTH_TIMEOUT=${DEPLOY_HEALTH_TIMEOUT:-360}
# Git Bash on Windows would rewrite the container paths below.
export MSYS_NO_PATHCONV=1

image=''; skip_tests=0; allow_dirty=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) image=${2:?--image needs a tag}; shift 2 ;;
    --skip-tests) skip_tests=1; shift ;;
    --allow-dirty) allow_dirty=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Arguments travel through the remote login shell as words: keep them plain.
safe='^[A-Za-z0-9._/:@+-]+$'
for v in "$DEPLOY_DIR" "$image" "$DEPLOY_KEEP" "$DEPLOY_HEALTH_TIMEOUT"; do
  [[ -z "$v" || "$v" =~ $safe ]] || { echo "unsafe characters in setting: $v" >&2; exit 2; }
done

# Runs a bash script (stdin) on the target, with positional arguments.
target() {
  if [[ -n "$DEPLOY_HOST" ]]; then
    ssh -o BatchMode=yes "$DEPLOY_HOST" bash -s -- "$@"
  else
    bash -s -- "$@"
  fi
}

if [[ -z "$image" ]]; then
  if grep -q $'\r' scripts/entrypoint.sh; then
    echo "scripts/entrypoint.sh has CRLF line endings; the image would not start" >&2
    exit 1
  fi
  semver=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n1)
  [[ -n "$semver" ]] || { echo "could not read version from package.json" >&2; exit 1; }
  sha=$(git rev-parse --short=12 HEAD)
  VERSION="${semver}+${sha}"
  # Untracked files count too: the image copies all of lib/ and public/.
  if [[ -n "$(git status --porcelain)" ]]; then
    if [[ $allow_dirty != 1 ]]; then
      echo "working tree is not clean (commit first, or pass --allow-dirty):" >&2
      git status --short >&2
      exit 1
    fi
    # A timestamp keeps successive dirty builds of one commit apart.
    VERSION="${VERSION}.dirty.$(date +%Y%m%d%H%M%S)"
  fi
  # Docker tags can't contain '+'.
  image="mtg-planner:${VERSION//+/-}"

  echo "==> Building ${image} (VERSION=${VERSION})"
  docker build -t "$image" --build-arg VERSION="$VERSION" .

  if [[ $skip_tests != 1 ]]; then
    echo "==> Testing inside ${image}"
    mount=$REPO
    if command -v cygpath >/dev/null; then mount=$(cygpath -m "$REPO"); fi
    docker run --rm --entrypoint npm -v "${mount}:/app" -w /app "$image" test
  fi

  if [[ -n "$DEPLOY_HOST" ]]; then
    local_id=$(docker image inspect -f '{{.Id}}' "$image")
    remote_id=$(target "$image" <<<'docker image inspect -f "{{.Id}}" "$1" 2>/dev/null || true')
    if [[ "$remote_id" == "$local_id" ]]; then
      echo "==> ${DEPLOY_HOST} already has ${image}"
    else
      echo "==> Shipping ${image} to ${DEPLOY_HOST}"
      docker save "$image" | ssh -o BatchMode=yes "$DEPLOY_HOST" docker load
    fi
  fi
fi

echo "==> Switching ${DEPLOY_HOST:-local} ${DEPLOY_DIR} to ${image}"
target "$image" "$DEPLOY_DIR" "$CONTAINER" "$SERVICE" "$DEPLOY_KEEP" "$DEPLOY_HEALTH_TIMEOUT" <<'REMOTE'
set -euo pipefail
image=$1; dir=$2; container=$3; service=$4; keep=$5; timeout=$6
cd "$dir"
docker image inspect "$image" >/dev/null || { echo "image $image not found on the target" >&2; exit 1; }

previous=$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)
state=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo missing)
echo "current: ${previous:-none} (${state})"

# Rewrite only our own line of .env; it also holds secrets, so never print it
# and never replace it with a partial copy.
touch .env
[[ -r .env ]] || { echo ".env is not readable" >&2; exit 1; }
cp -p .env .env.deploy-prev
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f "$tmp"' EXIT
rc=0; grep -v '^MTG_PLANNER_IMAGE=' .env > "$tmp" || rc=$?
(( rc <= 1 )) || { echo "reading .env failed" >&2; exit 1; }
printf 'MTG_PLANNER_IMAGE=%s\n' "$image" >> "$tmp"
kept=$(grep -vc '^MTG_PLANNER_IMAGE=' .env || true)
[[ $(wc -l < "$tmp") -eq $((kept + 1)) ]] || { echo ".env rewrite lost lines, aborting" >&2; exit 1; }
chmod --reference=.env "$tmp" 2>/dev/null || chmod 600 "$tmp"
mv "$tmp" .env
restore_env() { mv .env.deploy-prev .env; echo ".env restored" >&2; }

# Compose must resolve to exactly this image (an override with build: or a
# fixed image would silently run something else). Prints image names only.
resolved=$(docker compose config --images "$service" 2>/dev/null || true)
if [[ "$resolved" != "$image" ]]; then
  echo "compose resolves to '${resolved}', not ${image}: docker-compose.override.yml must use image: \${MTG_PLANNER_IMAGE} and pull_policy: never, without build:" >&2
  restore_env
  exit 1
fi

if ! docker compose up -d "$service"; then
  echo "docker compose up failed; .env points at ${image}" >&2
  echo "roll back with: scripts/deploy.sh --image ${previous:-<previous tag>}" >&2
  exit 1
fi
rm -f .env.deploy-prev

echo "==> Waiting up to ${timeout}s for ${container} to become healthy"
status=missing
deadline=$((SECONDS + timeout))
while (( SECONDS < deadline )); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo missing)
  case "$status" in
    healthy|exited|dead|missing) break ;;
  esac
  sleep 3
done
running=$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)
if [[ "$running" != "$image" ]]; then
  echo "container runs '${running}', expected ${image}" >&2
  exit 1
fi
if [[ "$status" != healthy ]]; then
  docker logs --tail 50 "$container" >&2 || true
  if [[ "$status" == starting ]]; then
    echo "still starting after ${timeout}s: check docker logs and /healthz again before rolling back" >&2
  else
    echo "container is ${status}" >&2
  fi
  echo "roll back with: scripts/deploy.sh --image ${previous:-<previous tag>}" >&2
  exit 1
fi
docker exec "$container" node -e "fetch('http://127.0.0.1:8080/healthz').then(r => r.json()).then(h => console.log('==> /healthz', h.version, 'ok=' + h.ok))"
echo "previous image: ${previous:-none} (rollback: scripts/deploy.sh --image ${previous:-<tag>})"

# Keep the newest $keep local builds (plus the running and previous one) for
# rollback. Best effort: a failed removal must not fail a finished deploy.
docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' 'mtg-planner' \
  | awk '$1 !~ /<none>/' | sort -k2 -r | awk '{print $1}' | tail -n +"$((keep + 1))" \
  | while read -r old; do
      if [[ "$old" != "$image" && "$old" != "$previous" ]]; then
        docker image rm "$old" >/dev/null 2>&1 && echo "removed old image $old" || echo "kept $old (still in use?)"
      fi
    done || true
docker image prune -f --filter 'label=org.opencontainers.image.title=mtg-planner' >/dev/null 2>&1 || true
REMOTE
