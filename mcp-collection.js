#!/usr/bin/env node
// "collection" MCP server: gives the Claude CLI read access to the owned
// collection and decks (incl. what built decks claim: owned vs free copies,
// conflicts, shopping list), plus two write tools: save_deck (decks the user then
// sees in the app) and edit_copies (fix language / printing / finish / condition
// of owned copies; lib/edits.js, actor 'claude', logged and undoable in the app),
// plus list_wishlist / add_to_wishlist (lib/wishlist.js; Claude may add, never remove).
// evaluate_deck is a dry run: stats, Commander bracket and 1-10 score of a draft
// list (lib/power.js) without saving it. Its combo check (Commander Spellbook,
// lib/spellbook.js) uses this process's own DB connection but the server's
// settings, rate slots and backoff from the shared meta table, so turning it off
// in the app (or SPELLBOOK_ENABLED=false) also stops it here.
// No delete, backup or restore tools by design: deleting is app-only. Spawned by
// the CLI per chat turn via --mcp-config.
//
// Protocol: MCP over stdio, hand-rolled (no SDK) — newline-delimited JSON-RPC
// 2.0 on stdin/stdout. stdout carries protocol messages ONLY; logs go to stderr.
// Requests are handled concurrently (save_deck may wait on Scryfall) and every
// response carries the id of its request, so out-of-order replies are fine.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { cardPrice, formatPrice, getAppMeta, openDb, setAppMeta, stats } from "./lib/db.js";
import { QUERY_HELP, searchCollection } from "./lib/query.js";
import {
  BOARDS, DECK_STATUSES, allocation, bracketVerdict, cardKey, cardUsage, deckDetail, deckPower, deckToText, draftDeck, findDeck, isBasicLand,
  listDecks, powerLines, saveDeck, shoppingList,
} from "./lib/decks.js";
import { createSpellbookScheduler } from "./lib/spellbook.js";
import { BinderError, listBinders } from "./lib/binders.js";
import { EDIT_CONDITIONS, editCopies } from "./lib/edits.js";
import { getPrinting, openIndex } from "./lib/cardindex.js";
import { fetchCollectionPolitely } from "./lib/manabox.js";
import { WishlistError, addWishlistItem, listWishlist, wishlistShopping } from "./lib/wishlist.js";
import { deckVersion, listDeckVersions } from "./lib/deckhistory.js";
import { accessoriesForRows, accessoriesText, ensureAccessoryData } from "./lib/accessories.js";

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

// The card index (read-only, optional): printing facts for edit_copies (other
// languages of a printing, finishes). The CLI passes only DB_FILE, so the index
// is looked for next to the app DB when INDEX_DB_FILE is not set.
let idx;
function getIndex() {
  if (idx !== undefined) return idx;
  idx = null;
  const dbFile = process.env.DB_FILE || "/data/mtg-planner.db";
  const file = [process.env.INDEX_DB_FILE, path.join(path.dirname(dbFile), "cardindex.db")].find((f) => f && existsSync(f));
  if (file) {
    try { idx = openIndex(file, { readOnly: true }); } catch (err) { log(`card index unavailable (${err.message})`); }
  }
  return idx;
}
// Combo checks (Commander Spellbook): the turn waits at most COMBO_WAIT_MS for one.
const COMBO_WAIT_MS = 8000;
let combosScheduler;
const combos = () => (combosScheduler ??= createSpellbookScheduler({ db: () => getDb(), version: VERSION, log: { warn: (m) => log(m) } }));

