// Deck tools: list/get/history, evaluate_deck (dry run: stats, bracket, score,
// combos), shopping_list, and the two deck writes save_deck and
// update_deck_notes (actor claude, kept in the deck history).

import { BOARDS, DECK_STATUSES, DeckError } from "../../lib/deckrules.js";
import { bracketVerdict, deckPower, draftDeck, powerLines } from "../../lib/deckpower.js";
import { DECK_NOTES_MAX, setDeckNotes } from "../../lib/deckedit.js";
import { deckDetail, findDeck, listDecks, saveDeck, shoppingList } from "../../lib/decks.js";
import { deckToText } from "../../lib/decktext.js";
import { wishlistShopping } from "../../lib/wishlist.js";
import { deckVersion, listDeckVersions } from "../../lib/deckhistory.js";
import { guideMeta } from "../../lib/deckguide.js";
import { accessoriesForRows, accessoriesText, ensureAccessoryData } from "../../lib/accessories.js";
import { COMBO_WAIT_MS, combos, getDb } from "../context.js";
import { deckLine, int, ToolError } from "../format.js";

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

export const TOOLS = [
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
    name: "update_deck_notes",
    description:
      "Replace the notes of one deck (shown on the deck page, Markdown: short ## headings, - bullets, **bold**, mana as " +
      "{G}) without touching its cards. Use it for strategy notes, a game plan or reminders the user asks for. Keep them " +
      "short and scannable on a phone (≤ ~25 lines). Send the COMPLETE new text: it replaces the old notes (get_deck shows " +
      "them); an empty string clears them. Say in one line what you change before calling. The previous notes stay in " +
      "the deck's History, so the user can go back in the app.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: ["string", "integer"], description: "Deck id, or (part of) the deck name." },
        notes: { type: "string", maxLength: DECK_NOTES_MAX, description: `The full new notes in Markdown (max ${DECK_NOTES_MAX} characters).` },
      },
      required: ["deck", "notes"],
      additionalProperties: false,
    },
    annotations: { title: "Update deck notes", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: updateDeckNotesTool,
  },
];

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

/**
 * The deck guide line for get_deck: the app writes beginner guides (Decks → deck → Guide, also as PDF);
 * Claude can point the user there instead of writing a long play guide into the chat.
 */
function guideLine(d, deckId) {
  let g = null;
  try { g = guideMeta(d, deckId); } catch { g = null; } // an older database without deck_guides
  if (!g) return "Deck guide: none yet. The user can make one in the app (Decks → this deck → Guide → Write the guide; also as a PDF).";
  const kind = g.kind === "facts" ? " (facts only, no strategy part)" : "";
  const stale = g.stale ? ", the deck changed since (Write it again updates it)" : "";
  return `Deck guide: written ${String(g.created_at).slice(0, 10)}${kind}${stale}. The user opens it on the deck page (Guide, or PDF).`;
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
  const text = `${deckToText(detail)}\n${guideLine(d, deck.id)}`;
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

function updateDeckNotesTool(args) {
  const d = getDb();
  const deck = findDeck(d, args.deck);
  if (!deck) throw new ToolError(`No deck matches "${args.deck}". Use list_decks for the ids.`);
  if (typeof args.notes !== "string") throw new ToolError("notes must be text (an empty string clears them).");
  let stored;
  try {
    stored = setDeckNotes(d, deck.id, args.notes, { actor: "claude" });
  } catch (err) {
    if (err instanceof DeckError) throw new ToolError(err.message);
    throw err;
  }
  if ((deck.description ?? null) === stored) return `The notes of deck #${deck.id} "${deck.name}" are unchanged.`;
  return stored
    ? `Updated the notes of deck #${deck.id} "${deck.name}" (${stored.length} characters). The user sees them on the deck page; the old notes are in the deck's History.`
    : `Cleared the notes of deck #${deck.id} "${deck.name}". The old notes are in the deck's History.`;
}
