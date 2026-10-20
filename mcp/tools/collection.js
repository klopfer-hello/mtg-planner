// Collection tools: overview, search (the app's query syntax), check_owned,
// get_card and list_binders. Read-only.

import { cardPrice, formatPrice, stats } from "../../lib/db.js";
import { QUERY_HELP, searchCollection } from "../../lib/query.js";
import { allocation, cardKey, cardUsage, isBasicLand, listDecks } from "../../lib/decks.js";
import { listBinders } from "../../lib/binders.js";
import { getDb } from "../context.js";
import { boxText, colorLabel, deckLine, int, likeEsc, mainType, oneLine, OWNED_BY_NAME, parseJson, setNum, ToolError } from "../format.js";

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

export const TOOLS = [
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
      "language. Terms are ANDed; 'or' and (parentheses) combine alternatives (t:goblin or t:elf; c:r (t:instant or " +
      "t:sorcery)); prefix a term or a group with '-' to negate it; quote multi-word values.\n" +
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
];

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
