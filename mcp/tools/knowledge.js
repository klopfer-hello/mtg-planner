// Knowledge tools (plan v1.3.0): what the planner cannot know from the collection
// alone. Tournament lists (meta_decks, compare_to_meta), structural gaps of a deck
// against anchors from public lists (deck_gaps), a goldfish simulation
// (simulate_deck), rules and rulings (rules_lookup, get_rulings), new cards
// (recent_cards), combos the collection already holds (owned_combos) and what
// other players run with a commander (commander_staples).
//
// Every web source is cached in the app DB and fetched on demand; a failed
// fetch answers from the cache (or says so) instead of failing the turn.
// Output stays compact: one line per card, capped lists, numbers in words.

import { allocation, cardUsage } from "../../lib/allocation.js";
import { normName } from "../../lib/cardclass.js";
import { nameArgs, nameMatch } from "../../lib/db.js";
import { commanderIdentity } from "../../lib/deckrules.js";
import { deckDetail, findDeck } from "../../lib/decks.js";
import { formatLabel } from "../../lib/formatlegal.js";
import { archetypeShares, compareToMeta, metaDecks, PAUPER_ARCHETYPES, refreshMetaDecks } from "../../lib/metadecks.js";
import { eurOfPrinting } from "../../lib/prices.js";
import { cardRulings, ensureRules, rulesLookup } from "../../lib/rules.js";
import { commanderStaples } from "../../lib/edhrec.js";
import { findCombos, ownedNames } from "../../lib/ownedcombos.js";
import { recentCards } from "../../lib/recentcards.js";
import { cardBlock } from "./collection.js";
import { draftDeck } from "../../lib/deckpower.js";
import { deckGaps, gapsText } from "../../lib/deckgaps.js";
import { simulateDeck, simulationText } from "../../lib/simulate.js";
import { getDb } from "../context.js";
import { eurText, ToolError } from "../format.js";
import { CARDS_SCHEMA, cardItems } from "./decks.js";

const META_FORMATS = ["pauper"];

/** "owned 2 (free 1), €0.30" / "not owned, €0.30" for a card name known locally; "" when unknown. */
export function ownText(d, alloc, name) {
  const c = d.prepare(`SELECT oracle_id, name, prices FROM cards WHERE ${nameMatch("name")} ORDER BY fetched_at DESC LIMIT 1`).get(...nameArgs(name));
  if (!c) return "";
  const u = cardUsage(d, { oracle_id: c.oracle_id, name: c.name }, alloc);
  const eur = eurOfPrinting(c.prices);
  return `${u.owned ? `owned ${u.owned} (free ${Math.max(0, u.available)})` : "not owned"}${eur != null ? `, ${eurText(eur)}` : ""}`;
}

function deckOf(d, ref) {
  const deck = findDeck(d, ref);
  if (!deck) throw new ToolError(`No deck matches "${ref}". Use list_decks for the ids.`);
  return deckDetail(d, deck.id, { accessories: false });
}

async function metaFor(d, format) {
  if (!META_FORMATS.includes(format)) throw new ToolError(`Tournament lists exist for ${META_FORMATS.join(", ")} only (MTGO).`);
  const r = await refreshMetaDecks(d, { format });
  const decks = metaDecks(d, format);
  const note = r.error ? ` (MTGO not reachable: ${r.error}; using ${decks.length ? "the lists from before" : "nothing"})` : "";
  return { decks, note };
}

