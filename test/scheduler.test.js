// Nightly scheduler (lib/scheduler.js): window, staleness rules, bulk check,
// sequencing and persisted state. Everything is injected: no timers, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler, nextWindow, schedulerConfig } from "../lib/scheduler.js";
import { getAppMeta, setAppMeta } from "../lib/db.js";
import { tempDb } from "./fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const at = (h, m = 0, day = 14) => new Date(2026, 9, day, h, m); // local time

function harness({ now = at(4, 0), info = {}, remote = "2026-10-13T09:00:00.000Z", config = {}, failIndex = false, failPrices = false } = {}) {
  const store = new Map();
  const calls = [];
  const h = {
    now,
    store,
    calls,
    info: { printings: 100, last_refresh: new Date(now.getTime() - 8 * DAY).toISOString(), bulk_updated_at: "2026-10-01T09:00:00.000Z", ...info },
    busy: false,
  };
  h.scheduler = createScheduler({
    config: { enabled: true, hour: 4, indexDays: 7, priceDays: 7, ...config },
    meta: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v == null ? null : String(v)) },
    indexInfo: () => h.info,
    indexBusy: () => h.busy,
    remoteBulkUpdatedAt: async () => { calls.push("bulk"); return remote; },
    runIndexRefresh: async () => { calls.push("refresh"); if (failIndex) throw new Error("boom"); },
    runPriceRefresh: async () => { calls.push("prices"); if (failPrices) throw new Error("scryfall down"); return { refreshed: 3 }; },
    checkpoint: () => calls.push("checkpoint"),
    now: () => h.now,
    log: { log() {}, warn() {} },
  });
  return h;
}

describe("schedulerConfig", () => {
  test("defaults and env overrides; invalid values fall back", () => {
    assert.deepEqual(schedulerConfig({}), { enabled: true, hour: 4, indexDays: 7, priceDays: 1 });
    assert.deepEqual(schedulerConfig({ SCHEDULER_ENABLED: "false", INDEX_REFRESH_HOUR: "23", INDEX_REFRESH_DAYS: "3", PRICE_REFRESH_DAYS: "1.5" }),
      { enabled: false, hour: 23, indexDays: 3, priceDays: 1.5 });
    assert.deepEqual(schedulerConfig({ INDEX_REFRESH_HOUR: "24", INDEX_REFRESH_DAYS: "-1", PRICE_REFRESH_DAYS: "x" }),
      { enabled: true, hour: 4, indexDays: 7, priceDays: 1 });
  });

  test("nextWindow is the next local HH:00", () => {
    assert.equal(nextWindow(at(3, 59), 4).getTime(), at(4, 0).getTime());
    assert.equal(nextWindow(at(4, 0), 4).getTime(), at(4, 0, 15).getTime());
    assert.equal(nextWindow(at(22, 10), 4).getTime(), at(4, 0, 15).getTime());
  });
});

