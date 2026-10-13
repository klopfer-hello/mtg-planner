#!/bin/sh
# mtg-planner container entrypoint.
#
# The Claude Code CLI is proprietary (© Anthropic PBC) and is NOT part of the
# published image. On start this script installs the pinned version
# (CLAUDE_CODE_VERSION) from npm into the persistent /claude volume, under
# Anthropic's terms, so it is downloaded once per volume and version. The app
# starts even when the install fails (e.g. no network): the chat and the
# scanner's Claude fallback then report "not installed" and /healthz shows
# claude_cli.status = "missing".
set -u

PREFIX="${CLAUDE_CLI_PREFIX:-${CLAUDE_CONFIG_DIR:-/claude}/cli}"
# An empty CLAUDE_CODE_VERSION (e.g. a blank line in .env) means the image's pin.
WANT="${CLAUDE_CODE_VERSION:-${CLAUDE_CODE_DEFAULT_VERSION:-}}"
if [ -n "$WANT" ]; then
  CLAUDE_CODE_VERSION="$WANT"
  export CLAUDE_CODE_VERSION
fi
PKG_JSON="$PREFIX/lib/node_modules/@anthropic-ai/claude-code/package.json"

log() { echo "[entrypoint] $*"; }

installed_version() {
  [ -f "$PKG_JSON" ] || return 0
  node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || "")) } catch {}' "$PKG_JSON"
}

install_cli() {
  # Install into a fresh directory first and swap it in only on success, so a
  # failed or interrupted install never breaks a working CLI.
  tmp="$PREFIX.new"
  rm -rf "$tmp"
  mkdir -p "$tmp" || return 1
  log "installing @anthropic-ai/claude-code@$WANT into $PREFIX"
  if timeout "${CLAUDE_INSTALL_TIMEOUT:-300}" npm install -g --prefix "$tmp" \
       --no-audit --no-fund --no-update-notifier --loglevel=error \
       --fetch-retries=1 --fetch-timeout=30000 --logs-max=0 \
       --cache "$tmp/.npm-cache" \
       "@anthropic-ai/claude-code@$WANT" \
     && [ -x "$tmp/bin/claude" ]; then
    rm -rf "$tmp/.npm-cache" "$PREFIX.old"
    [ -e "$PREFIX" ] && mv "$PREFIX" "$PREFIX.old"
    mv "$tmp" "$PREFIX" && rm -rf "$PREFIX.old"
    log "installed Claude Code $WANT"
  else
    rm -rf "$tmp"
    if [ -x "$PREFIX/bin/claude" ]; then
      log "WARNING: could not install Claude Code $WANT; keeping the installed $(installed_version), retrying on the next start"
    else
      log "WARNING: could not install Claude Code $WANT; chat and scanner fallback stay disabled until a later start installs it"
    fi
    return 1
  fi
}

if [ "${CLAUDE_CLI_INSTALL:-true}" = "false" ]; then
  log "CLAUDE_CLI_INSTALL=false: skipping the Claude Code install"
elif [ -z "$WANT" ]; then
  log "CLAUDE_CODE_VERSION is empty: skipping the Claude Code install"
else
  have="$(installed_version)"
  if [ "$have" = "$WANT" ] && [ -x "$PREFIX/bin/claude" ]; then
    log "Claude Code $have already installed"
  else
    [ -n "$have" ] && log "Claude Code $have installed, $WANT wanted"
    install_cli || true
  fi
fi

if [ -z "${CLAUDE_BIN:-}" ] && [ -x "$PREFIX/bin/claude" ]; then
  export CLAUDE_BIN="$PREFIX/bin/claude"
  CLAUDE_CLI_INSTALLED_VERSION="$(installed_version)"
  export CLAUDE_CLI_INSTALLED_VERSION
fi

if [ "$#" -eq 0 ]; then
  set -- node --disable-warning=ExperimentalWarning server.js
fi
exec "$@"