export const TOOLS = [
  {
    name: "meta_decks",
    description:
      "Current competitive Pauper meta from official MTGO decklists (Challenges + League 5-0s, last 60 days, refreshed every few days): " +
      "archetype shares, and with archetype the core cards (inclusion % and usual copies) plus the best-placed list. " +
      `Archetypes: ${Object.keys(PAUPER_ARCHETYPES).join(", ")}, Other.`,
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: META_FORMATS, default: "pauper" },
        archetype: { type: "string", description: "Show the core of this archetype (name as listed above)." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Tournament meta", readOnlyHint: true, openWorldHint: true },
    run: metaDecksTool,
  },
  {
    name: "deck_gaps",
    description:
      "What a saved Commander or Pauper deck is missing: its lands, ramp, card draw, removal, board wipes, protection and recursion " +
      "(bracket 3+), cheap plays, average mana value and colour fixing, each against the middle half of tuned public decks of its " +
      "format and bracket (Archidekt, WotC precons, MTGO; corpus size given), marked LOW/ok/HIGH, and for every LOW role the user's " +
      "FREE owned cards in its colours that fill it (cards with two roles first). Call it first for upgrades and 'what is missing'.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: ["string", "integer"], description: "Deck id or name." },
        candidates: { type: "integer", minimum: 0, maximum: 10, default: 5, description: "Free owned candidates per gap." },
      },
      required: ["deck"],
      additionalProperties: false,
    },
    annotations: { title: "Deck gaps", readOnlyHint: true, openWorldHint: false },
    run: (args) => {
      const d = getDb();
      const deck = deckOf(d, args.deck);
      return `Deck #${deck.id} "${deck.name}":\n${gapsText(deckGaps(d, deck, { perGap: args.candidates ?? 5 }))}`;
    },
  },
  {
    name: "simulate_deck",
    description:
      "Goldfish a deck: 10 000 seeded solo games (no opponent; same list = same numbers). Reports keepable opening hands, " +
      "land drops on curve (T3/T4), colour screw at T4, flood at T6, interaction by T3, median mana per turn, for Commander " +
      "the turn the commander is cast (vs its mana value) and, when Commander Spellbook knows the deck's combos, the turn one " +
      "is assembled. Use it to back a change with numbers: run it before and after (e.g. 'colour screw 14% → 6%'). " +
      "Give a saved deck, or a draft as cards (+ format/commander).",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: ["string", "integer"], description: "Saved deck: id or (part of) the name." },
        cards: { ...CARDS_SCHEMA, description: "Or a draft list (same shape as save_deck)." },
        format: { type: "string", description: "Format of a draft (commander, pauper, ...)." },
        games: { type: "integer", minimum: 500, maximum: 20000, default: 10000 },
      },
      additionalProperties: false,
    },
    annotations: { title: "Simulate deck", readOnlyHint: true, openWorldHint: false },
    run: simulateDeckTool,
  },
  {
    name: "rules_lookup",
    description:
      "Search WotC's Comprehensive Rules (current version, with the glossary) by words, or read a rule by number " +
      "(\"603.10\" also returns its sub-rules). Use it for every rules or interaction question and cite the rule number " +
      "(e.g. **603.10a**). Combine with get_rulings for card-specific rulings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words (e.g. \"leaves the battlefield trigger look back\") or a rule number." },
        limit: { type: "integer", minimum: 1, maximum: 12, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { title: "Rules lookup", readOnlyHint: true, openWorldHint: true },
    run: rulesLookupTool,
  },
  {
    name: "get_rulings",
    description: "Official rulings (Scryfall / Gatherer) for up to 5 cards by name, newest last. Read them before answering how a card works with another.",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, description: "Exact English card names." } },
      required: ["names"],
      additionalProperties: false,
    },
    annotations: { title: "Card rulings", readOnlyHint: true, openWorldHint: true },
    run: getRulingsTool,
  },
  {
    name: "commander_staples",
    description:
      "What other players run with a commander, from EDHREC (tens of thousands of decks for popular commanders): per card the " +
      "inclusion % (decks with it / decks that could play it), synergy % (how much more than in other decks of those colours) and " +
      "the user's copies + EUR. Optional bracket narrows to EDHREC's bracket page. With deck, cards already in it are marked. " +
      "Prefer high-synergy cards the user owns for free; inclusion alone favours generic staples.",
    inputSchema: {
      type: "object",
      properties: {
        commander: { type: "string", description: "Commander name (or use deck)." },
        deck: { type: ["string", "integer"], description: "Saved deck: its commander is used, its cards are marked." },
        bracket: { type: "integer", minimum: 1, maximum: 5 },
        min_synergy: { type: "integer", description: "Only cards with at least this synergy % (e.g. 20)." },
        limit: { type: "integer", minimum: 5, maximum: 60, default: 25 },
      },
      additionalProperties: false,
    },
    annotations: { title: "Commander staples", readOnlyHint: true, openWorldHint: true },
    run: commanderStaplesTool,
  },
  {
    name: "owned_combos",
    description:
      "Combos (Commander Spellbook) the user's collection already holds: with deck, its cards plus the user's free cards in its " +
      "colour identity (pieces outside the deck are marked); else every free owned card within identity. Lists complete combos " +
      "and combos missing exactly one card (with ownership/EUR of that card). Respect the target bracket: combos are B4 material.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: ["string", "integer"], description: "Saved deck (id or name)." },
        identity: { type: "string", description: "Colour identity like \"wb\" when no deck is given." },
        free_only: { type: "boolean", default: true, description: "false = also cards claimed by built decks or locked binders." },
        max_bracket: { type: "integer", minimum: 1, maximum: 5, description: "Leave out combos tagged above this bracket." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Owned combos", readOnlyHint: true, openWorldHint: true },
    run: ownedCombosTool,
  },
  {
    name: "recent_cards",
    description:
      "Cards from sets released recently (default: the last 12 months, no reprints), newest first: use it for upgrades, since " +
      "these cards may be newer than your knowledge. Filter by identity, format, role (ramp, draw, removal, wipe, protection, " +
      "recursion, interaction, ...) and extra Scryfall syntax; owned copies are marked. Same two-line format as get_cards.",
    inputSchema: {
      type: "object",
      properties: {
        identity: { type: "string", description: "Within this colour identity, e.g. \"bg\" (\"c\" = colourless)." },
        format: { type: "string", description: "Legal in this format, e.g. commander, pauper." },
        role: { type: "string", description: "The app's card role (role: values of search_collection)." },
        since: { type: "string", description: "YYYY-MM-DD (default one year ago)." },
        extra: { type: "string", description: "More Scryfall syntax, e.g. \"t:creature mv<=3\"." },
        owned_only: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 15 },
      },
      additionalProperties: false,
    },
    annotations: { title: "Recent cards", readOnlyHint: true, openWorldHint: true },
    run: recentCardsTool,
  },
  {
    name: "compare_to_meta",
    description:
      "Compare a saved Pauper deck with the MTGO tournament lists of its archetype (detected from signature cards): staples it misses " +
      "(in ≥ 50% of those lists, with ownership and EUR), cards it runs fewer copies of than usual, and its cards almost nobody plays. " +
      "Use it to tune a Pauper deck; it says nothing about casual strength.",
    inputSchema: {
      type: "object",
      properties: { deck: { type: ["integer", "string"], description: "Deck id or name (list_decks)." } },
      required: ["deck"],
      additionalProperties: false,
    },
    annotations: { title: "Compare with the meta", readOnlyHint: true, openWorldHint: true },
    run: compareToMetaTool,
  },
];

