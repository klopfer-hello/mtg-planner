// Deck power: the Commander bracket (official-rule floors) and a 1-10 score
// (plan v0.7.0 §4, §5, user decisions 2026-10-15).
//
// Why rules-first: the bracket a deck gets must be explainable with WotC's own
// rules, so every number comes from a floor that names the cards that set it
// (Game Changers, mass land denial, extra turns, two-card combos). Nothing else
// can raise it: tutors only feed the score (WotC dropped the tutor limits on
// 2025-10-21), Commander Spellbook's own bracket tag is a second opinion, and
// Brackets 1 and 5 are intent, so only the user sets them (`bracket_declared`).
// The score is an additive sum of capped categories (WEIGHTS), never clamped to
// the bracket; a note says when it falls outside the bracket's usual band.
//
// Pure and synchronous: it works on deckDetail's rows (deck_cards joined with
// cards), lib/deckstats.js and lib/cardclass.js, plus the Spellbook cache view
// (lib/spellbook.js cachedCombos). When combos were not checked (offline,
// disabled, pending) the combo category gives 0 and both results are partial
// ("≥"): going online can only add, so values stay comparable.
//
// Only commander decks get a bracket and a score (isCommanderDeck): the
// weights are absolute counts calibrated on 100-card decks.

import { parseJson as json } from "./db.js";
import { canPair, isBasicLand } from "./deckrules.js";
import { deckStats } from "./deckstats.js";
import { classifyByName, classifyCard, frontType, hasTag, isLand, mergeSpellbook, normName, tagOf } from "./cardclass.js";

// ---------------------------------------------------------------------------
// Rules

/**
 * The official bracket rules, as of the date below. Sources:
 * https://magic.wizards.com/en/formats/commander,
 * https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta,
 * https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025,
 * https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026.
 * `meaning` is the official minimum game length (2025-10-21). The rest are
 * this app's heuristics on top (extra-turn chaining, the ≤4 mana combo cut-off).
 */
export const BRACKET_RULES = Object.freeze({
  as_of: "2026-02-09",
  brackets: Object.freeze({
    1: Object.freeze({ label: "Exhibition", meaning: "games usually last 9+ turns", gc_max: 0 }),
    2: Object.freeze({ label: "Core", meaning: "games usually last 8+ turns", gc_max: 0 }),
    3: Object.freeze({ label: "Upgraded", meaning: "games usually last 6+ turns", gc_max: 3 }),
    4: Object.freeze({ label: "Optimized", meaning: "games usually last 4+ turns", gc_max: Infinity }),
    5: Object.freeze({ label: "cEDH", meaning: "games can end at any time (competitive)", gc_max: Infinity }),
  }),
  /** Auto value never goes above this: B5 (and B1) are the user's call. */
  auto_max: 4,
  /** Extra-turn cards from which chaining is likely (heuristic) → floor 3. */
  extra_turn_chain: 3,
  /** Two-card combo needing at most this much mana → floor 4 ("no two-card combo before turn 6"). */
  fast_combo_mv: 4,
  tutor_rule_removed: "2025-10-21",
  mld_definition: "regularly destroy, exile, and bounce other lands, keep lands tapped, or change what mana is produced by four or more lands per player",
});

/** The playgroup.gg bracket-calculator bands for the score (https://playgroup.gg/commander/bracket-calculator). */
export const SCORE_BANDS = Object.freeze({ 1: [1, 4.5], 2: [1, 4.5], 3: [4.5, 7.5], 4: [7, 9.5], 5: [8.5, 10] });

/**
 * Score weights. Plan §5 values (2026-10-15), tuned 2026-10-16 on the
 * calibration set (test/fixtures/decks-calibration, test/calibration.test.js):
 * fast mana 0.35 → 0.55 each (cap 1.5 → 1.75), tutors 0.3/0.15 → 0.4/0.2,
 * a fast two-card combo 1.2 → 1.5 and a 3+-card one 0.25 → 0.4, draw engines
 * 0.12 → 0.18, interaction cap 1.25 → 1.0 (precons already hit it). Caps sum
 * to 9, so score = 1 + Σ points lands in 1-10. Combo speed bands re-fitted
 * 2026-10-16 when the combo cost became the assembly cost (comboAssemblyMv:
 * manaValueNeeded + the battlefield pieces' mana value, typically 4-8 higher
 * than manaValueNeeded alone): fast ≤ 8, slow ≥ 12 (were ≤ 4 / ≥ 7 on
 * manaValueNeeded); the calibration scores came back unchanged.
 */