const indexPrinting = (id) => {
  const i = getIndex();
  if (!i) return null;
  try { return getPrinting(i, id); } catch { return null; }
};

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
   WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' ESCAPE '\\'
   ORDER BY col.quantity DESC, c.set_code, c.collector_number`;

/** A user string as a literal LIKE pattern (used with ESCAPE backslash): % and _ match only themselves. */
const likeEsc = (v) => String(v).replace(/[\\%_]/g, (c) => `\\${c}`);

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
  'avail>=1 t:creature              creatures with free copies (not claimed by a built deck, not in a locked binder)',
  'used>=1                          cards a built deck uses or a locked binder holds (avail<0 = built decks need more than owned)',
  'b:"trade binder"                 everything in a binder (see list_binders)',
  'src:scan                         copies added with the in-app scanner (src:manabox = synced from ManaBox)',
  'lightning                        names containing "lightning"',
];

/** The cards array of save_deck / evaluate_deck. */
const CARDS_SCHEMA = {
  type: "array", minItems: 1, maxItems: 500,
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact English card name." },
      quantity: { type: "integer", minimum: 1, default: 1 },
      board: { type: "string", enum: BOARDS, default: "main" },
      companion: { type: "boolean", description: "true for the companion (kept on the side board, outside the 99)." },
      set: { type: "string", description: "Optional set code to force a printing, e.g. \"cmm\"." },
      collector_number: { type: "string", description: "Optional collector number (with set)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

const POWER_TEXT_HELP =
  "Power lines: 'Stats:' (cards, lands, avg mana value, curve, colour pips vs land sources); for Commander decks also " +
  "'Bracket: N <label> (...) - <the rules that set it, with cards>' (≥N = combos not checked yet, may be higher; tutors " +
  "never set the bracket; Brackets 1 and 5 are only set by the user, the app hints 'looks cEDH-like'; Commander " +
  "Spellbook's own rating is a second opinion only), 'Score x/10: <8 categories points/max>' and 'Not Commander-legal: ...' " +
  "when there are problems. 'Tokens & extras:' = tokens to have ready (~estimate, owned copies) and counters/dice/markers the cards need.";

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
      "prices; qty counts owned copies; avail = owned copies minus those claimed by BUILT decks and those lying in locked binders (kept for their own deck; free to use); used = copies built decks claim or locked binders hold; b: matches the binder name; src: is manabox (synced from ManaBox), scan (added with the app's scanner) or app (organised into a binder in the app).\n" +
      `Examples:\n${SEARCH_EXAMPLES.map((e) => `  ${e}`).join("\n")}\n` +
      "Output: header 'N matches (showing a-b)' then one line per card: " +
      "'<qty>x <name> | <mana cost> | <type line> | <SET #number, or N printings> | <price> | <finishes> | free N (when built decks use it or locked binders hold it; '(n in locked binders)') | binders: ... | source: ...'. " +
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
      "(with set, collector number, finish), how many are FREE (owned minus copies claimed by built decks) and which built " +
      "decks use it, or NOT OWNED. Case-insensitive; the front-face name of double-faced/split " +
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
    name: "list_binders",
    description:
      "List the user's binders (storage groups of owned cards): name, type [binder | deck box | bulk | trade | other; ', locked' = " +
      "a locked binder: its copies are free only for the deck that owns it (deck boxes are locked unless the user unlocked them)], number " +
      "of printings, total copies, EUR value, linked decks, and where " +
      "the copies came from (manabox = synced from the ManaBox app, scan = added with the app's camera scanner, app = moved " +
      "into the binder in the app). Empty binders are listed too; Unsorted = copies without a binder. " +
      "Search a binder's contents with search_collection and b:\"<name>\".",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List binders", readOnlyHint: true, openWorldHint: false },
    run: listBindersTool,
  },
  {
    name: "list_decks",
    description:
      "List the user's decks: id, name, format, status (built = a physical deck that claims its cards, idea = a plan), " +
      "source (manabox = synced from a ManaBox deck binder, manual = entered in the app, scan = filled with the app's camera " +
      "scanner, claude = saved by you), card count, value in EUR (commander+main+side), cards to buy (not owned at all), " +
      "cards in other built decks (owned but claimed there, can be moved over), conflicts, last update and, for Commander " +
      "decks, the bracket and 1-10 power score (' · B3 · 6.4/10'; B≥3 / ≥6.4 = combos not checked yet, may be higher).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List decks", readOnlyHint: true, openWorldHint: false },
    run: listDecksTool,
  },
  {
    name: "get_deck",
    description:
      "Show one deck with its status (idea/built), every card, its board, and ownership against the collection: TO BUY n = " +
      "copies the user does not own at all; IN USE n in other deck(s) = owned copies claimed by other built decks (can be moved " +
      "over, not a purchase) on an idea deck; IN USE n in locked binder X = owned copies lying in a locked binder of another deck (or " +
      "one no deck owns), can be moved too; on a BUILT deck the same copies show as SHARED n with <deck> (CONFLICT: both " +
      "built decks need them, buy extra to play both); basic. Per-card prices, the deck value in EUR, its shopping list and the in-use list. " +
      POWER_TEXT_HELP,
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: ["string", "integer"], description: "Deck id, or (part of) the deck name." },
        target_bracket: { type: "integer", minimum: 1, maximum: 5, description: "Optional: add a verdict line for this Commander bracket (OK / OVER / UNDER)." },
      },
      required: ["deck"],
      additionalProperties: false,
    },
    annotations: { title: "Show deck", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: getDeck,
  },
  {
    name: "get_deck_history",
    description:
      "Read-only: the change history of one deck, newest first (time UTC, who changed it: app = the user in the app, claude = " +
      "you, import = a ManaBox import, scan = the scanner; and what changed, e.g. '+2 −1 cards'). With `version` (an id from " +
      "the list) it shows that version's changes per board. Going back to an older version is only possible in the app " +
      "(Decks → History).",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: ["string", "integer"], description: "Deck id, or (part of) the deck name." },
        version: { type: "integer", description: "Optional: a version id to show its changes in detail." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many versions to list (default 10)." },
      },
      required: ["deck"],
      additionalProperties: false,
    },
    annotations: { title: "Deck history", readOnlyHint: true, openWorldHint: false },
    run: getDeckHistory,
  },
  {
    name: "evaluate_deck",
    description:
      "Dry run: check a DRAFT decklist without saving it to your decks (it only caches card data and combo results). Returns its stats and, for Commander decks, the bracket (1-5, " +
      "from WotC's rules: Game Changers, mass land denial, extra turns, two-card combos) and the 1-10 power score with its " +
      "breakdown. With target_bracket it ends with 'Target bracket N: OK', 'OVER - <the rules and cards that push it higher>' " +
      "or 'UNDER - <weakest categories>'. Use it BEFORE save_deck when the user wants a deck for a bracket: swap the cards " +
      "named in OVER and check again. Give the list as decklist text (\"1 Sol Ring\" per line, sections Commander/Deck/" +
      "Sideboard) or as cards (same shape as save_deck). Card names (only names and counts) are sent to Commander Spellbook " +
      "for the combo check unless the user turned it off. " + POWER_TEXT_HELP,
    inputSchema: {
      type: "object",
      properties: {
        decklist: { type: "string", description: "Decklist text, one \"<count> <name>\" per line; a \"Commander\" section (or commander) sets the commander." },
        cards: { ...CARDS_SCHEMA, description: "Instead of decklist: the cards, like save_deck's cards." },
        format: { type: "string", description: "Format, e.g. commander (default when there is a commander or ~100 cards)." },
        commander: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 2 }],
          description: "Commander name (or two partners) when the list doesn't mark it.",
        },
        target_bracket: { type: "integer", minimum: 1, maximum: 5, description: "Bracket the user wants (1-5): adds the OK / OVER / UNDER verdict." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Evaluate draft deck", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: evaluateDeckTool,
  },
  {
    name: "shopping_list",
    description:
      "What the user has to buy: every card the BUILT decks together need more of than the user owns (with the decks " +
      "competing for it and EUR prices), plus per deck (built and idea) how many cards are to buy (not owned at all) with their " +
      "cost and how many are owned but in use in other built decks (can be moved over). The app shows it in Market → To buy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Shopping list", readOnlyHint: true, openWorldHint: false },
    run: shoppingListTool,
  },
  {
    name: "save_deck",
    description:
      "Save a deck so the user sees it in the app's Decks tab (this is how you hand over a deck you built). " +
      "Creates a new deck, or with deck_id replaces that deck's name/format/description and full card list; the previous list is kept as a " +
      "version in the deck's History (get_deck_history), so revise/upgrade/\"v2\" an existing deck with its deck_id instead of " +
      "creating a copy, unless the user wants both decks side by side. " +
      "Cards are matched to printings the user owns automatically — just give names; set/collector_number are only " +
      "needed to force a specific printing. Cards the user does not own are looked up on Scryfall and shown as missing. " +
      "Put the commander (and partner/background) in board \"commander\", the 99 in \"main\", optional extras in " +
      "\"side\" or \"maybe\". Include basic lands with their counts. Decks with source manabox are re-synced from the " +
      "user's ManaBox binders on the next import, so prefer creating a new deck over overwriting one of those. " +
      "Returns the deck id, any names that could not be resolved, and the deck with ownership, missing cost, stats, bracket and " +
      "score. With target_bracket it adds the verdict line (Target bracket N: OK / OVER / UNDER, see evaluate_deck).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Deck name." },
        format: { type: "string", description: "Format, e.g. commander, modern, standard, pauper, brawl." },
        description: { type: "string", description: "Short description / strategy notes shown in the app." },
        deck_id: { type: "integer", description: "Overwrite this existing deck (from list_decks) instead of creating a new one." },
        status: {
          type: "string", enum: DECK_STATUSES,
          description: "idea (default for new decks: a plan, claims no cards) or built (the user has physically built it; its cards are then claimed). Omit to keep an existing deck's status.",
        },
        target_bracket: { type: "integer", minimum: 1, maximum: 5, description: "Optional Commander bracket the deck is meant for: adds the OK / OVER / UNDER verdict." },
        cards: CARDS_SCHEMA,
      },
      required: ["name", "cards"],
      additionalProperties: false,
    },
    annotations: { title: "Save deck", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: saveDeckTool,
  },
  {
    name: "edit_copies",
    description:
      "Correct facts about copies the user OWNS: language, printing (another set/collector number of the SAME card), " +
      "finish (normal/foil/etched) or condition. Copies keep their binder; total copies never change (no deleting: " +
      "deleting is only possible in the app, point the user there). Every edit is logged and the user can undo it in the app.\n" +
      "BEFORE calling it, tell the user the exact change in one line (card, number of copies, which copies, from → to), " +
      "e.g. \"Changing **2× Counterspell** (7ED #67, binder Blue) from English to German.\" Never guess: if the user's " +
      "request or the owned copies leave it unclear which copies or what target is meant, ask instead of calling. " +
      "The tool refuses ambiguous requests too: when several different copies match, narrow them down with match " +
      "(set, collector_number, language, finish, condition, binder) or give quantity = all matching copies; quantity is " +
      "required when more than one copy matches. Copies imported from ManaBox: the first such edit makes mtg-planner " +
      "the master of the collection (ManaBox imports then add cards instead of replacing them); the tool then answers " +
      "with a confirmation request and a token: explain it and end your answer with the question. Only when the user " +
      "agrees in their NEXT message, call again with confirm_master set to that token (it only works in a later turn).",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "Card name (exact English name or front face) or oracle_id." },
        match: {
          type: "object",
          description: "Which owned copies (all fields optional, combined with AND; see get_card for the owned copies).",
          properties: {
            set: { type: "string", description: "Set code of the owned printing, e.g. \"7ed\"." },
            collector_number: { type: "string" },
            language: { type: "string", description: "Language code, e.g. en, de, it, ja." },
            finish: { type: "string", enum: ["normal", "foil", "etched"] },
            condition: { type: "string", enum: EDIT_CONDITIONS },
            binder: { type: "string", description: "Binder name (\"\" = Unsorted)." },
          },
          additionalProperties: false,
        },
        set: {
          type: "object",
          description: "The change (at least one field).",
          properties: {
            language: { type: "string", description: "New language code (en, de, fr, it, es, pt, ja, ko, ru, zhs, zht)." },
            printing: {
              type: "object",
              description: "New printing of the same card.",
              properties: { set: { type: "string" }, collector_number: { type: "string" } },
              required: ["set", "collector_number"],
              additionalProperties: false,
            },
            finish: { type: "string", enum: ["normal", "foil", "etched"] },
            condition: { type: "string", enum: EDIT_CONDITIONS },
          },
          additionalProperties: false,
        },
        quantity: { type: "integer", minimum: 1, description: "How many of the matching copies to change (required when more than one copy matches)." },
        confirm_master: { type: "string", description: "The token from an earlier confirmation request, only after the user agreed (in a later message) that editing ManaBox copies makes mtg-planner the collection master." },
      },
      required: ["card", "set"],
      additionalProperties: false,
    },
    annotations: { title: "Edit owned copies", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: editCopiesTool,
  },
  {
    name: "list_wishlist",
    description:
      "The user's wishlist (cards they want to buy, outside decks): per item the wanted copies, how many they own already " +
      "(got it = owned >= wanted), the current EUR price (cheapest known printing when any printing will do), the user's max " +
      "price and whether the price is below it, priority and note, plus the total EUR to buy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Wishlist", readOnlyHint: true, openWorldHint: false },
    run: listWishlistTool,
  },
  {
    name: "add_to_wishlist",
    description:
      "Add a card to the user's wishlist (only when the user asks for it). Give the name; set + collector_number only when the " +
      "user wants that exact printing. Adding a card already on the list adds the quantity. Removing items is only possible " +
      "in the app (Market tab → Wishlist).",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "Card name." },
        set: { type: "string", description: "Set code, only for one specific printing." },
        collector_number: { type: "string", description: "Collector number (with set)." },
        quantity: { type: "integer", minimum: 1, maximum: 99, description: "Copies wanted (default 1)." },
        finish: { type: "string", enum: ["any", "normal", "foil", "etched"], description: "Default any." },
        language: { type: "string", description: "Language code (en, de, ja, ...); default any." },
        max_price_eur: { type: "number", minimum: 0, description: "The most the user wants to pay per copy, in EUR." },
        priority: { type: "string", enum: ["high", "normal", "low"] },
        note: { type: "string", description: "Short note (why, for which deck)." },
      },
      required: ["card"],
      additionalProperties: false,
    },
    annotations: { title: "Add to wishlist", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: addToWishlistTool,
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

  const { binders, unsorted } = listBinders(d);
  if (binders.length || unsorted.copies) {
    lines.push("", `Binders (${binders.length}; printings / copies / source):`);
    for (const b of binders.slice(0, 40)) lines.push(`  ${b.name}: ${b.cards} / ${b.copies} / ${b.sources.join("+") || "empty"}`);
    if (binders.length > 40) lines.push(`  ... ${binders.length - 40} more (list_binders)`);
    if (unsorted.copies) lines.push(`  (Unsorted): ${unsorted.cards} / ${unsorted.copies} / ${unsorted.sources.join("+")}`);
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
    const boxed = r.boxed && !isBasicLand(r.name) ? ` (${r.boxed} in locked binders)` : "";
    const extra = `${r.used ? ` | free ${r.avail}${boxed}` : ""}${r.binders ? ` | binders: ${r.binders}` : ""}${r.sources ? ` | source: ${r.sources}` : ""}`;
    lines.push(`${r.qty}x ${r.name} | ${r.mana_cost || ""} | ${r.type_line || ""} | ${where} | ${formatPrice(price)} | ${finishes.join(",")}${extra}`);
    if (args.include_text && r.oracle_text) lines.push(`    ${oneLine(r.oracle_text)}`);
  }
  return lines.join("\n");
}

function checkOwned(args) {
  if (!Array.isArray(args.names) || args.names.length === 0) throw new ToolError("names must be a non-empty array of card names.");
  if (args.names.length > 300) throw new ToolError("At most 300 names per call.");
  const names = [...new Set(args.names.map((n) => String(n).trim()).filter(Boolean))];
  const d = getDb();
  const stmt = d.prepare(OWNED_BY_NAME);
  const alloc = allocation(d);
  const builtUse = (key) => (alloc.built.get(key)?.decks ?? []).map((k) => `#${k.deck_id} ${k.name} ${k.quantity}x`).join(", ");
  const lines = [];
  let ownedCount = 0;
  for (const name of names) {
    const rows = stmt.all(name, likeEsc(name));
    if (!rows.length) {
      const use = builtUse(cardKey(d.prepare("SELECT oracle_id FROM cards WHERE name = ? COLLATE NOCASE OR name LIKE ? || ' // %' ESCAPE '\\' LIMIT 1").get(name, likeEsc(name))?.oracle_id ?? null, name));
      lines.push(`${name}: NOT OWNED${use ? ` (needed by built decks: ${use})` : ""}`);
      continue;
    }
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
    const key = cardKey(rows[0].oracle_id, rows[0].name);
    const demand = alloc.built.get(key)?.demand ?? 0;
    const basic = isBasicLand(rows[0].name);
    const boxes = basic ? [] : alloc.reserve(key, rows[0].name).boxes;
    const boxed = boxes.reduce((a, b) => a + b.quantity, 0);
    const free = basic ? total : total - demand - boxed;
    const use = (demand ? `; used in built decks: ${builtUse(key)} (can be moved)` : "") + (boxed ? `; ${boxText(boxes)}` : "");
    lines.push(`${label}: ${total} owned, ${free} free${free < 0 ? " (SHORT)" : ""} — ${detail.join(", ")}${use}`);
  }
  return [`${ownedCount} of ${names.length} owned. "free" = owned minus copies claimed by built decks and copies in locked ` +
    "binders (kept for their own deck); those are still owned (in use in another deck or locked binder, can be moved), only NOT OWNED " +
    "cards are to buy.", ...lines].join("\n");
}