async function simulateDeckTool(args) {
  const d = getDb();
  let rows, combosOf = [], label;
  if (args.deck != null) {
    const deck = deckOf(d, args.deck);
    rows = deck.cards;
    combosOf = (deck.combos?.items ?? []).map((c) => c.cards);
    label = `Deck #${deck.id} "${deck.name}"`;
  } else if (args.cards != null) {
    const draft = await draftDeck(d, { items: cardItems(args.cards), format: args.format || null });
    rows = draft.rows;
    label = "Draft";
  } else throw new ToolError("Give deck (saved) or cards (a draft).");
  if (!rows.some((r) => r.board === "main" || r.board === "commander")) throw new ToolError("The list has no main deck cards.");
  return `${label}:\n${simulationText(simulateDeck(rows, { games: args.games ?? 10000, combos: combosOf }))}`;
}

const cut = (s, n = 500) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")} …` : s);

async function rulesLookupTool(args) {
  const d = getDb();
  const state = await ensureRules(d);
  if (!state.rules) return `The Comprehensive Rules are not available (${state.error}).`;
  const hits = rulesLookup(d, args.query, { limit: args.limit ?? 5 });
  if (!hits.length) return `No rule matches "${args.query}". Try other words or a rule number.`;
  return hits.map((r) => `${r.rule_no === "glossary" ? "Glossary" : r.rule_no}: ${cut(r.text)}`).join("\n");
}

async function getRulingsTool(args) {
  const d = getDb();
  const out = [];
  for (const name of [...new Set((args.names || []).map((n) => String(n).trim()).filter(Boolean))].slice(0, 5)) {
    try {
      const r = await cardRulings(d, name);
      if (!r) { out.push(`${name}: unknown card name.`); continue; }
      out.push(`${r.name}: ${r.rulings.length ? "" : "no rulings."}${r.stale ? " (cached, Scryfall not reachable)" : ""}`);
      for (const x of r.rulings.slice(-8)) out.push(`  ${x.date}: ${cut(x.text, 350)}`);
      if (r.rulings.length > 8) out.push(`  (${r.rulings.length - 8} older rulings left out)`);
    } catch (err) {
      out.push(`${name}: rulings not available (${err.message}).`);
    }
  }
  return out.join("\n");
}