export const WEIGHTS = Object.freeze({
  speed: Object.freeze({ max: 1.0, curve: [[2.0, 1.0], [2.5, 0.7], [3.0, 0.45], [3.5, 0.2], [4.0, 0]], top_heavy_mv: 6, top_heavy_n: 12, top_heavy_penalty: 0.1 }),
  fast_mana: Object.freeze({ max: 1.75, each: 0.55, sol_ring: 0.2 }),
  tutors: Object.freeze({ max: 1.0, cheap_cmc: 2, cheap: 0.4, other: 0.2, transmute: 0.2 }),
  combos: Object.freeze({ max: 2.0, fast: 1.5, mid: 0.8, slow: 0.4, longer: 0.4, factors: [1, 0.5, 0.25], fast_mv: 8, slow_mv: 12 }),
  interaction: Object.freeze({ max: 1.0, removal: 0.08, counter: 0.1, free_interaction: 0.3, wipe: 0.12, protection: 0.05, target: 12 }),
  draw: Object.freeze({ max: 1.0, draw_engine: 0.18, draw_burst: 0.05, cantrip: 0.02, target: 10 }),
  ramp: Object.freeze({ max: 0.75, each: 0.06, target: 10 }),
  mana_base: Object.freeze({ max: 0.5, fixing: 0.3, tapped_factor: 0.5, balanced: 0.2, balanced_ratio: 0.9, short: -0.2, short_lands: 32, short_ramp: 8 }),
});

/**
 * The "looks cEDH-like" hint (plan §4.3 step 12; never sets 5). Thresholds
 * tuned 2026-10-16 on the calibration set: the plan's fast mana ≥ 5 and avg
 * MV ≤ 2.3 matched none of the three current cEDH lists (post Mana Crypt ban
 * midrange runs 4 fast mana; storm decks sit at avg MV 2.4).
 */
export const CEDH_HINT = Object.freeze({ fast_mana: 4, tutors: 6, cheap_tutors: 2, cheap_tutor_cmc: 2, combo_mv: 4, avg_mv: 2.5 });

const CATEGORY_LABELS = {
  speed: "Speed", fast_mana: "Fast mana", tutors: "Tutors", combos: "Combos", interaction: "Interaction",
  draw: "Card draw", ramp: "Ramp", mana_base: "Mana base",
};
const SOURCE_ORDER = ["spellbook", "scryfall", "list", "name", "regex"];
const COMMANDER_FORMATS = new Set(["commander", "edh", "cedh"]);
const WUBRG = "WUBRG";

