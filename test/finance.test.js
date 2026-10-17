// Value history (lib/finance.js): snapshots, change-only card history, the
// added / removed / price split, movers, top cards, migration v12 from a v9
// database, and the scheduler's daily snapshot step (with daily prices).

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, openDb } from "../lib/db.js";
import {
  addDays, cardHistory, ensureSnapshot, financeHistory, financeMovers, financeSummary, financeTop, localDay, snapshotValue, stateAt,
} from "../lib/finance.js";
import { createScheduler, PRICE_SLACK_MS } from "../lib/scheduler.js";
import { ID, seedCards, seedCollection, tempDb } from "./fixtures.js";

const day = (d, h = 12) => new Date(2026, 9, d, h); // local time, October 2026
const setPrices = (db, id, prices) => db.prepare("UPDATE cards SET prices = ? WHERE scryfall_id = ?").run(JSON.stringify(prices), id);

let ctx;
beforeEach(() => {
  ctx = tempDb();
  seedCards(ctx.db);
  // Sol Ring 2 × €1.50 (Box), Lightning Bolt foil 1 × €5.00 (Unsorted) = €8.00
  seedCollection(ctx.db, [[ID.sol, 2, { binder: "Box" }], [ID.lightning, 1, { finish: "foil" }]]);
});
afterEach(() => ctx.cleanup());

describe("days", () => {
  test("localDay / addDays use local calendar days (month and year ends)", () => {
    assert.equal(localDay(day(5)), "2026-10-05");
    assert.equal(addDays("2026-10-01", -1), "2026-09-30");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-29", 1), "2026-03-30"); // DST change in Europe
  });
});

