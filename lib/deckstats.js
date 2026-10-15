// Deck statistics: mana curve, card types, colour split and coloured sources.
//
// Pure and synchronous: it works on the deck rows deckDetail already selects
// (deck_cards joined with cards), never touches the DB, and is cheap enough to
// run for every deck in listDecks. It describes the deck that is played, so
// only the commander and main boards count; side, maybe and companion rows are
// only counted (a companion lives outside the 99).
//
// Unknown cards never pretend to be free spells: a row without a Scryfall id,
// an offline fallback row (fetched_at '') or a card without a cmc goes to
// `unknown` and is left out of every other number except `total`.
//
// Faces: the front face decides land/creature/types and gives the pips (only
// one face of an MDFC, transform, adventure, flip or reversible card is cast at
// a time); a split card counts both halves, like its Scryfall cmc does. An MDFC
// with a land back is a "flex land": a spell in the curve, half a source in the
// mana-base math. Sources come from lands only, clipped to the deck's colour
// identity (+ colourless), so Command Tower counts once per identity colour.

const WUBRG = "WUBRG";
const COLOURS = new Set(WUBRG.split(""));
const BUCKETS = ["0", "1", "2", "3", "4", "5", "6", "7+"];
const TYPES = ["creature", "instant", "sorcery", "artifact", "enchantment", "planeswalker", "battle", "land"];
const TYPE_RES = TYPES.map((t) => [t, new RegExp(`\\b${t[0].toUpperCase()}${t.slice(1)}\\b`)]);
/** Layouts whose faces are cast one at a time: only the front face's cost counts. */
const FRONT_ONLY = new Set(["modal_dfc", "transform", "adventure", "flip", "reversible_card"]);
const FLEX_LAND_WEIGHT = 0.5;
/** Warn when a colour's share of sources lags its share of pips by more than this. */
export const SOURCE_LAG_WARN = 0.10;

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const faces = (s) => String(s ?? "").split(" // ");
const front = (s) => faces(s)[0];
const qtyOf = (r) => {
  const n = Number(r.quantity ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const sortColours = (set) => WUBRG.split("").filter((c) => set.has(c)).join("");

/** Colour letters of a 'WU' string, an array or a JSON array text. */
function colourSet(v) {
  if (v == null) return new Set();
  let list = v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      try { list = JSON.parse(t); } catch { list = []; }
    } else list = t.split("");
  }
  return new Set((Array.isArray(list) ? list : []).map((c) => String(c).toUpperCase()));
}

