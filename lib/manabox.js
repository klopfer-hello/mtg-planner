// ManaBox collection CSV import.
//
// ManaBox is the source of truth for the collection: the default "replace" mode
// wipes the owned cards and loads the export as-is (a full sync); "add" merges
// quantities on top. Every row is resolved against Scryfall (by Scryfall ID when
// present, else set + collector number, else name + set) which also refreshes
// prices for everything in the export.
//
// Binder handling: rows in a binder of type "deck" are owned cards AND become a
// deck of that name; rows of type "list" (wish lists) are not owned and skipped.
// In replace mode, binder decks (source "manabox") that are no longer in the
// export are removed; in add mode binder deck rows are merged into the deck.

import { transaction, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";
import { saveDeckRows } from "./decks.js";

export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.indexOf("\n") >>> 0);
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] != null && row[k] !== "") return row[k];
  return "";
};

function normFinish(v) {
  const s = v.toLowerCase();
  if (s.includes("etched")) return "etched";
  if (["foil", "true", "yes", "1"].includes(s)) return "foil";
  return "normal";
}

const normCondition = (v) => (v || "near_mint").toLowerCase().replace(/[\s-]+/g, "_");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function snapshot(db) {
  const map = new Map();
  for (const r of db.prepare("SELECT scryfall_id, SUM(quantity) AS q FROM collection GROUP BY scryfall_id").all()) {
    map.set(r.scryfall_id, r.q);
  }
  return map;
}

