// Anchors: structural targets (lands, ramp, draw, curve, …) learned from public decklists (#069). The corpus is
// built offline by scripts/anchors.mjs; only its result, lib/anchors.json, ships. This module is the pure part:
// one deck's metrics with the app's own classifier (lib/cardclass.js) and statistics (lib/deckstats.js), so an
// anchor and the user's deck are always measured the same way; the medians and 25–75% bands of a cell; and the
// lookup that falls back to the format-wide cell when a format × bracket cell is too small to quote.
//
// Statistics only (quantiles, no model): every number can be said in words with its corpus size.

import { classifyCard, hasTag, isLand } from "./cardclass.js";
import { deckStats, qtyOf } from "./deckstats.js";

/** A cell with fewer decks than this is not quoted; anchorFor falls back to the format-wide cell. */
export const MIN_CELL_N = 30;

/** Role metrics: metric -> the classifyCard tags that count for it (a card counts once per metric). */
const ROLE_TAGS = {
  ramp: ["ramp", "fast_mana"], draw: ["draw_engine", "draw_burst"], cantrips: ["cantrip"], removal: ["removal"],
  counters: ["counter"], wipes: ["wipe"], protection: ["protection"], recursion: ["recursion"], tutors: ["tutor"],
};
const BASIC = /^Basic\b.*\bLand\b/;
const round1 = (n) => Math.round(n * 10) / 10;

// Colours a land fixes for, read through deckStats (its source math, fetches and "any colour" included) so there
// is one copy of that logic. Memoised per land and identity: the corpus repeats the same lands thousands of times.
const fixMemo = new Map();
function fixColours(land, identity) {
  const key = `${land.name}|${identity}`;
  if (!fixMemo.has(key)) {
    const per = deckStats([{ ...land, board: "main", quantity: 1, companion: 0 }], { identity }).colours.per;
    fixMemo.set(key, per.filter((p) => p.c !== "C" && p.sources > 0).length);
  }
  return fixMemo.get(key);
}

/**
 * Metrics of one deck from rows in the app's `cards` shape plus {board: commander|main|side, quantity}.
 * Copies count (quantity), not unique cards; side rows only give `sideboard`. Returns {lands, mdfc_lands, ramp,
 * draw, cantrips, removal, counters, wipes, protection, recursion, tutors, cheap_plays (nonland MV ≤ 2, commander
 * excluded), avg_mv (deckStats: nonland, front face, commander excluded), fixing_lands (lands making ≥ 2 identity
 * colours; null below 2 colours), colors (identity size)}; 60-card decks (no commander row) also get four_ofs
 * (non-basic names with 4 copies in the main deck) and sideboard (copies).
 */
export function deckMetrics(rows) {
  const played = (rows || []).filter((r) => r.board === "commander" || r.board === "main");
  const st = deckStats(played);
  const identity = st.colours.identity;
  const m = { lands: st.lands, mdfc_lands: st.mdfc_lands };
  for (const k of Object.keys(ROLE_TAGS)) m[k] = 0;
  let cheap = 0, fixing = 0;
  const copies = new Map();
  for (const r of played) {
    const q = qtyOf(r);
    if (isLand(r)) {
      if (identity.length >= 2 && fixColours(r, identity) >= 2) fixing += q;
    } else {
      const tags = classifyCard(r);
      for (const [k, list] of Object.entries(ROLE_TAGS)) if (list.some((t) => hasTag(tags, t))) m[k] += q;
      if (r.board === "main" && r.cmc != null && Math.floor(Number(r.cmc)) <= 2) cheap += q;
    }
    if (r.board === "main" && !BASIC.test(String(r.type_line || ""))) copies.set(r.name, (copies.get(r.name) || 0) + q);
  }
  Object.assign(m, { cheap_plays: cheap, avg_mv: st.avg_mv, fixing_lands: identity.length >= 2 ? fixing : null, colors: identity.length });
  if (!played.some((r) => r.board === "commander")) {
    m.four_ofs = [...copies.values()].filter((n) => n === 4).length;
    m.sideboard = (rows || []).filter((r) => r.board === "side").reduce((s, r) => s + qtyOf(r), 0);
  }
  return m;
}

/** Quantile q (0..1) of sorted numbers, linear between ranks (R type 7). */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * One cell from many deckMetrics results: {n, metrics: {name: {p25, median, p75}}}, rounded to 1 decimal. Null
 * values are left out per metric; a metric whose count differs from the cell's n carries its own `n`.
 */
export function aggregate(list) {
  const n = list.length;
  const names = [...new Set(list.flatMap((m) => Object.keys(m)))];
  const metrics = {};
  for (const k of names) {
    const vals = list.map((m) => m[k]).filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
    if (!vals.length) continue;
    metrics[k] = { p25: round1(quantile(vals, 0.25)), median: round1(quantile(vals, 0.5)), p75: round1(quantile(vals, 0.75)) };
    if (vals.length !== n) metrics[k].n = vals.length;
  }
  return { n, metrics };
}

/**
 * The anchor cell for a deck: `format:b<bracket>` when it has ≥ MIN_CELL_N decks, else the format-wide cell.
 * Returns {key, n, metrics, fallback (true when the wanted cell was missing or small), wanted} or null when the
 * format has no anchors at all.
 */
export function anchorFor(anchors, { format, bracket = null } = {}) {
  const f = String(format ?? "").trim().toLowerCase();
  const cells = anchors?.cells || {};
  const wanted = bracket != null && bracket !== "" ? `${f}:b${bracket}` : f;
  for (const key of [wanted, f]) {
    const c = cells[key];
    if (c && c.n >= MIN_CELL_N) return { key, n: c.n, metrics: c.metrics, fallback: key !== wanted, wanted };
  }
  return null;
}
