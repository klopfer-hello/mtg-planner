// Collection value over time: daily snapshots and what moved the value.
//
// The value shown everywhere else (db.js stats) is computed live from the
// current prices; there was no memory of yesterday. This module writes one
// snapshot per local day (scheduler after the nightly price refresh, the server
// after every collection write and at boot; later snapshots of the same day
// overwrite it) and answers the Value tab from it:
//   - value_history / value_history_binders: totals per day (chart, binders);
//   - card_history: per printing + finish the held quantity and the unit EUR
//     price, stored only when one of them changed, so a year of a few thousand
//     printings stays small. The state on day D is the newest row with day <= D.
// A change between day A and now is split per printing+finish (A = the stored
// state, now = live): copies held on both days carry the price change
// (market movement), extra copies count as "added" at today's price, missing
// copies as "removed" at A's price. added - removed + price = the change.
// EUR only, never USD (same unit price as db.js stats: cardPrice with the
// English-twin fallback, a USD-only card counts as unpriced) and the same
// order-independent sum (db.js eurTotal), so both always show the same total.

import { cardPrice, eurTotal, transaction } from "./db.js";

const round2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");

/** Local calendar day of `d` (container TZ), e.g. "2026-10-17". */
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `day` (YYYY-MM-DD) plus `n` calendar days (n may be negative). */
export function addDays(day, n) {
  const [y, m, dd] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, dd + n, 12));
}

/** Unit EUR price of a card row's `prices` for a finish (db.js cardPrice rules), or null. */
export function unitEur(prices, finish = "normal") {
  const p = cardPrice({ prices }, finish);
  return p && p.currency === "€" ? p.value : null;
}

const keyOf = (id, finish) => `${id}|${finish}`;

/**
 * Live holdings per printing + finish: Map key → {scryfall_id, finish, quantity,
 * eur, name, set_code, collector_number, rarity, image_small, binders Map}.
 * Wishlist reference printings that aren't owned are added with quantity 0
 * (price history only).
 */
export function liveHoldings(db, { wishlist = true } = {}) {
  const out = new Map();
  const rows = db.prepare(
    `SELECT col.scryfall_id, col.finish, col.binder, SUM(col.quantity) AS quantity, c.prices, c.name, c.set_code, c.set_name,
            c.collector_number, c.rarity, c.image_small, c.oracle_id
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      GROUP BY col.scryfall_id, col.finish, col.binder`,
  ).all();
  for (const r of rows) {
    const k = keyOf(r.scryfall_id, r.finish);
    let h = out.get(k);
    if (!h) {
      h = {
        scryfall_id: r.scryfall_id, finish: r.finish, quantity: 0, eur: unitEur(r.prices, r.finish), name: r.name, oracle_id: r.oracle_id,
        set_code: r.set_code, set_name: r.set_name, collector_number: r.collector_number, rarity: r.rarity, image_small: r.image_small,
        binders: new Map(),
      };
      out.set(k, h);
    }
    h.quantity += r.quantity;
    h.binders.set(r.binder, (h.binders.get(r.binder) ?? 0) + r.quantity);
  }
  if (wishlist) {
    const wish = db.prepare(
      `SELECT w.scryfall_id, COALESCE(w.finish, 'normal') AS finish, c.prices, c.name, c.oracle_id
         FROM wishlist w JOIN cards c ON c.scryfall_id = w.scryfall_id`,
    ).all();
    for (const w of wish) {
      const k = keyOf(w.scryfall_id, w.finish);
      if (!out.has(k)) {
        out.set(k, { scryfall_id: w.scryfall_id, finish: w.finish, quantity: 0, eur: unitEur(w.prices, w.finish), name: w.name, oracle_id: w.oracle_id, binders: new Map() });
      }
    }
  }
  return out;
}

/** Totals of live holdings: {value_eur, copies, printings, unpriced, binders: [{binder, value_eur, copies}]}. */
function totalsOf(holdings) {
  const value = eurTotal();
  let copies = 0, printings = 0, unpriced = 0;
  const binders = new Map();
  for (const h of holdings.values()) {
    if (!h.quantity) continue;
    copies += h.quantity;
    printings++;
    if (h.eur == null) unpriced += h.quantity;
    else value.add(h.eur, h.quantity);
    for (const [b, q] of h.binders) {
      const e = binders.get(b) ?? { binder: b, total: eurTotal(), copies: 0 };
      e.copies += q;
      if (h.eur != null) e.total.add(h.eur, q);
      binders.set(b, e);
    }
  }
  return {
    value_eur: value.value, copies, printings, unpriced,
    binders: [...binders.values()].map(({ total, ...b }) => ({ ...b, value_eur: total.value })).sort((a, b) => b.value_eur - a.value_eur || a.binder.localeCompare(b.binder)),
  };
}

/** Stored per-printing state at the end of `day`: Map key → {quantity, eur}. */
export function stateAt(db, day) {
  const rows = db.prepare(
    `SELECT h.scryfall_id, h.finish, h.quantity, h.eur FROM card_history h
       JOIN (SELECT scryfall_id, finish, MAX(day) AS d FROM card_history WHERE day <= ? GROUP BY scryfall_id, finish) m
         ON m.scryfall_id = h.scryfall_id AND m.finish = h.finish AND m.d = h.day`,
  ).all(day);
  return new Map(rows.map((r) => [keyOf(r.scryfall_id, r.finish), { quantity: r.quantity, eur: r.eur }]));
}

