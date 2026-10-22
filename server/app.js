// The server's shared state, handed to every route module: the app database
// (a `db` swapped by a restore, so everything reads app.db at call time), the
// write lock for imports and collection changes (exclusive), the busy flags,
// the scanner, the background upkeep and the deck services that fill caches
// in the background (Commander Spellbook combos, tokens & extras).

import path from "node:path";

import { createAccessoryFetcher } from "../lib/accessories.js";
import { MAX_CONCURRENT, activeClaudeRuns } from "../lib/claude.js";
import { openDb } from "../lib/db.js";
import { deckComboRequest } from "../lib/deckpower.js";
import { schedulerConfig } from "../lib/scheduler.js";
import { createSpellbookScheduler } from "../lib/spellbook.js";
import { createBackground } from "./background.js";
import { HttpError } from "./http.js";
import { createScanner } from "./scanner.js";

export const DB_FILE = path.resolve(process.env.DB_FILE || "/data/mtg-planner.db");

/** Open the DB and the card index, wire the services; `version` = APP_VERSION. */
export function createApp({ version }) {
  const app = {
    version,
    dbFile: DB_FILE,
    db: openDb(DB_FILE),
    importBusy: false, // exclusive() holds it; a restore too
    restoring: false, // while true every other state-changing request gets 503
    backupBusy: false, // one backup or restore at a time
    shuttingDown: false,
    /** chat id → AbortController of the running Claude turn. */
    runs: new Map(),
    /** deck id → {started_at} of a deck guide being written in the background (server/routes/decks.js). */
    guideJobs: new Map(),
    /** Planner lessons distilled from ratings in the background (server/routes/chats.js). */
    lessons: { timer: null, running: false, last_error: null },
    scheduler: null, // lib/scheduler.js, set by server.js

    /**
     * Imports, moves, edits and price refreshes run one at a time: they hit Scryfall and rewrite the collection.
     * 503 while a restore swaps the DB (a request whose body was still arriving when the restore began lands
     * here), 409 while another writer holds the lock.
     */
    async exclusive(fn) {
      if (app.restoring) throw new HttpError(503, "A backup is being restored; try again in a moment");
      if (app.importBusy) throw new HttpError(409, "Another import or price refresh is running");
      app.importBusy = true;
      try { return await fn(); } finally { app.importBusy = false; app.background.scheduleEnglishPrices(); }
    },

    /** API requests whose handler has not finished yet (async work may still hold app.db); a restore waits for 0. */
    inflight: 0,

    /** True when chat turns + vision + guide runs fill the Claude concurrency limit. */
    claudeBusy: () => {
      const { vision, guide } = activeClaudeRuns();
      return app.runs.size + vision + guide >= MAX_CONCURRENT;
    },

    /** SQLite's datetime('now'): decks.updated_at uses it, so "decks changed since" works across a write. */
    sqlNow: () => app.db.prepare("SELECT datetime('now') AS t").get().t,

    /** Refresh the combos of a deck a few seconds after a write (debounced per deck; a cache hit makes no call). */
    scheduleSpellbook(deckId) {
      if (!app.shuttingDown && deckId) app.spellbook.schedule(Number(deckId));
    },

    /** Schedule the combos of every deck written since `since` (imports, scan commits, chat turns). */
    scheduleChangedDecks(since) {
      try {
        for (const { id } of app.db.prepare("SELECT id FROM decks WHERE updated_at >= ?").all(since)) app.scheduleSpellbook(id);
      } catch (err) {
        console.warn(`[spellbook] ${err.message}`);
      }
    },
  };

  app.background = createBackground(app);
  app.scanner = createScanner(app);

  // Commander Spellbook (lib/spellbook.js): combos for the bracket and score.
  // Deck reads only look at the cache; this scheduler fills it in the background,
  // never inside exclusive() (a fetch must not 409 imports and moves) and never
  // while a restore swaps the DB (every write goes to the db current at write time).
  app.spellbook = createSpellbookScheduler({
    db: () => app.db,
    restoring: () => app.restoring,
    // Debounce after a deck write (default 3 s); tests set it short instead of sleeping past it.
    ...(Number(process.env.SPELLBOOK_DELAY_MS) >= 0 && process.env.SPELLBOOK_DELAY_MS ? { delayMs: Number(process.env.SPELLBOOK_DELAY_MS) } : {}),
    version,
    log: console,
    requestFor: (conn, deckId) => deckComboRequest(conn, deckId),
  });

  // Tokens & extras (lib/accessories.js): deck reads only use cached card rows; the deck
  // cards without all_parts and the token printings they name are fetched here in the
  // background (/cards/collection, 2 req/s), written through exclusive() (busy → retried
  // in 5 s), never during a restore; off with the scheduler (SCHEDULER_ENABLED=false).
  app.tokenFetcher = createAccessoryFetcher({
    db: () => app.db,
    write: app.exclusive,
    enabled: () => !app.shuttingDown && schedulerConfig().enabled,
    log: console,
  });

  return app;
}