// ---------------------------------------------------------------------------
// Helpers

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const qtyOf = (r) => {
  const n = Number(r?.quantity ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const isCounted = (r) => !r.companion && (r.board === "commander" || r.board === "main");
const isResolved = (r) => r.scryfall_id != null;
const isOffline = (r) => isResolved(r) && r.fetched_at === "";
const fmtNames = (names, max = 5) => names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} +${names.length - max} more`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const colourSet = (v) => {
  const list = typeof v === "string" && !v.trim().startsWith("[") ? v.split("") : json(v, []);
  return new Set((Array.isArray(list) ? list : []).map((c) => String(c).toUpperCase()).filter((c) => WUBRG.includes(c)));
};
const sourcesOf = (entries) => SOURCE_ORDER.filter((s) => entries.some((e) => e.source === s)).join("+");
const isBasic = (r) => /\bBasic\b/.test(frontType(r)) || isBasicLand(r.name);

/**
 * True for a commander deck: format commander/edh/cedh (any case), or no format
 * (ManaBox decks are stored without one) and either a commander board or 98-101
 * cards in commander + main. Everything else gets stats only.
 */
export function isCommanderDeck(deck, rows) {
  const format = typeof deck?.format === "string" ? deck.format.trim().toLowerCase() : "";
  if (format) return COMMANDER_FORMATS.has(format);
  let commander = 0, total = 0;
  for (const r of rows || []) {
    if (r.companion) continue;
    if (r.board === "commander") commander += qtyOf(r);
    if (r.board === "commander" || r.board === "main") total += qtyOf(r);
  }
  return commander > 0 || (total >= 98 && total <= 101);
}

/** True when the cache view (cachedCombos) holds a usable result: ok or stale. */
const combosChecked = (combos) => (combos?.status === "ok" || combos?.status === "stale") && combos.result != null;

// ---------------------------------------------------------------------------
// Legality (a badge, never a bracket number)

/**
 * Commander legality problems of a deck's rows: banned / not legal cards (also
 * Spellbook's banned list), colour identity outside the commanders', singleton
 * duplicates (cards that allow any number / up to N are fine), size ≠ 100,
 * more than 2 commanders or 2 that cannot pair. Unknown rows (unresolved or
 * offline fallback) are left out and counted in `unchecked`. Returns {ok,
 * problems[{rule, text, cards[]}], unchecked, notes[]}.
 */
export function legality(deck, rows, { combos = null } = {}) {
  const problems = [];
  const notes = [];
  const all = (rows || []).filter((r) => isCounted(r) || r.companion);
  const counted = all.filter(isCounted);
  const commanders = counted.filter((r) => r.board === "commander");
  const known = all.filter((r) => isResolved(r) && !isOffline(r));
  const unchecked = all.filter((r) => !isResolved(r) || isOffline(r)).reduce((s, r) => s + qtyOf(r), 0);
  const suffix = " (only OK in Bracket 1 by agreement)";

  // Banned / not legal.
  const sbBanned = new Set(combosChecked(combos) ? (combos.result.banned || []).map(normName) : []);
  const banned = [], notLegal = [];
  for (const r of all) {
    const status = json(r.legalities, {})?.commander;
    if (status === "banned" || sbBanned.has(normName(r.name))) banned.push(r.name);
    else if (isResolved(r) && !isOffline(r) && status === "not_legal") notLegal.push(r.name);
  }
  if (banned.length) problems.push({ rule: "banned", text: `Banned in Commander: ${fmtNames(banned)}${suffix}`, cards: banned });
  if (notLegal.length) problems.push({ rule: "not_legal", text: `Not legal in Commander: ${fmtNames(notLegal)}${suffix}`, cards: notLegal });

  // Colour identity (not checked while a commander has no card data: its
  // identity is unknown, so every coloured card would look outside it).
  const cmdUnknown = commanders.some((r) => !isResolved(r) || isOffline(r) || r.color_identity == null);
  if (commanders.length && cmdUnknown) notes.push("Commander not identified: colour identity not checked");
  else if (commanders.length) {
    const ident = new Set();
    for (const r of commanders) for (const c of colourSet(r.color_identity)) ident.add(c);
    const outside = known.filter((r) => r.board !== "commander" && [...colourSet(r.color_identity)].some((c) => !ident.has(c))).map((r) => r.name);
    if (outside.length) {
      const id = WUBRG.split("").filter((c) => ident.has(c)).join("") || "colourless";
      problems.push({ rule: "identity", text: `Outside the commander's colours (${id}): ${fmtNames(outside)}${suffix}`, cards: outside });
    }
  } else notes.push("No commander set: colour identity not checked");

  // Singleton (cards without data are left out: counted in `unchecked`).
  const perName = new Map();
  for (const r of counted) {
    if (!isResolved(r) || isOffline(r)) continue;
    const key = normName(r.name);
    const e = perName.get(key) ?? { name: r.name, n: 0, row: r };
    e.n += qtyOf(r);
    if (isResolved(r)) e.row = r;
    perName.set(key, e);
  }
  const dupes = [];
  for (const e of perName.values()) {
    if (e.n <= 1 || isBasic(e.row)) continue;
    const text = String(e.row.oracle_text || "");
    if (/A deck can have any number of cards named/i.test(text)) continue;
    const upTo = /A deck can have up to (\w+) cards named/i.exec(text);
    const limit = upTo ? (Number(upTo[1]) || WORDS[upTo[1].toLowerCase()] || 1) : 1;
    if (e.n > limit) dupes.push(`${e.n}x ${e.name}`);
  }
  if (dupes.length) problems.push({ rule: "singleton", text: `More than one copy: ${fmtNames(dupes)}${suffix}`, cards: dupes.map((d) => d.replace(/^\d+x /, "")) });

  // Size and commanders.
  const total = counted.reduce((s, r) => s + qtyOf(r), 0);
  if (total !== 100) problems.push({ rule: "size", text: `${total} cards with the commander, not 100${suffix}`, cards: [] });
  const nCmd = commanders.reduce((s, r) => s + qtyOf(r), 0);
  if (nCmd > 2) problems.push({ rule: "commanders", text: `${nCmd} commanders: at most 2 that can pair${suffix}`, cards: commanders.map((r) => r.name) });
  else if (nCmd === 2) {
    const [a, b] = commanders.length === 2 ? commanders : [commanders[0], commanders[0]];
    const checkable = isResolved(a) && isResolved(b) && !isOffline(a) && !isOffline(b);
    if (checkable && !canPair(a, b)) {
      problems.push({ rule: "commanders", text: `${a.name} and ${b.name} cannot be commanders together (no partner, background or doctor pairing)${suffix}`, cards: commanders.map((r) => r.name) });
    }
  }
  if (unchecked) notes.push(`${plural(unchecked, "card")} not checked (card data missing)`);
  return { ok: problems.length === 0, problems, unchecked, notes };
}
const WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// ---------------------------------------------------------------------------
// Card facts (local classification + Spellbook flags merged per deck)

/** Spellbook per-card flags by normalised name, from a trimmed result. */
function spellbookFlags(result) {
  const flags = new Map();
  const set = (names, key) => {
    for (const n of names || []) {
      const k = normName(n);
      flags.set(k, { ...flags.get(k), [key]: true });
    }
  };
  set(result?.gc, "gameChanger");
  set(result?.mld, "massLandDenial");
  set(result?.extra_turns, "extraTurn");
  return flags;
}

/**
 * Per counted card (commander + main, no companion): {row, name, qty, tags,
 * unresolved, unknown_flag (Game Changer status not known), identified}.
 */
