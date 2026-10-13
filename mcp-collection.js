#!/usr/bin/env node
// "collection" MCP server: gives the Claude CLI read access to the owned
// collection and decks, plus one write tool (save_deck) for creating decks the
// user then sees in the app. Spawned by the CLI per chat turn via --mcp-config.
//
// Protocol: MCP over stdio, hand-rolled (no SDK) — newline-delimited JSON-RPC
// 2.0 on stdin/stdout. stdout carries protocol messages ONLY; logs go to stderr.
// Requests are handled concurrently (save_deck may wait on Scryfall) and every
// response carries the id of its request, so out-of-order replies are fine.

import { createInterface } from "node:readline";
import { cardPrice, formatPrice, openDb, stats } from "./lib/db.js";
import { QUERY_HELP, searchCollection } from "./lib/query.js";
import { BOARDS, deckDetail, deckToText, findDeck, listDecks, saveDeck } from "./lib/decks.js";

const VERSION = process.env.APP_VERSION || "dev";
const DEFAULT_PROTOCOL = "2025-06-18";

// Anything printed by accident (a library, a stray debug line) must not corrupt
// the protocol stream.
console.log = console.info = console.debug = (...args) => console.error(...args);
const log = (...args) => console.error("[mcp-collection]", ...args);

// The DB is opened on first use so the handshake succeeds even when the volume
// is unavailable; tool calls then report the error instead.
let db;
const getDb = () => (db ??= openDb());

// ---------------------------------------------------------------------------
// Helpers

class ToolError extends Error {}

const parseJson = (s, fallback) => {
  if (s == null || typeof s !== "string") return s ?? fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

const int = (v, def, min, max) => {
  const n = Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.trunc(Number(v)) : def;
  return Math.min(max, Math.max(min, n));
};

const COLOR_NAMES = { W: "white", U: "blue", B: "black", R: "red", G: "green" };
const colorLabel = (ci) => (ci ? `${ci} (${[...ci].map((l) => COLOR_NAMES[l] ?? l).join("/")})` : "colorless");

// Main card type of the front face; creature wins over artifact/enchantment.
const TYPE_PRIORITY = ["Creature", "Planeswalker", "Battle", "Land", "Instant", "Sorcery", "Artifact", "Enchantment"];
function mainType(typeLine) {
  const front = String(typeLine || "").split(" // ")[0];
  return TYPE_PRIORITY.find((t) => front.includes(t)) ?? "Other";
}

const setNum = (r) => `${String(r.set_code || "?").toUpperCase()} #${r.collector_number ?? "?"}`;
const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " / ");

// Owned rows (all printings) matching a card name, case-insensitively and by
// the front face of double-faced / split cards ("Name // Back").
const OWNED_BY_NAME = `
  SELECT c.scryfall_id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number,
         col.finish, col.language, col.condition, col.binder, col.quantity, c.prices
    FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
   WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %'
   ORDER BY col.quantity DESC, c.set_code, c.collector_number`;

// ---------------------------------------------------------------------------
// Tools

const SEARCH_EXAMPLES = [
  't:creature c:g cmc<=3            green creatures with mana value 3 or less',
  'id:bg f:commander o:"sacrifice"  cards for a Golgari commander deck that mention sacrificing',
  'is:commander id:wur              legendary creatures usable as a Jeskai commander',
  'k:flying -t:creature             noncreature cards with flying (e.g. equipment granting it)',
  'r:mythic eur>10                  mythics worth more than €10 (use sort "price")',
  'c:m t:instant                    multicolored instants',
  'o:"draw a card" mv=2 c<=ub       two-drops that draw, castable in Dimir',
  's:mh3 is:foil                    foils from Modern Horizons 3',
  'qty>=4 t:land                    lands owned in 4+ copies',
  'b:"trade binder"                 everything in a ManaBox binder',
  'lightning                        names containing "lightning"',
];

