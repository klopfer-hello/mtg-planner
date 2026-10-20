// mtg-planner web server: JSON API, ManaBox CSV import, decks, Claude chat
// (Server-Sent Events), the card scanner (identify + staging + commit, local
// card index jobs), manual backup/restore of the app database, the wishlist,
// the value history (Market tab) and the static single-page app. Node stdlib only.
//
// This file wires things together: the shared state (server/app.js), the API
// routes (server/routes/*.js), static files, /healthz, the nightly scheduler,
// boot and shutdown.
//
// Unauthenticated by design: meant for a trusted LAN (see docs/backups-and-security.md).

import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";

import * as claudeLib from "./lib/claude.js";
import { claudeConfigured, killAll, prepareMcpConfig } from "./lib/claude.js";
import { checkpointIndex } from "./lib/cardindex.js";
import { getAppMeta, setAppMeta } from "./lib/db.js";
import { ensureSnapshot, snapshotValue } from "./lib/finance.js";
import { refreshOwnedCards } from "./lib/manabox.js";
import { createScheduler, schedulerConfig } from "./lib/scheduler.js";
import { pruneSpellbookCache, seedSpellbookSettings, spellbookHealth } from "./lib/spellbook.js";
import { createApp } from "./server/app.js";
import { libHttpError } from "./server/errors.js";
import { HttpError, SECURITY_HEADERS, checkSameOrigin, sendJson } from "./server/http.js";
import { Router } from "./server/router.js";
import { JOB_DONE } from "./server/scanner.js";
import { createStaticHandler } from "./server/static.js";
import { backupRoutes } from "./server/routes/backups.js";
import { binderRoutes } from "./server/routes/binders.js";
import { chatRoutes } from "./server/routes/chats.js";
import { collectionRoutes } from "./server/routes/collection.js";
import { debugRoutes } from "./server/routes/debug.js";
import { deckRoutes } from "./server/routes/decks.js";
import { downloadRoutes } from "./server/routes/downloads.js";
import { marketRoutes } from "./server/routes/market.js";
import { scanRoutes } from "./server/routes/scans.js";
import { settingsRoutes } from "./server/routes/settings.js";

const PORT = Number(process.env.PORT) || 8080;
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || "/app/public");
const VERSION = process.env.APP_VERSION || "dev";

const app = createApp({ version: VERSION });
const { background, scanner } = app;

// ---------------------------------------------------------------------------
// Routes

const router = new Router();
for (const routes of [
  backupRoutes, downloadRoutes, collectionRoutes, settingsRoutes, binderRoutes, deckRoutes, marketRoutes, chatRoutes, scanRoutes,
  debugRoutes,
]) routes(router, app);
const serveStatic = createStaticHandler(STATIC_DIR);

async function handleApi(req, res, url) {
  checkSameOrigin(req);
  if (app.restoring && req.method !== "GET" && req.method !== "HEAD") throw new HttpError(503, "A backup is being restored; try again in a moment");
  if (!(await router.handle(req, res, url))) throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
// /healthz

/**
 * Claude CLI presence: lib/claude.js's claudeCliStatus() when it provides one,
 * else whether CLAUDE_BIN (set by the image's entrypoint) exists.
 */
function claudeCliHealth() {
  try {
    if (typeof claudeLib.claudeCliStatus === "function") return claudeLib.claudeCliStatus();
  } catch (err) {
    return { status: "missing", version: null, error: err.message };
  }
  const bin = process.env.CLAUDE_BIN;
  if (!bin) return { status: "unknown", version: null };
  return { status: existsSync(bin) ? "installed" : "missing", version: process.env.CLAUDE_CODE_VERSION || null };
}

/** Spellbook state (never fails the health check). */
function spellbookHealthz() {
  try {
    return { ...spellbookHealth(app.db), queued: app.spellbook.pending().length };
  } catch (err) {
    return { error: err.message };
  }
}

async function healthz() {
  return {
    ok: true, version: VERSION, claude_configured: claudeConfigured(), claude_cli: claudeCliHealth(), scanner: await scanner.health(),
    spellbook: spellbookHealthz(), card_facts: background.cardFactsHealth(),
  };
}

// ---------------------------------------------------------------------------
// Server

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.on("close", () => {
    const aborted = res.writableFinished ? "" : " (client closed)";
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms${aborted}`);
  });

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "Bad request URL" });
  }

  try {
    if (url.pathname === "/healthz") return sendJson(res, 200, await healthz());
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    return await serveStatic(req, res, url);
  } catch (caught) {
    // lib/ errors carry their own status (a missing deck, a binder name taken, ...).
    const err = libHttpError(caught) ?? caught;
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(`[error] ${req.method} ${req.url}:`, err);
    else if (status >= 500) console.warn(`[warn] ${req.method} ${req.url}: ${err.message}`);
    if (res.headersSent) {
      // e.g. an SSE stream already started: report in-band and close.
      try { if (!res.writableEnded) res.end(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`); } catch { /* ignore */ }
      return;
    }
    // Drain any unread body so the connection can be reused.
    req.resume();
    sendJson(res, status, { ...(err instanceof HttpError && err.extra ? err.extra : {}), error: status === 500 ? `Internal error: ${err.message}` : err.message });
  }
});

