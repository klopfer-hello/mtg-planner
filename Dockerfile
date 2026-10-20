# syntax=docker/dockerfile:1
#
# mtg-planner: Node stdlib web app + two stdio MCP servers (our own collection
# server and bmurdock/scryfall-mcp), plus the card scanner's system binaries
# (tesseract OCR with traineddata for every printed card language, djpeg from
# libjpeg-turbo for server-side JPEG decoding), plus mtg-ocr, a small C helper
# that keeps Tesseract loaded between OCR calls (native/mtg-ocr.c).
#
# The Claude Code CLI is proprietary and is deliberately NOT in this image:
# scripts/entrypoint.sh installs the pinned CLAUDE_CODE_VERSION from npm into
# the /claude volume on first start (see THIRD_PARTY_NOTICES.md).

# ---------------------------------------------------------------------------
# Stage 1: build bmurdock/scryfall-mcp at a pinned commit.
FROM node:24-slim AS scryfall-mcp
ARG SCRYFALL_MCP_REF=dc06a9749d7554564ddaa0f7f17305124b074968
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/scryfall-mcp
RUN git init -q . \
 && git remote add origin https://github.com/bmurdock/scryfall-mcp \
 && git fetch -q --depth 1 origin "$SCRYFALL_MCP_REF" \
 && git checkout -q FETCH_HEAD
# `npm run build` also runs the test suite, so compile with tsc directly.
RUN npm ci --no-audit --no-fund \
 && npx tsc \
 && npm prune --omit=dev \
 && test -f dist/index.js && test -f mtgrules.txt && test -f LICENSE

# ---------------------------------------------------------------------------
# Stage 2: mtg-ocr, the persistent Tesseract helper lib/ocr.js talks to
# (native/mtg-ocr.c). Same base image as the runtime, so it links against the
# very libtesseract/libleptonica the runtime's tesseract-ocr package installs.
FROM node:24-slim AS mtg-ocr
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gcc libc6-dev pkg-config libtesseract-dev libleptonica-dev \
 && rm -rf /var/lib/apt/lists/*
COPY native/mtg-ocr.c /src/mtg-ocr.c
RUN mkdir -p /out \
 && gcc -O2 -Wall -Wextra -Werror -o /out/mtg-ocr /src/mtg-ocr.c $(pkg-config --cflags --libs tesseract lept) \
 && strip /out/mtg-ocr \
 && dpkg-query -W -f='${Version}' libtesseract5 > /out/libtesseract.version

# ---------------------------------------------------------------------------
# Stage 3: runtime.
FROM node:24-slim

# Scanner: collector-line/title OCR (tesseract + per-language traineddata) and
# JPEG -> PNM decoding for fingerprints (djpeg). Spawned as child processes,
# so the app itself keeps zero npm runtime dependencies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-ita tesseract-ocr-spa \
      tesseract-ocr-por tesseract-ocr-jpn tesseract-ocr-chi-sim \
      tesseract-ocr-chi-tra tesseract-ocr-kor tesseract-ocr-rus \
      libjpeg-turbo-progs \
 && rm -rf /var/lib/apt/lists/*

# Persistent OCR helper (lib/ocr.js OCR_HELPER, ~20 KB). It must link against
# the libtesseract build the tesseract CLI uses (identical OCR output).
COPY --from=mtg-ocr /out/mtg-ocr /usr/local/bin/mtg-ocr
COPY --from=mtg-ocr /out/libtesseract.version /tmp/libtesseract.version
RUN test "$(dpkg-query -W -f='${Version}' libtesseract5)" = "$(cat /tmp/libtesseract.version)" \
 && /usr/local/bin/mtg-ocr </dev/null \
 && rm /tmp/libtesseract.version

# scryfall-mcp reads ../../mtgrules.txt relative to dist/tools.
# Its MIT LICENSE ships next to its code.
COPY --from=scryfall-mcp /opt/scryfall-mcp/package.json /opt/scryfall-mcp/mtgrules.txt /opt/scryfall-mcp/LICENSE /opt/scryfall-mcp/
COPY --from=scryfall-mcp /opt/scryfall-mcp/dist /opt/scryfall-mcp/dist
COPY --from=scryfall-mcp /opt/scryfall-mcp/node_modules /opt/scryfall-mcp/node_modules

WORKDIR /app
COPY package.json server.js mcp-collection.js LICENSE THIRD_PARTY_NOTICES.md ./
COPY lib ./lib
COPY server ./server
COPY public ./public
COPY --chmod=755 scripts/entrypoint.sh /usr/local/bin/mtg-planner-entrypoint

ARG VERSION=dev
# Claude Code version the entrypoint installs into /claude/cli at runtime.
ARG CLAUDE_CODE_VERSION=2.1.296
ENV APP_VERSION=${VERSION} \
    CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} \
    CLAUDE_CODE_DEFAULT_VERSION=${CLAUDE_CODE_VERSION} \
    PATH=/claude/cli/bin:$PATH \
    NODE_ENV=production \
    PORT=8080 \
    DB_FILE=/data/mtg-planner.db \
    STATIC_DIR=/app/public \
    CLAUDE_CONFIG_DIR=/claude \
    SCRYFALL_MCP_ENTRY=/opt/scryfall-mcp/dist/index.js \
    DISABLE_AUTOUPDATER=1 \
    OMP_THREAD_LIMIT=1 \
    INDEX_DB_FILE=/data/cardindex.db \
    FP_IMAGE_DIR=/data/images

RUN mkdir -p /data /claude && chown node:node /data /claude
VOLUME ["/data", "/claude"]
USER node
EXPOSE 8080

# start-period covers the one-time CLI install on a fresh /claude volume.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

LABEL org.opencontainers.image.title="mtg-planner" \
      org.opencontainers.image.description="Self-hosted Magic: The Gathering collection + deck planner (ManaBox sync, camera scanner, Scryfall data) with a Claude-powered assistant" \
      org.opencontainers.image.source="https://github.com/klopfer-hello/mtg-planner" \
      org.opencontainers.image.url="https://github.com/klopfer-hello/mtg-planner" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.version="${VERSION}"

ENTRYPOINT ["mtg-planner-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