describe("snapshots", () => {
  test("day 0: totals, binders, card rows; no changes before history exists", () => {
    const s = snapshotValue(ctx.db, { now: day(1) });
    assert.deepEqual([s.day, s.value_eur, s.copies, s.printings, s.unpriced], ["2026-10-01", 8, 3, 2, 0]);
    const binders = ctx.db.prepare("SELECT binder, value_eur, copies FROM value_history_binders WHERE day = '2026-10-01' ORDER BY binder").all();
    assert.deepEqual(binders.map((b) => [b.binder, b.value_eur, b.copies]), [["", 5, 1], ["Box", 3, 2]]);
    const sum = financeSummary(ctx.db, { now: day(1, 18) });
    assert.equal(sum.history_start, "2026-10-01");
    assert.equal(sum.value_eur, 8);
    assert.deepEqual(sum.changes, { today: null, d7: null, d30: null });
    assert.deepEqual(sum.binders.map((b) => [b.binder, b.value_eur]), [["", 5], ["Box", 3]], "by value");
    assert.equal(financeMovers(ctx.db, { days: 7, now: day(1) }).available, false);
    // ensureSnapshot only seeds a day without one
    assert.equal(ensureSnapshot(ctx.db, { now: day(1, 20) }), null);
    assert.ok(ensureSnapshot(ctx.db, { now: day(2) }));
  });

  test("change split: added copies, removed copies and price changes add up", () => {
    snapshotValue(ctx.db, { now: day(1) });
    // Next day: Bolt foil €5 → €6, one Sol Ring sold, 3 Serra Angels (€0.10) added.
    setPrices(ctx.db, ID.lightning, { eur: "2.00", eur_foil: "6.00" });
    ctx.db.prepare("UPDATE collection SET quantity = 1 WHERE scryfall_id = ?").run(ID.sol);
    seedCollection(ctx.db, [[ID.serra, 3]]);
    const sum = financeSummary(ctx.db, { now: day(2) });
    assert.equal(sum.value_eur, 7.8);
    const c = sum.changes.today;
    assert.equal(c.from_day, "2026-10-01");
    assert.deepEqual([c.added_eur, c.removed_eur, c.price_eur, c.change_eur, c.added_copies, c.removed_copies], [0.3, 1.5, 1, -0.2, 3, 1]);
    assert.equal(c.value_from_eur, 8);
    assert.equal(sum.changes.d7, null, "history doesn't reach 7 days back");

    const movers = financeMovers(ctx.db, { days: 1, now: day(2) });
    assert.equal(movers.available, true);
    assert.deepEqual(movers.risers.map((m) => [m.name, m.finish, m.from_eur, m.to_eur, m.change_total_eur, m.change_pct]), [["Lightning Bolt", "foil", 5, 6, 1, 20]]);
    assert.deepEqual(movers.fallers, []);

    const top = financeTop(ctx.db, { limit: 2 }).cards;
    assert.deepEqual(top.map((t) => [t.name, t.finish, t.price_eur, t.quantity]), [["Lightning Bolt", "foil", 6, 1], ["Sol Ring", "normal", 1.5, 1]]);
    assert.deepEqual(top[1].binders, [{ binder: "Box", quantity: 1 }]);
  });

  test("card_history stores changes only; a sold card gets a 0 row; state per day", () => {
    snapshotValue(ctx.db, { now: day(1) });
    const n1 = ctx.db.prepare("SELECT COUNT(*) AS n FROM card_history").get().n;
    assert.equal(n1, 2);
    assert.equal(snapshotValue(ctx.db, { now: day(2) }).changed, 0, "nothing changed: no rows");
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM card_history").get().n, n1);
    setPrices(ctx.db, ID.sol, { eur: "1.80" });
    ctx.db.prepare("DELETE FROM collection WHERE scryfall_id = ?").run(ID.lightning);
    assert.equal(snapshotValue(ctx.db, { now: day(3) }).changed, 2);
    assert.deepEqual(cardHistory(ctx.db, ID.sol), [{ day: "2026-10-01", quantity: 2, eur: 1.5 }, { day: "2026-10-03", quantity: 2, eur: 1.8 }]);
    assert.deepEqual(cardHistory(ctx.db, ID.lightning, "foil").map((p) => p.quantity), [1, 0]);
    // A later snapshot on the same day rewrites that day's row instead of adding one.
    setPrices(ctx.db, ID.sol, { eur: "1.90" });
    snapshotValue(ctx.db, { now: day(3, 20) });
    assert.equal(cardHistory(ctx.db, ID.sol).length, 2);
    assert.equal(stateAt(ctx.db, "2026-10-02").get(`${ID.sol}|normal`).eur, 1.5);
    assert.equal(stateAt(ctx.db, "2026-10-03").get(`${ID.sol}|normal`).eur, 1.9);
    assert.equal(stateAt(ctx.db, "2026-09-30").size, 0);
  });

  test("history: stored days in range plus today's live value; USD-only cards are unpriced", () => {
    snapshotValue(ctx.db, { now: day(1) });
    snapshotValue(ctx.db, { now: day(2) });
    seedCollection(ctx.db, [[ID.azorius, 2]]); // eur null, usd 0.30: never counted
    const h = financeHistory(ctx.db, { days: 30, now: day(4) });
    assert.deepEqual(h.points.map((p) => [p.day, p.value_eur, p.copies]), [["2026-10-01", 8, 3], ["2026-10-02", 8, 3], ["2026-10-04", 8, 5]]);
    assert.equal(financeHistory(ctx.db, { days: 1, now: day(4) }).points.length, 1);
    assert.equal(snapshotValue(ctx.db, { now: day(4) }).unpriced, 2);
  });

  test("wishlist printings get price history with quantity 0", () => {
    ctx.db.prepare("INSERT INTO wishlist (oracle_id, name, scryfall_id) VALUES ('o-atraxa', 'Atraxa, Praetors'' Voice', ?)").run(ID.atraxa);
    const s = snapshotValue(ctx.db, { now: day(1) });
    assert.equal(s.value_eur, 8, "wishlist cards are not part of the value");
    assert.deepEqual(cardHistory(ctx.db, ID.atraxa), [{ day: "2026-10-01", quantity: 0, eur: 20 }]);
  });
});

