# syntax=docker/dockerfile:1
#
# mtg-planner: Node stdlib web app + Claude Code CLI + two stdio MCP servers
# (our own collection server and bmurdock/scryfall-mcp).

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
 && test -f dist/index.js && test -f mtgrules.txt

# ---------------------------------------------------------------------------
# Stage 2: runtime.
FROM node:24-slim

ARG CLAUDE_CODE_VERSION=2.1.296
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# scryfall-mcp reads ../../mtgrules.txt relative to dist/tools.
COPY --from=scryfall-mcp /opt/scryfall-mcp/package.json /opt/scryfall-mcp/mtgrules.txt /opt/scryfall-mcp/
COPY --from=scryfall-mcp /opt/scryfall-mcp/dist /opt/scryfall-mcp/dist
COPY --from=scryfall-mcp /opt/scryfall-mcp/node_modules /opt/scryfall-mcp/node_modules

WORKDIR /app
COPY package.json server.js mcp-collection.js ./
COPY lib ./lib
COPY public ./public

ARG VERSION=dev
ENV APP_VERSION=${VERSION} \
    NODE_ENV=production \
    PORT=8080 \
    DB_FILE=/data/mtg-planner.db \
    STATIC_DIR=/app/public \
    CLAUDE_CONFIG_DIR=/claude \
    SCRYFALL_MCP_ENTRY=/opt/scryfall-mcp/dist/index.js \
    DISABLE_AUTOUPDATER=1

RUN mkdir -p /data /claude && chown node:node /data /claude
VOLUME ["/data", "/claude"]
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

LABEL org.opencontainers.image.title="mtg-planner" \
      org.opencontainers.image.description="Self-hosted Magic: The Gathering collection + deck planner (ManaBox sync, Scryfall data) with a Claude-powered assistant" \
      org.opencontainers.image.source="https://github.com/klopfer-hello/mtg-planner" \
      org.opencontainers.image.url="https://github.com/klopfer-hello/mtg-planner" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