/** "in locked binder X of #2 Deck 2x, ..." for allocation reserve().boxes. */
const boxText = (boxes) => boxes.map((b) => `in locked binder ${b.binder}${b.deck_name ? ` of #${b.deck_id} ${b.deck_name}` : " (no deck)"} ${b.quantity}x`).join(", ");

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
  let card = d.prepare(pickSql("c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' ESCAPE '\\'")).get(name, likeEsc(name));
  if (!card) {
    const candidates = d.prepare("SELECT DISTINCT name FROM cards WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 11").all(`%${likeEsc(name)}%`).map((r) => r.name);
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
  // A foreign printing without its own EUR price shows its English twin's (`*_en`, lib/prices.js).
  const priceOf = (k) => prices[k] ?? (k.startsWith("eur") ? prices[`${k}_en`] : null) ?? null;
  const priceParts = ["eur", "eur_foil", "eur_etched", "usd", "usd_foil", "usd_etched"]
    .filter((k) => priceOf(k) != null)
    .map((k) => `${k}${prices[k] == null ? " (English printing)" : ""} ${k.startsWith("eur") ? "€" : "$"}${Number(priceOf(k)).toFixed(2)}`);
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
    `SELECT c.set_code, c.collector_number, col.finish, col.language, col.condition, col.binder, col.quantity, col.source
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id = ? ORDER BY col.quantity DESC`,
  ).all(card.oracle_id);
  const total = owned.reduce((a, r) => a + r.quantity, 0);
  lines.push("", total ? `Owned: ${total} copies` : "Owned: none");
  for (const r of owned) {
    lines.push(`  ${r.quantity}x ${setNum(r)} ${r.finish} ${r.language} ${r.condition}${r.binder ? ` [binder: ${r.binder}]` : ""}${r.source === "scan" ? " (scanned)" : r.source === "app" ? " (organised in app)" : ""}`);
  }
  const usage = cardUsage(d, { oracle_id: card.oracle_id, name: card.name });
  if (usage.built_demand || (usage.boxed && !usage.basic)) {
    const claim = usage.built_demand ? `Built decks claim ${usage.built_demand}` : "";
    const boxed = usage.boxed && !usage.basic ? `${boxText(usage.in_boxes)}` : "";
    lines.push(`${[claim, boxed].filter(Boolean).join("; ")}; free: ${usage.available}${usage.available < 0 ? " (SHORT)" : ""}`);
  }
  if (usage.decks.length) {
    lines.push(`In decks: ${usage.decks.map((k) => `#${k.id} ${k.name} [${k.status}] (${k.quantity}x ${k.board})`).join(", ")}`);
  }
  if (card.scryfall_uri) lines.push(`Scryfall: ${card.scryfall_uri}`);
  return lines.join("\n");
}

function listBindersTool() {
  const { binders, unsorted, collection_master: master } = listBinders(getDb());
  if (!binders.length && !unsorted.copies) return "The user has no binders and no cards in the collection yet.";
  const line = (name, b) => `${name}${b.type ? ` [${b.type.replace("_", " ")}${b.locked ? ", locked" : ""}]` : ""}: ${b.cards} printings, ${b.copies} copies` +
    `${b.copies ? `, value €${(b.value_eur ?? 0).toFixed(2)}` : ""}${b.sources.length ? `, source ${b.sources.join("+")}` : " (empty)"}` +
    `${b.box_deck ? `, box of deck #${b.box_deck.id} ${b.box_deck.name}` : b.locked ? ", locked for every deck (no owner deck)" : ""}` +
    `${b.decks?.length && !b.box_deck ? `, deck ${b.decks.map((d) => `#${d.id} ${d.name}`).join(", ")}` : ""}`;
  const lines = binders.map((b) => line(b.name, b));
  if (unsorted.copies) lines.push(line("(Unsorted, no binder)", unsorted));
  lines.push(`Collection master: ${master === "app" ? "mtg-planner (ManaBox imports add cards)" : "ManaBox (imports replace ManaBox cards)"}`);
  return lines.join("\n");
}

const deckLine = (k) =>
  `#${k.id} ${k.name}${k.format ? ` [${k.format}]` : ""} — ${k.status ?? "idea"}, ${k.card_count} cards, value €${(k.value_eur ?? 0).toFixed(2)}` +
  `${k.missing_count ? `, to buy ${k.missing_count} (€${(k.missing_cost_eur ?? 0).toFixed(2)})` : ""}` +
  `${k.in_use_count ? (k.status === "built"
    ? `, ${k.in_use_count} shared with other built decks (buy extra to play both)`
    : `, ${k.in_use_count} in other built decks (can be moved)`) : ""}` +
  `${k.conflict_count ? `, ${k.conflict_count} CONFLICTS with other built decks` : ""}` +
  `, source ${k.source}, updated ${k.updated_at}` +
  `${k.bracket != null ? ` · B${k.bracket_partial && k.bracket_declared == null ? "≥" : ""}${k.bracket}` : ""}` +
  `${k.score != null ? ` · ${k.score_partial ? "≥" : ""}${k.score.toFixed(1)}/10` : ""}` +
  `${k.legal === false ? " · not Commander-legal" : ""}`;

function shoppingListTool() {
  const { built, per_deck: perDeck } = shoppingList(getDb());
  const eur = (v) => (v == null ? "no EUR price" : `€${v.toFixed(2)}`);
  const lines = [built.items.length
    ? `Built decks are short of ${built.items.length} cards (total ${eur(built.total_eur)}):`
    : "The built decks have every card they need."];
  for (const it of built.items.slice(0, 100)) {
    lines.push(`  ${it.short}x ${it.name} | ${eur(it.price_eur)} each | ${it.decks.map((k) => `#${k.deck_id} ${k.name} ${k.quantity}x`).join(", ")}`);
  }
  if (built.items.length > 100) lines.push(`  ... ${built.items.length - 100} more`);
  if (perDeck.length) {
    lines.push("", "Per deck (to buy = not owned at all; in other decks = owned, claimed by another built deck, can be moved):");
    for (const k of perDeck) {
      lines.push(`  #${k.id} ${k.name} [${k.status}]: ${k.to_buy_count} to buy, ${eur(k.missing_eur)}` +
        `${k.in_use_count ? (k.status === "built"
          ? `; ${k.in_use_count} shared with other built decks (in the built shortage above)`
          : `; ${k.in_use_count} in other decks (buying instead ${eur(k.in_use_eur)})`) : ""}`);
    }
  }
  const wish = wishlistShopping(getDb());
  if (wish.items.length) {
    lines.push("", `Wishlist (not for a deck): ${wish.items.length} cards, ${eur(wish.total_eur)} (details: list_wishlist):`);
    for (const it of wish.items.slice(0, 50)) {
      lines.push(`  ${it.need}x ${it.name} | ${eur(it.price_eur)} each${it.below_max ? " (below the user's max price)" : ""}`);
    }
  }
  return lines.join("\n");
}

// --- wishlist (lib/wishlist.js): list + add only; deleting is app-only ----------

const eurText = (v) => (v == null ? "no EUR price" : `€${v.toFixed(2)}`);
function wishLine(i) {
  const printing = i.any_printing ? "any printing" : `${String(i.set_code || "").toUpperCase()} #${i.collector_number}`;
  const extra = [i.finish === "normal" ? "non-foil" : i.finish, i.language ? i.language.toUpperCase() : null].filter(Boolean);
  return `  #${i.id} ${i.quantity}x ${i.name} (${printing}${extra.length ? `, ${extra.join(", ")}` : ""}) | owned ${i.owned}` +
    `${i.got_it ? " | GOT IT" : ` | to buy ${i.to_buy}, ${eurText(i.price_eur)} each`}` +
    `${i.max_price_eur != null ? ` | max €${i.max_price_eur.toFixed(2)}${i.below_max ? " (price is below max)" : ""}` : ""}` +
    `${i.priority !== "normal" ? ` | ${i.priority} priority` : ""}${i.note ? ` | note: ${i.note}` : ""}`;
}

function listWishlistTool() {
  const { items, totals } = listWishlist(getDb());
  if (!items.length) return "The wishlist is empty.";
  return [`Wishlist: ${totals.items} items, ${totals.to_buy} copies to buy for ${eurText(totals.to_buy_eur)}` +
    `${totals.unpriced ? ` (${totals.unpriced} without EUR price)` : ""}${totals.got_it ? `; ${totals.got_it} already owned (got it)` : ""}:`,
  ...items.slice(0, 200).map(wishLine), ...(items.length > 200 ? [`  ... ${items.length - 200} more`] : [])].join("\n");
}

async function addToWishlistTool(args) {
  const name = String(args.card ?? "").trim();
  if (!name) throw new ToolError("card is required.");
  if (args.collector_number != null && !args.set) throw new ToolError("collector_number needs set.");
  try {
    const { item, merged } = await addWishlistItem(getDb(), {
      name, set: args.set || undefined, collector_number: args.collector_number ?? undefined, quantity: args.quantity,
      finish: args.finish, language: args.language, max_price_eur: args.max_price_eur, priority: args.priority, note: args.note,
    }, { source: "claude" });
    return `${merged ? "Updated" : "Added"} wishlist item:\n${wishLine(item)}\nThe user sees it in the app (Market tab → Wishlist).`;
  } catch (err) {
    if (err instanceof WishlistError) throw new ToolError(err.message);
    throw err;
  }
}

function listDecksTool() {
  const decks = listDecks(getDb());
  return decks.length ? decks.map(deckLine).join("\n") : "The user has no decks yet.";
}

/** target_bracket argument: undefined/null = none, else an integer 1-5 (ToolError otherwise). */
function targetBracket(v) {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 1 || v > 5) throw new ToolError("target_bracket must be an integer 1-5.");
  return v;
}

/**
 * deckDetail with its combos checked when they are missing or stale: one
 * Spellbook call (shared settings, slots and backoff), waiting at most
 * COMBO_WAIT_MS; on timeout/offline the text says "combos not checked".
 * Missing tokens & extras data (all_parts, token rows) is fetched too, as long.
 */
async function detailWithCombos(d, id, { withCombos = true } = {}) {
  let detail = deckDetail(d, id);
  if (!detail) return detail;
  const extras = detail.accessories?.fetch_ids.length ? ensureAccessoryData(d, detail.cards, { timeoutMs: COMBO_WAIT_MS }) : null;
  const combo = withCombos && detail.combos?.needs_fetch && detail.spellbook_request
    ? combos().evaluate(detail.spellbook_request, { waitMs: COMBO_WAIT_MS }) : null;
  if (!extras && !combo) return detail;
  await Promise.all([extras, combo]);
  detail = deckDetail(d, id);
  return withExtrasStatus(detail);
}

/** Token data still missing after a fetch attempt: the text says it came partly from card text. */
function withExtrasStatus(detail) {
  if (detail?.accessories?.fetch_ids.length) detail.accessories.status = "unavailable";
  return detail;
}

async function getDeck(args) {
  const d = getDb();
  const target = targetBracket(args.target_bracket);
  const deck = findDeck(d, args.deck);
  if (!deck) {
    const names = listDecks(d).map(deckLine);
    throw new ToolError(`No deck matches "${args.deck}".${names.length ? `\nDecks:\n${names.join("\n")}` : " The user has no decks."}`);
  }
  const detail = await detailWithCombos(d, deck.id);
  const text = deckToText(detail);
  return target ? `${text}\n\n${bracketVerdict(detail.power, target)}` : text;
}

function getDeckHistory(args) {
  const d = getDb();
  const deck = findDeck(d, args.deck);
  if (!deck) throw new ToolError(`No deck matches "${args.deck}".`);
  const when = (at) => String(at).replace("T", " ").slice(0, 16);
  if (args.version != null) {
    let v;
    try { v = deckVersion(d, deck.id, Number(args.version)); } catch { throw new ToolError(`Deck "${deck.name}" has no version ${args.version}.`); }
    const lines = [`Version ${v.version.id} of deck #${deck.id} "${deck.name}" (${when(v.version.at)} UTC, ${v.version.actor}): ${v.version.summary}`];
    if (!v.diff) lines.push("Oldest kept version: no earlier version to compare with.");
    for (const b of v.diff?.boards ?? []) {
      const parts = [...b.added.map((c) => `+${c.quantity} ${c.name}`), ...b.removed.map((c) => `−${c.quantity} ${c.name}`),
        ...b.changed.map((c) => `${c.name} ${c.from}→${c.to}${c.printing ? " (printing)" : ""}`)];
      lines.push(`${b.board}: ${parts.join("; ")}`);
    }
    for (const m of v.diff?.meta ?? []) lines.push(`${m.field}: ${m.from ?? "-"} → ${m.to ?? "-"}`);
    return lines.join("\n");
  }
  const limit = Number.isInteger(args.limit) ? Math.min(50, Math.max(1, args.limit)) : 10;
  const { versions } = listDeckVersions(d, deck.id);
  const lines = [`History of deck #${deck.id} "${deck.name}" (${versions.length} version${versions.length === 1 ? "" : "s"} kept, newest first):`];
  for (const v of versions.slice(0, limit)) {
    lines.push(`- v${v.id} · ${when(v.at)} · ${v.actor} · ${v.summary} · ${v.card_count} cards${v.current ? " (current)" : ""}`);
  }
  if (versions.length > limit) lines.push(`... ${versions.length - limit} older`);
  return lines.join("\n");
}

/** save_deck / evaluate_deck cards → deck items (ToolError on bad input). */
function cardItems(cards) {
  if (!Array.isArray(cards) || cards.length === 0) throw new ToolError("cards must be a non-empty array.");
  if (cards.length > 500) throw new ToolError("At most 500 cards.");
  return cards.map((c, i) => {
    const cardName = String(c?.name ?? "").trim();
    if (!cardName) throw new ToolError(`cards[${i}] has no name.`);
    if (c.board != null && !BOARDS.includes(c.board)) throw new ToolError(`cards[${i}].board must be one of ${BOARDS.join(", ")}.`);
    // A companion lives on the side board (outside the 99).
    const companion = c.companion === true;
    return {
      name: cardName,
      quantity: int(c.quantity, 1, 1, 999),
      board: companion ? "side" : c.board ?? "main",
      set: c.set ? String(c.set).toLowerCase() : undefined,
      collector_number: c.set && c.collector_number != null ? String(c.collector_number) : undefined,
      ...(companion ? { companion: true } : {}),
    };
  });
}

async function evaluateDeckTool(args) {
  const target = targetBracket(args.target_bracket);
  const hasText = typeof args.decklist === "string" && args.decklist.trim();
  if (!hasText && args.cards == null) throw new ToolError("Give the draft as decklist (text) or cards.");
  if (hasText && args.decklist.length > 200000) throw new ToolError("decklist is too long.");
  const items = hasText ? null : cardItems(args.cards);
  const commander = Array.isArray(args.commander) ? args.commander.slice(0, 2).map(String) : args.commander != null ? String(args.commander) : null;
  const d = getDb();
  const draft = await draftDeck(d, { text: hasText ? args.decklist : null, items, format: args.format ? String(args.format) : null, commander });
  if (!draft.rows.length) {
    throw new ToolError(`No cards recognised${draft.parse_errors.length ? ` (e.g. "${draft.parse_errors[0]}")` : ""}.`);
  }
  const view = draft.request ? await combos().evaluate(draft.request, { waitMs: COMBO_WAIT_MS }) : undefined;
  const p = deckPower(d, draft.deck, draft.rows, { combos: view });
  await ensureAccessoryData(d, draft.rows, { timeoutMs: COMBO_WAIT_MS });
  const acc = accessoriesForRows(d, draft.rows.map(({ all_parts: _p, ...r }) => r));
  if (acc.fetch_ids.length) acc.status = "unavailable";
  const counts = BOARDS.map((b) => `${b} ${draft.rows.filter((r) => r.board === b).reduce((a, r) => a + r.quantity, 0)}`).join(", ");
  const lines = [`Draft${draft.deck.format ? ` [${draft.deck.format}]` : ""} (not saved): ${counts}.${p.power.commander ? "" : " Not a Commander deck: stats only (no bracket or score)."}`];
  if (draft.unresolved.length) lines.push(`Not found on Scryfall (check spelling; left out of the checks): ${draft.unresolved.join("; ")}`);
  if (draft.parse_errors.length) lines.push(`Lines not understood: ${draft.parse_errors.slice(0, 5).join("; ")}${draft.parse_errors.length > 5 ? "; ..." : ""}`);
  lines.push(...powerLines(p));
  if (p.combos?.items.length) {
    const top = p.combos.items.slice(0, 5).map((c) => `${c.cards.join(" + ")} (${c.assembly_mv ?? "?"} mana)`);
    lines.push(`Combos (Commander Spellbook): ${top.join("; ")}${p.combos.items.length > 5 ? "; ..." : ""}`);
  }
  const extras = accessoriesText(acc);
  if (extras) lines.push(extras);
  if (target) lines.push(bracketVerdict(p.power, target));
  return lines.join("\n");
}

async function saveDeckTool(args) {
  const name = String(args.name ?? "").trim();
  if (!name) throw new ToolError("name is required.");
  const items = cardItems(args.cards);
  const target = targetBracket(args.target_bracket);
  const d = getDb();
  let id;
  if (args.status != null && !DECK_STATUSES.includes(args.status)) throw new ToolError(`status must be ${DECK_STATUSES.join(" or ")}.`);
  if (args.deck_id != null) {
    id = Number(args.deck_id);
    if (!Number.isInteger(id) || !d.prepare("SELECT 1 FROM decks WHERE id = ?").get(id)) {
      throw new ToolError(`Deck ${args.deck_id} does not exist. Omit deck_id to create a new deck.`);
    }
  }
  const saved = await saveDeck(d, {
    id, name, format: args.format || null, description: args.description || null, source: "claude", items,
    status: args.status ?? (id ? null : "idea"),
  });
  const lines = [`${id ? "Updated" : "Created"} deck #${saved.id} "${name}". The user can open it in the app's Decks tab.`];
  if (saved.unresolved.length) {
    lines.push(`Could not resolve ${saved.unresolved.length} name(s) on Scryfall (kept as unknown cards — check spelling): ${saved.unresolved.join("; ")}`);
  }
  // With a target the verdict needs the combos (usually cached by the evaluate_deck run before).
  const detail = await detailWithCombos(d, saved.id, { withCombos: Boolean(target) });
  lines.push("", deckToText(detail));
  if (target) lines.push("", bracketVerdict(detail.power, target));
  return lines.join("\n");
}

// --- edit_copies -------------------------------------------------------------

// Making the app the collection master needs the user's OK, not just the model's word: a
// confirm_master refusal stores a one-time token (app meta), and the token is only accepted
// by ANOTHER server process, i.e. a later chat turn (the CLI spawns this server per turn),
// so the user has answered in between. A token is bound to the copies it was issued for
// (oracle card + the matched rows and quantity): it can't flip the master for another edit.
// The new values (set) may differ, so a retry after a refused finish still works. 1 h, single
// use, consumed only when the edit succeeds; up to 10 open tokens (one per question).
const PROCESS_ID = randomBytes(8).toString("hex");
const MASTER_TOKEN_KEY = "claude_master_token";
const MASTER_TOKEN_TTL_MS = 3600 * 1000;
const MASTER_TOKENS_MAX = 10;

function openTokens(d) {
  let saved = null;
  try { saved = JSON.parse(getAppMeta(d, MASTER_TOKEN_KEY) || "null"); } catch { saved = null; }
  const list = Array.isArray(saved?.tokens) ? saved.tokens : [];
  return list.filter((t) => t && typeof t.token === "string" && Date.now() - t.at < MASTER_TOKEN_TTL_MS);
}

function issueMasterToken(d, scope) {
  const token = randomBytes(6).toString("hex");
  const tokens = [...openTokens(d), { token, process: PROCESS_ID, at: Date.now(), scope }].slice(-MASTER_TOKENS_MAX);
  setAppMeta(d, MASTER_TOKEN_KEY, JSON.stringify({ tokens }));
  return token;
}

/**
 * true when `value` is a valid token from an earlier turn for these copies (`scope`); false when
 * absent; ToolError when wrong. Does not consume it: consumeMasterToken after the edit worked.
 */
function masterConfirmed(d, value, scope) {
  if (value == null || value === false) return false;
  const saved = typeof value === "string" ? openTokens(d).find((t) => t.token === value) : null;
  if (saved && saved.process !== PROCESS_ID && saved.scope === scope) return true;
  throw new ToolError(saved?.process === PROCESS_ID
    ? "Not changed: the user has not answered yet. Ask them first; the token works only after their reply."
    : saved
      ? "Not changed: that confirm_master token was issued for other copies. Call without it to ask the user about these."
      : "Not changed: confirm_master must be the token from an earlier confirmation request (call without it to get one).");
}

function consumeMasterToken(d, value) {
  if (typeof value !== "string") return;
  setAppMeta(d, MASTER_TOKEN_KEY, JSON.stringify({ tokens: openTokens(d).filter((t) => t.token !== value) }));
}

const normFinish = (f) => { const v = String(f).trim().toLowerCase(); return v === "nonfoil" ? "normal" : v; };
const normCondition = (c) => String(c).trim().toLowerCase().replace(/[\s-]+/g, "_");
const rowLabel = (r) => `${setNum(r)} ${r.finish} ${r.language} ${r.condition}${r.binder ? ` [binder: ${r.binder}]` : " [Unsorted]"}`;

/** The one oracle card `card` names (oracle_id, exact name or front face); ToolError otherwise. */
function resolveOwnedCard(d, card) {
  const ref = String(card ?? "").trim();
  if (!ref) throw new ToolError("card is required (name or oracle_id).");
  const byOracle = d.prepare("SELECT oracle_id, name FROM cards WHERE oracle_id = ? LIMIT 1").get(ref);
  if (byOracle) return byOracle;
  const hits = d.prepare(
    `SELECT DISTINCT c.oracle_id, c.name FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' ESCAPE '\\'`,
  ).all(ref, likeEsc(ref));
  const oracles = [...new Map(hits.map((h) => [h.oracle_id, h])).values()];
  if (oracles.length > 1) {
    throw new ToolError(`"${ref}" names ${oracles.length} different cards (${oracles.map((o) => `${o.name}: oracle_id ${o.oracle_id}`).join("; ")}). ` +
      "Ask the user which one and pass its oracle_id as card.");
  }
  if (!oracles.length) throw new ToolError(`The user owns no "${ref}" (check the name with search_collection or check_owned).`);
  return oracles[0];
}

/**
 * The new printing for `set.printing` {set, collector_number}: a printing of the same oracle card,
 * in the wanted language when it exists (else English, else the only one). Sources: the cards
 * table, the card index, then Scryfall (/cards/collection gives the English printing).
 */
async function resolveNewPrinting(d, oracle, spec, wantLang) {
  const set = String(spec?.set ?? "").trim().toLowerCase();
  const cn = String(spec?.collector_number ?? "").trim();
  if (!set || !cn) throw new ToolError("set.printing needs set and collector_number.");
  const label = `${set.toUpperCase()} #${cn}`;
  const found = new Map(); // id -> {id, lang, oracle_id, name}
  for (const r of d.prepare("SELECT scryfall_id AS id, lang, oracle_id, name FROM cards WHERE set_code = ? COLLATE NOCASE AND collector_number = ? COLLATE NOCASE").all(set, cn)) {
    found.set(r.id, r);
  }
  const i = getIndex();
  if (i) {
    try {
      for (const r of i.prepare("SELECT id, lang, oracle_id, name FROM printings WHERE set_code = ? AND collector_number = ? COLLATE NOCASE").all(set, cn)) {
        if (!found.has(r.id)) found.set(r.id, r);
      }
    } catch { /* index not built yet */ }
  }
  if (!found.size) {
    try {
      const { cards } = await fetchCollectionPolitely([{ set, collector_number: cn }]);
      for (const c of cards) found.set(c.id, { id: c.id, lang: c.lang, oracle_id: c.oracle_id, name: c.name });
    } catch (err) { log(`Scryfall printing lookup failed: ${err.message}`); }
  }
  if (!found.size) throw new ToolError(`No printing ${label} found (check the set code and collector number, e.g. with the scryfall tools).`);
  const same = [...found.values()].filter((p) => p.oracle_id === oracle.oracle_id);
  if (!same.length) {
    throw new ToolError(`${label} is ${[...found.values()][0].name}, not ${oracle.name}: a printing can only change to another printing of the same card.`);
  }
  return same.find((p) => p.lang === wantLang) ?? same.find((p) => p.lang === "en") ??
    (same.length === 1 ? same[0] : (() => {
      throw new ToolError(`${label} of ${oracle.name} exists in ${same.map((p) => p.lang).join(", ")}: set language to pick one.`);
    })());
}

async function editCopiesTool(args) {
  const d = getDb();
  const oracle = resolveOwnedCard(d, args.card);
  const match = args.match ?? {};
  if (typeof match !== "object" || Array.isArray(match)) throw new ToolError("match must be an object.");
  const set = args.set;
  if (!set || typeof set !== "object" || Array.isArray(set)) throw new ToolError("set is required: {language?, printing?, finish?, condition?}.");
  const unknown = [...Object.keys(match).filter((k) => !["set", "collector_number", "language", "finish", "condition", "binder"].includes(k)),
    ...Object.keys(set).filter((k) => !["language", "printing", "finish", "condition"].includes(k))];
  if (unknown.length) throw new ToolError(`Unknown field(s): ${unknown.join(", ")}.`);
  if (!["language", "printing", "finish", "condition"].some((k) => set[k] != null)) {
    throw new ToolError("set needs at least one of language, printing, finish, condition.");
  }

  // The owned copies of the card that `match` selects.
  const owned = d.prepare(
    `SELECT col.*, c.name, c.set_code, c.collector_number FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id = ? ORDER BY c.set_code, c.collector_number, col.binder, col.id`,
  ).all(oracle.oracle_id);
  const eq = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").trim().toLowerCase();
  const rows = owned.filter((r) =>
    (match.set == null || eq(r.set_code, match.set)) &&
    (match.collector_number == null || eq(r.collector_number, match.collector_number)) &&
    (match.language == null || eq(r.language, match.language)) &&
    (match.finish == null || r.finish === normFinish(match.finish)) &&
    (match.condition == null || r.condition === normCondition(match.condition)) &&
    (match.binder == null || eq(r.binder, match.binder)));
  const groups = groupRows(rows);
  const total = rows.reduce((a, r) => a + r.quantity, 0);
  const list = (gs) => gs.map((g) => `  ${g.quantity}x ${rowLabel(g.row)}`).join("\n");
  if (!total) {
    throw new ToolError(`No owned copies of ${oracle.name} match ${JSON.stringify(match)}. The user owns:\n${list(groupRows(owned))}`);
  }
  if (args.quantity != null && (!Number.isInteger(args.quantity) || args.quantity < 1)) throw new ToolError("quantity must be a positive integer.");
  const quantity = args.quantity ?? (total === 1 ? 1 : null);
  if (quantity == null) {
    throw new ToolError(`${total} copies of ${oracle.name} match:\n${list(groups)}\n` +
      "Ask the user how many (and which) copies to change, then pass quantity (and match).");
  }
  if (quantity > total) throw new ToolError(`Only ${total} matching copies of ${oracle.name}:\n${list(groups)}`);
  if (groups.length > 1 && quantity !== total) {
    throw new ToolError(`${quantity} of ${total} copies is ambiguous: the matching copies differ:\n${list(groups)}\n` +
      "Ask the user which ones, then narrow match (set, collector_number, language, finish, condition, binder).");
  }

  // The new printing (same card) and the edit itself.
  const out = {};
  if (set.language != null) out.language = String(set.language);
  if (set.finish != null) out.finish = normFinish(set.finish);
  if (set.condition != null) out.condition = normCondition(set.condition);
  if (set.printing != null) {
    const langs = new Set(groups.map((g) => g.row.language));
    const wantLang = out.language?.trim().toLowerCase() ?? (langs.size === 1 ? [...langs][0] : "en");
    out.printing_id = (await resolveNewPrinting(d, oracle, set.printing, wantLang)).id;
  }
  const items = groups.map(({ row, quantity: q }) => ({
    scryfall_id: row.scryfall_id, finish: row.finish, language: row.language, condition: row.condition, binder: row.binder,
    quantity: groups.length === 1 ? quantity : q,
  }));
  // The copies a confirm_master token covers (see masterConfirmed).
  const scope = JSON.stringify([oracle.oracle_id, items.map((i) => [i.scryfall_id, i.finish, i.language, i.condition, i.binder.toLowerCase(), i.quantity])]);
  let res;
  try {
    const confirmed = masterConfirmed(d, args.confirm_master, scope);
    res = await editCopies(d, { items, set: out, confirm_master: confirmed, actor: "claude" }, { getPrinting: indexPrinting });
    if (confirmed) consumeMasterToken(d, args.confirm_master);
  } catch (err) {
    if (!(err instanceof BinderError)) throw err;
    if (err.extra?.code === "confirm_master") {
      const token = issueMasterToken(d, scope);
      throw new ToolError(`Not changed yet: ${err.extra.manabox_copies} of these copies were imported from ManaBox. Editing them makes ` +
        "mtg-planner the master of the collection (ManaBox imports then add new cards instead of replacing the collection). " +
        "Explain this to the user and ask; end your answer there. Only if they agree in their next message, call edit_copies " +
        `again with confirm_master: "${token}" (the token is refused in this same turn).`);
    }
    throw new ToolError(err.message);
  }
  if (!res.edit_id) return `Nothing changed: the ${quantity === 1 ? "copy already has" : "copies already have"} these values.`;
  const cards = d.prepare("SELECT set_code, collector_number FROM cards WHERE scryfall_id = ?");
  const now = res.rows.map((r) => `  ${r.quantity}x ${oracle.name} ${rowLabel({ ...r, ...cards.get(r.scryfall_id) })}${r.source === "app" ? " (kept by the app)" : r.source === "scan" ? " (scanned)" : ""}`);
  const lines = [`Edit #${res.edit_id}: ${res.summary}. The user can undo it in the app's edit log.`];
  if (now.length) lines.push("Rows with the edited copies now:", ...now);
  if (res.converted_copies) lines.push(`${res.converted_copies} ManaBox ${res.converted_copies === 1 ? "copy is" : "copies are"} now kept by the app; mtg-planner is the collection master.`);
  return lines.join("\n");
}

/** Owned rows grouped by key without source: copies from ManaBox / scan / app are the same copies to the user. */
function groupRows(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = JSON.stringify([r.scryfall_id, r.finish, r.language, r.condition, r.binder.toLowerCase()]);
    const g = m.get(k) ?? { row: r, quantity: 0 };
    g.quantity += r.quantity;
    m.set(k, g);
  }
  return [...m.values()];
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
          "to hand decks over to the app and edit_copies to correct owned copies (state the exact change first, ask when " +
          "unclear; no deleting, that is app-only). Check ownership with check_owned / search_collection before recommending cards; " +
          "built decks claim their cards and locked binders (deck boxes, precons, binders the user locked) keep theirs, so 'free' " +
          "copies (avail) are what is left for new decks; claimed or locked copies are still owned (in use in another deck or " +
          "locked binder, can be " +
          "moved), not purchases.",
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
  try { idx?.close(); } catch { /* ignore */ }
  process.exit(0);
});
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
log(`started (version ${VERSION}, db ${process.env.DB_FILE || "/data/mtg-planner.db"})`);