server.requestTimeout = 0; // SSE turns and large imports can take minutes
server.headersTimeout = 60000;
server.keepAliveTimeout = 5000;

// ---------------------------------------------------------------------------
// Nightly maintenance (lib/scheduler.js): index refresh + fingerprints, prices.

app.scheduler = createScheduler({
  config: schedulerConfig(),
  meta: { get: (k) => getAppMeta(app.db, k), set: (k, v) => setAppMeta(app.db, k, v) },
  indexInfo: scanner.indexInfo,
  indexBusy: () => Boolean(scanner.indexJob.running),
  remoteBulkUpdatedAt: scanner.remoteBulkUpdatedAt,
  runIndexRefresh: async () => { await scanner.startIndexJob("refresh", { then: "fingerprints" })[JOB_DONE]; },
  runPriceRefresh: () => app.exclusive(() => refreshOwnedCards(app.db)),
  // Daily value snapshot (after the prices); waits out an import like the debounced one.
  runSnapshot: async () => {
    for (let i = 0; (app.importBusy || app.restoring) && i < 60; i++) await new Promise((r) => setTimeout(r, 5000));
    return snapshotValue(app.db);
  },
  checkpoint: () => { if (scanner.idx && !scanner.indexJob.running) checkpointIndex(scanner.idx); },
});

// ---------------------------------------------------------------------------
// Boot

prepareMcpConfig();
// Spellbook settings live in meta (shared with the MCP process); the env seeds them and its "false" always wins.
try {
  seedSpellbookSettings(app.db, process.env, console);
  const pruned = pruneSpellbookCache(app.db);
  if (pruned) console.log(`[spellbook] pruned ${pruned} cache entries unused for 60 days`);
} catch (err) {
  console.warn(`[spellbook] ${err.message}`);
}
// First commit after boot creates the app DB's WAL file (one fsync, ~60 ms
// on a spinning disk): pay it here instead of in the first scan's staging.
try { setAppMeta(app.db, "last_start", new Date().toISOString()); } catch (err) { console.warn(`[db] ${err.message}`); }
// Day 0 of the value history (Market tab): today's snapshot from the current prices when there is none.
try {
  const seeded = ensureSnapshot(app.db);
  if (seeded) console.log(`[finance] value snapshot ${seeded.day}: €${seeded.value_eur.toFixed(2)}, ${seeded.copies} copies`);
} catch (err) { console.warn(`[finance] ${err.message}`); }
scanner.autoIndex();
app.scheduler.start();
server.listen(PORT, () => {
  console.log(`mtg-planner ${VERSION} listening on :${PORT} (static: ${STATIC_DIR}, claude: ${claudeConfigured() ? "configured" : "not configured"})`);
  // CARD_FACTS_DELAY_MS: tests only (default 30 s after start).
  background.scheduleCardFacts(Number(process.env.CARD_FACTS_DELAY_MS) >= 0 && process.env.CARD_FACTS_DELAY_MS ? Number(process.env.CARD_FACTS_DELAY_MS) : 30000);
  // Preload the fingerprints now so the first scan doesn't pay for it; the twin prices follow.
  if (!scanner.start(() => background.scheduleEnglishPrices())) background.scheduleEnglishPrices(5000);
});

// ---------------------------------------------------------------------------
// Shutdown

function shutdown(signal) {
  if (app.shuttingDown) return;
  app.shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  app.scheduler.stop();
  app.spellbook.close();
  background.stop();
  for (const controller of app.runs.values()) controller.abort();
  scanner.stop();
  killAll();
  // Give aborted runs a moment to store their partial answers, then close.
  const deadline = Date.now() + 8000;
  const timer = setInterval(() => {
    if (app.runs.size === 0 || Date.now() > deadline) {
      clearInterval(timer);
      server.closeAllConnections();
      try { app.db.close(); } catch { /* ignore */ }
      scanner.close();
      process.exit(0);
    }
  }, 100);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