describe("migration v11/v12", () => {
  test("a v9 database gets wishlist + history tables, keeps its rows, and seeds day 0", () => {
    // Downgrade the fresh DB to v9 (drop what v10-v12 add).
    ctx.db.exec(`DROP TABLE wishlist; DROP TABLE value_history; DROP TABLE value_history_binders; DROP TABLE card_history;
      PRAGMA user_version = 9`);
    ctx.db.close();
    const raw = new DatabaseSync(ctx.file);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'wishlist'").get(), undefined);
    raw.close();
    const db = openDb(ctx.file);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    assert.ok(SCHEMA_VERSION >= 12);
    for (const t of ["wishlist", "value_history", "value_history_binders", "card_history"]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
    }
    assert.equal(db.prepare("SELECT SUM(quantity) AS n FROM collection").get().n, 3);
    assert.equal(ensureSnapshot(db, { now: day(1) }).value_eur, 8);
    // Re-running the migrations on a migrated DB is harmless.
    db.exec("PRAGMA user_version = 9");
    db.close();
    const again = openDb(ctx.file);
    assert.equal(again.prepare("SELECT COUNT(*) AS n FROM value_history").get().n, 1);
    again.close();
    ctx.db = openDb(ctx.file); // for cleanup
  });
});

describe("scheduler snapshot step + daily prices", () => {
  const DAY = 24 * 60 * 60 * 1000;
  function harness({ now, store = new Map(), failPrices = false, priceDays = 1 }) {
    const calls = [];
    const h = { now, calls, store };
    h.scheduler = createScheduler({
      config: { enabled: true, hour: 4, indexDays: 7, priceDays },
      meta: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v == null ? null : String(v)) },
      indexInfo: () => null,
      runPriceRefresh: async () => { calls.push("prices"); if (failPrices) throw new Error("scryfall down"); return {}; },
      runSnapshot: () => { calls.push("snapshot"); return { day: localDay(h.now) }; },
      now: () => h.now,
      log: { log() {}, warn() {} },
    });
    return h;
  }

  test("snapshot after the prices, once per window; also when the price refresh fails", async () => {
    const h = harness({ now: new Date(2026, 9, 14, 4, 0) });
    const out = await h.scheduler.tick();
    assert.deepEqual(h.calls, ["prices", "snapshot"]);
    assert.deepEqual(out.snapshot, { ran: true, day: "2026-10-14" });
    h.now = new Date(2026, 9, 14, 4, 15);
    await h.scheduler.tick();
    assert.deepEqual(h.calls, ["prices", "snapshot"], "window done");

    const f = harness({ now: new Date(2026, 9, 14, 4, 0), failPrices: true });
    const r = await f.scheduler.tick();
    assert.match(r.prices.error, /scryfall down/);
    assert.deepEqual(f.calls, ["prices", "snapshot"]);
    f.now = new Date(2026, 9, 14, 4, 15);
    await f.scheduler.tick();
    assert.deepEqual(f.calls, ["prices", "snapshot", "prices"], "prices retried, snapshot not repeated");
  });

  test("PRICE_REFRESH_DAYS=1: last night's run a few minutes later still makes tonight's due", async () => {
    const store = new Map([["last_price_refresh", new Date(2026, 9, 13, 4, 20).toISOString()]]);
    const h = harness({ now: new Date(2026, 9, 14, 4, 0), store });
    const out = await h.scheduler.tick();
    assert.equal(out.prices.ran, true);
    assert.ok(PRICE_SLACK_MS < DAY / 4);
    // ... but a refresh an hour ago is fresh.
    const fresh = harness({ now: new Date(2026, 9, 14, 4, 0), store: new Map([["last_price_refresh", new Date(2026, 9, 14, 3, 0).toISOString()]]) });
    assert.equal((await fresh.scheduler.tick()).prices.skipped, "fresh");
  });
});