function deckFacts(rows, combos) {
  const checked = combosChecked(combos);
  const flags = checked ? spellbookFlags(combos.result) : new Map();
  const sbUnresolved = new Set(checked ? (combos.result.unresolved || []).map(normName) : []);
  const byName = new Map();
  for (const r of rows || []) {
    if (!isCounted(r)) continue;
    const key = normName(r.name);
    const seenBySpellbook = checked && !sbUnresolved.has(key);
    let tags, identified = true, unknownFlag = false;
    if (isResolved(r)) {
      tags = classifyCard(r);
      unknownFlag = r.game_changer == null && !hasTag(tags, "game_changer") && !seenBySpellbook;
    } else {
      const byList = classifyByName(r.name);
      tags = byList.tags;
      identified = byList.known || seenBySpellbook;
    }
    const f = flags.get(key);
    if (f) tags = mergeSpellbook(tags, f);
    const prev = byName.get(key);
    if (prev) { prev.qty += qtyOf(r); continue; }
    byName.set(key, { row: r, name: r.name, qty: qtyOf(r), tags, unresolved: !isResolved(r), identified, unknown_flag: unknownFlag });
  }
  return [...byName.values()];
}

const cardsWith = (facts, tag) => facts.filter((f) => hasTag(f.tags, tag));
const cardEntry = (f, tag) => {
  const t = tagOf(f.tags, tag);
  return { name: f.name, source: t?.source ?? null, why: t?.why ?? null };
};

// ---------------------------------------------------------------------------
// Combos

const WIN_RE = /win the game|infinite/i;
/** A combo that counts at all: relevant (or borderline) and it wins, goes infinite, locks or takes turns. */
const isPowerCombo = (c) => Boolean((c.relevant || c.borderlineRelevant)
  && ((c.produces || []).some((p) => WIN_RE.test(p)) || c.lock || c.skipTurns || c.controlAllOpponents || c.extraTurn));
const isTwoCard = (c) => c.definitelyTwoCard || c.arguablyTwoCard;

/** Mana value by normalised name of the counted rows with card data (commander included). */
function cmcByName(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!isCounted(r) || !isResolved(r) || isOffline(r) || r.cmc == null || r.cmc === "") continue;
    const v = Number(r.cmc);
    if (!Number.isFinite(v)) continue;
    for (const n of [r.name, r.card_name]) if (n) out.set(normName(n), v);
  }
  return out;
}

/**
 * Mana to assemble a combo: Spellbook's manaValueNeeded (mana spent during
 * the combo and for pieces cast from hand) plus the mana value of every piece
 * that must already be on the battlefield (`battlefield`, from trimResult).
 * null = unknown (no manaValueNeeded, or a battlefield piece without a known
 * mana value in this deck).
 */
export function comboAssemblyMv(c, cmcs) {
  if (c?.manaValueNeeded == null) return null;
  let mv = c.manaValueNeeded;
  for (const n of c.battlefield || []) {
    const v = cmcs.get(normName(n));
    if (v == null) return null;
    mv += v;
  }
  return mv;
}

/** Each combo of a trimmed result with `assembly_mv` (comboAssemblyMv against these deck rows). */
export function withAssemblyMv(combos, rows) {
  const cmcs = cmcByName(rows);
  return (combos || []).map((c) => ({ ...c, assembly_mv: comboAssemblyMv(c, cmcs) }));
}

const mvText = (c) => (c.assembly_mv == null ? "mana unknown" : `${c.assembly_mv} mana`);
const comboName = (c) => c.cards.join(" + ");
/** Spellbook combo page. */
export const comboUrl = (id) => `https://commanderspellbook.com/combo/${encodeURIComponent(id)}/`;

/** The combo floor of one combo (4, 3 or null = info only) and its reason text. */
function comboFloor(c) {
  if (!isPowerCombo(c) || !isTwoCard(c)) return null;
  const what = c.extraTurn ? "2-card extra-turn combo" : c.lock || c.skipTurns ? "2-card lock" : "2-card combo";
  if (!c.definitelyTwoCard) {
    return { floor: 3, borderline: true, text: `${what} ${comboName(c)} (${mvText(c)}; borderline: arguably 2 cards)` };
  }
  if (c.controlAllOpponents) return { floor: 4, text: `${what} ${comboName(c)} takes control of all opponents (${mvText(c)})` };
  const fast = c.assembly_mv != null && c.assembly_mv <= BRACKET_RULES.fast_combo_mv;
  if (fast) return { floor: 4, text: `${what} ${comboName(c)}, ≤${BRACKET_RULES.fast_combo_mv} mana (${mvText(c)}): can end games before turn 6 (heuristic)` };
  return { floor: 3, text: `late ${what} ${comboName(c)} (${mvText(c)})` };
}

// ---------------------------------------------------------------------------
// Bracket

const bracketMeta = (n) => BRACKET_RULES.brackets[n] ?? null;
const validDeclared = (v) => (v == null || v === "" ? null : Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 5 ? Number(v) : null);

