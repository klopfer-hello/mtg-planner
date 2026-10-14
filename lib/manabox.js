// ManaBox collection CSV import.
//
// Three modes:
// - "replace" (default while ManaBox is the collection master): wipes the
//   ManaBox-sourced rows and loads the export as-is (a full sync).
// - "delta" (default once the app is the master, lib/binders.js): the app
//   remembers the last export (table manabox_snapshot, keyed by printing +
//   finish + language + condition + binder). Only the INCREASE per key is
//   added (into the ManaBox binder, source 'manabox'); decreases are reported,
//   never deleted, because the copies may have been moved or reorganised in the
//   app. Re-importing the same file changes nothing.
// - "add": merges every quantity on top (duplicates what is already there).
// Every import rewrites the snapshot with the file's owned rows.
// Every row is resolved against Scryfall (by Scryfall ID when present, else set
// + collector number, else name + set) which also refreshes prices.
//
// Rows carry collection.source = 'manabox'; a replace only wipes those, so
// cards added with the in-app scanner (source 'scan') or organised in the app
// (source 'app', see lib/binders.js) survive a re-sync.
//
// Binder handling: rows in a binder of type "deck" are owned cards AND become a
// deck of that name (status 'built'); rows of type "list" (wish lists) are not
// owned and skipped. In replace mode, binder decks (source "manabox") that are
// no longer in the export are removed; in add mode binder deck rows are merged
// into the deck. Replace and delta rebuild a binder deck with every card in
// "main", then put back the board assignments the user made in the app
// (commander / side / maybe) for cards that are still in the binder.