describe("scheduler tick", () => {
  test("outside the window or disabled: nothing happens", async () => {
    const h = harness({ now: at(5, 0) });
    assert.deepEqual(await h.scheduler.tick(), { skipped: "outside window" });
    const off = harness({ config: { enabled: false } });
    assert.deepEqual(await off.scheduler.tick(), { skipped: "disabled" });
    assert.equal(off.scheduler.status().next_run, null);
    assert.deepEqual([...h.calls, ...off.calls], []);
  });

  test("stale index + newer Scryfall bulk: refresh (with fingerprints) then checkpoint, then prices", async () => {
    const h = harness();
    const out = await h.scheduler.tick();
    assert.deepEqual(h.calls, ["bulk", "refresh", "checkpoint", "prices"]);
    assert.deepEqual(out.index, { ran: true });
    assert.equal(out.prices.ran, true);
    const st = h.scheduler.status();
    assert.equal(st.last_price_refresh, h.now.toISOString());
    assert.equal(st.last_index_result.ok, true);
    assert.equal(st.running, null);
    assert.equal(st.next_run, at(4, 0, 15).toISOString());
    assert.equal(st.last_run.at, h.now.toISOString());

    // Same night, next quarter: the window already ran -> no work.
    h.now = at(4, 15);
    h.calls.length = 0;
    assert.deepEqual(await h.scheduler.tick(), { skipped: "already ran this window" });
    assert.deepEqual(h.calls, []);
    // Even with the window markers gone, the staleness rules hold.
    h.store.delete("scheduler_window_done");
    h.store.delete("scheduler_prices_window");
    const again = await h.scheduler.tick();
    assert.deepEqual(h.calls, []);
    assert.equal(again.index.skipped, "checked recently");
    assert.equal(again.prices.skipped, "fresh");
  });

  test("Scryfall not newer: no download, but the check is remembered", async () => {
    const h = harness({ remote: "2026-10-01T09:00:00.000Z" });
    const out = await h.scheduler.tick();
    assert.equal(out.index.skipped, "up to date");
    assert.deepEqual(h.calls, ["bulk", "prices"]);
    assert.ok(h.scheduler.status().last_index_check);
  });

  test("fresh index, busy index job or no index: no bulk request", async () => {
    for (const [opts, reason] of [
      [{ info: { last_refresh: new Date(at(4).getTime() - 2 * DAY).toISOString() } }, "fresh"],
      [{ info: { printings: 0 } }, "no index"],
    ]) {
      const h = harness(opts);
      h.store.set("last_price_refresh", h.now.toISOString());
      const out = await h.scheduler.tick();
      assert.equal(out.index.skipped, reason);
      assert.deepEqual(h.calls, []);
    }
    const h = harness();
    h.busy = true;
    assert.equal((await h.scheduler.tick()).index.skipped, "index job running");
    // The window stays open: once the job is done, a later tick refreshes.
    h.busy = false;
    h.now = at(4, 30);
    assert.deepEqual((await h.scheduler.tick()).index, { ran: true });
  });

  test("a failing refresh is recorded, still checkpoints, and prices still run", async () => {
    const h = harness({ failIndex: true });
    const out = await h.scheduler.tick();
    assert.deepEqual(out.index, { error: "boom" });
    assert.deepEqual(h.calls, ["bulk", "refresh", "checkpoint", "prices"]);
    assert.equal(h.scheduler.status().last_index_result.ok, false);
  });

  test("a failing price refresh is retried on the next tick of the window", async () => {
    const h = harness({ failPrices: true, info: { last_refresh: new Date().toISOString() } });
    h.info.last_refresh = h.now.toISOString();
    assert.deepEqual((await h.scheduler.tick()).prices, { error: "scryfall down" });
    assert.equal(h.scheduler.status().last_price_refresh, null);
  });

  test("0-day intervals still run only once per window; a failed price refresh retries", async () => {
    const h = harness({ config: { indexDays: 0, priceDays: 0 }, info: { last_refresh: at(4).toISOString() } });
    const first = await h.scheduler.tick();
    assert.equal(first.prices.ran, true);
    h.now = at(4, 15);
    assert.deepEqual(await h.scheduler.tick(), { skipped: "already ran this window" });
    h.now = at(4, 45);
    assert.deepEqual(await h.scheduler.tick(), { skipped: "already ran this window" });
    assert.equal(h.calls.filter((c) => c === "prices").length, 1);
    h.now = at(4, 0, 15); // next night
    assert.equal((await h.scheduler.tick()).prices.ran, true);
    assert.equal(h.calls.filter((c) => c === "prices").length, 2);

    const f = harness({ failPrices: true, info: { last_refresh: at(4).toISOString() } });
    await f.scheduler.tick();
    f.now = at(4, 15);
    assert.deepEqual((await f.scheduler.tick()).prices, { error: "scryfall down" });
    assert.equal(f.calls.filter((c) => c === "prices").length, 2);
  });

  test("PRICE_REFRESH_DAYS=0 refreshes prices once per window even while an index job keeps it open", async () => {
    const h = harness({ config: { indexDays: 0, priceDays: 0 } });
    h.busy = true;
    for (const m of [0, 15, 30, 45]) {
      h.now = at(4, m);
      const out = await h.scheduler.tick();
      assert.equal(out.index.skipped, "index job running");
      if (m > 0) assert.equal(out.prices.skipped, "already ran this window");
    }
    assert.equal(h.calls.filter((c) => c === "prices").length, 1);
    h.now = at(4, 0, 15);
    await h.scheduler.tick();
    assert.equal(h.calls.filter((c) => c === "prices").length, 2);
  });

  test("an index from a local bulk file (no bulk updated_at) compares Scryfall against the refresh time", async () => {
    const h = harness({ config: { indexDays: 0 }, info: { bulk_updated_at: null, last_refresh: "2026-10-13T20:00:00.000Z" }, remote: "2026-10-13T09:00:00.000Z" });
    assert.equal((await h.scheduler.tick()).index.skipped, "up to date");
    const n = harness({ config: { indexDays: 0 }, info: { bulk_updated_at: null, last_refresh: "2026-10-12T20:00:00.000Z" }, remote: "2026-10-13T09:00:00.000Z" });
    assert.deepEqual((await n.scheduler.tick()).index, { ran: true });
  });

  test("runs never overlap; force runs outside the window", async () => {
    const h = harness({ now: at(12) });
    const first = h.scheduler.tick({ force: true });
    assert.deepEqual(await h.scheduler.tick({ force: true }), { skipped: "already running" });
    await first;
    assert.deepEqual(h.calls, ["bulk", "refresh", "checkpoint", "prices"]);
  });

  test("state persists in the app meta table", async () => {
    const ctx = tempDb();
    try {
      const s = createScheduler({
        config: { enabled: true, hour: 4, indexDays: 7, priceDays: 7 },
        meta: { get: (k) => getAppMeta(ctx.db, k), set: (k, v) => setAppMeta(ctx.db, k, v) },
        runPriceRefresh: async () => ({}),
        now: () => at(4),
        log: { log() {}, warn() {} },
      });
      await s.tick();
      assert.equal(getAppMeta(ctx.db, "last_price_refresh"), at(4).toISOString());
      assert.equal(s.status().last_price_refresh, at(4).toISOString());
    } finally {
      ctx.cleanup();
    }
  });
});