export async function importManaBoxCsv(db, text, { mode = "replace", filename = null } = {}) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("The CSV file is empty.");
  const cols = Object.keys(rows[0]);
  if (!cols.includes("name") || !(cols.includes("scryfall id") || cols.includes("set code"))) {
    throw new Error(`Not a ManaBox collection export: need "Name" plus "Scryfall ID" or "Set code" columns (got: ${cols.join(", ")}).`);
  }

  const entries = [];
  let skippedLists = 0;
  for (const row of rows) {
    const binderType = pick(row, "binder type").toLowerCase();
    if (binderType === "list") { skippedLists++; continue; }
    const quantity = parseInt(pick(row, "quantity", "count", "qty") || "1", 10);
    if (!(quantity > 0)) continue;
    const price = parseFloat(pick(row, "purchase price").replace(",", "."));
    entries.push({
      name: pick(row, "name"),
      scryfallId: pick(row, "scryfall id").toLowerCase(),
      set: pick(row, "set code", "set").toLowerCase(),
      number: pick(row, "collector number", "card number"),
      finish: normFinish(pick(row, "foil", "finish", "printing")),
      language: pick(row, "language").toLowerCase() || "en",
      condition: normCondition(pick(row, "condition")),
      binder: pick(row, "binder name"),
      binderType,
      quantity,
      purchasePrice: Number.isFinite(price) ? price : null,
      purchaseCurrency: pick(row, "purchase price currency") || null,
    });
  }

  // Resolve every distinct printing against Scryfall (also refreshes prices).
  const keyOf = (e) => (e.scryfallId ? `id:${e.scryfallId}` : e.set && e.number ? `sn:${e.set}|${e.number}` : `n:${e.name.toLowerCase()}|${e.set}`);
  const idents = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (idents.has(k)) continue;
    // Scryfall rejects the whole batch for one malformed identifier, so rows
    // with a broken Scryfall ID or no name are left out (reported unresolved).
    if (e.scryfallId) { if (UUID.test(e.scryfallId)) idents.set(k, { id: e.scryfallId }); }
    else if (e.set && e.number) idents.set(k, { set: e.set, collector_number: e.number });
    else if (e.name) idents.set(k, e.set ? { name: e.name, set: e.set } : { name: e.name });
  }
  const { cards } = await fetchCollection([...idents.values()]);
  const resolved = new Map();
  const nameById = new Map(cards.map((c) => [c.id, c.name]));
  for (const c of cards) {
    resolved.set(`id:${c.id}`, c.id);
    resolved.set(`sn:${c.set}|${c.collector_number}`, c.id);
    resolved.set(`n:${c.name.toLowerCase()}|${c.set}`, c.id);
    resolved.set(`n:${c.name.toLowerCase()}|`, c.id);
    // Name lookups may use the front face of a double-faced card ("Delver of
    // Secrets"), while Scryfall answers with the full "A // B" name.
    for (const f of c.card_faces || []) {
      if (!f.name) continue;
      resolved.set(`n:${f.name.toLowerCase()}|${c.set}`, c.id);
      resolved.set(`n:${f.name.toLowerCase()}|`, c.id);
    }
  }

  // A "full sync" with nothing importable (a wish-list export, all rows
  // unresolved, ...) would silently empty the collection: refuse it instead.
  if (mode === "replace" && !entries.some((e) => resolved.has(keyOf(e)))) {
    throw new Error("Nothing importable in this file (no owned cards could be resolved); the collection was left unchanged.");
  }

  const before = snapshot(db);
  const unresolved = [];
  const decks = new Map();
  let decksRemoved = [];
  transaction(db, () => {
    upsertCards(db, cards.map(normalizeCard));
    if (mode === "replace") db.exec("DELETE FROM collection");
    const insert = db.prepare(
      `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scryfall_id, finish, language, condition, binder)
       DO UPDATE SET quantity = quantity + excluded.quantity,
                     purchase_price = COALESCE(excluded.purchase_price, purchase_price),
                     purchase_currency = COALESCE(excluded.purchase_currency, purchase_currency)`,
    );
    for (const e of entries) {
      const id = resolved.get(keyOf(e));
      if (!id) { unresolved.push(`${e.quantity}x ${e.name}${e.set ? ` (${e.set.toUpperCase()} ${e.number})` : ""}`); continue; }
      insert.run(id, e.finish, e.language, e.condition, e.binder, e.quantity, e.purchasePrice, e.purchaseCurrency);
      if (e.binderType === "deck" && e.binder) {
        if (!decks.has(e.binder)) decks.set(e.binder, []);
        decks.get(e.binder).push({ scryfall_id: id, name: nameById.get(id) ?? e.name, quantity: e.quantity, board: "main" });
      }
    }
    for (const [name, deckRows] of decks) {
      saveDeckRows(db, { name, source: "manabox", rows: deckRows, matchByName: true, append: mode === "add" });
    }
    if (mode === "replace") {
      // Binders dissolved or renamed in ManaBox: their decks go too.
      const stale = db.prepare("SELECT id, name FROM decks WHERE source = 'manabox'").all().filter((d) => !decks.has(d.name));
      const del = db.prepare("DELETE FROM decks WHERE id = ?");
      for (const d of stale) del.run(d.id);
      decksRemoved = stale.map((d) => d.name);
    }
  });

  const after = snapshot(db);
  let added = 0, removed = 0, changed = 0;
  for (const [id, q] of after) {
    if (!before.has(id)) added++;
    else if (before.get(id) !== q) changed++;
  }
  for (const id of before.keys()) if (!after.has(id)) removed++;
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

  const summary = {
    mode,
    rows: rows.length,
    imported_rows: entries.length - unresolved.length,
    printings: after.size,
    total_cards_before: sum(before),
    total_cards_after: sum(after),
    printings_added: added,
    printings_removed: removed,
    printings_changed: changed,
    decks_from_binders: [...decks.keys()],
    decks_removed: decksRemoved,
    skipped_wishlist_rows: skippedLists,
    unresolved,
  };
  db.prepare("INSERT INTO imports (kind, filename, mode, summary) VALUES ('manabox', ?, ?, ?)").run(filename, mode, JSON.stringify(summary));
  return summary;
}

/** Re-fetch prices and card data for every owned printing. */
export async function refreshOwnedCards(db) {
  const ids = db.prepare("SELECT DISTINCT scryfall_id FROM collection UNION SELECT DISTINCT scryfall_id FROM deck_cards WHERE scryfall_id IS NOT NULL").all().map((r) => r.scryfall_id);
  const { cards, notFound } = await fetchCollection(ids.map((id) => ({ id })));
  transaction(db, () => upsertCards(db, cards.map(normalizeCard)));
  return { refreshed: cards.length, not_found: notFound.length };
}
