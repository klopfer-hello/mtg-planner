// Decks: decklist parsing, name → printing resolution (owned printings first),
// persistence, and ownership coverage against the collection.
//
// Allocation: a deck is an 'idea' (a plan, claims nothing) or 'built' (a
// physical deck). Built decks CLAIM owned copies, counted per oracle card
// across all printings, from the commander+main+side boards (never maybe):
//   owned(card)        every copy in the collection
//   built_demand(card) sum over built decks
//   available(card)    owned - built_demand (negative = short)
// Seen from one deck, used_elsewhere is the demand of the OTHER built decks and
// available_for_this = owned - used_elsewhere. The copies a deck needs split into
//   covered  free copies (min(need, free))
//   in_use   owned, but claimed by other built decks: can be moved over, so they
//            are not bought (min(need, owned) - covered)
//   to_buy   copies the user does not own at all (need - owned); only these are
//            "missing" (missing_count, shopping list, to-buy cost)
// Basic lands never conflict and are never to buy or in use.
//
// Locked binders: copies lying in a locked binder (lib/deckboxes.js: the user's
// lock, else auto = deck boxes) belong to that binder. They are free only for the
// deck that owns it; for every other deck they count like copies another built
// deck claims (in_use, "🔒 in X · locked", can be moved), never free and never to
// buy. A built deck's claim takes from its own box first, so the lock and the
// claim never reserve the same copies twice. Conflicts stay about built decks'
// claims only (a lock never makes one); basics stay always free. The fields keep
// their beta.2 names (in_boxes, in_use_box, in_use_box_count) plus the aliases
// in_locked, in_use_locked, in_use_locked_count.
//
// Power (v0.7.0): deckDetail also returns stats (lib/deckstats.js), the
// Commander bracket + 1-10 score (lib/power.js) and the cached Commander
// Spellbook combos. It only READS the Spellbook cache (lib/spellbook.js
// cachedCombos): the network call happens elsewhere (server scheduler, MCP),
// so listDecks stays a local, synchronous read. The power part is memoised per
// deck on everything it depends on, so a list of unchanged decks is cheap.

import { createHash } from "node:crypto";
import { cardPrice, eurOf, formatPrice, parsePrices, transaction, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";
import { deckStats } from "./deckstats.js";
import { BRACKET_RULES, CEDH_HINT, SCORE_BANDS, comboUrl, isCommanderDeck, powerOf, withAssemblyMv } from "./power.js";
import { cachedCombos, spellbookRequest, spellbookSettings } from "./spellbook.js";
import { textOf } from "./cardclass.js";
import { recordDeckVersion } from "./deckhistory.js";
import { accessoriesForRows, accessoriesText } from "./accessories.js";
import { lockedBinders } from "./deckboxes.js";

export const BOARDS = ["commander", "main", "side", "maybe"];
/** Boards whose copies a built deck claims. */
export const CLAIM_BOARDS = ["commander", "main", "side"];
export const DECK_STATUSES = ["idea", "built"];
export const BASIC_LANDS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes",
  "snow-covered plains", "snow-covered island", "snow-covered swamp", "snow-covered mountain", "snow-covered forest"]);
export const isBasicLand = (name) => BASIC_LANDS.has(String(name || "").toLowerCase());

/** Allocation key of a card: its oracle id, else (unresolved deck rows) its lower-cased name. */
export const cardKey = (oracleId, name) => oracleId ?? `name:${String(name || "").toLowerCase()}`;

/**
 * Snapshot of ownership, built-deck claims and deck-box reservations: {ownedOf(key, name),
 * built: Map key -> {name, oracle_id, demand, decks:[{deck_id, name, status, quantity}]},
 * boxes (lib/deckboxes.js lockedBinders), boxCopiesOf(key, name) -> [{binder, owners, quantity}],
 * reserve(key, name, viewerId = null) -> {decks (other built decks' claims), boxes:[{binder,
 * deck_id, deck_name, quantity}] (box copies reserved against the viewer, after the owning
 * built deck's claim took its share), elsewhere (sum of both)}, boxReserveByOracle() -> Map
 * oracle_id -> box copies reserved on top of the built claims (viewer = nobody)}. Compute it
 * once and pass it to deckDetail/cardUsage when handling several decks.
 */
export function allocation(db) {
  const owned = new Map();
  for (const r of db.prepare(
    `SELECT c.oracle_id, SUM(col.quantity) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id IS NOT NULL GROUP BY c.oracle_id`,
  ).all()) owned.set(r.oracle_id, r.q);
  const byName = db.prepare(
    `SELECT COALESCE(SUM(col.quantity), 0) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE`,
  );
  const ownedOf = (key, name) => {
    if (owned.has(key)) return owned.get(key);
    if (!key.startsWith("name:")) return 0;
    const q = byName.get(name, name).q;
    owned.set(key, q);
    return q;
  };
  const built = new Map();
  const rows = db.prepare(
    `SELECT d.id AS deck_id, d.name AS deck_name, d.status, c.oracle_id, MIN(dc.name) AS card_name, SUM(dc.quantity) AS q
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE d.status = 'built' AND dc.board IN ('commander', 'main', 'side')
      GROUP BY d.id, COALESCE(c.oracle_id, 'name:' || lower(dc.name))
      ORDER BY d.name COLLATE NOCASE, d.id`,
  ).all();
  for (const r of rows) {
    const key = cardKey(r.oracle_id, r.card_name);
    const e = built.get(key) ?? { name: r.card_name, oracle_id: r.oracle_id, demand: 0, decks: [] };
    e.demand += r.q;
    e.decks.push({ deck_id: r.deck_id, name: r.deck_name, status: r.status, quantity: r.q });
    built.set(key, e);
  }
  // Copies per locked binder and card.
  const boxes = lockedBinders(db);
  const boxKeys = JSON.stringify([...boxes.keys()]);
  const boxCopies = new Map();
  if (boxes.size) {
    for (const r of db.prepare(
      `SELECT c.oracle_id, lower(col.binder) AS k, SUM(col.quantity) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
        WHERE c.oracle_id IS NOT NULL AND lower(col.binder) IN (SELECT value FROM json_each(?))
        GROUP BY c.oracle_id, lower(col.binder) ORDER BY lower(col.binder)`,
    ).all(boxKeys)) {
      const b = boxes.get(r.k);
      if (!boxCopies.has(r.oracle_id)) boxCopies.set(r.oracle_id, []);
      boxCopies.get(r.oracle_id).push({ binder: b.name, owners: b.owners, quantity: r.q });
    }
  }
  const boxByName = boxes.size ? db.prepare(
    `SELECT lower(col.binder) AS k, SUM(col.quantity) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE (c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE) AND lower(col.binder) IN (SELECT value FROM json_each(?))
      GROUP BY lower(col.binder) ORDER BY lower(col.binder)`,
  ) : null;
  const boxCopiesOf = (key, name) => {
    if (boxCopies.has(key)) return boxCopies.get(key);
    if (!key.startsWith("name:") || !boxByName) return [];
    const list = boxByName.all(name, name, boxKeys).map((r) => ({ binder: boxes.get(r.k).name, owners: boxes.get(r.k).owners, quantity: r.q }));
    boxCopies.set(key, list);
    return list;
  };
  const reserve = (key, name, viewer = null) => {
    const claims = built.get(key)?.decks ?? [];
    const decks = viewer == null ? claims : claims.filter((d) => d.deck_id !== viewer);
    // A built deck's claim is met from its own box first: those copies are reserved once.
    const absorb = new Map(claims.map((d) => [d.deck_id, d.quantity]));
    const held = [];
    for (const e of boxCopiesOf(key, name)) {
      if (viewer != null && e.owners.some((o) => o.id === viewer)) continue;
      let q = e.quantity;
      for (const o of e.owners) {
        const a = absorb.get(o.id) ?? 0;
        const t = Math.min(a, q);
        if (t) { absorb.set(o.id, a - t); q -= t; }
      }
      if (q > 0) held.push({ binder: e.binder, deck_id: e.owners[0]?.id ?? null, deck_name: e.owners[0]?.name ?? null, quantity: q });
    }
    const elsewhere = decks.reduce((a, d) => a + d.quantity, 0) + held.reduce((a, b) => a + b.quantity, 0);
    return { decks, boxes: held, elsewhere };
  };
  const boxReserveByOracle = () => {
    const out = new Map();
    for (const key of boxCopies.keys()) {
      if (String(key).startsWith("name:")) continue;
      const n = reserve(key, null).boxes.reduce((a, b) => a + b.quantity, 0);
      if (n) out.set(key, n);
    }
    return out;
  };
  return { ownedOf, built, boxes, boxCopiesOf, reserve, boxReserveByOracle };
}

/**
 * Usage of one card: {owned, built_demand, in_boxes:[{binder, deck_id, deck_name, quantity}],
 * boxed (copies kept in locked binders on top of the built claims), available (owned minus
 * both; basics: owned), decks:[{id, name, status, board, quantity}]}
 * (decks = every deck holding the card, any status and board).
 */