/** First day with a snapshot, or null. */
export function historyStart(db) {
  return db.prepare("SELECT MIN(day) AS d FROM value_history").get()?.d ?? null;
}

/**
 * Write (or rewrite) today's snapshot: the totals, the per-binder totals and
 * the changed card_history rows. One transaction; cheap (one grouped query).
 * Returns {day, value_eur, copies, printings, unpriced, changed}.
 */
export function snapshotValue(db, { now = new Date() } = {}) {
  const day = localDay(now);
  const holdings = liveHoldings(db);
  const t = totalsOf(holdings);
  let changed = 0;
  transaction(db, () => {
    db.prepare(
      `INSERT INTO value_history (day, value_eur, copies, printings, unpriced, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET value_eur = excluded.value_eur, copies = excluded.copies, printings = excluded.printings,
         unpriced = excluded.unpriced, updated_at = excluded.updated_at`,
    ).run(day, t.value_eur, t.copies, t.printings, t.unpriced, now.toISOString());
    db.prepare("DELETE FROM value_history_binders WHERE day = ?").run(day);
    const ins = db.prepare("INSERT INTO value_history_binders (day, binder, value_eur, copies) VALUES (?, ?, ?, ?)");
    for (const b of t.binders) ins.run(day, b.binder, b.value_eur, b.copies);

    // card_history: compare with the newest row of each key (today's included).
    const last = new Map(db.prepare(
      `SELECT h.scryfall_id, h.finish, h.day, h.quantity, h.eur FROM card_history h
         JOIN (SELECT scryfall_id, finish, MAX(day) AS d FROM card_history GROUP BY scryfall_id, finish) m
           ON m.scryfall_id = h.scryfall_id AND m.finish = h.finish AND m.d = h.day`,
    ).all().map((r) => [keyOf(r.scryfall_id, r.finish), r]));
    const put = db.prepare(
      `INSERT INTO card_history (scryfall_id, finish, day, quantity, eur) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scryfall_id, finish, day) DO UPDATE SET quantity = excluded.quantity, eur = excluded.eur`,
    );
    const write = (id, finish, quantity, eur) => {
      const prev = last.get(keyOf(id, finish));
      if (prev && prev.quantity === quantity && prev.eur === eur) return;
      put.run(id, finish, day, quantity, eur);
      changed++;
    };
    for (const h of holdings.values()) write(h.scryfall_id, h.finish, h.quantity, h.eur);
    // Gone since the last row (sold, deleted, moved off the wishlist): held 0 now.
    for (const [k, prev] of last) {
      if (!holdings.has(k) && prev.quantity !== 0) write(prev.scryfall_id, prev.finish, 0, prev.eur);
    }
  });
  return { day, value_eur: t.value_eur, copies: t.copies, printings: t.printings, unpriced: t.unpriced, changed };
}

/** Snapshot only when today has none yet (boot seed); returns the snapshot or null. */
export function ensureSnapshot(db, { now = new Date() } = {}) {
  if (db.prepare("SELECT 1 FROM value_history WHERE day = ?").get(localDay(now))) return null;
  return snapshotValue(db, { now });
}

/**
 * Change from the stored end of `fromDay` to now (live), split into added /
 * removed copies and price changes; also the per-key detail for movers.
 */
function changeSince(db, fromDay, holdings) {
  const base = stateAt(db, fromDay);
  let added = 0, removed = 0, price = 0, addedCopies = 0, removedCopies = 0;
  const keys = new Set([...base.keys(), ...[...holdings.entries()].filter(([, h]) => h.quantity > 0).map(([k]) => k)]);
  const movers = [];
  for (const k of keys) {
    const a = base.get(k) ?? { quantity: 0, eur: null };
    const b = holdings.get(k) ?? { quantity: 0, eur: null };
    const pa = a.eur ?? b.eur ?? 0;
    const pb = b.eur ?? a.eur ?? 0;
    const held = Math.min(a.quantity, b.quantity);
    if (b.quantity > a.quantity) { added += (b.quantity - a.quantity) * pb; addedCopies += b.quantity - a.quantity; }
    if (a.quantity > b.quantity) { removed += (a.quantity - b.quantity) * pa; removedCopies += a.quantity - b.quantity; }
    if (held > 0) {
      price += held * (pb - pa);
      if (a.eur != null && b.eur != null && a.eur !== b.eur) movers.push({ key: k, held, from: a.eur, to: b.eur, h: b });
    }
  }
  return {
    added_eur: round2(added), removed_eur: round2(removed), price_eur: round2(price), change_eur: round2(added - removed + price),
    added_copies: addedCopies, removed_copies: removedCopies, movers,
  };
}

const PERIODS = [["today", 1], ["d7", 7], ["d30", 30]];

/**
 * Market tab value summary: live totals, today / 7 / 30 day changes (null when the
 * history doesn't reach back to that day yet), value per binder and rarity.
 */
