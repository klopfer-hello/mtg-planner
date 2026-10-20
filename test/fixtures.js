// Shared test fixtures: throwaway SQLite databases, a small card pool shaped
// like Scryfall API objects, and a fake `fetch` that answers Scryfall's
// /cards/collection endpoint from that pool so nothing touches the network.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, upsertCards } from "../lib/db.js";
import { normalizeCard, setThrottle } from "../lib/scryfall.js";

/** Open a fresh DB in a temp dir; returns { db, file, cleanup }. */
export function tempDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-"));
  const file = path.join(dir, "test.db");
  const db = openDb(file);
  return {
    db,
    file,
    cleanup() {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const legal = (...formats) => Object.fromEntries(
  ["standard", "pioneer", "modern", "legacy", "vintage", "commander", "pauper"].map((f) => [f, formats.includes(f) ? "legal" : "not_legal"]),
);

/** Minimal Scryfall card objects (only the fields normalizeCard reads). */
export const SCRYFALL_CARDS = [
  {
    id: "00000000-0000-0000-0000-000000000001", oracle_id: "o-solring", name: "Sol Ring", set: "c21", set_name: "Commander 2021",
    collector_number: "263", lang: "en", rarity: "uncommon", type_line: "Artifact", mana_cost: "{1}", cmc: 1,
    colors: [], color_identity: [], oracle_text: "{T}: Add {C}{C}.", keywords: [],
    legalities: legal("commander", "vintage"), prices: { eur: "1.50", usd: "1.20", eur_foil: null },
  },
  {
    id: "00000000-0000-0000-0000-000000000002", oracle_id: "o-bolt", name: "Lightning Bolt", set: "m10", set_name: "Magic 2010",
    collector_number: "146", lang: "en", rarity: "common", type_line: "Instant", mana_cost: "{R}", cmc: 1,
    colors: ["R"], color_identity: ["R"], oracle_text: "Lightning Bolt deals 3 damage to any target.", keywords: [],
    legalities: legal("modern", "legacy", "vintage", "commander", "pauper"), prices: { eur: "2.00", eur_foil: "5.00", usd: "2.50" },
  },
  {
    id: "00000000-0000-0000-0000-000000000003", oracle_id: "o-serra", name: "Serra Angel", set: "dmu", set_name: "Dominaria United",
    collector_number: "33", lang: "en", rarity: "uncommon", type_line: "Creature — Angel", mana_cost: "{3}{W}{W}", cmc: 5,
    colors: ["W"], color_identity: ["W"], oracle_text: "Flying, vigilance", keywords: ["Flying", "Vigilance"],
    legalities: legal("standard", "pioneer", "modern", "legacy", "vintage", "commander"), prices: { eur: "0.10", usd: "0.15" },
  },
  {
    id: "00000000-0000-0000-0000-000000000004", oracle_id: "o-atraxa", name: "Atraxa, Praetors' Voice", set: "2xm", set_name: "Double Masters",
    collector_number: "190", lang: "en", rarity: "mythic", type_line: "Legendary Creature — Phyrexian Angel Horror",
    mana_cost: "{G}{W}{U}{B}", cmc: 4, colors: ["G", "W", "U", "B"], color_identity: ["B", "G", "U", "W"],
    oracle_text: "Flying, vigilance, deathtouch, lifelink\nAt the beginning of your end step, proliferate.",
    keywords: ["Flying", "Vigilance", "Deathtouch", "Lifelink", "Proliferate"],
    legalities: legal("legacy", "vintage", "commander"), prices: { eur: "20.00", usd: "25.00" },
  },
  // Two printings of the same oracle card.
  {
    id: "00000000-0000-0000-0000-000000000005", oracle_id: "o-counter", name: "Counterspell", set: "mh2", set_name: "Modern Horizons 2",
    collector_number: "267", lang: "en", rarity: "uncommon", type_line: "Instant", mana_cost: "{U}{U}", cmc: 2,
    colors: ["U"], color_identity: ["U"], oracle_text: "Counter target spell.", keywords: [],
    legalities: legal("modern", "legacy", "vintage", "commander", "pauper"), prices: { eur: "1.00", usd: "1.10" },
  },
  {
    id: "00000000-0000-0000-0000-000000000006", oracle_id: "o-counter", name: "Counterspell", set: "7ed", set_name: "Seventh Edition",
    collector_number: "67", lang: "en", rarity: "common", type_line: "Instant", mana_cost: "{U}{U}", cmc: 2,
    colors: ["U"], color_identity: ["U"], oracle_text: "Counter target spell.", keywords: [],
    legalities: legal("modern", "legacy", "vintage", "commander", "pauper"), prices: { eur: "3.00", usd: "2.00" },
  },
  // Double-faced card: colors/text live on the faces.
  {
    id: "00000000-0000-0000-0000-000000000007", oracle_id: "o-delver", name: "Delver of Secrets // Insectile Aberration",
    set: "isd", set_name: "Innistrad", collector_number: "51", lang: "en", rarity: "common", cmc: 1, color_identity: ["U"],
    keywords: ["Transform", "Flying"], legalities: legal("modern", "legacy", "vintage", "commander", "pauper"),
    prices: { eur: "0.50", usd: "0.40" },
    card_faces: [
      { name: "Delver of Secrets", mana_cost: "{U}", type_line: "Creature — Human Wizard", oracle_text: "At the beginning of your upkeep, look at the top card of your library.", colors: ["U"], image_uris: { small: "https://img/delver-s.jpg", normal: "https://img/delver-n.jpg" } },
      { name: "Insectile Aberration", mana_cost: "", type_line: "Creature — Human Insect", oracle_text: "Flying", colors: ["U"] },
    ],
  },
  {
    id: "00000000-0000-0000-0000-000000000008", oracle_id: "o-azcharm", name: "Azorius Charm", set: "rtr", set_name: "Return to Ravnica",
    collector_number: "145", lang: "en", rarity: "uncommon", type_line: "Instant", mana_cost: "{W}{U}", cmc: 2,
    colors: ["U", "W"], color_identity: ["U", "W"], oracle_text: "Choose one — You gain life... ; or draw a card.", keywords: [],
    legalities: legal("modern", "legacy", "vintage", "commander"), prices: { eur: null, usd: "0.30" },
  },
  {
    id: "00000000-0000-0000-0000-000000000009", oracle_id: "o-forest", name: "Forest", set: "dmu", set_name: "Dominaria United",
    collector_number: "277", lang: "en", rarity: "common", type_line: "Basic Land — Forest", mana_cost: "", cmc: 0,
    colors: [], color_identity: ["G"], oracle_text: "({T}: Add {G}.)", keywords: [],
    legalities: legal("standard", "pioneer", "modern", "legacy", "vintage", "commander", "pauper"), prices: { eur: "0.05", usd: "0.05" },
  },
];

export const ID = Object.fromEntries(SCRYFALL_CARDS.map((c) => [
  `${c.name.split(/[ ,/]/)[0].toLowerCase()}${c.set === "7ed" ? "7ed" : ""}`, c.id,
]));
// => ID.sol, ID.lightning, ID.serra, ID.atraxa, ID.counterspell, ID.counterspell7ed, ID.delver, ID.azorius, ID.forest

/** Load every fixture card into the cards table. */
export function seedCards(db) {
  upsertCards(db, SCRYFALL_CARDS.map(normalizeCard));
}

/**
 * Insert owned copies: rows of [scryfall_id, quantity, {finish, language, condition, binder, source
 * (default manabox), price (purchase price), currency}?].
 */
export function seedCollection(db, rows) {
  const stmt = db.prepare(
    `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source, purchase_price, purchase_currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, qty, opts = {}] of rows) {
    stmt.run(id, opts.finish ?? "normal", opts.language ?? "en", opts.condition ?? "near_mint", opts.binder ?? "", qty,
      opts.source ?? "manabox", opts.price ?? null, opts.currency ?? null);
  }
}

/**
 * Replace globalThis.fetch with a fake Scryfall that resolves /cards/collection
 * identifiers from SCRYFALL_CARDS, with lib/scryfall.js's rate limits off
 * (restore() brings both back). Returns { calls, restore }.
 */
export function stubScryfall(pool = SCRYFALL_CARDS) {
  const original = globalThis.fetch;
  const calls = [];
  setThrottle({ minMs: 0, limitedMs: 0 });
  const lc = (s) => String(s ?? "").toLowerCase();
  const match = (ident) => pool.find((c) => {
    if (ident.id) return c.id === ident.id;
    if (ident.collector_number) return c.set === lc(ident.set) && c.collector_number === String(ident.collector_number);
    const nameOk = lc(c.name) === lc(ident.name) || (c.card_faces || []).some((f) => lc(f.name) === lc(ident.name));
    return nameOk && (!ident.set || c.set === lc(ident.set));
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname !== "/cards/collection" || init.method !== "POST") {
      return new Response(JSON.stringify({ object: "error", details: "not stubbed" }), { status: 404 });
    }
    const { identifiers } = JSON.parse(init.body);
    calls.push(identifiers);
    const data = [];
    const notFound = [];
    for (const ident of identifiers) {
      const card = match(ident);
      if (card) data.push(card); else notFound.push(ident);
    }
    return new Response(JSON.stringify({ object: "list", data, not_found: notFound }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; setThrottle(); } };
}
