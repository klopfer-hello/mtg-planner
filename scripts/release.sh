#!/usr/bin/env bash
# Tag the build that runs on the deploy target as a GitHub release, wait for
# CI, then remove every older release, its tag and its GHCR image versions.
#
# Why: a release is the build that was deployed and tried, never a fresh one,
# so the script refuses unless the target's /healthz reports exactly HEAD and
# the package.json version. Only the newest release stays published, so the
# cleanup runs after CI is green (a red run keeps the previous release).
#
# Settings: DEPLOY_HOST, read by scripts/prod-check.sh (as in scripts/deploy.sh).
# Needs git, gh (logged in, with the packages scopes) and ssh access to the target.
#
# Usage: scripts/release.sh            release package.json's version at HEAD
#        options: --no-cleanup         keep the older releases and images
set -euo pipefail

cd "$(dirname "$0")/.."
PACKAGE=mtg-planner
export MSYS_NO_PATHCONV=1

cleanup=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cleanup) cleanup=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "$*" >&2; exit 1; }

semver=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n1)
[[ "$semver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "package.json version '$semver' is not a final X.Y.Z (betas are not released)"
tag="v$semver"
sha=$(git rev-parse --short=12 HEAD)
[[ "$(git branch --show-current)" == main ]] || die "not on main"
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"

# The target must run exactly this commit and version.
running=$(bash scripts/prod-check.sh --version)
[[ "$running" == "${semver}+${sha}" ]] || die "target runs '$running', HEAD is ${semver}+${sha}: deploy first"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  [[ "$(git rev-parse "$tag^{commit}")" == "$(git rev-parse HEAD)" ]] || die "$tag already exists on another commit"
else
  git tag "$tag" HEAD
fi
older=$(gh release list --limit 100 --json tagName --jq '.[].tagName' | grep -vx "$tag" || true)

echo "==> Pushing main and $tag"
git push origin main "$tag"

echo "==> Waiting for the release workflow on $sha"
run=''
for _ in $(seq 1 30); do
  run=$(gh run list --workflow release.yml --commit "$(git rev-parse HEAD)" --event push --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  [[ -n "$run" ]] && break
  sleep 4
done
[[ -n "$run" ]] || die "no release workflow run appeared for $tag"
if ! gh run watch "$run" --exit-status --interval 20 >/dev/null; then
  gh run view "$run" --json jobs --jq '.jobs[] | "  \(.name): \(.conclusion)"' >&2
  die "release workflow $run failed; older releases were kept"
fi
gh run view "$run" --json jobs --jq '.jobs[] | "  \(.name): \(.conclusion)"'
started=$(gh run view "$run" --json createdAt --jq .createdAt)

if [[ $cleanup == 1 ]]; then
  for old in $older; do
    gh release delete "$old" --cleanup-tag -y && echo "removed release $old"
    git tag -d "$old" >/dev/null 2>&1 || true
  done
  # Image versions (index, image, attestation) pushed before this run belong to older releases.
  for id in $(gh api "user/packages/container/$PACKAGE/versions?per_page=100" --jq ".[] | select(.created_at < \"$started\") | .id"); do
    gh api -X DELETE "user/packages/container/$PACKAGE/versions/$id" && echo "removed image version $id"
  done
fi

echo "==> Released $(gh release view "$tag" --json url --jq .url)"