const commandersOf = (deck) => deck.cards.filter((c) => c.board === "commander").map((c) => c.card_name || c.name);

async function commanderStaplesTool(args) {
  const d = getDb();
  const deck = args.deck != null ? deckOf(d, args.deck) : null;
  const commander = args.commander || (deck && commandersOf(deck)[0]);
  if (!commander) throw new ToolError(deck ? `Deck #${deck.id} has no commander.` : "Give commander or deck.");
  let r;
  try {
    r = await commanderStaples(d, commander, { bracket: args.bracket ?? null });
  } catch (err) {
    if (err.status === 404) throw new ToolError(`EDHREC has no page for "${commander}" (check the name, or it is too new).`);
    throw new ToolError(`EDHREC not reachable (${err.message}).`);
  }
  const inDeck = new Set((deck?.cards ?? []).map((c) => normName(c.card_name || c.name)));
  const alloc = allocation(d);
  const cards = r.cards.filter((c) => normName(c.name) !== normName(commander) && (args.min_synergy == null || c.synergy >= args.min_synergy)).slice(0, args.limit ?? 25);
  const lines = [`EDHREC ${commander}${r.bracket ? ` (bracket ${r.bracket} page)` : ""}: ~${r.decks.toLocaleString("en")} decks, data from ${String(r.fetched_at).slice(0, 10)}${r.stale ? " (cached, EDHREC not reachable)" : ""}.`];
  for (const c of cards) {
    const own = ownText(d, alloc, c.name);
    lines.push(`${c.name} · ${c.inclusion}% · synergy ${c.synergy >= 0 ? "+" : ""}${c.synergy}%${own ? ` · ${own}` : ""}${inDeck.has(normName(c.name)) ? " · IN DECK" : ""}`);
  }
  return lines.join("\n");
}