/** produced_mana as a Set, or null when unknown (NULL / unparsable). */
function producedSet(v) {
  if (v == null || v === "") return null;
  let list = v;
  if (typeof v === "string") {
    try { list = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(list) ? new Set(list.map((c) => String(c).toUpperCase())) : null;
}

/**
 * Pips of a mana cost: {W: n, U: n, ..., C: n}. Each {…} symbol is split on '/':
 * the colour parts share 1 evenly ({W/U} = .5 each, {G/W/P} = .5 each); P, numbers
 * and C inside a hybrid don't take a share ({2/W} and {C/W} = 1 W); {HW} = .5 W;
 * a lone {C} = 1 C; generic numbers, X/Y/Z, S and anything else count nothing.
 */
export function pipsOf(cost) {
  const out = {};
  const add = (c, n) => { out[c] = (out[c] || 0) + n; };
  for (const [, sym] of String(cost ?? "").matchAll(/\{([^}]*)\}/g)) {
    const s = sym.toUpperCase();
    if (s === "C") { add("C", 1); continue; }
    if (/^H[WUBRG]$/.test(s)) { add(s[1], 0.5); continue; }
    const colours = s.split("/").filter((p) => COLOURS.has(p));
    for (const c of colours) add(c, 1 / colours.length);
  }
  return out;
}

/**
 * The cost whose pips count: the front face, or both halves of a split card. A NULL
 * layout (rows from before the v9 backfill) also counts the front face only.
 */
function castCost(row) {
  const cost = row.mana_cost;
  if (cost == null) return "";
  if (row.layout === "split") return faces(cost).join("");
  if (FRONT_ONLY.has(row.layout) || row.layout == null) return front(cost);
  return cost;
}

const isLandFront = (row) => /\bLand\b/.test(front(row.type_line));
const isFlexLand = (row) => row.layout === "modal_dfc" && !isLandFront(row) && faces(row.type_line).slice(1).some((t) => /\bLand\b/.test(t));
const isUnknown = (row) => row.scryfall_id == null || row.fetched_at === "" || row.cmc == null || !Number.isFinite(Number(row.cmc));
const mvOf = (row) => Math.floor(Number(row.cmc));

const BASIC_TYPE = { plains: "W", island: "U", swamp: "B", mountain: "R", forest: "G" };
const FETCH_RE = /search your library for an? (?:basic )?(plains|island|swamp|mountain|forest)(?: or (?:a |an )?(?:basic )?(plains|island|swamp|mountain|forest))? card/gi;

/**
 * Colours a land can make: its produced_mana; when that is NULL, `Add {X}` in the
 * text, "any colour" (= identity) and fetches (basic land types -> colours, "basic
 * land card" -> identity). Not yet clipped to the identity.
 */
function landColours(row, identity) {
  const produced = producedSet(row.produced_mana);
  if (produced && produced.size) return produced;
  const out = new Set();
  const text = String(row.oracle_text ?? "");
  if (!produced) {
    // Every symbol of an "Add …" clause up to its sentence end ("Add {R} or {G}.").
    for (const [, clause] of text.matchAll(/\bAdd (\{[^.\n]*)/g)) for (const [, c] of clause.matchAll(/\{([WUBRGC])\}/g)) out.add(c);
    if (/any colou?r/i.test(text)) for (const c of identity) out.add(c);
  }
  for (const m of text.matchAll(FETCH_RE)) for (const t of [m[1], m[2]]) if (t) out.add(BASIC_TYPE[t.toLowerCase()]);
  if (/basic land card/i.test(text)) for (const c of identity) out.add(c);
  return out;
}

/**
 * Statistics of a deck from its rows ({board, name, quantity, scryfall_id, type_line,
 * mana_cost, cmc, colors, color_identity, oracle_text, produced_mana, layout, fetched_at,
 * companion}). opts.identity ('WU' or ['W','U']) overrides the derived colour identity.
 * Returns {total, unknown{count, names}, companion{name}|null, excluded{side, maybe,
 * companion}, lands, mdfc_lands, avg_mv, x_spells{count, names}, curve{buckets,
 * creature[8], other[8], commander[{name, mv}]}, types{creature, instant, sorcery,
 * artifact, enchantment, planeswalker, battle, land}, colours{identity, per[{c, cards,
 * pips, pip_share, sources, source_share, warn}], colourless_cards}}.
 * per lists the identity colours (WUBRG order) plus C when the costs ask for {C}.
 */
export function deckStats(rows, { identity = null } = {}) {
  const counted = [];
  let companion = null;
  const excluded = { side: 0, maybe: 0, companion: 0 };
  for (const r of rows || []) {
    const q = qtyOf(r);
    if (r.companion) {
      excluded.companion += q;
      companion ??= { name: r.name };
    } else if (r.board === "commander" || r.board === "main") counted.push(r);
    else if (r.board === "side" || r.board === "maybe") excluded[r.board] += q;
  }
  const commanders = counted.filter((r) => r.board === "commander");

  const unknownNames = new Set();
  let total = 0, unknownCount = 0;
  const known = [];
  for (const r of counted) {
    const q = qtyOf(r);
    total += q;
    if (isUnknown(r)) {
      unknownCount += q;
      unknownNames.add(r.name);
    } else known.push(r);
  }
  const nonland = known.filter((r) => !isLandFront(r));

  // Identity: the commanders' colour identity, else what the cards themselves
  // show (also when a commander has no card data: an empty identity would
  // hide every source warning and the mana base's fixing).
  const cmdUnknown = commanders.some((r) => r.scryfall_id == null || r.fetched_at === "" || r.color_identity == null);
  let ident;
  if (identity != null) ident = colourSet(Array.isArray(identity) ? identity : String(identity));
  else if (commanders.length && !cmdUnknown) {
    ident = new Set();
    for (const r of commanders) for (const c of colourSet(r.color_identity)) ident.add(c);
  } else {
    ident = new Set();
    for (const r of nonland) {
      for (const c of colourSet(r.colors)) ident.add(c);
      for (const c of Object.keys(pipsOf(castCost(r)))) ident.add(c);
    }
  }
  for (const c of [...ident]) if (!COLOURS.has(c)) ident.delete(c);

  // Lands, curve, averages, X spells, types.
  const creature = Array(8).fill(0), other = Array(8).fill(0);
  const types = Object.fromEntries(TYPES.map((t) => [t, 0]));
  const xNames = new Set();
  let lands = 0, mdfcLands = 0, xCount = 0, mvSum = 0, mvN = 0;
  for (const r of known) {
    const q = qtyOf(r);
    const frontType = front(r.type_line);
    for (const [t, re] of TYPE_RES) if (re.test(frontType)) types[t] += q;
    if (isLandFront(r)) { lands += q; continue; }
    if (isFlexLand(r)) mdfcLands += q;
    if (r.board === "commander") continue;
    const mv = mvOf(r);
    const b = Math.min(Math.max(mv, 0), 7);
    (/\bCreature\b/.test(frontType) ? creature : other)[b] += q;
    mvSum += mv * q;
    mvN += q;
    if (/\{X\}/i.test(front(r.mana_cost))) { xCount += q; xNames.add(r.name); }
  }
  const commanderList = commanders.map((r) => ({ name: r.name, mv: isUnknown(r) ? null : mvOf(r) }));

  // Colours: cards and pips over the nonland cards (commander included), sources from lands.
  const cardsPer = {}, pips = {}, sources = {};
  let colourless = 0;
  for (const r of nonland) {
    const q = qtyOf(r);
    const cs = colourSet(r.colors);
    let any = false;
    for (const c of cs) if (COLOURS.has(c)) { cardsPer[c] = (cardsPer[c] || 0) + q; any = true; }
    if (!any) colourless += q;
    for (const [c, n] of Object.entries(pipsOf(castCost(r)))) pips[c] = (pips[c] || 0) + n * q;
  }
  const sourceColours = new Set([...ident, "C"]);
  for (const r of known) {
    const flex = isFlexLand(r);
    if (!isLandFront(r) && !flex) continue;
    const w = qtyOf(r) * (flex ? FLEX_LAND_WEIGHT : 1);
    for (const c of landColours(r, ident)) if (sourceColours.has(c)) sources[c] = (sources[c] || 0) + w;
  }
  const list = WUBRG.split("").filter((c) => ident.has(c));
  if (pips.C > 0) list.push("C");
  const pipTotal = list.reduce((s, c) => s + (pips[c] || 0), 0);
  const srcTotal = list.reduce((s, c) => s + (sources[c] || 0), 0);
  const colourlessDeck = ident.size === 0;
  const per = list.map((c) => {
    const p = pips[c] || 0, s = sources[c] || 0;
    const pipShare = pipTotal > 0 ? p / pipTotal : null;
    const srcShare = srcTotal > 0 ? s / srcTotal : null;
    const warn = !colourlessDeck && pipShare != null && srcShare != null && srcShare < pipShare - SOURCE_LAG_WARN;
    return {
      c, cards: c === "C" ? 0 : cardsPer[c] || 0, pips: round(p), pip_share: pipShare == null ? null : round(pipShare, 3),
      sources: round(s), source_share: srcShare == null ? null : round(srcShare, 3), warn,
    };
  });

  return {
    total,
    unknown: { count: unknownCount, names: [...unknownNames] },
    companion,
    excluded,
    lands,
    mdfc_lands: mdfcLands,
    avg_mv: mvN ? round(mvSum / mvN) : null,
    x_spells: { count: xCount, names: [...xNames] },
    curve: { buckets: BUCKETS, creature, other, commander: commanderList },
    types,
    colours: { identity: sortColours(ident), per, colourless_cards: colourless },
  };
}