/**
 * The Commander bracket of a deck (null for a non-commander deck). opts:
 * stats (deckStats result, computed when absent), combos (cachedCombos view:
 * {status ok|stale|pending|offline|disabled, fetched_at, result}), declared
 * (overrides deck.bracket_declared). Returns {value (shown: declared ?? auto),
 * auto, declared, label, meaning, partial, display ("3" / "≥3"), cedh_hint
 * (shown unless declared 5), cedh_like (the same test, whatever is declared),
 * legality, reasons[{rule, floor, text, cards[{name, source, why}], source,
 * level?}], info[], spellbook{status, fetched_at, tag, bracket}}. Floors only
 * come from official rules (+ the two documented heuristics); B1/B5 only when
 * declared; the Spellbook tag never raises it.
 */
export function bracketOf(deck, rows, { stats = null, combos = null, declared } = {}) {
  if (!isCommanderDeck(deck, rows)) return null;
  stats ??= deckStats(rows);
  const facts = deckFacts(rows, combos);
  const checked = combosChecked(combos);
  const floors = [];
  const info = [];
  const partialWhy = [];

  floors.push({ rule: "base", floor: 2, text: "No rule pushes it higher; Bracket 1 is about intent, set it yourself", cards: [], source: "rules" });

  // Game Changers.
  const gc = cardsWith(facts, "game_changer");
  if (gc.length) {
    const cards = gc.map((f) => cardEntry(f, "game_changer"));
    const n = gc.length;
    floors.push(n <= BRACKET_RULES.brackets[3].gc_max
      ? { rule: "game_changers", floor: 3, text: `${plural(n, "Game Changer")}: ${fmtNames(cards.map((c) => c.name))}. Bracket 3 allows up to ${BRACKET_RULES.brackets[3].gc_max}`, cards, source: sourcesOf(cards) }
      : { rule: "game_changers", floor: 4, text: `${plural(n, "Game Changer")}: ${fmtNames(cards.map((c) => c.name))}. More than ${BRACKET_RULES.brackets[3].gc_max} means Bracket 4`, cards, source: sourcesOf(cards) });
  }
  const unknownGc = facts.filter((f) => f.unknown_flag);
  if (unknownGc.length) partialWhy.push(`${plural(unknownGc.length, "card")}: Game Changer flag not fetched yet`);

  // Mass land denial.
  const mld = cardsWith(facts, "mld");
  if (mld.length) {
    const cards = mld.map((f) => cardEntry(f, "mld"));
    floors.push({ rule: "mld", floor: 4, text: `Mass land denial: ${fmtNames(cards.map((c) => c.name))} (WotC: cards that ${BRACKET_RULES.mld_definition}; Bracket 4+)`, cards, source: sourcesOf(cards) });
  }

  // Extra turns.
  const turns = cardsWith(facts, "extra_turn");
  if (turns.length) {
    const cards = turns.map((f) => cardEntry(f, "extra_turn"));
    const names = fmtNames(cards.map((c) => c.name));
    if (turns.length >= BRACKET_RULES.extra_turn_chain) {
      floors.push({ rule: "extra_turns", floor: 3, text: `${plural(turns.length, "extra-turn card")}: ${names}. Chaining likely (heuristic)`, cards, source: sourcesOf(cards) });
    } else info.push(`${plural(turns.length, "extra-turn card")} (${names}): low numbers are fine in Bracket 2`);
  }

  // Combos.
  const combosList = checked ? withAssemblyMv(combos.result.combos, rows) : [];
  let longer = 0;
  for (const c of combosList) {
    const f = comboFloor(c);
    if (f) {
      floors.push({
        rule: c.extraTurn ? "extra_turn_combo" : "combo", floor: f.floor, text: f.text, borderline: !!f.borderline,
        cards: c.cards.map((name) => ({ name, source: "spellbook", why: `combo_${c.id}` })), source: "spellbook", combo_id: c.id, url: comboUrl(c.id),
      });
    } else if (isPowerCombo(c)) longer++;
  }
  if (longer) info.push(`${plural(longer, "combo")} of 3+ cards (not a bracket rule)`);
  if (checked && (combos.result.combos_total ?? 0) > combosList.length) info.push(`Only the first ${combosList.length} of ${combos.result.combos_total} combos were checked`);

  // Tutors: score only.
  const tutors = cardsWith(facts, "tutor");
  if (tutors.length) info.push(`${plural(tutors.length, "tutor")}, not a bracket rule since 21 Oct 2025`);

  // Unidentified names, Spellbook's unchecked names.
  const unidentified = facts.filter((f) => f.unresolved && !f.identified);
  if (unidentified.length) partialWhy.push(`${plural(unidentified.length, "card")} not identified: ${fmtNames(unidentified.map((f) => f.name), 3)}`);
  if (checked && combos.result.unresolved?.length) info.push(`${plural(combos.result.unresolved.length, "card")} not checked by Commander Spellbook`);

  // Combos unchecked / stale.
  if (!checked) {
    const why = combos?.status === "disabled" ? "combo check is off" : combos?.status === "offline" ? "offline" : "pending";
    partialWhy.unshift(`combos not checked (${why})`);
  } else if (combos.status === "stale") info.push(`combos from ${String(combos.fetched_at || "").slice(0, 10)}`);

  // Values.
  const top = Math.max(...floors.map((f) => f.floor));
  const auto = Math.min(top, BRACKET_RULES.auto_max);
  const decl = validDeclared(declared === undefined ? deck?.bracket_declared : declared);
  const value = decl ?? auto;
  const partial = partialWhy.length > 0;
  // Floor reasons, highest first; the base reason only when nothing pushes higher.
  const reasons = top > 2 ? floors.filter((f) => f.floor > 2).sort((a, b) => b.floor - a.floor) : floors.slice(0, 1);
  if (decl != null && decl < auto && auto > 2) {
    const why = reasons.filter((r) => r.floor > decl).map((r) => r.text).join("; ");
    reasons.unshift({ rule: "declared_below", floor: null, level: "warn", text: `You set ${decl}, but the rules point to ≥${auto}: ${why}`, cards: [], source: "rules" });
  }
  for (const p of partialWhy) reasons.push({ rule: "partial", floor: null, level: "warn", text: p, cards: [], source: "rules" });

  const leg = legality(deck, rows, { combos });
  if (!leg.ok) reasons.push({ rule: "legality", floor: null, level: "bad", text: `Not Commander-legal: ${leg.problems.map((p) => p.text.replace(/ \(only OK.*\)$/, "")).join("; ")} (only OK in Bracket 1 by agreement)`, cards: [], source: "rules" });

  // Spellbook second opinion (never raises ours).
  const tag = checked ? combos.result.tag ?? null : null;
  const sbBracket = tag == null ? null : TAG_BRACKET[tag] ?? null;
  if (sbBracket === "banned") info.push("Commander Spellbook flags a banned card");
  else if (typeof sbBracket === "number" && sbBracket > value) info.push(`Commander Spellbook rates it ${TAG_LABEL[tag]} (≈${sbBracket})`);

  // cEDH hint.
  const fastMana = cardsWith(facts, "fast_mana").length;
  const cheapTutors = tutors.filter((f) => f.row.cmc != null && Number(f.row.cmc) <= CEDH_HINT.cheap_tutor_cmc).length;
  const fastCombo = combosList.some((c) => isPowerCombo(c) && c.assembly_mv != null && c.assembly_mv <= CEDH_HINT.combo_mv);
  const cedhLike = auto === 4 && fastMana >= CEDH_HINT.fast_mana
    && (tutors.length >= CEDH_HINT.tutors || cheapTutors >= CEDH_HINT.cheap_tutors) && fastCombo
    && stats.avg_mv != null && stats.avg_mv <= CEDH_HINT.avg_mv;
  const cedhHint = decl !== 5 && cedhLike;
  if (cedhHint) info.push("Looks cEDH-like; set 5 if that is the intent");

  const meta = bracketMeta(value);
  return {
    value,
    auto,
    declared: decl,
    label: meta.label,
    meaning: meta.meaning,
    partial,
    display: decl != null ? String(decl) : `${partial ? "≥" : ""}${auto}`,
    cedh_hint: cedhHint,
    cedh_like: cedhLike,
    legality: leg,
    reasons,
    info,
    spellbook: { status: combos?.status ?? "pending", fetched_at: combos?.fetched_at ?? null, tag, bracket: sbBracket },
    as_of: BRACKET_RULES.as_of,
  };
}
const TAG_BRACKET = { R: 4, S: 3, P: 3, O: 2, C: 2, E: 1, B: "banned" };
const TAG_LABEL = { R: "Ruthless", S: "Spicy", P: "Powerful", O: "Oddball", C: "Core", E: "Exhibition", B: "Banned" };

