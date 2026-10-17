// Nightly maintenance: keeps the scanner's card index and the collection's
// prices fresh without anyone pressing a button.
//
// A timer wakes up on every quarter hour (wall clock). Inside the refresh hour
// (INDEX_REFRESH_HOUR, container local time, so TZ applies) it runs, one after
// the other:
//   (a) the index refresh when the local index is older than INDEX_REFRESH_DAYS
//       AND Scryfall's all_cards bulk file is newer than ours (one small GET of
//       /bulk-data, at most once a day), followed by the incremental
//       fingerprint job (already-hashed groups are skipped);
//   (b) the price refresh of owned, deck and wishlist cards when the last one
//       is older than PRICE_REFRESH_DAYS (default 1 = every night: ~2,300
//       printings are 31 batched /cards/collection requests at 2 req/s, under a
//       minute); it has its own per-window marker, so it runs at most once a
//       window even while the window stays open for a busy index job. The age
//       check allows PRICE_SLACK_MS, so yesterday's run a few minutes later in
//       the window doesn't make tonight's look "fresh";
//   (c) the daily value snapshot (lib/finance.js) after the prices, also when
//       the price step was skipped or failed; own per-window marker too.
// Each window runs at most once: once both steps went through (or were not
// due), the window's local date+hour is stored and later ticks in it skip, so
// INDEX_REFRESH_DAYS / PRICE_REFRESH_DAYS = 0 means "every night", not "every
// quarter hour". A failed price refresh, or an index job that was busy, leaves
// the window open for a retry.
// One extra check runs shortly after start, so a container (re)started inside
// the window does not wait for the next quarter hour.
// Runs never overlap; a run that is still going when the hour ends finishes.
// SCHEDULER_ENABLED=false turns it off. Last runs persist in the app's meta
// table, so a restart neither repeats nor forgets them.

const QUARTER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// The bulk-data entry is checked at most this often (one tick per window would
// otherwise ask Scryfall up to four times a night).
const CHECK_SPACING_MS = 20 * 60 * 60 * 1000;
// First check after start().
const START_DELAY_MS = 60 * 1000;
// A price refresh this much younger than PRICE_REFRESH_DAYS still counts as due.
export const PRICE_SLACK_MS = 3 * 60 * 60 * 1000;

/** Local date + hour of `d`, e.g. "2026-10-14T04" (identifies one window). */
export function windowKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

const intEnv = (v, def, min, max) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isInteger(n) && n >= min && n <= max ? n : def;
};
const numEnv = (v, def) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : def;
};