import { transaction, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";
import { findManaboxDeck, saveDeckRows } from "./decks.js";
import { defaultImportMode, ensureBinder, findBinder, pruneManaboxBinders } from "./binders.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BATCH = 75;
// Scryfall allows 2 req/s on /cards/collection (a 429 locks the client out for 30 s).
export const COLLECTION_INTERVAL_MS = 500;

/** fetchCollection in batches of 75, at most 2 requests per second. */
export async function fetchCollectionPolitely(identifiers, { intervalMs = COLLECTION_INTERVAL_MS } = {}) {
  const cards = [];
  const notFound = [];
  for (let i = 0; i < identifiers.length; i += BATCH) {
    if (i) await sleep(intervalMs);
    const res = await fetchCollection(identifiers.slice(i, i + BATCH));
    cards.push(...res.cards);
    notFound.push(...res.notFound);
  }
  return { cards, notFound };
}

/** Non-main board rows of a manabox deck: [{name, board, quantity}]. */
function boardAssignments(db, binder) {
  const deck = findManaboxDeck(db, binder);
  if (!deck) return [];
  return db.prepare("SELECT name, board, quantity FROM deck_cards WHERE deck_id = ? AND board <> 'main'").all(deck.id);
}

/** Move copies back out of main into the boards they had (only names still in the deck). */
function reapplyBoards(db, deckId, assignments) {
  const main = db.prepare("SELECT name, scryfall_id, quantity FROM deck_cards WHERE deck_id = ? AND board = 'main' AND name = ? COLLATE NOCASE");
  for (const a of assignments) {
    const row = main.get(deckId, a.name);
    if (!row) continue;
    const n = Math.min(a.quantity, row.quantity);
    if (n >= row.quantity) db.prepare("DELETE FROM deck_cards WHERE deck_id = ? AND board = 'main' AND name = ?").run(deckId, row.name);
    else db.prepare("UPDATE deck_cards SET quantity = quantity - ? WHERE deck_id = ? AND board = 'main' AND name = ?").run(n, deckId, row.name);
    db.prepare(`INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (deck_id, board, name) DO UPDATE SET quantity = quantity + excluded.quantity`)
      .run(deckId, a.board, row.name, row.scryfall_id, n);
  }
}

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

export const IMPORT_MODES = ["replace", "delta", "add"];
const LIST_CAP = 500;
const printKey = (id, finish, language, condition) => [id, finish, language, condition].join("|");
const snapKey = (id, finish, language, condition, binder) => [id, finish, language, condition, binder.toLowerCase()].join("|");

/**
 * mode: "replace" | "delta" | "add"; omitted = defaultImportMode (delta once the app is the
 * collection master). The summary has added:[{name, set_code, collector_number, finish, language,
 * condition, binder, quantity}] and decreased:[{..., before, after, quantity (negative), message}]
 * (delta only; capped at 500 entries each, added_copies / decreased_copies count everything).
 */
export async function importManaBoxCsv(db, text, { mode = null, filename = null } = {}) {
  mode = mode ?? defaultImportMode(db);
  if (!IMPORT_MODES.includes(mode)) throw new Error('mode must be "replace", "delta" or "add"');
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
  const { cards } = await fetchCollectionPolitely([...idents.values()]);
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
  // The same goes for a delta: it would reset the snapshot (and re-add everything next time).
  if (mode !== "add" && !entries.some((e) => resolved.has(keyOf(e)))) {
    throw new Error("Nothing importable in this file (no owned cards could be resolved); the collection was left unchanged.");
  }

  const before = snapshot(db);
  const unresolved = [];
  const decks = new Map();
  let decksRemoved = [];
  const added = [];
  const decreased = [];
  const bindersCreated = [];
  let addedCopies = 0, decreasedCopies = 0, addedRows = 0, decreasedRows = 0, keptAppCopies = 0;
  transaction(db, () => {
    upsertCards(db, cards.map(normalizeCard));
    if (mode === "replace") db.exec("DELETE FROM collection WHERE source = 'manabox'");
    // source 'app' rows are ManaBox copies the user moved in the app. ManaBox still lists
    // them (in their old binder), so a replace loads each printing minus those copies
    // instead of counting them twice.
    const appLeft = new Map();
    if (mode === "replace") {
      for (const r of db.prepare(
        "SELECT scryfall_id, finish, language, condition, SUM(quantity) AS q FROM collection WHERE source = 'app' GROUP BY 1, 2, 3, 4",
      ).all()) appLeft.set(printKey(r.scryfall_id, r.finish, r.language, r.condition), r.q);
    }
    const insert = db.prepare(
      `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manabox')
       ON CONFLICT (scryfall_id, finish, language, condition, binder, source)
       DO UPDATE SET quantity = quantity + excluded.quantity,
                     purchase_price = COALESCE(excluded.purchase_price, purchase_price),
                     purchase_currency = COALESCE(excluded.purchase_currency, purchase_currency)`,
    );
    const knownBinder = (name) => {
      if (!name) return "";
      const existing = findBinder(db, name);
      if (!existing) bindersCreated.push(name);
      ensureBinder(db, existing ?? name, "manabox");
      return existing ?? name;
    };
    // The file's owned rows per snapshot key (rows may repeat a key).
    const fileRows = new Map();
    const unresolvedIds = new Set();
    for (const e of entries) {
      const id = resolved.get(keyOf(e));
      if (!id) {
        unresolved.push(`${e.quantity}x ${e.name}${e.set ? ` (${e.set.toUpperCase()} ${e.number})` : ""}`);
        if (e.scryfallId) unresolvedIds.add(e.scryfallId);
        continue;
      }
      // replace/add load every row (replace minus the copies already held as app rows);
      // delta adds only the increase per key below.
      if (mode !== "delta") {
        const pk = printKey(id, e.finish, e.language, e.condition);
        const held = Math.min(appLeft.get(pk) ?? 0, e.quantity);
        if (held) { appLeft.set(pk, appLeft.get(pk) - held); keptAppCopies += held; }
        if (e.quantity > held) insert.run(id, e.finish, e.language, e.condition, knownBinder(e.binder), e.quantity - held, e.purchasePrice, e.purchaseCurrency);
      }
      const k = snapKey(id, e.finish, e.language, e.condition, e.binder);
      const f = fileRows.get(k) ?? { id, e, quantity: 0 };
      f.quantity += e.quantity;
      fileRows.set(k, f);
      if (e.binderType === "deck" && e.binder) {
        if (!decks.has(e.binder)) decks.set(e.binder, []);
        decks.get(e.binder).push({ scryfall_id: id, name: nameById.get(id) ?? e.name, quantity: e.quantity, board: "main" });
      }
    }
    const cardInfo = db.prepare("SELECT name, set_code, collector_number FROM cards WHERE scryfall_id = ?");
    const describe = (id, finish, language, condition, binder) => {
      const c = cardInfo.get(id) ?? {};
      return { name: c.name ?? nameById.get(id) ?? id, set_code: c.set_code ?? null, collector_number: c.collector_number ?? null, finish, language, condition, binder };
    };
    const fewer = (d, before, after) => {
      const n = before - after;
      decreasedCopies += n;
      decreasedRows++;
      if (decreased.length < LIST_CAP) {
        decreased.push({ ...d, before, after, quantity: -n, message: `ManaBox has fewer copies of ${d.name} (\u2212${n})` });
      }
    };
    if (mode === "replace") {
      // More app-held copies than ManaBox lists: kept (the app is not told to delete), reported.
      for (const [pk, left] of appLeft) {
        if (left <= 0) continue;
        const [id, finish, language, condition] = pk.split("|");
        if (unresolvedIds.has(id)) continue;
        const held = db.prepare("SELECT SUM(quantity) AS q FROM collection WHERE source = 'app' AND scryfall_id = ? AND finish = ? AND language = ? AND condition = ?")
          .get(id, finish, language, condition).q;
        fewer(describe(id, finish, language, condition, null), held, held - left);
      }
    }
    if (mode === "delta") {
      const prev = new Map(db.prepare("SELECT * FROM manabox_snapshot").all()
        .map((r) => [snapKey(r.scryfall_id, r.finish, r.language, r.condition, r.binder), r]));
      for (const [k, f] of fileRows) {
        const before = prev.get(k)?.quantity ?? 0;
        const { e } = f;
        if (f.quantity > before) {
          const n = f.quantity - before;
          const binder = knownBinder(e.binder);
          insert.run(f.id, e.finish, e.language, e.condition, binder, n, e.purchasePrice, e.purchaseCurrency);
          addedCopies += n;
          addedRows++;
          if (added.length < LIST_CAP) added.push({ ...describe(f.id, e.finish, e.language, e.condition, binder), quantity: n });
        } else if (f.quantity < before) {
          fewer(describe(f.id, e.finish, e.language, e.condition, prev.get(k).binder), before, f.quantity);
        }
      }
      for (const [k, r] of prev) {
        if (fileRows.has(k)) continue;
        // A row Scryfall could not resolve this time is kept as it was, not reported.
        if (unresolvedIds.has(r.scryfall_id)) { fileRows.set(k, { id: r.scryfall_id, e: r, quantity: r.quantity }); continue; }
        fewer(describe(r.scryfall_id, r.finish, r.language, r.condition, r.binder), r.quantity, 0);
      }
    }
    // The snapshot is the last export, whatever the mode.
    db.exec("DELETE FROM manabox_snapshot");
    const snap = db.prepare("INSERT INTO manabox_snapshot (scryfall_id, finish, language, condition, binder, quantity) VALUES (?, ?, ?, ?, ?, ?)");
    for (const f of fileRows.values()) snap.run(f.id, f.e.finish, f.e.language, f.e.condition, f.e.binder, f.quantity);

    for (const [name, deckRows] of decks) {
      const rebuild = mode !== "add";
      const keep = rebuild ? boardAssignments(db, name) : [];
      const deckId = saveDeckRows(db, { name, source: "manabox", rows: deckRows, matchByName: true, append: !rebuild });
      if (keep.length) reapplyBoards(db, deckId, keep);
    }
    if (mode === "replace") {
      // Binders dissolved or renamed in ManaBox: their decks go too.
      const synced = new Set([...decks.keys()].map((n) => n.toLowerCase()));
      const stale = db.prepare("SELECT id, name, manabox_binder FROM decks WHERE source = 'manabox'").all()
        .filter((d) => !synced.has((d.manabox_binder ?? d.name).toLowerCase()));
      const del = db.prepare("DELETE FROM decks WHERE id = ?");
      for (const d of stale) del.run(d.id);
      decksRemoved = stale.map((d) => d.name);
      pruneManaboxBinders(db);
    }
  });

  const after = snapshot(db);
  let printingsAdded = 0, removed = 0, changed = 0;
  for (const [id, q] of after) {
    if (!before.has(id)) printingsAdded++;
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
    printings_added: printingsAdded,
    printings_removed: removed,
    printings_changed: changed,
    decks_from_binders: [...decks.keys()],
    decks_removed: decksRemoved,
    skipped_wishlist_rows: skippedLists,
    unresolved,
    added,
    added_copies: addedCopies,
    added_truncated: addedRows - added.length,
    decreased,
    decreased_copies: decreasedCopies,
    decreased_truncated: decreasedRows - decreased.length,
    binders_created: bindersCreated,
    kept_app_copies: keptAppCopies,
  };
  db.prepare("INSERT INTO imports (kind, filename, mode, summary) VALUES ('manabox', ?, ?, ?)").run(filename, mode, JSON.stringify(summary));
  return summary;
}

/** Re-fetch prices and card data for every owned or deck printing (2 req/s). */
export async function refreshOwnedCards(db) {
  const ids = db.prepare("SELECT DISTINCT scryfall_id FROM collection UNION SELECT DISTINCT scryfall_id FROM deck_cards WHERE scryfall_id IS NOT NULL").all().map((r) => r.scryfall_id);
  const { cards, notFound } = await fetchCollectionPolitely(ids.map((id) => ({ id })));
  transaction(db, () => upsertCards(db, cards.map(normalizeCard)));
  return { refreshed: cards.length, not_found: notFound.length };
}