export function financeSummary(db, { now = new Date() } = {}) {
  const today = localDay(now);
  const start = historyStart(db);
  const holdings = liveHoldings(db);
  const t = totalsOf(holdings);
  const changes = {};
  for (const [name, days] of PERIODS) {
    const from = addDays(today, -days);
    if (!start || start > from) { changes[name] = null; continue; }
    const c = changeSince(db, from, holdings);
    delete c.movers;
    changes[name] = { from_day: from, value_from_eur: round2(t.value_eur - c.change_eur), ...c };
  }
  const rarity = new Map();
  for (const h of holdings.values()) {
    if (!h.quantity) continue;
    const r = h.rarity || "unknown";
    const e = rarity.get(r) ?? { rarity: r, total: eurTotal(), copies: 0 };
    e.copies += h.quantity;
    if (h.eur != null) e.total.add(h.eur, h.quantity);
    rarity.set(r, e);
  }
  return {
    today, history_start: start, value_eur: t.value_eur, copies: t.copies, printings: t.printings, unpriced_copies: t.unpriced, changes,
    binders: t.binders,
    rarities: [...rarity.values()].map(({ total, ...r }) => ({ ...r, value_eur: total.value })).sort((a, b) => b.value_eur - a.value_eur),
  };
}

/** Daily totals of the last `days` days (oldest first); today's point is the live value. */
export function financeHistory(db, { days = 90, now = new Date() } = {}) {
  const n = Math.min(3660, Math.max(1, Math.floor(Number(days)) || 90));
  const today = localDay(now);
  const from = addDays(today, -n);
  const points = db.prepare("SELECT day, value_eur, copies FROM value_history WHERE day >= ? AND day < ? ORDER BY day").all(from, today)
    .map((r) => ({ day: r.day, value_eur: r.value_eur, copies: r.copies }));
  const t = totalsOf(liveHoldings(db, { wishlist: false }));
  points.push({ day: today, value_eur: t.value_eur, copies: t.copies });
  return { days: n, from_day: from, today, history_start: historyStart(db), points };
}

const moverRow = (m) => ({
  scryfall_id: m.h.scryfall_id, finish: m.h.finish, name: m.h.name, set_code: m.h.set_code, collector_number: m.h.collector_number,
  image_small: m.h.image_small ?? null, quantity: m.h.quantity, held: m.held, from_eur: m.from, to_eur: m.to,
  change_eur: round2(m.to - m.from), change_total_eur: round2((m.to - m.from) * m.held), change_pct: m.from > 0 ? round2(((m.to - m.from) / m.from) * 100) : null,
});

/**
 * Biggest risers and fallers among cards held on both days (price change ×
 * copies held): {from_day, available, risers[], fallers[]}.
 */
export function financeMovers(db, { days = 7, limit = 10, now = new Date() } = {}) {
  const n = Math.min(3660, Math.max(1, Math.floor(Number(days)) || 7));
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit)) || 10));
  const today = localDay(now);
  const from = addDays(today, -n);
  const start = historyStart(db);
  if (!start || start > from) return { days: n, from_day: from, history_start: start, available: false, risers: [], fallers: [] };
  const { movers } = changeSince(db, from, liveHoldings(db, { wishlist: false }));
  const byTotal = (a, b) => (b.to - b.from) * b.held - (a.to - a.from) * a.held;
  const up = movers.filter((m) => m.to > m.from).sort(byTotal).slice(0, lim).map(moverRow);
  const down = movers.filter((m) => m.to < m.from).sort((a, b) => -byTotal(a, b)).slice(0, lim).map(moverRow);
  return { days: n, from_day: from, history_start: start, available: true, risers: up, fallers: down };
}

/** Most valuable owned printings by unit price: [{..., quantity, price_eur, value_eur, binders[{binder, quantity}]}]. */
export function financeTop(db, { limit = 20 } = {}) {
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
  const list = [...liveHoldings(db, { wishlist: false }).values()].filter((h) => h.quantity > 0 && h.eur != null)
    .sort((a, b) => b.eur - a.eur || b.quantity - a.quantity || a.name.localeCompare(b.name)).slice(0, lim);
  return {
    cards: list.map((h) => ({
      scryfall_id: h.scryfall_id, oracle_id: h.oracle_id, name: h.name, set_code: h.set_code, set_name: h.set_name, collector_number: h.collector_number,
      finish: h.finish, rarity: h.rarity, image_small: h.image_small, quantity: h.quantity, price_eur: h.eur, value_eur: round2(h.eur * h.quantity),
      binders: [...h.binders].map(([binder, quantity]) => ({ binder, quantity })).sort((a, b) => b.quantity - a.quantity),
    })),
  };
}

/** Stored price/quantity history of one printing + finish (change points, oldest first). */
export function cardHistory(db, scryfallId, finish = "normal") {
  return db.prepare("SELECT day, quantity, eur FROM card_history WHERE scryfall_id = ? AND finish = ? ORDER BY day").all(scryfallId, finish)
    .map((r) => ({ day: r.day, quantity: r.quantity, eur: r.eur }));
}
