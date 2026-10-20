// Debounced background upkeep of the app DB, never on a request path and
// never while an import (exclusive()) or a restore runs:
// - English twin prices (lib/prices.js): foreign printings without an EUR
//   price are valued at their English twin's. Run after every collection
//   write, index job, chat turn (Claude can edit copies), restore and at boot.
// - The value history (lib/finance.js): today's snapshot follows the prices
//   (one grouped query + one transaction, ~10-50 ms for a few thousand printings).
// - v9/v15 card facts (game_changer, produced_mana, layout, all_parts) of cards
//   fetched before those migrations: one /cards/collection request per chunk
//   outside the lock, then only its write through exclusive(); after boot and
//   after a restore; off with the scheduler (SCHEDULER_ENABLED=false).

import { getAppMeta } from "../lib/db.js";
import { snapshotValue } from "../lib/finance.js";
import { CARD_FACTS_META, backfillCardFacts, cardFactsPending, tokenFactsPending } from "../lib/manabox.js";
import { syncEnglishPrices } from "../lib/prices.js";
import { schedulerConfig } from "../lib/scheduler.js";

const CARD_FACTS_RETRY_MS = 60_000;

/** `app` gives db, importBusy, restoring, shuttingDown, exclusiveUnlessRestoring() and scanner.indexPrices(). */
export function createBackground(app) {
  const busy = () => app.importBusy || app.restoring;
  const later = (timer, fn, delay) => {
    clearTimeout(timer);
    const t = setTimeout(fn, delay);
    t.unref?.();
    return t;
  };

  let englishTimer = null;
  let englishRunning = false;
  function scheduleEnglishPrices(delay = 1000) {
    if (app.shuttingDown) return;
    englishTimer = later(englishTimer, runEnglishPrices, delay);
  }
  async function runEnglishPrices() {
    if (app.shuttingDown) return;
    if (busy() || englishRunning) return scheduleEnglishPrices(5000);
    englishRunning = true;
    try {
      const r = await syncEnglishPrices(app.db, { indexPrices: app.scanner.indexPrices() });
      if (r.updated) console.log(`[prices] English twin prices: ${r.updated} of ${r.checked} foreign printings updated${r.index ? "" : " (cards table only)"}`);
    } catch (err) {
      console.warn(`[prices] English twin prices: ${err.message}`);
    } finally {
      englishRunning = false;
      scheduleSnapshot(); // values follow the (twin) prices
    }
  }

  let snapshotTimer = null;
  function scheduleSnapshot(delay = 1500) {
    if (app.shuttingDown) return;
    snapshotTimer = later(snapshotTimer, runSnapshot, delay);
  }
  function runSnapshot() {
    if (app.shuttingDown) return;
    if (busy()) return scheduleSnapshot(5000);
    try { snapshotValue(app.db); } catch (err) { console.warn(`[finance] snapshot: ${err.message}`); }
  }

  let cardFactsTimer = null;
  let cardFactsRunning = false;
  function scheduleCardFacts(delay = 5000) {
    if (app.shuttingDown || !schedulerConfig().enabled) return;
    cardFactsTimer = later(cardFactsTimer, runCardFacts, delay);
  }
  async function runCardFacts() {
    if (app.shuttingDown) return;
    if (app.restoring || cardFactsRunning) return scheduleCardFacts(CARD_FACTS_RETRY_MS);
    cardFactsRunning = true;
    try {
      const db = app.db;
      if (!cardFactsPending(db).length && !tokenFactsPending(db).length && getAppMeta(db, CARD_FACTS_META)) return;
      const r = await backfillCardFacts(() => app.db, { runChunk: app.exclusiveUnlessRestoring });
      if (r.refreshed || r.skipped) console.log(`[cards] card facts (v9/v15): ${r.refreshed} refreshed (incl. tokens), ${r.skipped} skipped`);
    } catch (err) {
      console.warn(`[cards] card facts: ${err.message}; retrying in ${CARD_FACTS_RETRY_MS / 1000} s`);
      cardFactsRunning = false;
      return scheduleCardFacts(CARD_FACTS_RETRY_MS);
    } finally {
      cardFactsRunning = false;
    }
  }

  /** /healthz card_facts: the backfill's meta {done_at, refreshed, skipped (count)} or null while not done. */
  function cardFactsHealth() {
    try {
      const m = JSON.parse(getAppMeta(app.db, CARD_FACTS_META) || "null");
      return m ? { done_at: m.done_at ?? null, refreshed: m.refreshed ?? 0, skipped: Array.isArray(m.skipped) ? m.skipped.length : 0 } : null;
    } catch {
      return null;
    }
  }

  return {
    scheduleEnglishPrices, scheduleSnapshot, scheduleCardFacts, cardFactsHealth,
    stop: () => { clearTimeout(englishTimer); clearTimeout(snapshotTimer); clearTimeout(cardFactsTimer); },
  };
}