// ---------------------------------------------------------------------------
// Score

function piecewise(x, points) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

/** Colours (WUBRG ∩ identity) a land can make, from produced_mana or its text. */
function landColours(r, ident) {
  const produced = json(r.produced_mana, null);
  const out = new Set();
  if (Array.isArray(produced) && produced.length) for (const c of produced) out.add(String(c).toUpperCase());
  else {
    const text = String(r.oracle_text || "");
    for (const [, clause] of text.matchAll(/\bAdd (\{[^.\n]*)/g)) for (const [, c] of clause.matchAll(/\{([WUBRG])\}/g)) out.add(c);
    if (/any colou?r/i.test(text) || /basic land card/i.test(text)) for (const c of ident) out.add(c);
    const types = { plains: "W", island: "U", swamp: "B", mountain: "R", forest: "G" };
    for (const m of text.matchAll(/search your library for an? (?:basic )?(plains|island|swamp|mountain|forest)(?: or (?:a |an )?(?:basic )?(plains|island|swamp|mountain|forest))? card/gi)) {
      for (const t of [m[1], m[2]]) if (t) out.add(types[t.toLowerCase()]);
    }
  }
  return new Set([...out].filter((c) => ident.has(c)));
}
const entersTapped = (r) => {
  const t = String(r.oracle_text || "");
  return /enters (?:the battlefield )?tapped/i.test(t) && !/\bunless\b|If you don't/i.test(t);
};

function category(key, points, extra) {
  const w = WEIGHTS[key];
  const p = Math.max(0, Math.min(w.max, points));
  return { key, label: CATEGORY_LABELS[key], points: round(p), max: w.max, bar: Math.round((10 * p) / w.max), ...extra };
}
/** Sum per-card weights, best first; returns {points, cards (top 5 names), count}. */
function sumCards(list) {
  list.sort((a, b) => b.w - a.w || a.name.localeCompare(b.name));
  return { points: list.reduce((s, e) => s + e.w, 0), cards: list.slice(0, 5).map((e) => e.name), count: list.length };
}

/**
 * The 1-10 power score of a commander deck (null otherwise): 1 + the sum of
 * eight capped categories (WEIGHTS). opts: stats, combos (cachedCombos view),
 * bracket (bracketOf result, for the band note). Unknown cards add 0; with
 * combos unchecked the combo category is 0 and the score is partial ("≥").
 * Returns {value (1 decimal), half (UI half step), partial, display, breakdown
 * [{key, label, points, max, bar 0-10, count, words, cards[≤5], note}],
 * unknown, band{bracket, low, high}, note}.
 */
export function scoreOf(deck, rows, { stats = null, combos = null, bracket = null } = {}) {
  if (!isCommanderDeck(deck, rows)) return null;
  stats ??= deckStats(rows);
  const checked = combosChecked(combos);
  // Unknown cards (unresolved, offline fallback, no cmc) add nothing.
  const facts = deckFacts(rows, combos).filter((f) => !f.unresolved && !isOffline(f.row) && f.row.cmc != null);
  const breakdown = [];

  // 1 Speed.
  {
    const w = WEIGHTS.speed;
    let p = stats.avg_mv == null ? 0 : piecewise(stats.avg_mv, w.curve);
    const heavy = [...stats.curve.creature.slice(w.top_heavy_mv), ...stats.curve.other.slice(w.top_heavy_mv)].reduce((s, n) => s + n, 0);
    let note = null;
    if (heavy > w.top_heavy_n) { p -= w.top_heavy_penalty; note = `${heavy} cards cost ${w.top_heavy_mv}+`; }
    breakdown.push(category("speed", p, { count: heavy, words: stats.avg_mv == null ? "no spells known" : `average mana value ${stats.avg_mv}`, cards: [], note }));
  }

  // 2 Fast mana.
  {
    const w = WEIGHTS.fast_mana;
    const s = sumCards(cardsWith(facts, "fast_mana").map((f) => ({ name: f.name, w: normName(f.name) === "sol ring" ? w.sol_ring : w.each })));
    breakdown.push(category("fast_mana", s.points, { count: s.count, words: s.count ? plural(s.count, "fast mana card") : "no fast mana", cards: s.cards, note: null }));
  }

  // 3 Tutors.
  {
    const w = WEIGHTS.tutors;
    const s = sumCards(cardsWith(facts, "tutor").map((f) => {
      const transmute = tagOf(f.tags, "tutor")?.why === "tutor_transmute";
      const cheap = f.row.cmc != null && Number(f.row.cmc) <= w.cheap_cmc;
      return { name: f.name, w: transmute ? w.transmute : cheap ? w.cheap : w.other };
    }));
    breakdown.push(category("tutors", s.points, { count: s.count, words: s.count ? plural(s.count, "tutor") : "no tutors", cards: s.cards, note: null }));
  }

  // 4 Combos.
  {
    const w = WEIGHTS.combos;
    let p = 0, count = 0, cards = [], words = "not checked", note = null;
    if (checked) {
      const scored = [];
      for (const c of withAssemblyMv(combos.result.combos, rows)) {
        if (!isPowerCombo(c)) continue;
        let v;
        if (isTwoCard(c)) {
          // No manaValueNeeded → slow; known but a battlefield piece's cost unknown → mid.
          const mv = c.assembly_mv;
          v = c.manaValueNeeded == null || mv >= w.slow_mv ? w.slow : mv == null ? w.mid : mv <= w.fast_mv ? w.fast : w.mid;
        } else v = w.longer;
        scored.push({ v, name: comboName(c), two: isTwoCard(c) });
      }
      scored.sort((a, b) => b.v - a.v);
      scored.forEach((e, i) => { p += e.v * w.factors[Math.min(i, w.factors.length - 1)]; });
      count = scored.length;
      cards = scored.slice(0, 5).map((e) => e.name);
      const two = scored.filter((e) => e.two).length;
      words = count ? `${two} two-card, ${count - two} longer` : "no combos found";
    } else note = "Combos not checked: the score may be higher";
    breakdown.push(category("combos", p, { count, words, cards, note }));
  }

  // 5 Interaction.
  {
    const w = WEIGHTS.interaction;
    const keys = ["free_interaction", "wipe", "counter", "removal", "protection"];
    const list = [];
    for (const f of facts) {
      const best = Math.max(0, ...keys.filter((k) => hasTag(f.tags, k)).map((k) => w[k]));
      if (best > 0) list.push({ name: f.name, w: best });
    }
    const s = sumCards(list);
    breakdown.push(category("interaction", s.points, { count: s.count, words: `interaction ${s.count} of ~${w.target}`, cards: s.cards, note: null }));
  }

  // 6 Card draw.
  {
    const w = WEIGHTS.draw;
    const keys = ["draw_engine", "draw_burst", "cantrip"];
    const list = [];
    for (const f of facts) {
      const best = Math.max(0, ...keys.filter((k) => hasTag(f.tags, k)).map((k) => w[k]));
      if (best > 0) list.push({ name: f.name, w: best });
    }
    const s = sumCards(list);
    breakdown.push(category("draw", s.points, { count: s.count, words: `draw ${s.count} of ~${w.target}`, cards: s.cards, note: null }));
  }

  // 7 Ramp.
  const rampCards = cardsWith(facts, "ramp");
  {
    const w = WEIGHTS.ramp;
    const s = sumCards(rampCards.map((f) => ({ name: f.name, w: w.each })));
    breakdown.push(category("ramp", s.points, { count: s.count, words: `ramp ${s.count} of ~${w.target}`, cards: s.cards, note: null }));
  }

  // 8 Mana base.
  {
    const w = WEIGHTS.mana_base;
    const ident = new Set(stats.colours.identity.split(""));
    const nonbasic = (rows || []).filter((r) => isCounted(r) && isResolved(r) && !isOffline(r) && isLand(r) && !isBasic(r));
    let fixing = 0, n = 0;
    const fixers = [];
    for (const r of nonbasic) {
      const q = qtyOf(r);
      n += q;
      if (landColours(r, ident).size >= 2) {
        fixing += q * (entersTapped(r) ? w.tapped_factor : 1);
        fixers.push(r.name);
      }
    }
    const share = n ? fixing / n : 0;
    let p = w.fixing * share;
    const coloured = stats.colours.per.filter((c) => c.c !== "C" && c.pip_share > 0);
    const balanced = coloured.length > 0 && coloured.every((c) => c.source_share != null && c.source_share / c.pip_share >= w.balanced_ratio);
    if (balanced) p += w.balanced;
    const landCount = stats.lands + 0.5 * stats.mdfc_lands;
    const rampish = new Set([...rampCards, ...cardsWith(facts, "fast_mana")].map((f) => f.name)).size;
    let note = null;
    if (landCount < w.short_lands && rampish < w.short_ramp) { p += w.short; note = `only ${landCount} lands and ${rampish} ramp`; }
    const words = `${n ? `${Math.round(share * 100)}% of ${plural(n, "nonbasic land")} fix` : "no nonbasic lands"}${balanced ? ", sources match the pips" : ""}`;
    breakdown.push(category("mana_base", p, { count: fixers.length, words, cards: fixers.slice(0, 5), note }));
  }

  const sum = breakdown.reduce((s, b) => s + b.points, 0);
  const value = Math.min(10, Math.max(1, round(1 + sum, 1)));
  const half = Math.round(value * 2) / 2;
  const partial = !checked;
  const unknown = stats.unknown?.count ?? 0;

  // Band note against the shown bracket.
  let band = null, note = null;
  const b = bracket?.value ?? null;
  if (b != null && SCORE_BANDS[b]) {
    const [low, high] = SCORE_BANDS[b];
    band = { bracket: b, low, high };
    const ratio = (x) => x.points / x.max;
    if (value > high) {
      const top = [...breakdown].sort((x, y) => y.points - x.points)[0];
      note = `Score is high for Bracket ${b} because of ${top.label.toLowerCase()}`;
    } else if (value < low && !partial && unknown <= 0.1 * (stats.total || 0)) {
      const weak = [...breakdown].sort((x, y) => ratio(x) - ratio(y))[0];
      note = `Score is low for Bracket ${b}: little ${weak.label.toLowerCase()}`;
    }
  }
  return {
    value, half, partial, display: `${partial ? "≥ " : ""}${value}`, breakdown, unknown, band, note,
  };
}

/**
 * Stats, bracket, score and legality of a deck in one call (what deckDetail,
 * listDecks and evaluate_deck use). Non-commander decks get stats only.
 * Returns {commander, stats, bracket|null, score|null, legality|null}.
 */
export function powerOf(deck, rows, { combos = null, stats = null } = {}) {
  stats ??= deckStats(rows);
  if (!isCommanderDeck(deck, rows)) return { commander: false, stats, bracket: null, score: null, legality: null };
  const bracket = bracketOf(deck, rows, { stats, combos });
  const score = scoreOf(deck, rows, { stats, combos, bracket });
  return { commander: true, stats, bracket, score, legality: bracket.legality };
}