async function ownedCombosTool(args) {
  const d = getDb();
  const deck = args.deck != null ? deckOf(d, args.deck) : null;
  const commanders = deck ? commandersOf(deck) : [];
  const identity = deck ? commanderIdentity(deck.cards) : args.identity ?? null;
  if (!deck && identity == null) throw new ToolError("Give deck or identity.");
  const deckNames = (deck?.cards ?? []).filter((c) => c.board !== "commander" && c.board !== "maybe").map((c) => (c.card_name || c.name).split(" // ")[0]);
  const names = [...new Set([...deckNames, ...ownedNames(d, { identity, freeOnly: args.free_only !== false })])];
  let r;
  try {
    r = await findCombos(d, names, { commanders });
  } catch (err) {
    throw new ToolError(`Combos not available: ${err.message}.`);
  }
  const inDeck = new Set([...deckNames, ...commanders].map(normName));
  const ok = (c) => args.max_bracket == null || c.bracket == null || c.bracket <= args.max_bracket;
  const mark = (n) => (deck && !inDeck.has(normName(n)) ? `${n} (collection)` : n);
  const line = (c) => `${c.cards.map(mark).join(" + ")} → ${c.produces.join(", ") || "?"}${c.bracket ? ` · B${c.bracket}+` : ""}${c.mana_value != null ? ` · ${c.mana_value} mana` : ""}`;
  const alloc = allocation(d);
  const complete = r.complete.filter(ok).slice(0, 8), almost = r.one_missing.filter(ok).slice(0, 8);
  const lines = [`Spellbook over ${r.names} cards${deck ? ` (deck #${deck.id} + free cards in ${identity || "colourless"})` : ` within ${identity || "colourless"}`}${r.truncated ? " (list cut)" : ""}${r.stale ? " (cached)" : ""}:`];
  lines.push(complete.length ? `Complete (${r.complete.length}):` : "Complete: none.");
  for (const c of complete) lines.push(`  ${line(c)}`);
  if (almost.length) {
    lines.push(`One card missing (${r.one_missing.length}):`);
    for (const c of almost) lines.push(`  ${line(c)} · missing ${c.missing.map((n) => { const o = ownText(d, alloc, n); return o ? `${n} (${o})` : n; }).join(", ")}`);
  }
  return lines.join("\n");
}

async function recentCardsTool(args) {
  const d = getDb();
  let r;
  try {
    r = await recentCards(d, { identity: args.identity ?? null, format: args.format ?? null, role: args.role ?? null, since: args.since ?? null, extra: args.extra ?? "", ownedOnly: args.owned_only === true });
  } catch (err) {
    throw new ToolError(/Unknown role/.test(err.message) ? err.message : `Scryfall not reachable (${err.message}).`);
  }
  const alloc = allocation(d);
  const shown = r.cards.slice(0, args.limit ?? 15);
  const head = `${r.total} new cards since ${r.since} (${r.query})${r.stale ? " (cached)" : ""}${r.total > shown.length ? `, showing ${shown.length}` : ""}:`;
  return [head, ...shown.map((c) => cardBlock(d, alloc, c, ` | ${String(c.set_code || "?").toUpperCase()}`))].join("\n");
}

async function metaDecksTool(args) {
  const d = getDb();
  const format = args.format || "pauper";
  const { decks, note } = await metaFor(d, format);
  if (!decks.length) return `No ${formatLabel(format)} tournament lists stored${note}.`;
  const dates = decks.map((x) => x.date).filter(Boolean).sort();
  const lines = [`${formatLabel(format)} meta: ${decks.length} MTGO lists, ${dates[0]} to ${dates.at(-1)}${note}.`];
  if (!args.archetype) {
    lines.push(`Archetypes: ${archetypeShares(decks).slice(0, 14).map((s) => `${s.archetype} ${s.pct}%`).join(" · ")}`);
    return lines.join("\n");
  }
  const want = String(args.archetype).toLowerCase();
  const name = Object.keys(PAUPER_ARCHETYPES).find((a) => a.toLowerCase() === want) ?? (want === "other" ? "Other" : null);
  if (!name) throw new ToolError(`Unknown archetype "${args.archetype}". Archetypes: ${Object.keys(PAUPER_ARCHETYPES).join(", ")}, Other.`);
  const peers = decks.filter((x) => x.archetype === name);
  if (!peers.length) return `${lines[0]}\nNo ${name} lists in that period.`;
  const core = compareToMeta(peers, []).missing; // nothing owned in an empty list: every ≥ 50% card
  const alloc = allocation(d);
  lines.push(`${name}: ${peers.length} lists (${Math.round((peers.length / decks.length) * 100)}% of the meta). Core (in ≥ 50% of them):`);
  for (const c of core) lines.push(`  ${c.copies}x ${c.name} · ${c.pct}%${(() => { const o = ownText(d, alloc, c.name); return o ? ` · ${o}` : ""; })()}`);
  const best = [...peers].sort((a, b) => (Number(a.placing) || 99) - (Number(b.placing) || 99))[0];
  lines.push(`Best placed: ${best.player} (${best.placing ?? "?"}, ${best.date}): ${best.main.map((c) => `${c.quantity} ${c.name}`).join(", ")}` +
    `${best.side.length ? ` | side: ${best.side.map((c) => `${c.quantity} ${c.name}`).join(", ")}` : ""}`);
  return lines.join("\n");
}

async function compareToMetaTool(args) {
  const d = getDb();
  const deck = deckOf(d, args.deck);
  const format = deck.format || "pauper";
  const { decks, note } = await metaFor(d, format);
  if (!decks.length) return `No ${formatLabel(format)} tournament lists to compare with${note}.`;
  const r = compareToMeta(decks, deck.cards);
  const alloc = allocation(d);
  const own = (n) => { const o = ownText(d, alloc, n); return o ? ` (${o})` : ""; };
  const lines = [`Deck #${deck.id} "${deck.name}" looks like ${r.archetype}; compared with ${r.peers} MTGO lists (${r.peers_archetype})${note}.`];
  lines.push(r.missing.length ? `Missing staples: ${r.missing.map((c) => `${c.copies}x ${c.name} ${c.pct}%${own(c.name)}`).join("; ")}` : "Missing staples: none.");
  if (r.fewer.length) lines.push(`Fewer copies than usual: ${r.fewer.map((c) => `${c.name} ${c.mine} vs ${c.copies} (${c.pct}%)`).join("; ")}`);
  if (r.rare.length) lines.push(`Rare in the meta (≤ 10% of lists): ${r.rare.join(", ")}`);
  return lines.join("\n");
}