/** Scheduler settings from the environment. */
export function schedulerConfig(env = process.env) {
  return {
    enabled: String(env.SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false",
    hour: intEnv(env.INDEX_REFRESH_HOUR, 4, 0, 23),
    indexDays: numEnv(env.INDEX_REFRESH_DAYS, 7),
    priceDays: numEnv(env.PRICE_REFRESH_DAYS, 1),
  };
}

/** Next local `hour`:00 strictly after `now` (DST-safe: built from local fields). */
export function nextWindow(now, hour) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

const olderThan = (iso, days, now, slack = 0) => {
  if (!iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || now.getTime() - t >= days * DAY_MS - slack;
};

/**
 * Create the scheduler. Dependencies are injected so it can be tested offline:
 *   meta: {get(key), set(key, value)}       persistent state (app meta table)
 *   indexInfo(): {printings, last_refresh, bulk_updated_at} | null (no index)
 *   indexBusy(): true while an index job (manual or automatic) is running
 *   remoteBulkUpdatedAt(): Promise<string|null>  Scryfall's all_cards updated_at
 *   runIndexRefresh(): Promise   refresh + fingerprints, resolves when both are done
 *   runPriceRefresh(): Promise   price refresh of owned/deck/wishlist cards
 *   runSnapshot(): any           daily value snapshot (sync or Promise)
 *   checkpoint(): void           WAL checkpoint of the index DB
 *   now(): Date, log
 */
export function createScheduler({
  config = schedulerConfig(),
  meta,
  indexInfo = () => null,
  indexBusy = () => false,
  remoteBulkUpdatedAt = async () => null,
  runIndexRefresh = async () => {},
  runPriceRefresh = async () => {},
  runSnapshot = null,
  checkpoint = () => {},
  now = () => new Date(),
  log = console,
} = {}) {
  let timer = null;
  let running = null; // the current run's promise
  let current = null; // "index" | "prices" while running

  const record = (key, value) => { try { meta.set(key, value); } catch (err) { log.warn?.(`[scheduler] could not store ${key}: ${err.message}`); } };
  const read = (key) => { try { return meta.get(key); } catch { return null; } };

  async function indexStep(at) {
    const info = indexInfo();
    // No index at all is the boot-time auto build's business.
    if (!info || !info.printings) return { skipped: "no index" };
    if (indexBusy()) return { skipped: "index job running" };
    if (!olderThan(info.last_refresh, config.indexDays, at)) return { skipped: "fresh" };
    const lastCheck = Date.parse(read("scheduler_index_checked_at") || "");
    if (Number.isFinite(lastCheck) && at.getTime() - lastCheck < CHECK_SPACING_MS) return { skipped: "checked recently" };
    record("scheduler_index_checked_at", at.toISOString());
    const remote = await remoteBulkUpdatedAt();
    // An index built from a local file (INDEX_BULK_SOURCE) has no bulk
    // updated_at; then the refresh time stands in for it.
    const ours = Date.parse(info.bulk_updated_at || info.last_refresh || "");
    const theirs = Date.parse(remote || "");
    if (Number.isFinite(ours) && (!Number.isFinite(theirs) || theirs <= ours)) return { skipped: "up to date", remote };
    current = "index";
    log.log?.(`[scheduler] index refresh (ours ${info.bulk_updated_at || "none"}, Scryfall ${remote || "?"})`);
    try {
      await runIndexRefresh();
      record("scheduler_last_index_refresh", now().toISOString());
      record("scheduler_index_result", JSON.stringify({ ok: true, at: now().toISOString(), bulk_updated_at: remote }));
      return { ran: true };
    } catch (err) {
      record("scheduler_index_result", JSON.stringify({ ok: false, at: now().toISOString(), error: err.message }));
      throw err;
    } finally {
      try { checkpoint(); } catch { /* best effort */ }
    }
  }

  async function priceStep(at, key, force) {
    // Own per-window marker: the window may stay open for the index step, and
    // PRICE_REFRESH_DAYS=0 must still mean once a night.
    if (!force && read("scheduler_prices_window") === key) return { skipped: "already ran this window" };
    if (!olderThan(read("last_price_refresh"), config.priceDays, at, PRICE_SLACK_MS)) return { skipped: "fresh" };
    current = "prices";
    log.log?.("[scheduler] price refresh");
    const result = await runPriceRefresh();
    // Same key as the manual refresh (POST /api/refresh-prices) writes.
    record("last_price_refresh", now().toISOString());
    record("scheduler_prices_window", key);
    return { ran: true, result: result ?? null };
  }

  async function snapshotStep(key, force) {
    if (!runSnapshot) return null;
    if (!force && read("scheduler_snapshot_window") === key) return { skipped: "already ran this window" };
    const result = await runSnapshot();
    record("scheduler_snapshot_window", key);
    return { ran: true, day: result?.day ?? null };
  }

  /** One check. Inside the window (or with force) it runs what is due; resolves to a summary. */
  function tick({ force = false } = {}) {
    if (!config.enabled && !force) return Promise.resolve({ skipped: "disabled" });
    if (running) return Promise.resolve({ skipped: "already running" });
    const at = now();
    if (!force && at.getHours() !== config.hour) return Promise.resolve({ skipped: "outside window" });
    const key = windowKey(at);
    if (!force && read("scheduler_window_done") === key) {
      log.log?.("[scheduler] tonight's run is already done");
      return Promise.resolve({ skipped: "already ran this window" });
    }
    running = (async () => {
      const out = {};
      try { out.index = await indexStep(at); } catch (err) { out.index = { error: err.message }; log.warn?.(`[scheduler] index refresh failed: ${err.message}`); }
      try { out.prices = await priceStep(at, key, force); } catch (err) { out.prices = { error: err.message }; log.warn?.(`[scheduler] price refresh failed: ${err.message}`); }
      if (runSnapshot) {
        try { out.snapshot = await snapshotStep(key, force); } catch (err) { out.snapshot = { error: err.message }; log.warn?.(`[scheduler] value snapshot failed: ${err.message}`); }
      }
      record("scheduler_last_run", JSON.stringify({ at: at.toISOString(), index: out.index, prices: out.prices ? { ...out.prices, result: undefined } : null, ...(out.snapshot ? { snapshot: out.snapshot } : {}) }));
      // A busy index job (e.g. resumed fingerprints after a restart) leaves the
      // window open so a later tick can still do the index step.
      if (!force && !out.prices?.error && out.index?.skipped !== "index job running") record("scheduler_window_done", key);
      return out;
    })().finally(() => { running = null; current = null; });
    return running;
  }

  function schedule(first = false) {
    const t = now().getTime();
    // Wake on the wall-clock quarter hour so the window's first tick is HH:00.
    const delay = first ? START_DELAY_MS : QUARTER_MS - (t % QUARTER_MS) + 1000;
    timer = setTimeout(() => {
      tick().catch((err) => log.warn?.(`[scheduler] ${err.message}`)).finally(() => { if (timer) schedule(); });
    }, delay);
    timer.unref?.();
  }

  return {
    config,
    start() {
      if (!config.enabled || timer) return;
      schedule(true);
      log.log?.(`[scheduler] on: daily at ${String(config.hour).padStart(2, "0")}:00 local; index every ${config.indexDays} d, prices every ${config.priceDays} d`);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tick,
    /** Settled promise of the current run (or null). */
    get running() { return running; },
    status() {
      const info = (() => { try { return indexInfo(); } catch { return null; } })();
      let lastRun = null;
      try { lastRun = JSON.parse(read("scheduler_last_run") || "null"); } catch { lastRun = null; }
      let indexResult = null;
      try { indexResult = JSON.parse(read("scheduler_index_result") || "null"); } catch { indexResult = null; }
      return {
        enabled: config.enabled,
        hour: config.hour,
        index_refresh_days: config.indexDays,
        price_refresh_days: config.priceDays,
        next_run: config.enabled ? nextWindow(now(), config.hour).toISOString() : null,
        last_index_refresh: info?.last_refresh ?? read("scheduler_last_index_refresh"),
        last_index_check: read("scheduler_index_checked_at"),
        last_index_result: indexResult,
        last_price_refresh: read("last_price_refresh"),
        last_snapshot_window: read("scheduler_snapshot_window"),
        last_run: lastRun,
        running: running ? current || "checking" : null,
      };
    },
  };
}
