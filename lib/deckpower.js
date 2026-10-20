// Deck power (v0.7.0): stats (lib/deckstats.js), Commander bracket + 1-10
// score (lib/power.js) and the cached Commander Spellbook combos, plus the
// text lines and the target-bracket verdict for Claude, and draftDeck (a
// decklist checked without saving it).
//
// Power (v0.7.0): deckDetail also returns stats (lib/deckstats.js), the
// Commander bracket + 1-10 score (lib/power.js) and the cached Commander
// Spellbook combos. It only READS the Spellbook cache (lib/spellbook.js
// cachedCombos): the network call happens elsewhere (server scheduler, MCP),
// so listDecks stays a local, synchronous read. The power part is memoised per
// deck on everything it depends on, so a list of unchanged decks is cheap.

import { createHash } from "node:crypto";
import { deckStats } from "./deckstats.js";
import { BRACKET_RULES, CEDH_HINT, comboUrl, isCommanderDeck, powerOf, SCORE_BANDS, withAssemblyMv } from "./power.js";
import { cachedCombos, spellbookRequest, spellbookSettings } from "./spellbook.js";
import { normalizeFormat, parseDecklist } from "./deckrules.js";
import { resolveDeckItems } from "./deckresolve.js";

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