export function cardUsage(db, { oracle_id: oracleId = null, name = "" } = {}, alloc = allocation(db)) {
  const key = cardKey(oracleId, name);
  const owned = alloc.ownedOf(key, name);
  const demand = alloc.built.get(key)?.demand ?? 0;
  const inBoxes = alloc.reserve(key, name).boxes;
  const boxed = inBoxes.reduce((a, b) => a + b.quantity, 0);
  const decks = db.prepare(
    `SELECT d.id, d.name, d.status, dc.board, SUM(dc.quantity) AS quantity
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE c.oracle_id = ? OR (c.oracle_id IS NULL AND dc.name = ? COLLATE NOCASE)
      GROUP BY d.id, dc.board
      ORDER BY CASE d.status WHEN 'built' THEN 0 ELSE 1 END, d.name COLLATE NOCASE, d.id,
               CASE dc.board WHEN 'commander' THEN 0 WHEN 'main' THEN 1 WHEN 'side' THEN 2 ELSE 3 END`,
  ).all(oracleId, name);
  // Basic lands never conflict: every owned basic counts as free.
  const basic = isBasicLand(name || alloc.built.get(key)?.name);
  return { owned, built_demand: demand, in_boxes: inBoxes, boxed, available: basic ? owned : owned - demand - boxed, basic, decks };
}

/** Set a deck's status ('idea' | 'built'), recorded in the deck history. Returns the deck row. */
export function setDeckStatus(db, deckId, status, { actor = "app" } = {}) {
  if (!DECK_STATUSES.includes(status)) throw new DeckError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  const deck = requireDeck(db, deckId);
  db.prepare("UPDATE decks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, deck.id);
  recordDeckVersion(db, deck.id, { actor });
  return db.prepare("SELECT * FROM decks WHERE id = ?").get(deck.id);
}

const SECTION = [
  [/^(commanders?|command zone)\b/i, "commander"],
  [/^(sideboard|side)\b/i, "side"],
  [/^(maybe(board)?|considering)\b/i, "maybe"],
  [/^companions?\b/i, "companion"],
  [/^(deck|main(board|deck)?)\b/i, "main"],
];
// "1 Sol Ring", "1x Sol Ring (C21) 263", "SB: 2 Duress", "1 Arcane Signet (CMM) 1015 *F*"
const LINE = /^(?:(SB|CMDR):\s*)?(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([^\s*]+))?)?(?:\s+\*[A-Z]+\*)*\s*$/;

/**
 * Parse a text decklist (ManaBox / MTGA / Moxfield style). A `Companion`
 * section's cards go to the side board with `companion: true` (a companion is
 * not part of the 99); the copy MTGA also lists in the Sideboard is dropped.
 */
export function parseDecklist(text) {
  let board = "main";
  const items = [];
  const errors = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const section = SECTION.find(([re]) => re.test(line) && !/^\d/.test(line));
    if (section && line.replace(/[:\s]/g, "").length <= 14) { board = section[1]; continue; }
    const m = line.match(LINE);
    if (!m) { errors.push(line); continue; }
    const [, prefix, qty, name, set, number] = m;
    const companion = !prefix && board === "companion";
    items.push({
      quantity: parseInt(qty, 10),
      name: name.trim(),
      set: set?.toLowerCase(),
      collector_number: number,
      board: prefix === "SB" || companion ? "side" : prefix === "CMDR" ? "commander" : board,
      ...(companion ? { companion: true } : {}),
    });
  }
  // MTGA exports list the companion in the Companion section AND the sideboard.
  for (const comp of items.filter((i) => i.companion)) {
    let left = comp.quantity;
    for (const it of items) {
      if (left <= 0) break;
      if (it.companion || it.board !== "side" || it.name.toLowerCase() !== comp.name.toLowerCase()) continue;
      const n = Math.min(left, it.quantity);
      it.quantity -= n;
      left -= n;
    }
  }
  return { items: items.filter((i) => i.quantity > 0), errors };
}

function ownedPrintingByName(db, name) {
  return db.prepare(
    `SELECT c.scryfall_id, c.name FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE
      GROUP BY c.scryfall_id ORDER BY SUM(col.quantity) DESC LIMIT 1`,
  ).get(name, name);
}

// A companion is a side-board row; on any other board the flag is dropped.
const companionOf = (item, board) => (item.companion && board === "side" ? { companion: true } : {});

/**
 * Resolve {name, quantity, board, set?, collector_number?, companion?} items to deck rows.
 * Name-only items prefer a printing the user owns; everything else is looked
 * up on Scryfall. Returns { rows, unresolved }.
 */
export async function resolveDeckItems(db, items) {
  const rows = [];
  const lookups = [];
  for (const item of items) {
    const board = BOARDS.includes(item.board) ? item.board : "main";
    const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
    if (!item.set) {
      const owned = ownedPrintingByName(db, item.name);
      if (owned) { rows.push({ name: owned.name, scryfall_id: owned.scryfall_id, quantity, board, ...companionOf(item, board) }); continue; }
    }
    lookups.push({ item: { ...item, board, quantity },
      ident: item.set && item.collector_number ? { set: item.set, collector_number: String(item.collector_number) }
        : item.set ? { name: item.name, set: item.set } : { name: item.name } });
  }
  const unresolved = [];
  if (lookups.length) {
    const { cards } = await fetchCollection(lookups.map((l) => l.ident));
    upsertCards(db, cards.map(normalizeCard));
    const norm = (s) => s.toLowerCase();
    for (const { item, ident } of lookups) {
      const card = cards.find((c) => ident.collector_number
        ? c.set === ident.set && c.collector_number === ident.collector_number
        : norm(c.name) === norm(item.name) || norm(c.name).startsWith(norm(item.name) + " // ")
          || (c.card_faces || []).some((f) => norm(f.name) === norm(item.name)));
      const extra = companionOf(item, item.board);
      if (card) rows.push({ name: card.name, scryfall_id: card.id, quantity: item.quantity, board: item.board, ...extra });
      else { unresolved.push(item.name); rows.push({ name: item.name, scryfall_id: null, quantity: item.quantity, board: item.board, ...extra }); }
    }
  }
  return { rows, unresolved };
}

/**
 * Create or replace a deck's contents. Must run inside a transaction when
 * called alongside other writes. With matchByName, an existing deck of the same
 * name and source is replaced instead of creating a duplicate. With append,
 * the rows are merged into the existing cards instead of replacing them.
 */