const TOOLS = [
  {
    name: "collection_overview",
    description:
      "Summary of the user's Magic collection: totals (unique cards, printings, total copies, estimated value in EUR), " +
      "breakdown by color identity and by main card type, the 15 most valuable owned cards, the user's decks, and the " +
      "date of the last ManaBox import. Call this first to get a feel for what the user owns.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Collection overview", readOnlyHint: true, openWorldHint: false },
    run: collectionOverview,
  },
  {
    name: "search_collection",
    description:
      "Search the cards the user OWNS (not all of Magic — use the scryfall tools for that) with a Scryfall-like query " +
      "language. Terms are ANDed; prefix a term with '-' to negate it; quote multi-word values.\n" +
      `Syntax: ${QUERY_HELP}.\n` +
      "Notes: c: is the card's colors (c:wu = at least white and blue, c=wu exactly, c<=wu within); id: is color " +
      "identity and means 'within' (what fits a commander of that identity); f:<format> = legal in that format " +
      "(commander, modern, standard, pioneer, legacy, pauper, ...); is:commander = can be a commander; eur/usd are per-copy " +
      "prices; qty counts owned copies; b: matches the ManaBox binder name.\n" +
      `Examples:\n${SEARCH_EXAMPLES.map((e) => `  ${e}`).join("\n")}\n` +
      "Output: header 'N matches (showing a-b)' then one line per card: " +
      "'<qty>x <name> | <mana cost> | <type line> | <SET #number, or N printings> | <price> | <finishes>'. " +
      "Page through large results with offset. Set include_text to also get oracle text (costs more tokens).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query in the syntax above. Empty string lists everything." },
        group: {
          type: "string", enum: ["card", "printing"], default: "card",
          description: "'card' = one line per card with all printings summed (default); 'printing' = one line per set printing.",
        },
        sort: {
          type: "string", enum: ["name", "cmc", "price", "qty", "set", "rarity"], default: "name",
          description: "Sort key (price/qty/rarity default to descending).",
        },
        dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction override." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Max lines to return (max 200)." },
        offset: { type: "integer", minimum: 0, default: 0, description: "Skip this many matches (paging)." },
        include_text: { type: "boolean", default: false, description: "Include each card's oracle text." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { title: "Search owned cards", readOnlyHint: true, openWorldHint: false },
    run: searchTool,
  },
  {
    name: "check_owned",
    description:
      "Check which of the given card names the user owns. For each name returns the owned copies across all printings " +
      "(with set, collector number, finish) or NOT OWNED. Case-insensitive; the front-face name of double-faced/split " +
      "cards also matches. Use it to check a candidate list or decklist against the collection in one call (max 300 names).",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array", items: { type: "string" }, minItems: 1, maxItems: 300,
          description: "Exact English card names, e.g. [\"Sol Ring\", \"Delver of Secrets\"].",
        },
      },
      required: ["names"],
      additionalProperties: false,
    },
    annotations: { title: "Check owned cards", readOnlyHint: true, openWorldHint: false },
    run: checkOwned,
  },
  {
    name: "get_card",
    description:
      "Full details of a card the user owns or that is cached locally (e.g. because it is in a deck): oracle text, type, " +
      "mana cost, legality in common formats, prices, owned printings and decks using it. For cards not in the local " +
      "database use the scryfall tools (get_card / search_cards) instead.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Card name (exact or front face; a unique partial match also works)." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { title: "Card details", readOnlyHint: true, openWorldHint: false },
    run: getCard,
  },
  {
    name: "list_decks",
    description:
      "List the user's decks: id, name, format, source (manabox = synced from a ManaBox deck binder, manual = entered " +
      "in the app, claude = saved by you), card count and last update.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List decks", readOnlyHint: true, openWorldHint: false },
    run: listDecksTool,
  },
  {
    name: "get_deck",
    description:
      "Show one deck with every card, its board, and ownership against the collection (owned / MISSING n / basic), " +
      "per-card prices and the estimated cost of the missing cards.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: ["string", "integer"], description: "Deck id, or (part of) the deck name." },
      },
      required: ["deck"],
      additionalProperties: false,
    },
    annotations: { title: "Show deck", readOnlyHint: true, openWorldHint: false },
    run: getDeck,
  },
  {
    name: "save_deck",
    description:
      "Save a deck so the user sees it in the app's Decks view (this is how you hand over a deck you built). " +
      "Creates a new deck, or with deck_id replaces that deck's name/format/description and full card list. " +
      "Cards are matched to printings the user owns automatically — just give names; set/collector_number are only " +
      "needed to force a specific printing. Cards the user does not own are looked up on Scryfall and shown as missing. " +
      "Put the commander (and partner/background) in board \"commander\", the 99 in \"main\", optional extras in " +
      "\"side\" or \"maybe\". Include basic lands with their counts. Decks with source manabox are re-synced from the " +
      "user's ManaBox binders on the next import, so prefer creating a new deck over overwriting one of those. " +
      "Returns the deck id, any names that could not be resolved, and the deck with ownership and missing cost.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Deck name." },
        format: { type: "string", description: "Format, e.g. commander, modern, standard, pauper, brawl." },
        description: { type: "string", description: "Short description / strategy notes shown in the app." },
        deck_id: { type: "integer", description: "Overwrite this existing deck (from list_decks) instead of creating a new one." },
        cards: {
          type: "array", minItems: 1, maxItems: 500,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Exact English card name." },
              quantity: { type: "integer", minimum: 1, default: 1 },
              board: { type: "string", enum: BOARDS, default: "main" },
              set: { type: "string", description: "Optional set code to force a printing, e.g. \"cmm\"." },
              collector_number: { type: "string", description: "Optional collector number (with set)." },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "cards"],
      additionalProperties: false,
    },
    annotations: { title: "Save deck", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: saveDeckTool,
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function collectionOverview() {
  const d = getDb();
  const s = stats(d);
  const lines = [
    `Collection: ${s.unique_cards} unique cards, ${s.printings} printings, ${s.total_cards} total copies, ` +
      `est. value €${s.value_eur.toFixed(2)} (EUR prices only). Last ManaBox import: ${s.last_import ?? "never"}.`,
  ];
  if (!s.total_cards) {
    lines.push("The collection is empty — the user has to upload a ManaBox CSV export in the app first.");
  }

  // One entry per oracle card (all printings summed).
  const cards = d.prepare(
    `SELECT c.color_identity, c.type_line, SUM(col.quantity) AS qty
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      GROUP BY c.oracle_id`,
  ).all();
  const tally = (keyFn) => {
    const m = new Map();
    for (const c of cards) {
      const k = keyFn(c);
      const e = m.get(k) ?? { cards: 0, copies: 0 };
      e.cards++; e.copies += c.qty;
      m.set(k, e);
    }
    return [...m].sort((a, b) => b[1].cards - a[1].cards);
  };
  if (cards.length) {
    lines.push("", "By color identity (unique cards / copies):");
    for (const [k, e] of tally((c) => c.color_identity || "")) lines.push(`  ${colorLabel(k)}: ${e.cards} / ${e.copies}`);
    lines.push("", "By main type (unique cards / copies):");
    for (const [k, e] of tally((c) => mainType(c.type_line))) lines.push(`  ${k}: ${e.cards} / ${e.copies}`);
  }

  // Most valuable per printing + finish, by per-copy price.
  const owned = d.prepare(
    `SELECT c.name, c.set_code, c.collector_number, c.prices, col.finish, SUM(col.quantity) AS qty
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      GROUP BY c.scryfall_id, col.finish`,
  ).all();
  const valued = owned
    .map((r) => ({ ...r, price: cardPrice(r, r.finish) }))
    .filter((r) => r.price)
    .sort((a, b) => b.price.value - a.price.value)
    .slice(0, 15);
  if (valued.length) {
    lines.push("", "Most valuable owned cards (per copy):");
    for (const r of valued) {
      lines.push(`  ${formatPrice(r.price)} ${r.name} (${setNum(r)}${r.finish !== "normal" ? `, ${r.finish}` : ""}) x${r.qty}`);
    }
  }

  const decks = listDecks(d);
  lines.push("", decks.length ? `Decks (${decks.length}):` : "Decks: none yet.");
  for (const k of decks) lines.push(`  ${deckLine(k)}`);
  return lines.join("\n");
}

function searchTool(args) {
  const query = typeof args.query === "string" ? args.query : "";
  const limit = int(args.limit, 50, 1, 200);
  const offset = int(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const group = args.group === "printing" ? "printing" : "card";
  let result;
  try {
    result = searchCollection(getDb(), { q: query, group, sort: args.sort, dir: args.dir, limit, offset });
  } catch (err) {
    const help = err.message.includes("Supported:") ? "" : `\nSupported syntax: ${QUERY_HELP}`;
    throw new ToolError(`Invalid query: ${err.message}${help}`);
  }
  const { total, rows } = result;
  const header = rows.length
    ? `${total} matches (showing ${offset + 1}-${offset + rows.length})`
    : `${total} matches${total ? ` (none at offset ${offset})` : ""}`;
  const lines = [header];
  for (const r of rows) {
    const finishes = String(r.finishes || "normal").split(",");
    const price = cardPrice(r, r.finish || "normal"); // most valuable owned printing
    const where = group === "card" && r.printing_count > 1 ? `${r.printing_count} printings` : setNum(r);
    lines.push(`${r.qty}x ${r.name} | ${r.mana_cost || ""} | ${r.type_line || ""} | ${where} | ${formatPrice(price)} | ${finishes.join(",")}`);
    if (args.include_text && r.oracle_text) lines.push(`    ${oneLine(r.oracle_text)}`);
  }
  return lines.join("\n");
}

function checkOwned(args) {
  if (!Array.isArray(args.names) || args.names.length === 0) throw new ToolError("names must be a non-empty array of card names.");
  if (args.names.length > 300) throw new ToolError("At most 300 names per call.");
  const names = [...new Set(args.names.map((n) => String(n).trim()).filter(Boolean))];
  const stmt = getDb().prepare(OWNED_BY_NAME);
  const lines = [];
  let ownedCount = 0;
  for (const name of names) {
    const rows = stmt.all(name, name);
    if (!rows.length) { lines.push(`${name}: NOT OWNED`); continue; }
    ownedCount++;
    // Merge rows that differ only by condition/language/binder.
    const per = new Map();
    for (const r of rows) {
      const k = `${setNum(r)}|${r.finish}`;
      per.set(k, (per.get(k) ?? 0) + r.quantity);
    }
    const total = rows.reduce((a, r) => a + r.quantity, 0);
    const detail = [...per].map(([k, q]) => {
      const [sn, finish] = k.split("|");
      return `${q}x ${sn}${finish !== "normal" ? ` ${finish}` : ""}`;
    });
    const label = rows[0].name.toLowerCase() === name.toLowerCase() ? rows[0].name : `${name} (${rows[0].name})`;
    lines.push(`${label}: ${total} owned — ${detail.join(", ")}`);
  }
  return [`${ownedCount} of ${names.length} owned.`, ...lines].join("\n");
}

const COMMON_FORMATS = ["standard", "pioneer", "modern", "legacy", "vintage", "pauper", "commander", "brawl"];

function getCard(args) {
  const name = String(args.name ?? "").trim();
  if (!name) throw new ToolError("name is required.");
  const d = getDb();
  // Prefer an owned printing, then the most recently fetched one.
  const pickSql = (where) => `
    SELECT c.*, (SELECT COALESCE(SUM(quantity), 0) FROM collection WHERE scryfall_id = c.scryfall_id) AS own_qty
      FROM cards c WHERE ${where}
     ORDER BY own_qty DESC, c.fetched_at DESC LIMIT 1`;
  let card = d.prepare(pickSql("c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %'")).get(name, name);
  if (!card) {
    const candidates = d.prepare("SELECT DISTINCT name FROM cards WHERE name LIKE ? ORDER BY name LIMIT 11").all(`%${name}%`).map((r) => r.name);
    if (candidates.length === 1) card = d.prepare(pickSql("c.name = ?")).get(candidates[0]);
    else if (candidates.length > 1) {
      return `"${name}" is ambiguous in the local database. Did you mean: ${candidates.slice(0, 10).join("; ")}${candidates.length > 10 ? "; ..." : ""}?`;
    }
  }
  if (!card) {
    return `"${name}" is not in the local database (the user does not own it and it is in no deck). ` +
      "Use the scryfall tools (get_card / search_cards) to look it up.";
  }

  const legal = parseJson(card.legalities, {});
  const prices = parseJson(card.prices, {});
  const keywords = parseJson(card.keywords, []);
  const priceParts = ["eur", "eur_foil", "usd", "usd_foil", "usd_etched"]
    .filter((k) => prices[k] != null)
    .map((k) => `${k} ${k.startsWith("eur") ? "€" : "$"}${Number(prices[k]).toFixed(2)}`);
  const lines = [
    `${card.name} ${card.mana_cost || ""}`.trim(),
    `${card.type_line || "?"} | mana value ${card.cmc ?? "?"} | colors ${card.colors || "colorless"} | color identity ${card.color_identity || "colorless"}`,
    `Printing shown: ${card.set_name || ""} (${setNum(card)}), ${card.rarity || "?"}`,
    "",
    card.oracle_text || "(no rules text)",
    "",
  ];
  if (keywords.length) lines.push(`Keywords: ${keywords.join(", ")}`);
  lines.push(`Legality: ${COMMON_FORMATS.map((f) => `${f} ${(legal[f] || "?").replace("not_legal", "no")}`).join(", ")}`);
  lines.push(`Prices: ${priceParts.join(", ") || "n/a"}`);

  const owned = d.prepare(
    `SELECT c.set_code, c.collector_number, col.finish, col.language, col.condition, col.binder, col.quantity
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id = ? ORDER BY col.quantity DESC`,
  ).all(card.oracle_id);
  const total = owned.reduce((a, r) => a + r.quantity, 0);
  lines.push("", total ? `Owned: ${total} copies` : "Owned: none");
  for (const r of owned) {
    lines.push(`  ${r.quantity}x ${setNum(r)} ${r.finish} ${r.language} ${r.condition}${r.binder ? ` [binder: ${r.binder}]` : ""}`);
  }
  const decks = d.prepare(
    `SELECT d.id, d.name, dc.board, SUM(dc.quantity) AS quantity
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE c.oracle_id = ? OR (dc.scryfall_id IS NULL AND dc.name = ? COLLATE NOCASE)
      GROUP BY d.id, dc.board ORDER BY d.name`,
  ).all(card.oracle_id, card.name);
  if (decks.length) lines.push(`In decks: ${decks.map((k) => `#${k.id} ${k.name} (${k.quantity}x ${k.board})`).join(", ")}`);
  if (card.scryfall_uri) lines.push(`Scryfall: ${card.scryfall_uri}`);
  return lines.join("\n");
}

const deckLine = (k) =>
  `#${k.id} ${k.name}${k.format ? ` [${k.format}]` : ""} — ${k.card_count} cards, source ${k.source}, updated ${k.updated_at}`;

function listDecksTool() {
  const decks = listDecks(getDb());
  return decks.length ? decks.map(deckLine).join("\n") : "The user has no decks yet.";
}

function getDeck(args) {
  const d = getDb();
  const deck = findDeck(d, args.deck);
  if (!deck) {
    const names = listDecks(d).map(deckLine);
    throw new ToolError(`No deck matches "${args.deck}".${names.length ? `\nDecks:\n${names.join("\n")}` : " The user has no decks."}`);
  }
  return deckToText(deckDetail(d, deck.id));
}

async function saveDeckTool(args) {
  const name = String(args.name ?? "").trim();
  if (!name) throw new ToolError("name is required.");
  if (!Array.isArray(args.cards) || args.cards.length === 0) throw new ToolError("cards must be a non-empty array.");
  const items = args.cards.map((c, i) => {
    const cardName = String(c?.name ?? "").trim();
    if (!cardName) throw new ToolError(`cards[${i}] has no name.`);
    if (c.board != null && !BOARDS.includes(c.board)) throw new ToolError(`cards[${i}].board must be one of ${BOARDS.join(", ")}.`);
    return {
      name: cardName,
      quantity: int(c.quantity, 1, 1, 999),
      board: c.board ?? "main",
      set: c.set ? String(c.set).toLowerCase() : undefined,
      collector_number: c.set && c.collector_number != null ? String(c.collector_number) : undefined,
    };
  });
  const d = getDb();
  let id;
  if (args.deck_id != null) {
    id = Number(args.deck_id);
    if (!Number.isInteger(id) || !d.prepare("SELECT 1 FROM decks WHERE id = ?").get(id)) {
      throw new ToolError(`Deck ${args.deck_id} does not exist. Omit deck_id to create a new deck.`);
    }
  }
  const saved = await saveDeck(d, {
    id, name, format: args.format || null, description: args.description || null, source: "claude", items,
  });
  const lines = [`${id ? "Updated" : "Created"} deck #${saved.id} "${name}". The user can open it in the app's Decks view.`];
  if (saved.unresolved.length) {
    lines.push(`Could not resolve ${saved.unresolved.length} name(s) on Scryfall (kept as unknown cards — check spelling): ${saved.unresolved.join("; ")}`);
  }
  lines.push("", deckToText(deckDetail(d, saved.id)));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(params) {
  const tool = TOOL_BY_NAME.get(params?.name);
  if (!tool) return { protocolError: [-32602, `Unknown tool: ${params?.name}`] };
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  const started = Date.now();
  try {
    const text = await tool.run(args);
    log(`${tool.name} ok in ${Date.now() - started} ms`);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    log(`${tool.name} failed:`, err instanceof ToolError ? err.message : err);
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

/** Handle one JSON-RPC message; resolves to a response object or null (notifications/responses). */
async function handle(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
    return fail(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== "string") {
    // A response to a server->client request (we never send any) — ignore.
    return "result" in msg || "error" in msg ? null : fail(id ?? null, -32600, "Invalid Request");
  }
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "mtg-collection", version: VERSION },
        instructions:
          "Read access to the user's Magic: The Gathering collection (synced from ManaBox) and decks, plus save_deck " +
          "to hand decks over to the app. Check ownership with check_owned / search_collection before recommending cards.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const result = await callTool(params);
      return result.protocolError ? fail(id, ...result.protocolError) : reply(id, result);
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send(fail(null, -32700, "Parse error"));
    return;
  }
  try {
    if (Array.isArray(msg)) {
      if (!msg.length) { send(fail(null, -32600, "Invalid Request")); return; }
      const out = (await Promise.all(msg.map(handle))).filter(Boolean);
      if (out.length) send(out);
    } else {
      const out = await handle(msg);
      if (out) send(out);
    }
  } catch (err) {
    log("internal error:", err);
    if (msg && !Array.isArray(msg) && msg.id != null) send(fail(msg.id, -32603, `Internal error: ${err.message}`));
  }
}

const pending = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  // Don't await: a slow save_deck must not hold up other requests.
  const p = handleLine(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on("close", async () => {
  // stdin closed: finish in-flight calls, then exit.
  await Promise.allSettled([...pending]);
  try { db?.close(); } catch { /* ignore */ }
  process.exit(0);
});
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
log(`started (version ${VERSION}, db ${process.env.DB_FILE || "/data/mtg-planner.db"})`);
