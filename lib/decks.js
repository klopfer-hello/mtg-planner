// Decks: persistence (save, find, list), the deck detail the app shows
// (per-card ownership and allocation, value in EUR, shopping list, cover,
// tokens & extras, power) and the global shopping list.
//
// The pieces live in their own modules: lib/deckrules.js (boards, decklist
// parsing, pairing), lib/deckresolve.js (names → printings), lib/allocation.js
// (owned vs claimed copies), lib/deckpower.js (stats, bracket, score, combos),
// lib/deckedit.js (card edits, status, notes, commander) and lib/decktext.js
// (exports and Claude's deck text).

import { cardPrice, round2, transaction } from "./db.js";
import { spellbookSettings } from "./spellbook.js";
import { recordDeckVersion } from "./deckhistory.js";
import { accessoriesForRows } from "./accessories.js";
import { BOARD_ORDER_SQL, BOARDS, cardKey, CLAIM_BOARDS, DECK_STATUSES, DeckError, isBasicLand, isCommanderFormat, normalizeFormat } from "./deckrules.js";
import { resolveDeckItems } from "./deckresolve.js";
import { allocation, byOracleOrName } from "./allocation.js";
import { deckPower } from "./deckpower.js";
import { eurForFinish, eurOfPrinting } from "./prices.js";

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
 * to_buy_count, to_buy_eur (to-buy cost), in_use_count (in_use_locked_count of it in locked binders) and in_use_eur,
 * plus the power
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
    d.to_buy_count = detail?.to_buy_count ?? 0;
    d.to_buy_eur = detail?.to_buy_eur ?? 0;
    d.in_use_count = detail?.in_use_count ?? 0;
    d.in_use_locked_count = detail?.in_use_locked_count ?? 0;
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

/**
 * Deck with per-card ownership (counted across all printings of the card) and
 * its EUR value. Owned copies are valued at the price of the owned printing and
 * finish (else the deck printing's EUR price), missing copies at the deck
 * printing's EUR price; USD is never mixed in (cards without any EUR price are
 * counted in value.no_eur_price instead).
 *
 * Allocation (see the header): per card {owned, available_for_this,
 * used_elsewhere:[{deck_id, name, status, quantity}], conflict, to_buy, in_use}.
 * Owned copies are shared across the card's rows in board order. Deck level
 * (maybe board excluded from every count): status, conflicts (built deck only:
 * cards whose built demand exceeds what is owned while another built deck also
 * claims them), conflict_count, to_buy_count, in_use_count,
 * to_buy_eur (= value.to_buy_eur), in_use_eur (buying those instead, at
 * the deck printing's EUR) and shopping {items:[{name, oracle_id, need,
 * price_eur, cost_eur}], total_eur, in_use:[{name, oracle_id, quantity,
 * decks:[{id, name}], conflict, price_eur, cost_eur}], in_use_eur}.
 * In-use copies are valued as owned (value.owned_eur); value.in_use_eur = in_use_eur.
 * Locked binders (see the header): per card in_locked [{binder, deck_id, deck_name, quantity}] (locked binders
 * holding it) and in_use_locked (the part of in_use lying there); deck in_use_locked_count, shopping
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
      ORDER BY ${BOARD_ORDER_SQL}, c.cmc, dc.name`,
  ).all(deckId);
  // Every owned copy of the card (all printings), with its finish price; and where the owned copies
  // lie: copies per binder ('' = Unsorted), most first.
  const ownedRowsStmt = byOracleOrName(db,
    "SELECT col.quantity, col.finish, c.prices FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id",
    "ORDER BY col.id",
  );
  const bindersStmt = byOracleOrName(db,
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
  let toBuyCount = 0;
  let inUseCount = 0;
  let inUseLockedCount = 0;
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
    card.in_locked = basic ? [] : reserved.boxes;
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
    card.in_use_locked = basic ? 0 : Math.min(card.in_use, Math.max(0, boxedElsewhere - boxUsed));
    inUseBoxed.set(key, boxUsed + card.in_use_locked);
    const demand = elsewhere + (built ? ownDemand.get(key) ?? 0 : 0);
    card.conflict = built && !basic && CLAIM_BOARDS.includes(card.board) && usedElsewhere.length > 0 && demand > owned;
    if (card.conflict && !conflicts.has(key)) {
      conflicts.set(key, { name: card.name, oracle_id: card.oracle_id, owned, demand, decks: claims.decks });
    }
    const price = card.prices ? cardPrice(card) : null;
    card.price = price;
    const unitEur = eurOfPrinting(card.prices);
    if (card.to_buy && card.board !== "maybe") {
      toBuyCount += card.to_buy;
      const item = shopping.get(key) ?? { name: card.name, oracle_id: card.oracle_id, need: 0, price_eur: unitEur, cost_eur: null };
      item.need += card.to_buy;
      if (item.price_eur == null) item.price_eur = unitEur;
      shopping.set(key, item);
    }
    if (card.in_use && card.board !== "maybe") {
      inUseCount += card.in_use;
      inUseLockedCount += card.in_use_locked;
      const item = inUse.get(key) ?? { name: card.name, oracle_id: card.oracle_id, quantity: 0,
        decks: usedElsewhere.map((d) => ({ id: d.deck_id, name: d.name })),
        boxes: card.in_locked.map((b) => ({ binder: b.binder, deck_id: b.deck_id, deck_name: b.deck_name })),
        in_box: 0, conflict: false, price_eur: unitEur, cost_eur: null };
      item.quantity += card.in_use;
      item.in_box += card.in_use_locked;
      item.conflict ||= card.conflict;
      if (item.price_eur == null) item.price_eur = unitEur;
      // Same per-row pricing as value.in_use_eur, so header and in-use list agree.
      if (unitEur != null) item.cost_eur = (item.cost_eur ?? 0) + unitEur * card.in_use;
      inUse.set(key, item);
    }

    // Value: owned copies at their own finish price, the rest at the deck printing's EUR price.
    const ownedUsed = card.quantity - card.to_buy;
    let ownedVal = 0, buyVal = 0, noPrice = 0;
    for (let i = 0; i < ownedUsed; i++) {
      const eur = copies[alreadyUsed + i] ?? unitEur;
      if (eur == null) noPrice++; else ownedVal += eur;
    }
    if (unitEur == null) noPrice += card.to_buy; else buyVal += unitEur * card.to_buy;
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
    to_buy_count: toBuyCount,
    in_use_count: inUseCount,
    in_use_locked_count: inUseLockedCount,
    box: deckBoxInfo(alloc, deck),
    to_buy_eur: value.to_buy_eur,
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

/**
 * Everything the built decks are short of, plus each deck's to-buy and in-use counts:
 * {built: {items:[{name, oracle_id, short, decks:[{deck_id, name, status, quantity}], price_eur, cost_eur}],
 * total_eur}, per_deck:[{id, name, status, to_buy_count, to_buy_eur (to-buy cost), in_use_count, in_use_eur}]}.
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
        id: d.id, name: d.name, status: d.status, to_buy_count: d.to_buy_count, to_buy_eur: d.to_buy_eur,
        in_use_count: d.in_use_count, in_use_eur: d.in_use_eur,
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
      ORDER BY ${BOARD_ORDER_SQL}, dc.name`,
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