export function saveDeckRows(db, { id, name, format = null, description = null, source = "manual", status = null, rows, matchByName = false, append = false }) {
  format = normalizeFormat(format);
  if (status != null && !DECK_STATUSES.includes(status)) throw new DeckError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  let deckId = id;
  let keepName = false;
  if (!deckId && matchByName) {
    // ManaBox decks match on their binder, so a deck renamed in the app keeps its name and is not recreated.
    deckId = source === "manabox" ? findManaboxDeck(db, name)?.id
      : db.prepare("SELECT id FROM decks WHERE name = ? AND source = ?").get(name, source)?.id;
    keepName = source === "manabox";
  }
  if (deckId) {
    const existing = db.prepare("SELECT * FROM decks WHERE id = ?").get(deckId);
    if (!existing) throw new Error(`Deck ${deckId} not found`);
    db.prepare("UPDATE decks SET name = ?, format = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(keepName ? existing.name : name ?? existing.name, format ?? existing.format, description ?? existing.description, status ?? existing.status, deckId);
    if (!append) db.prepare("DELETE FROM deck_cards WHERE deck_id = ?").run(deckId);
  } else {
    // ManaBox binder decks are physical decks; everything else starts as an idea.
    deckId = Number(db.prepare("INSERT INTO decks (name, format, description, source, status, manabox_binder) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, format, description, source, status ?? (source === "manabox" ? "built" : "idea"), source === "manabox" ? name : null).lastInsertRowid);
  }
  const insert = db.prepare(
    `INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity, companion) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (deck_id, board, name) DO UPDATE SET quantity = quantity + excluded.quantity,
       companion = MAX(companion, excluded.companion)`,
  );
  for (const r of rows) insert.run(deckId, r.board, r.name, r.scryfall_id, r.quantity, r.companion && r.board === "side" ? 1 : 0);
  return deckId;
}

/** The ManaBox deck synced from binder `binder` (its stored binder name, else its name), or undefined. */
export function findManaboxDeck(db, binder) {
  return db.prepare(
    `SELECT * FROM decks WHERE source = 'manabox'
       AND (manabox_binder = ? COLLATE NOCASE OR (manabox_binder IS NULL AND name = ? COLLATE NOCASE))
     ORDER BY manabox_binder IS NULL, id LIMIT 1`,
  ).get(binder, binder);
}

/** History actor of a deck source (lib/deckhistory.js). */
export const actorOfSource = (source) => ({ claude: "claude", manabox: "import", scan: "scan" })[source] ?? "app";

/**
 * Resolve items and save; status (idea|built) defaults to idea for new decks and is kept on update.
 * Recorded in the deck history (actor from the source: claude, else app).
 */
export async function saveDeck(db, { id, name, format, description, source, status = null, items, matchByName }) {
  if (status != null && !DECK_STATUSES.includes(status)) throw new DeckError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  const { rows, unresolved } = await resolveDeckItems(db, items);
  const deckId = transaction(db, () => {
    const saved = saveDeckRows(db, { id, name, format, description, source, status, rows, matchByName });
    recordDeckVersion(db, saved, { actor: actorOfSource(source) });
    return saved;
  });
  return { id: deckId, unresolved };
}

/** Longest deck notes (decks.description, Markdown) the app and Claude may store. */
export const DECK_NOTES_MAX = 5000;

/**
 * Replace a deck's notes (decks.description, Markdown; '' clears them) and record a history version
 * (equal text = no version). Returns the stored text (null = none). DeckError 404 / 400 (too long).
 */
export function setDeckNotes(db, deckId, text, { actor = "app" } = {}) {
  if (text != null && typeof text !== "string") throw new DeckError(400, "notes must be text");
  const notes = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (notes.length > DECK_NOTES_MAX) throw new DeckError(400, `notes are too long (${notes.length} > ${DECK_NOTES_MAX} characters)`);
  return transaction(db, () => {
    const deck = requireDeck(db, deckId);
    const value = notes || null;
    if ((deck.description ?? null) === value) return value;
    db.prepare("UPDATE decks SET description = ?, updated_at = datetime('now') WHERE id = ?").run(value, deck.id);
    recordDeckVersion(db, deck.id, { actor });
    return value;
  });
}

export function findDeck(db, ref) {
  if (ref == null || ref === "") return null;
  if (/^\d+$/.test(String(ref))) {
    const d = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(ref));
    if (d) return d;
  }
  return db.prepare("SELECT * FROM decks WHERE name = ? COLLATE NOCASE ORDER BY updated_at DESC").get(String(ref))
    ?? db.prepare("SELECT * FROM decks WHERE name LIKE ? ORDER BY updated_at DESC").get(`%${ref}%`);
}

/**
 * Decks, newest first, with card_count, value_eur (commander+main+side, EUR only), status, conflict_count,
 * to_buy_count (= missing_count), missing_cost_eur (to-buy cost), in_use_count (in_use_box_count of it in other deck
 * boxes) and in_use_eur, plus the power
 * summary (null for non-commander decks): bracket (shown: declared ?? auto), bracket_auto, bracket_partial,
 * bracket_display ("3" / "≥3"), score (1 decimal), score_half (UI half step), score_partial, legal, combos_status.
 */
export function listDecks(db) {
  const decks = db.prepare(
    `SELECT d.*, COALESCE(SUM(dc.quantity), 0) AS card_count
       FROM decks d LEFT JOIN deck_cards dc ON dc.deck_id = d.id
      GROUP BY d.id ORDER BY d.updated_at DESC`,
  ).all();
  const alloc = allocation(db);
  const settings = spellbookSettings(db);
  for (const d of decks) {
    const detail = deckDetail(db, d.id, { alloc, spellbook: settings, accessories: false });
    // Power (commander decks only, else null): the shown bracket and the score.
    const b = detail?.power?.bracket ?? null;
    const s = detail?.power?.score ?? null;
    d.bracket = b?.value ?? null;
    d.bracket_auto = b?.auto ?? null;
    d.bracket_partial = b ? b.partial : null;
    d.bracket_display = b?.display ?? null;
    d.score = s?.value ?? null;
    d.score_half = s?.half ?? null;
    d.score_partial = s ? s.partial : null;
    d.legal = detail?.power?.legality ? detail.power.legality.ok : null;
    d.combos_status = detail?.combos?.status ?? null;
    // Not in the JSON: the request to fetch when the combos are missing or stale.
    if (detail?.combos?.needs_fetch) Object.defineProperty(d, "spellbook_request", { value: detail.spellbook_request, enumerable: false });
    d.value_eur = detail?.value.total_eur ?? 0;
    d.conflict_count = detail?.conflict_count ?? 0;
    d.missing_count = detail?.missing_count ?? 0;
    d.to_buy_count = detail?.to_buy_count ?? 0;
    d.missing_cost_eur = detail?.missing_cost_eur ?? 0;
    d.in_use_count = detail?.in_use_count ?? 0;
    d.in_use_box_count = detail?.in_use_box_count ?? 0;
    d.in_use_locked_count = d.in_use_box_count;
    d.in_use_eur = detail?.in_use_eur ?? 0;
    d.cover = detail?.cover ?? null;
    d.favorite = Boolean(d.favorite);
    // Colour identity (WUBRG order, '' = colourless): the commanders', else the cards' (deckStats).
    d.colors = detail?.stats?.colours?.identity ?? "";
  }
  return decks;
}

/** Scryfall art crop URL from a card image URL (cards.scryfall.io/<size>/...), else null. */
export function artCropUrl(url) {
  if (typeof url !== "string") return null;
  const m = /^(https:[/][/]cards[.]scryfall[.]io[/])(small|normal|large|png|border_crop)([/].+)$/.exec(url);
  return m ? `${m[1]}art_crop${m[3].replace(/[.]png([?]|$)/, ".jpg$1")}` : null;
}

/**
 * The deck's cover card: the first commander row with an image, else the most expensive
 * non-basic commander/main/side card by EUR (eurOfPrinting, never USD; ties by name).
 * {scryfall_id, name, image_small, image_normal, image_art, source commander|top} or null.
 */
export function deckCover(cards) {
  const usable = cards.filter((c) => c.scryfall_id && (c.image_small || c.image_normal));
  let pick = usable.find((c) => c.board === "commander");
  let source = "commander";
  if (!pick) {
    source = "top";
    let best = null;
    for (const c of usable) {
      if (!CLAIM_BOARDS.includes(c.board) || isBasicLand(c.name)) continue;
      const eur = eurOfPrinting(c.prices) ?? -1;
      if (!best || eur > best.eur || (eur === best.eur && c.name.localeCompare(best.c.name) < 0)) best = { c, eur };
    }
    pick = best?.c;
  }
  if (!pick) return null;
  return {
    scryfall_id: pick.scryfall_id, name: pick.card_name ?? pick.name, image_small: pick.image_small ?? null,
    image_normal: pick.image_normal ?? null, image_art: artCropUrl(pick.image_normal ?? pick.image_small), source,
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
/**
 * EUR price of a printing for one finish exactly (eur / eur_foil / eur_etched), or null. Never USD.
 * A foreign printing without its own price uses its English twin's (db.js eurOf).
 */
export function eurForFinish(prices, finish = "normal") {
  return eurOf(parsePrices(prices), finish === "foil" ? "eur_foil" : finish === "etched" ? "eur_etched" : "eur");
}

/** EUR price of a printing to buy: nonfoil eur, else (foil/etched-only printings) the foil/etched eur (English twin fallback). Never USD. */
export function eurOfPrinting(prices) {
  const p = parsePrices(prices);
  return eurOf(p, "eur") ?? eurOf(p, "eur_foil") ?? eurOf(p, "eur_etched");
}

/** Canonical stored format: trimmed + lowercase ("Commander " -> "commander"), null when empty. */
export function normalizeFormat(format) {
  return typeof format === "string" && format.trim() ? format.trim().toLowerCase().slice(0, 50) : null;
}
const isCommanderFormat = (deck) => normalizeFormat(deck?.format) === "commander";

/**
 * Deck with per-card ownership (counted across all printings of the card) and
 * its EUR value. Owned copies are valued at the price of the owned printing and
 * finish (else the deck printing's EUR price), missing copies at the deck
 * printing's EUR price; USD is never mixed in (cards without any EUR price are
 * counted in value.no_eur_price instead).
 *
 * Allocation (see the header): per card {owned, available_for_this,
 * used_elsewhere:[{deck_id, name, status, quantity}], conflict, to_buy, in_use,
 * missing (= to_buy since v0.3.1; before, copies in use elsewhere counted too)}.
 * Owned copies are shared across the card's rows in board order. Deck level
 * (maybe board excluded from every count): status, conflicts (built deck only:
 * cards whose built demand exceeds what is owned while another built deck also
 * claims them), conflict_count, to_buy_count (= missing_count), in_use_count,
 * missing_cost_eur (= value.to_buy_eur), in_use_eur (buying those instead, at
 * the deck printing's EUR) and shopping {items:[{name, oracle_id, need,
 * price_eur, cost_eur}], total_eur, in_use:[{name, oracle_id, quantity,
 * decks:[{id, name}], conflict, price_eur, cost_eur}], in_use_eur}.
 * In-use copies are valued as owned (value.owned_eur); value.in_use_eur = in_use_eur.
 * Locked binders (see the header): per card in_boxes = in_locked [{binder, deck_id, deck_name, quantity}] (locked binders
 * holding it) and in_use_box = in_use_locked (the part of in_use lying there); deck in_use_box_count (= in_use_locked_count), shopping
 * in_use items add boxes [{binder, deck_id, deck_name}] and in_box; box {binder, via} = the box this deck owns.
 * opts.alloc: a precomputed allocation(db).
 *
 * Power (opts.power, default true; see deckPower): stats (all decks), power
 * {commander, bracket, score, legality} (null parts for non-commander decks)
 * and combos (the cached Spellbook view, null for non-commander decks). The
 * non-enumerable `spellbook_request` is what a background fetch would send.
 * opts.spellbook: precomputed spellbookSettings(db).
 *
 * Tokens & extras (opts.accessories, default true; lib/accessories.js): `accessories`
 * {status, tokens, markers, ...}; its non-enumerable fetch_ids = card/token rows to fetch.
 */
export function deckDetail(db, deckId, { alloc = null, spellbook = null, power = true, accessories = true } = {}) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(deckId);
  if (!deck) return null;
  alloc ??= allocation(db);
  const built = deck.status === "built";
  const cards = db.prepare(
    `SELECT dc.board, dc.name, dc.quantity, dc.scryfall_id, dc.companion, c.name AS card_name, c.oracle_id, c.type_line, c.mana_cost, c.cmc,
            c.colors, c.color_identity, c.rarity, c.set_code, c.collector_number, c.prices, c.image_small, c.image_normal,
            c.oracle_text, c.keywords, c.legalities, c.game_changer, c.produced_mana, c.layout, c.fetched_at, c.all_parts
       FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE dc.deck_id = ?
      ORDER BY CASE dc.board WHEN 'commander' THEN 0 WHEN 'main' THEN 1 WHEN 'side' THEN 2 ELSE 3 END, c.cmc, dc.name`,
  ).all(deckId);
  // Every owned copy of the card (all printings), with its finish price; and where the owned copies
  // lie: copies per binder ('' = Unsorted), most first. By oracle id (indexed), else (unresolved rows)
  // by name: one OR'ed WHERE made SQLite scan the whole collection per card.
  const byOracleOrName = (select, tail) => {
    const oracle = db.prepare(`${select} WHERE c.oracle_id = ? ${tail}`);
    const named = db.prepare(`${select} WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE ${tail}`);
    return { all: (oracleId, name) => (oracleId != null ? oracle.all(oracleId) : named.all(name, name)) };
  };
  const ownedRowsStmt = byOracleOrName(
    "SELECT col.quantity, col.finish, c.prices FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id",
    "ORDER BY col.id",
  );
  const bindersStmt = byOracleOrName(
    "SELECT col.binder, SUM(col.quantity) AS quantity FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id",
    "GROUP BY col.binder COLLATE NOCASE ORDER BY quantity DESC, col.binder COLLATE NOCASE",
  );
  const bindersOf = new Map();
  // This deck's claim per card (commander+main+side), for the conflict check.
  const ownDemand = new Map();
  for (const card of cards) {
    if (!CLAIM_BOARDS.includes(card.board)) continue;
    const key = cardKey(card.oracle_id, card.name);
    ownDemand.set(key, (ownDemand.get(key) ?? 0) + card.quantity);
  }
  let missingCount = 0;
  let inUseCount = 0;
  let inUseBoxCount = 0;
  const inUseBoxed = new Map(); // key -> in_use copies attributed to locked binders so far
  const inUse = new Map();
  const neededByOracle = new Map();
  const ownedCopies = new Map(); // key -> [{eur|null}] expanded per copy (capped)
  const conflicts = new Map();
  const shopping = new Map();
  const value = { total_eur: 0, owned_eur: 0, to_buy_eur: 0, in_use_eur: 0, maybe_eur: 0, no_eur_price: 0 };
  for (const card of cards) {
    const basic = isBasicLand(card.name);
    const key = cardKey(card.oracle_id, card.name);
    if (!ownedCopies.has(key)) {
      const copies = [];
      for (const r of ownedRowsStmt.all(card.oracle_id, card.name)) {
        const eur = eurForFinish(r.prices, r.finish);
        for (let i = 0; i < r.quantity && copies.length < 10000; i++) copies.push(eur);
      }
      ownedCopies.set(key, copies);
    }
    const copies = ownedCopies.get(key);
    const owned = alloc.ownedOf(key, card.name);
    const claims = alloc.built.get(key);
    const reserved = alloc.reserve(key, card.name, deck.id);
    const usedElsewhere = reserved.decks;
    const elsewhere = usedElsewhere.reduce((a, d) => a + d.quantity, 0);
    const boxedElsewhere = reserved.elsewhere - elsewhere;
    const availableForThis = owned - reserved.elsewhere;
    // The same card can sit in several boards; free copies are shared between them.
    const alreadyUsed = neededByOracle.get(key) ?? 0;
    neededByOracle.set(key, alreadyUsed + card.quantity);
    card.owned = owned;
    card.basic = basic;
    card.available_for_this = availableForThis;
    card.used_elsewhere = usedElsewhere;
    card.in_boxes = basic ? [] : reserved.boxes;
    card.in_locked = card.in_boxes;
    if (!bindersOf.has(key)) {
      bindersOf.set(key, bindersStmt.all(card.oracle_id, card.name)
        .map((r) => ({ binder: r.binder, quantity: r.quantity })));
    }
    card.binders = bindersOf.get(key);
    const ownedLeft = Math.max(0, owned - alreadyUsed);
    const freeLeft = basic ? ownedLeft : Math.max(0, Math.max(0, availableForThis) - alreadyUsed);
    card.to_buy = basic ? 0 : Math.max(0, card.quantity - ownedLeft);
    card.in_use = basic ? 0 : Math.min(card.quantity, ownedLeft) - Math.min(card.quantity, freeLeft);
    // The part of in_use that lies in locked binders (counted first: those copies are physically boxed).
    const boxUsed = inUseBoxed.get(key) ?? 0;
    card.in_use_box = basic ? 0 : Math.min(card.in_use, Math.max(0, boxedElsewhere - boxUsed));
    card.in_use_locked = card.in_use_box;
    inUseBoxed.set(key, boxUsed + card.in_use_box);
    card.missing = card.to_buy;
    const demand = elsewhere + (built ? ownDemand.get(key) ?? 0 : 0);
    card.conflict = built && !basic && CLAIM_BOARDS.includes(card.board) && usedElsewhere.length > 0 && demand > owned;
    if (card.conflict && !conflicts.has(key)) {
      conflicts.set(key, { name: card.name, oracle_id: card.oracle_id, owned, demand, decks: claims.decks });
    }
    const price = card.prices ? cardPrice(card) : null;
    card.price = price;
    const unitEur = eurOfPrinting(card.prices);
    if (card.missing && card.board !== "maybe") {
      missingCount += card.missing;
      const item = shopping.get(key) ?? { name: card.name, oracle_id: card.oracle_id, need: 0, price_eur: unitEur, cost_eur: null };
      item.need += card.missing;
      if (item.price_eur == null) item.price_eur = unitEur;
      shopping.set(key, item);
    }
    if (card.in_use && card.board !== "maybe") {
      inUseCount += card.in_use;
      inUseBoxCount += card.in_use_box;
      const item = inUse.get(key) ?? { name: card.name, oracle_id: card.oracle_id, quantity: 0,
        decks: usedElsewhere.map((d) => ({ id: d.deck_id, name: d.name })),
        boxes: card.in_boxes.map((b) => ({ binder: b.binder, deck_id: b.deck_id, deck_name: b.deck_name })),
        in_box: 0, conflict: false, price_eur: unitEur, cost_eur: null };
      item.quantity += card.in_use;
      item.in_box += card.in_use_box;
      item.conflict ||= card.conflict;
      if (item.price_eur == null) item.price_eur = unitEur;
      // Same per-row pricing as value.in_use_eur, so header and in-use list agree.
      if (unitEur != null) item.cost_eur = (item.cost_eur ?? 0) + unitEur * card.in_use;
      inUse.set(key, item);
    }

    // Value: owned copies at their own finish price, the rest at the deck printing's EUR price.
    const ownedUsed = card.quantity - card.missing;
    let ownedVal = 0, buyVal = 0, noPrice = 0;
    for (let i = 0; i < ownedUsed; i++) {
      const eur = copies[alreadyUsed + i] ?? unitEur;
      if (eur == null) noPrice++; else ownedVal += eur;
    }
    if (unitEur == null) noPrice += card.missing; else buyVal += unitEur * card.missing;
    card.eur = unitEur;
    card.value_eur = noPrice === card.quantity ? null : round2(ownedVal + buyVal);
    if (card.board === "maybe") {
      value.maybe_eur += ownedVal + buyVal;
    } else {
      value.owned_eur += ownedVal;
      value.to_buy_eur += buyVal;
      if (unitEur != null) value.in_use_eur += unitEur * card.in_use;
      value.no_eur_price += noPrice;
    }
  }
  value.owned_eur = round2(value.owned_eur);
  value.to_buy_eur = round2(value.to_buy_eur);
  value.in_use_eur = round2(value.in_use_eur);
  value.maybe_eur = round2(value.maybe_eur);
  value.total_eur = round2(value.owned_eur + value.to_buy_eur);
  const items = [...shopping.values()];
  for (const it of items) it.cost_eur = it.price_eur == null ? null : round2(it.price_eur * it.need);
  items.sort((a, b) => (b.cost_eur ?? -1) - (a.cost_eur ?? -1) || a.name.localeCompare(b.name));
  const inUseItems = [...inUse.values()];
  for (const it of inUseItems) it.cost_eur = it.cost_eur == null ? null : round2(it.cost_eur);
  inUseItems.sort((a, b) => (b.cost_eur ?? -1) - (a.cost_eur ?? -1) || a.name.localeCompare(b.name));
  const count = (board) => cards.filter((c) => c.board === board).reduce((a, c) => a + c.quantity, 0);
  const detail = {
    ...deck,
    cards,
    counts: Object.fromEntries(BOARDS.map((b) => [b, count(b)])),
    missing_count: missingCount,
    to_buy_count: missingCount,
    in_use_count: inUseCount,
    in_use_box_count: inUseBoxCount,
    in_use_locked_count: inUseBoxCount,
    box: deckBoxInfo(alloc, deck),
    missing_cost_eur: value.to_buy_eur,
    in_use_eur: value.in_use_eur,
    value,
    conflicts: [...conflicts.values()],
    conflict_count: conflicts.size,
    shopping: {
      items, total_eur: round2(items.reduce((a, it) => a + (it.cost_eur ?? 0), 0)),
      in_use: inUseItems, in_use_eur: value.in_use_eur,
    },
  };
  if (isCommanderFormat(deck) && detail.counts.commander === 0) detail.commander_suggestions = commanderSuggestions(db, deckId);
  detail.cover = deckCover(cards);
  if (accessories) detail.accessories = accessoriesForRows(db, cards);
  for (const c of cards) delete c.all_parts;
  if (power) {
    const p = deckPower(db, deck, cards, { settings: spellbook });
    Object.assign(detail, { stats: p.stats, power: p.power, combos: p.combos });
    // Not in the JSON: what the server's Spellbook scheduler would fetch for this deck.
    Object.defineProperty(detail, "spellbook_request", { value: p.request, enumerable: false });
  }
  return detail;
}

/** The locked binder (deck box) this deck owns (lib/deckboxes.js): {binder, via link|manabox|name} or null. */
function deckBoxInfo(alloc, deck) {
  const id = Number(deck.id);
  let best = null;
  for (const b of alloc.boxes.values()) {
    const o = b.owners.find((x) => x.id === id);
    if (o && (!best || (best.via !== "link" && o.via === "link"))) best = { binder: b.name, via: o.via };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Power: stats, bracket, score and the cached Spellbook combos (v0.7.0)

const POWER_MEMO_MAX = 300;
const powerMemo = new Map(); // hash of everything deckPower reads -> {stats, power}

/**
 * Full `A // B` names for rows without a card row that are typed as a front
 * face, from the local cards table only (same rule as spellbook.js
 * deckPayloadRows, so a deck's request key is the same either way).
 */
function addFullNames(db, rows) {
  let stmt = null;
  for (const r of rows) {
    if (r.card_name || r.full_name || String(r.name).includes(" // ")) continue;
    stmt ??= db.prepare("SELECT name FROM cards WHERE name LIKE ? ESCAPE '\\' ORDER BY fetched_at DESC LIMIT 1");
    const hit = stmt.get(String(r.name).replace(/[\\%_]/g, (m) => "\\" + m) + " // %");
    if (hit) r.full_name = hit.name;
  }
}

const memoKey = (deck, rows, view) => createHash("sha1").update(JSON.stringify([
  deck.id, deck.format, deck.bracket_declared ?? null, view?.status ?? null, view?.fetched_at ?? null,
  rows.map((r) => [r.board, r.name, r.quantity, r.scryfall_id, r.companion ? 1 : 0, r.fetched_at ?? null, r.game_changer ?? null, r.full_name ?? null]),
])).digest("base64");

/** The Spellbook request of a saved deck (null when it is not a commander deck): what the server's scheduler fetches. */
export function deckComboRequest(db, deckId) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(deckId));
  if (!deck) return null;
  const rows = db.prepare(
    `SELECT dc.board, dc.name, dc.quantity, dc.scryfall_id, dc.companion, c.name AS card_name
       FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id WHERE dc.deck_id = ?`,
  ).all(deck.id);
  addFullNames(db, rows);
  return isCommanderDeck(deck, rows) ? spellbookRequest(rows, { isCommander: true }) : null;
}

/**
 * The API shape of a cache view: {status, fetched_at, checked, tag,
 * items[{...combo, assembly_mv (mana to assemble it in this deck, or null), url}],
 * combos_total, unresolved[], truncated, needs_fetch, retry_at, error}.
 */
function comboView(view, request, rows) {
  const result = view?.result ?? null;
  return {
    status: view?.status ?? "pending",
    fetched_at: view?.fetched_at ?? null,
    checked: (view?.status === "ok" || view?.status === "stale") && result != null,
    tag: result?.tag ?? null,
    items: withAssemblyMv(result?.combos, rows).map((c) => ({ ...c, url: comboUrl(c.id) })),
    combos_total: result?.combos_total ?? 0,
    unresolved: result?.unresolved ?? [],
    truncated: Boolean(request?.truncated),
    needs_fetch: Boolean(view?.needs_fetch),
    retry_at: view?.retry_at ?? null,
    error: view?.error ?? null,
  };
}

/**
 * Stats for every deck; bracket, score and legality for commander decks
 * (lib/power.js), from the deck row and its card rows (deckDetail's columns).
 * The combos are only READ: opts.combos (a cache view or a fresh refresh
 * result) or else cachedCombos() with opts.settings. Returns {stats, power:
 * {commander, bracket, score, legality}, combos (null for non-commander
 * decks), request (the Spellbook request or null)}. Memoised per saved deck.
 */
export function deckPower(db, deck, rows, { settings = null, combos = undefined } = {}) {
  addFullNames(db, rows);
  const commander = isCommanderDeck(deck, rows);
  const request = commander ? spellbookRequest(rows, { isCommander: true }) : null;
  let view = null;
  if (commander) {
    if (combos !== undefined) view = combos;
    else if (request) view = cachedCombos(db, request.key, { settings: settings ?? spellbookSettings(db) });
    else view = { status: "pending", fetched_at: null, result: null };
  }
  const key = deck.id != null ? memoKey(deck, rows, view) : null;
  let hit = key ? powerMemo.get(key) : null;
  if (!hit) {
    const stats = deckStats(rows);
    const p = powerOf(deck, rows, { combos: view, stats });
    hit = { stats, power: { commander: p.commander, bracket: p.bracket, score: p.score, legality: p.legality } };
    if (key) {
      if (powerMemo.size >= POWER_MEMO_MAX) powerMemo.delete(powerMemo.keys().next().value);
      powerMemo.set(key, hit);
    }
  }
  return { stats: hit.stats, power: hit.power, combos: commander ? comboView(view, request, rows) : null, request };
}

/**
 * A decklist checked without saving it (evaluate_deck, POST /api/decks/evaluate):
 * parse (or take items), put `commander` (one name or a list) on the commander
 * board, resolve names like saveDeck (card rows are upserted, no deck row is
 * written) and build the card rows deckPower needs. Returns {deck, rows,
 * unresolved, parse_errors, commander (is a commander deck), request}.
 */
export async function draftDeck(db, { text = null, items = null, format = null, commander = null, name = "Draft" } = {}) {
  const parsed = Array.isArray(items) ? { items, errors: [] } : parseDecklist(text ?? "");
  const list = parsed.items.map((i) => ({ ...i }));
  const wanted = (Array.isArray(commander) ? commander : commander ? [commander] : []).map((s) => String(s).trim()).filter(Boolean);
  for (const want of wanted) {
    const lower = want.toLowerCase();
    if (list.some((i) => i.board === "commander" && i.name.toLowerCase() === lower)) continue;
    const from = list.find((i) => i.board === "main" && i.name.toLowerCase() === lower && i.quantity > 0)
      ?? list.find((i) => i.board === "side" && i.name.toLowerCase() === lower && i.quantity > 0);
    if (from) from.quantity -= 1;
    list.push({ name: from?.name ?? want, quantity: 1, board: "commander", set: from?.set, collector_number: from?.collector_number });
  }
  const { rows: resolved, unresolved } = await resolveDeckItems(db, list.filter((i) => i.quantity > 0));
  // One row per (board, name), like deck_cards.
  const merged = new Map();
  for (const r of resolved) {
    const k = `${r.board}|${r.name.toLowerCase()}`;
    const e = merged.get(k);
    if (e) { e.quantity += r.quantity; e.companion ||= Boolean(r.companion); } else merged.set(k, { ...r, companion: Boolean(r.companion) });
  }
  const card = db.prepare(
    `SELECT name AS card_name, oracle_id, type_line, mana_cost, cmc, colors, color_identity, rarity, set_code, collector_number, prices,
            oracle_text, keywords, legalities, game_changer, produced_mana, layout, fetched_at, all_parts
       FROM cards WHERE scryfall_id = ?`,
  );
  const rows = [...merged.values()].map((r) => ({
    board: r.board, name: r.name, quantity: r.quantity, scryfall_id: r.scryfall_id, companion: r.companion && r.board === "side" ? 1 : 0,
    ...(r.scryfall_id ? card.get(r.scryfall_id) ?? {} : {}),
  }));
  const deck = { id: null, name, format: normalizeFormat(format), bracket_declared: null, status: "idea", source: "draft" };
  addFullNames(db, rows);
  const isCommander = isCommanderDeck(deck, rows);
  return { deck, rows, unresolved, parse_errors: parsed.errors, commander: isCommander, request: isCommander ? spellbookRequest(rows, { isCommander }) : null };
}

const num = (v) => String(Math.round(v * 100) / 100);
const SCORE_WORDS = { speed: "speed", fast_mana: "fast mana", tutors: "tutors", combos: "combos", interaction: "interaction", draw: "draw", ramp: "ramp", mana_base: "mana base" };
const SPELLBOOK_TAG_LABELS = { R: "Ruthless", S: "Spicy", P: "Powerful", O: "Oddball", C: "Core", E: "Exhibition", B: "Banned" };
const SPELLBOOK_TAG_BRACKET = { R: 4, S: 3, P: 3, O: 2, C: 2, E: 1 };

/** "combos checked 2026-10-15" / "combos from <date>" / "combos not checked (offline)". */
function combosNote(combos) {
  const day = String(combos?.fetched_at || "").slice(0, 10);
  if (combos?.status === "ok") return `combos checked ${day}`;
  if (combos?.status === "stale") return `combos from ${day}`;
  const why = combos?.status === "disabled" ? "combo check is off" : combos?.status === "offline" ? "offline" : "pending";
  return `combos not checked (${why})`;
}

/** The `Score x/10: speed 0.6/1 · ...` line of a score (null without one). */
export function scoreText(score) {
  if (!score) return null;
  const parts = score.breakdown.map((b) => `${SCORE_WORDS[b.key] ?? b.key} ${num(b.points)}/${num(b.max)}`);
  return `Score ${score.partial ? "≥" : ""}${score.value.toFixed(1)}/10: ${parts.join(" · ")}${score.note ? ` (${score.note})` : ""}`;
}

/**
 * Text lines for Claude: Stats, then (commander decks) Bracket with its
 * reasons and info, Score with its breakdown and, when not legal, a
 * `Not Commander-legal:` line. Input: {stats, power, combos} (deckDetail or deckPower).
 */
export function powerLines({ stats, power, combos } = {}) {
  const lines = [];
  if (stats) {
    const curve = stats.curve.buckets.map((b, i) => `${b}:${stats.curve.creature[i] + stats.curve.other[i]}`).join(" ");
    const per = stats.colours.per;
    const colours = per.length ? ` · pips ${per.map((c) => `${c.c}${num(c.pips)}`).join(" ")} / sources ${per.map((c) => `${c.c}${num(c.sources)}`).join(" ")}` : "";
    const warn = per.filter((c) => c.warn).map((c) => c.c);
    lines.push(`Stats: ${stats.total} cards · lands ${stats.lands}${stats.mdfc_lands ? ` (+${stats.mdfc_lands} MDFC)` : ""} · avg MV ${stats.avg_mv ?? "?"} · curve ${curve}${colours}` +
      `${warn.length ? ` (few sources for ${warn.join(", ")})` : ""}` +
      `${stats.x_spells.count ? ` · ${stats.x_spells.count} X spells` : ""}${stats.companion ? ` · companion ${stats.companion.name}` : ""}` +
      `${stats.unknown.count ? ` · ${stats.unknown.count} unknown (${stats.unknown.names.slice(0, 5).join(", ")}${stats.unknown.names.length > 5 ? ", ..." : ""})` : ""}`);
  }
  const b = power?.bracket;
  if (b) {
    const how = b.declared != null ? `set by the user; rules: ${b.partial ? "≥" : ""}${b.auto}` : "auto";
    // Legality has its own line; "combos not checked" is already in the parenthesis.
    const reasons = b.reasons.filter((r) => r.rule !== "legality" && !(r.rule === "partial" && /^combos not checked/.test(r.text))).map((r) => r.text);
    const info = [...b.info];
    const tag = combos?.tag ?? b.spellbook?.tag ?? null;
    if (tag && SPELLBOOK_TAG_LABELS[tag] && !info.some((i) => i.startsWith("Commander Spellbook "))) {
      info.push(`Spellbook: ${SPELLBOOK_TAG_LABELS[tag]}${SPELLBOOK_TAG_BRACKET[tag] ? ` (≈${SPELLBOOK_TAG_BRACKET[tag]})` : ""}`);
    }
    lines.push(`Bracket: ${b.display} ${b.label} (${how}; ${combosNote(combos ?? b.spellbook)}) - ${reasons.join("; ")}${info.length ? ` · ${info.join(" · ")}` : ""}`);
  }
  const s = scoreText(power?.score);
  if (s) lines.push(s);
  if (power?.legality && !power.legality.ok) {
    lines.push(`Not Commander-legal: ${power.legality.problems.map((p) => p.text).join("; ")}`);
  }
  return lines;
}

/**
 * Verdict of a commander deck's power against a target bracket (1-5):
 * `Target bracket N: OK`, `... OVER - <floor reasons with cards>` or
 * `... UNDER - <weakest categories>`. Uses the rules (auto), not a declared
 * bracket (except target 5: a deck the user set to 5 fits it); while combos
 * are unchecked it says the result may still go up.
 */
export function bracketVerdict(power, target) {
  const t = Number(target);
  if (!Number.isInteger(t) || t < 1 || t > 5) return null;
  const head = `Target bracket ${t}`;
  const b = power?.bracket;
  if (!b) return `${head}: not a Commander deck (brackets only apply to Commander)`;
  const maybe = b.partial ? " (combos not checked yet: it may still go up)" : "";
  const floors = b.reasons.filter((r) => typeof r.floor === "number" && r.floor > Math.max(2, t));
  if (floors.length) return `${head}: OVER - ${floors.map((r) => r.text).join("; ")}`;
  const weakest = () => {
    const list = [...(power.score?.breakdown ?? [])].sort((x, y) => x.points / x.max - y.points / y.max).slice(0, 3);
    return list.map((x) => `${SCORE_WORDS[x.key] ?? x.key} ${num(x.points)}/${num(x.max)} (${x.words})`).join(", ");
  };
  if (t === 5) {
    if (b.declared === 5) return `${head}: OK (the user set Bracket 5)${b.cedh_like ? "; looks cEDH-like" : ""}`;
    const h = CEDH_HINT;
    return b.cedh_like ?? b.cedh_hint ? `${head}: OK (looks cEDH-like; Bracket 5 is the user's call)${maybe}`
      : `${head}: UNDER - not cEDH-like (needs Bracket 4 by the rules, ≥${h.fast_mana} fast mana, ≥${h.tutors} tutors or ≥${h.cheap_tutors} at ≤${h.cheap_tutor_cmc} mana, a combo assembled for ≤${h.combo_mv} mana, avg MV ≤ ${h.avg_mv}); weakest: ${weakest()}${maybe}`;
  }
  if (t <= b.auto) return `${head}: OK${t === 1 ? " (no rule pushes it above 2; Bracket 1 is about intent)" : ""}${maybe}`;
  // Below the target by the rules: still fine when the score already fits the target's band.
  const band = SCORE_BANDS[t];
  const score = power.score?.value ?? null;
  if (score != null && band && score >= band[0]) return `${head}: OK (no rule needs Bracket ${t}, but score ${score.toFixed(1)} fits it)${maybe}`;
  return `${head}: UNDER - the rules give ${b.auto} ${BRACKET_RULES.brackets[b.auto]?.label ?? ""}, score ${score?.toFixed(1) ?? "?"}; weakest: ${weakest()}${maybe}`;
}

/**
 * Everything the built decks are short of, plus each deck's to-buy and in-use counts:
 * {built: {items:[{name, oracle_id, short, decks:[{deck_id, name, status, quantity}], price_eur, cost_eur}],
 * total_eur}, per_deck:[{id, name, status, missing_count (= to_buy_count), missing_eur (to-buy cost),
 * to_buy_count, in_use_count, in_use_eur}]}.
 * price_eur is the cheapest EUR price among the printings the decks list.
 */
export function shoppingList(db) {
  const alloc = allocation(db);
  const priceStmt = db.prepare(
    `SELECT c.prices FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE d.status = 'built' AND dc.board IN ('commander', 'main', 'side')
        AND (c.oracle_id = ? OR (? IS NULL AND dc.name = ? COLLATE NOCASE))`,
  );
  const items = [];
  for (const [key, e] of alloc.built) {
    if (isBasicLand(e.name)) continue;
    const short = e.demand - alloc.ownedOf(key, e.name);
    if (short <= 0) continue;
    const prices = priceStmt.all(e.oracle_id, e.oracle_id, e.name).map((r) => eurOfPrinting(r.prices)).filter((v) => v != null);
    const price = prices.length ? Math.min(...prices) : null;
    items.push({ name: e.name, oracle_id: e.oracle_id, short, decks: e.decks, price_eur: price, cost_eur: price == null ? null : round2(price * short) });
  }
  items.sort((a, b) => (b.cost_eur ?? -1) - (a.cost_eur ?? -1) || a.name.localeCompare(b.name));
  const perDeck = db.prepare("SELECT id FROM decks ORDER BY CASE status WHEN 'built' THEN 0 ELSE 1 END, name COLLATE NOCASE, id").all()
    .map(({ id }) => {
      const d = deckDetail(db, id, { alloc, power: false, accessories: false });
      return {
        id: d.id, name: d.name, status: d.status, missing_count: d.missing_count, missing_eur: d.missing_cost_eur,
        to_buy_count: d.to_buy_count, in_use_count: d.in_use_count, in_use_eur: d.in_use_eur,
      };
    });
  return { built: { items, total_eur: round2(items.reduce((a, it) => a + (it.cost_eur ?? 0), 0)) }, per_deck: perDeck };
}

const CAN_BE_COMMANDER = /can be your commander/i;

/** Cards in the deck that could lead it: legendary creatures and "can be your commander" cards. */
export function commanderSuggestions(db, deckId) {
  const rows = db.prepare(
    `SELECT dc.name, dc.board, dc.scryfall_id, c.type_line, c.oracle_text, c.color_identity, c.image_small, c.image_normal
       FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE dc.deck_id = ? AND dc.board <> 'commander'
      ORDER BY CASE dc.board WHEN 'main' THEN 0 WHEN 'side' THEN 1 ELSE 2 END, dc.name`,
  ).all(deckId);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const front = String(r.type_line || "").split(" // ")[0];
    const ok = (/\bLegendary\b/.test(front) && /\bCreature\b/.test(front)) || CAN_BE_COMMANDER.test(r.oracle_text || "");
    if (!ok || seen.has(r.name.toLowerCase())) continue;
    seen.add(r.name.toLowerCase());
    out.push({
      name: r.name, board: r.board, scryfall_id: r.scryfall_id, type_line: r.type_line, color_identity: r.color_identity,
      image_small: r.image_small, image_normal: r.image_normal,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editing boards

/** Deck edit error with an HTTP status for the API layer. */
export class DeckError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireDeck(db, deckId) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(deckId));
  if (!deck) throw new DeckError(404, "Deck not found");
  return deck;
}

const touch = (db, deckId) => db.prepare("UPDATE decks SET updated_at = datetime('now') WHERE id = ?").run(deckId);

/** Add `quantity` copies of a card row to a board (merging into an existing row of that name). */
function addToBoard(db, deckId, board, row, quantity) {
  const existing = db.prepare("SELECT name, scryfall_id FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ? COLLATE NOCASE")
    .get(deckId, board, row.name);
  if (existing) {
    db.prepare("UPDATE deck_cards SET quantity = quantity + ?, scryfall_id = COALESCE(scryfall_id, ?) WHERE deck_id = ? AND board = ? AND name = ?")
      .run(quantity, row.scryfall_id, deckId, board, existing.name);
  } else {
    db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, ?, ?, ?, ?)")
      .run(deckId, board, row.name, row.scryfall_id, quantity);
  }
}

/** Take `quantity` copies off a board row (removing the row when none are left). */
function takeFromBoard(db, deckId, row, quantity) {
  if (quantity >= row.quantity) db.prepare("DELETE FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ?").run(deckId, row.board, row.name);
  else db.prepare("UPDATE deck_cards SET quantity = quantity - ? WHERE deck_id = ? AND board = ? AND name = ?").run(quantity, deckId, row.board, row.name);
}

const validQuantity = (q, { min = 0 } = {}) => {
  const n = typeof q === "string" && /^\d+$/.test(q) ? Number(q) : q;
  if (!Number.isInteger(n) || n < min || n > 999) throw new DeckError(400, `quantity must be an integer ${min}-999`);
  return n;
};

/**
 * Change one card row of a deck: {name, board, to_board?, quantity?}.
 * Without to_board, quantity sets the row's copies (0 removes the row).
 * With to_board, `quantity` copies (default all) move there, merging into a
 * row of the same name. Recorded in the deck history (actor, default app).
 * Returns {deck_id, name, board, to_board, moved?, quantity?}.
 */
export function updateDeckCard(db, deckId, { name, board, to_board: toBoard, quantity, actor = "app" } = {}) {
  return transaction(db, () => {
    const deck = requireDeck(db, deckId);
    if (typeof name !== "string" || !name.trim()) throw new DeckError(400, "name is required");
    if (!BOARDS.includes(board)) throw new DeckError(400, `board must be one of ${BOARDS.join(", ")}`);
    if (toBoard != null && !BOARDS.includes(toBoard)) throw new DeckError(400, `to_board must be one of ${BOARDS.join(", ")}`);
    const row = db.prepare("SELECT * FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ? COLLATE NOCASE").get(deck.id, board, name.trim());
    if (!row) throw new DeckError(404, `"${name}" is not in the ${board} board`);
    let result;
    if (toBoard != null && toBoard !== board) {
      const n = quantity == null ? row.quantity : Math.min(row.quantity, validQuantity(quantity, { min: 1 }));
      takeFromBoard(db, deck.id, row, n);
      addToBoard(db, deck.id, toBoard, row, n);
      result = { deck_id: deck.id, name: row.name, board, to_board: toBoard, moved: n };
    } else {
      if (quantity == null) throw new DeckError(400, "quantity or to_board is required");
      const n = validQuantity(quantity);
      if (n === 0) db.prepare("DELETE FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ?").run(deck.id, board, row.name);
      else db.prepare("UPDATE deck_cards SET quantity = ? WHERE deck_id = ? AND board = ? AND name = ?").run(n, deck.id, board, row.name);
      result = { deck_id: deck.id, name: row.name, board, to_board: null, quantity: n };
    }
    touch(db, deck.id);
    recordDeckVersion(db, deck.id, { actor });
    return result;
  });
}

// Partner pairs: plain Partner / Friends forever on both sides, "Partner with X"
// naming each other, "Partner—V" with the same V, "Choose a Background" + a
// Background, or Doctor's companion + a Time Lord Doctor.
const norm = (x) => String(x || "").trim().toLowerCase();
/** Partner abilities from the oracle text (keywords only when there is no text). */
function partnerInfo(c) {
  const info = { generic: false, with: [], variants: [] };
  let lines = String(c?.oracle_text || "").split("\n");
  if (!c?.oracle_text) {
    let kw = [];
    try { kw = JSON.parse(c?.keywords || "[]"); } catch { /* ignore */ }
    // "Partner with" as a bare keyword names nobody we can check: never pairs.
    if (kw.some((k) => norm(k) === "partner with")) return info;
    lines = kw;
  }
  for (const raw of lines) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    const w = /^Partner with (.+)$/i.exec(line);
    if (w) { info.with.push(norm(w[1])); continue; }
    for (const part of line.split(",").map((p) => p.trim())) {
      const v = /^Partner\s*[—–-]\s*(.+)$/i.exec(part);
      if (v) info.variants.push(norm(v[1]));
      else if (/^Partner$/i.test(part)) info.generic = true;
    }
  }
  return info;
}
const nameMatches = (wanted, card) => {
  const n = norm(card?.name);
  return wanted === n || wanted === norm(n.split(" // ")[0]);
};
/** True when two commanders can lead one deck together (Partner, Partner with, Friends forever, Background, Doctor). */
export function canPair(a, b) {
  const pa = partnerInfo(a), pb = partnerInfo(b);
  if (pa.generic && pb.generic) return true;
  if (pa.with.some((w) => nameMatches(w, b)) && pb.with.some((w) => nameMatches(w, a))) return true;
  if (pa.variants.some((v) => pb.variants.includes(v))) return true;
  const ta = textOf(a), tb = textOf(b);
  if (/\bFriends forever\b/i.test(ta) && /\bFriends forever\b/i.test(tb)) return true;
  const bg = (x) => /\bBackground\b/.test(String(x?.type_line || ""));
  if ((/Choose a Background/i.test(ta) && bg(b)) || (/Choose a Background/i.test(tb) && bg(a))) return true;
  const doctor = (x) => /Time Lord Doctor/i.test(String(x?.type_line || ""));
  if ((/Doctor's companion/i.test(ta) && doctor(b)) || (/Doctor's companion/i.test(tb) && doctor(a))) return true;
  return false;
}

/**
 * Make `name` (a card already in the deck, any board) the commander: one copy
 * moves into the commander board. Format commander allows two commanders when
 * they can pair (partner, friends forever, background, doctor's companion);
 * otherwise the existing commander(s) move back to main. `replace` (a
 * commander's name) swaps out that one specifically. Recorded in the deck history.
 * Returns {deck_id, commanders: [names], replaced: [names]}.
 */
export function setCommander(db, deckId, { name, replace = null, actor = "app" } = {}) {
  return transaction(db, () => {
    const deck = requireDeck(db, deckId);
    if (typeof name !== "string" || !name.trim()) throw new DeckError(400, "name is required");
    const card = (n) => db.prepare(
      `SELECT dc.*, c.type_line, c.oracle_text, c.keywords FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
        WHERE dc.deck_id = ? AND dc.name = ? COLLATE NOCASE
        ORDER BY CASE dc.board WHEN 'commander' THEN 0 WHEN 'main' THEN 1 WHEN 'side' THEN 2 ELSE 3 END`,
    ).all(deck.id, n);
    const rows = card(name.trim());
    if (!rows.length) throw new DeckError(404, `"${name}" is not in this deck`);
    const commanders = () => db.prepare(
      `SELECT dc.*, c.type_line, c.oracle_text, c.keywords FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
        WHERE dc.deck_id = ? AND dc.board = 'commander' ORDER BY dc.name`,
    ).all(deck.id);
    const replaced = [];
    if (rows[0].board !== "commander") {
      const src = rows[0];
      let current = commanders();
      const demote = (c) => { takeFromBoard(db, deck.id, c, c.quantity); addToBoard(db, deck.id, "main", c, c.quantity); replaced.push(c.name); };
      if (replace != null) {
        const r = current.find((c) => c.name.toLowerCase() === String(replace).trim().toLowerCase());
        if (!r) throw new DeckError(404, `"${replace}" is not a commander of this deck`);
        demote(r);
        current = commanders();
      }
      const keep = isCommanderFormat(deck) && current.length === 1 && current[0].quantity === 1 && canPair(current[0], src);
      if (!keep) for (const c of current) demote(c);
      takeFromBoard(db, deck.id, src, 1);
      addToBoard(db, deck.id, "commander", src, 1);
      touch(db, deck.id);
      recordDeckVersion(db, deck.id, { actor });
    }
    return { deck_id: deck.id, commanders: commanders().map((c) => c.name), replaced };
  });
}

/** ManaBox/Moxfield-importable text export. */
export function exportDeck(detail) {
  const label = { commander: "Commander", main: "Deck", side: "Sideboard", maybe: "Maybeboard" };
  const out = [];
  // The companion comes first in its own section, so a re-import keeps the flag.
  const companions = detail.cards.filter((c) => c.companion);
  if (companions.length) {
    out.push("Companion");
    for (const c of companions) out.push(`${c.quantity} ${c.name}${c.set_code ? ` (${c.set_code.toUpperCase()}) ${c.collector_number}` : ""}`);
  }
  for (const board of BOARDS) {
    const cards = detail.cards.filter((c) => c.board === board && !c.companion);
    if (!cards.length) continue;
    if (out.length) out.push("");
    out.push(label[board]);
    for (const c of cards) out.push(`${c.quantity} ${c.name}${c.set_code ? ` (${c.set_code.toUpperCase()}) ${c.collector_number}` : ""}`);
  }
  return out.join("\n") + "\n";
}

/**
 * A buy list as text ("<copies> <name>" per line, sorted by name), for the "Export list" buttons:
 * a deck's To buy (shopping.items, key to_buy/need) and the built decks' shortage (built.items, key short).
 */
export function buyListText(items, qtyKey = "need") {
  const lines = (items || [])
    .map((it) => ({ name: it.name, n: Number(it[qtyKey] ?? it.need ?? it.quantity) || 0 }))
    .filter((x) => x.name && x.n > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((x) => `${x.n} ${x.name}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Compact text rendering for Claude. */
export function deckToText(detail) {
  const status = detail.status === "built" ? "BUILT (physical deck, claims its cards)" : "idea (plan, claims nothing)";
  const lines = [`Deck #${detail.id} "${detail.name}"${detail.format ? ` [${detail.format}]` : ""} (source: ${detail.source}, status: ${status})`];
  if (detail.description) lines.push(`Notes (Markdown, update_deck_notes changes them):\n${detail.description}`);
  if (detail.box?.binder) lines.push(`Deck box: ${detail.box.binder} (locked binder: its copies are free for this deck, locked for all others).`);
  const built = detail.status === "built";
  const inUseEur = `~€${(detail.in_use_eur ?? 0).toFixed(2)}`;
  // in_use splits into copies other built decks claim and copies lying in locked binders.
  const inBoxes = detail.in_use_box_count ?? 0;
  const inDecks = (detail.in_use_count ?? 0) - inBoxes;
  const boxNote = inBoxes ? ` In locked binders: ${inBoxes} cards (owned, locked for another deck or for all decks, can be moved over).` : "";
  const inUseNote = (!inDecks ? ""
    : built
      ? ` Shared with other built decks: ${inDecks} cards (CONFLICT: owned copies are needed by both built decks; buy extra ${inUseEur} to play all built decks at once).`
      : ` In other built decks: ${inDecks} cards (owned, can be moved over; buying them instead ${inUseEur}).`) + boxNote;
  lines.push(`Counts: ${BOARDS.map((b) => `${b} ${detail.counts[b]}`).join(", ")}. To buy (not owned at all): ${detail.missing_count} cards (~€${detail.missing_cost_eur.toFixed(2)}).${inUseNote}`);
  const v = detail.value;
  if (v) {
    lines.push(`Value: €${v.total_eur.toFixed(2)} (owned €${v.owned_eur.toFixed(2)}, to buy €${v.to_buy_eur.toFixed(2)}; maybeboard €${v.maybe_eur.toFixed(2)})`
      + (v.no_eur_price ? `; ${v.no_eur_price} cards have no EUR price.` : "."));
  }
  if (detail.stats) lines.push(...powerLines(detail));
  const extras = accessoriesText(detail.accessories);
  if (extras) lines.push(extras);
  if (detail.conflicts?.length) {
    lines.push(`Conflicts (${detail.conflict_count}, cards also claimed by another built deck): ` + detail.conflicts.map((c) =>
      `${c.name} owned ${c.owned}, needed ${c.demand} (${c.decks.map((d) => `#${d.deck_id} ${d.name} ${d.quantity}x`).join(", ")})`).join("; "));
  }
  if (detail.shopping?.items.length) {
    const top = detail.shopping.items.slice(0, 10).map((it) => `${it.need}x ${it.name}${it.price_eur != null ? ` €${it.price_eur.toFixed(2)}` : ""}`);
    lines.push(`Shopping list: ${detail.shopping.items.length} cards, €${detail.shopping.total_eur.toFixed(2)}: ${top.join(", ")}${detail.shopping.items.length > 10 ? ", ..." : ""}`);
  }
  if (detail.shopping?.in_use?.length) {
    const list = detail.shopping.in_use;
    const where = (it) => [...it.decks.map((d) => d.name), ...(it.boxes ?? []).map((b) => `locked binder ${b.binder}`)].join(", ");
    const top = list.slice(0, 10).map((it) => `${it.quantity}x ${it.name} (in ${where(it)})`);
    lines.push(`${built && inDecks ? `Shared with other built decks${inBoxes ? " or in locked binders" : ""} (both need them; buy extra to play both)` : built ? "Owned but in locked binders (move them over instead of buying)" : inBoxes ? "Owned but in other built decks or locked binders (move them over instead of buying)" : "Owned but in other built decks (move them over instead of buying)"}: ${top.join(", ")}${list.length > 10 ? ", ..." : ""}`);
  }
  if (detail.commander_suggestions?.length) {
    lines.push(`No commander set. Possible commanders in the deck: ${detail.commander_suggestions.map((c) => c.name).join(", ")}.`);
  }
  for (const board of BOARDS) {
    const cards = detail.cards.filter((c) => c.board === board);
    if (!cards.length) continue;
    lines.push(`\n## ${board}`);
    for (const c of cards) {
      const free = Math.max(0, c.available_for_this ?? c.owned);
      const elsewhere = (c.used_elsewhere ?? []).map((d) => d.name).join(", ");
      const boxes = (c.in_boxes ?? []).map((b) => b.binder).join(", ");
      const parts = [];
      if (c.basic) parts.push("basic");
      else {
        if (c.to_buy) parts.push(`TO BUY ${c.to_buy}`);
        const inBox = c.in_use_box ?? 0;
        const inDeck = c.in_use - inBox;
        if (inDeck > 0) {
          parts.push(c.conflict
            ? `SHARED ${inDeck} with ${elsewhere} (CONFLICT: both built decks need it; buy extra to play both)`
            : `IN USE ${inDeck} in other deck(s): ${elsewhere} (can be moved)`);
        }
        if (inBox > 0) parts.push(`IN USE ${inBox} in locked binder ${boxes} (can be moved)`);
        parts.push(`owned ${c.owned}${free !== c.owned ? `, free ${free}` : ""}`);
        if (c.used_elsewhere?.length && !c.in_use && !c.conflict) parts.push(`also in ${elsewhere}`);
        if (c.conflict && !c.in_use) parts.push(`CONFLICT (also in ${elsewhere})`);
      }
      const own = parts.join(", ");
      lines.push(`${c.quantity}x ${c.name} | ${c.mana_cost || ""} | ${c.type_line || "?"} | ${own} | ${formatPrice(c.price)}`);
    }
  }
  return lines.join("\n");
}
