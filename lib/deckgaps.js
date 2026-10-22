// What a deck is missing (plan v1.3.0 #068): its land, ramp, draw, removal,
// wipe, protection, recursion and curve counts against the anchors of tuned
// public decks of its format and bracket (lib/anchors.json, #069), each gap
// with the user's FREE owned cards that fill it, so "upgrade from free cards"
// starts from one tool call instead of guessed searches.
//
// Outside the 25–75% band = low/high. The checks follow the Commander
// beginner-mistakes video the user brought (2026-10-22): lands are a fixed
// floor, ramp and draw both matter, removal and wipes are counted apart,
// protection and recursion (commander resilience) weigh from bracket 3 up.
// Candidates come from the collection search (avail>=1 role:… id<=…), cards
// with two or more roles first: they fill two slots.

import { readFileSync } from "node:fs";
import { anchorFor, deckMetrics } from "./anchorstats.js";
import { classifyCard, normName } from "./cardclass.js";
import { commanderIdentity, idTerm, isCommanderFormat, normalizeFormat } from "./deckrules.js";
import { formatLabel } from "./formatlegal.js";
import { searchCollection } from "./query.js";

let anchors;
const loadAnchors = () => (anchors ??= JSON.parse(readFileSync(new URL("./anchors.json", import.meta.url), "utf8")));

/** Metrics checked, in answer order: [metric, label, role: search value (candidates), when]. */
const CHECKS = [
  ["lands", "lands", null, () => true],
  ["ramp", "ramp", "ramp", () => true],
  ["draw", "card draw", "draw", () => true],
  ["removal", "removal", "removal", () => true],
  ["wipes", "board wipes", "wipe", (ctx) => ctx.commander],
  ["protection", "protection", "protection", (ctx) => ctx.commander && (ctx.bracket ?? 2) >= 3],
  ["recursion", "recursion", "recursion", (ctx) => ctx.commander && (ctx.bracket ?? 2) >= 3],
  ["cheap_plays", "plays at MV ≤ 2", null, () => true],
  ["avg_mv", "average mana value", null, () => true],
  ["fixing_lands", "colour-fixing lands", null, (ctx) => ctx.colors >= 2],
];


/** Free owned candidates for a role (cards with more roles first), not in the deck. */
function candidates(db, ctx, role, n) {
  const where = [`avail>=1`, `role:${role}`, ctx.commander ? idTerm(ctx.identity) : "", ctx.format && !ctx.commander ? `f:${ctx.format}` : ""];
  const { rows } = searchCollection(db, { q: where.filter(Boolean).join(" "), limit: 200, sort: "cmc", dir: "asc" });
  return rows.filter((r) => !ctx.inDeck.has(normName(r.name)))
    .map((r) => ({ name: r.name, cmc: r.cmc, roles: classifyCard(r).map((t) => t.tag), free: r.avail }))
    .sort((a, b) => b.roles.length - a.roles.length || (a.cmc ?? 9) - (b.cmc ?? 9)).slice(0, n);
}

/**
 * Gaps of a deck (deckDetail shape: format, cards, power): {anchor: {key, n, fallback, label}, checks: [{metric,
 * label, value, p25, median, p75, status: low|ok|high, gap, candidates}]}; null when no anchors exist for the format.
 */
export function deckGaps(db, detail, { perGap = 5 } = {}) {
  const rows = detail.cards;
  const commander = isCommanderFormat(detail) || rows.some((r) => r.board === "commander");
  const format = commander ? "commander" : normalizeFormat(detail.format);
  const bracket = commander ? detail.power?.bracket?.value ?? null : null;
  const anchor = anchorFor(loadAnchors(), { format, bracket });
  if (!anchor) return null;
  const metrics = deckMetrics(rows);
  const ctx = { commander, format, bracket, identity: commanderIdentity(rows), colors: metrics.colors ?? 0, inDeck: new Set(rows.map((r) => normName(r.card_name || r.name))) };
  const checks = [];
  for (const [metric, label, role, when] of CHECKS) {
    const band = anchor.metrics[metric];
    const value = metrics[metric];
    if (!band || value == null || !when(ctx)) continue;
    const status = value < band.p25 ? "low" : value > band.p75 ? "high" : "ok";
    const gap = Math.round((band.median - value) * 10) / 10;
    checks.push({ metric, label, value, p25: band.p25, median: band.median, p75: band.p75, status, gap,
      candidates: status === "low" && role && perGap ? candidates(db, ctx, role, perGap) : [] });
  }
  const where = commander ? `Commander${anchor.key.endsWith(`:b${bracket}`) ? ` bracket ${bracket}` : ""}` : formatLabel(format);
  return { anchor: { key: anchor.key, n: anchor.n, fallback: Boolean(anchor.fallback), label: `tuned ${where} decks (n=${anchor.n}${anchor.fallback ? ", whole format: too few decks of that bracket" : ""})` }, checks };
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Text lines for Claude; `brief` = one line with only what is outside the band (evaluate_deck). */
export function gapsText(g, { brief = false } = {}) {
  if (!g) return brief ? "" : "No anchors for this format yet (Commander and Pauper only).";
  const off = g.checks.filter((c) => c.status !== "ok");
  if (brief) return off.length ? `Anchors vs ${g.anchor.label}: ${off.map((c) => `${c.label} ${fmt(c.value)} (${c.status}, usual ${fmt(c.p25)}–${fmt(c.p75)})`).join("; ")}` : `Anchors vs ${g.anchor.label}: all counts within the usual range.`;
  const lines = [`Compared with ${g.anchor.label}; usual = middle half of those decks:`];
  for (const c of g.checks) {
    lines.push(`${c.status === "ok" ? "ok  " : c.status === "low" ? "LOW " : "HIGH"} ${c.label}: ${fmt(c.value)} (usual ${fmt(c.p25)}–${fmt(c.p75)}, median ${fmt(c.median)})` +
      `${c.candidates.length ? ` · free: ${c.candidates.map((x) => `${x.name}${x.roles.length > 1 ? ` [${x.roles.join("+")}]` : ""}`).join(", ")}` : ""}`);
  }
  if (g.checks.some((c) => c.metric === "lands" && c.status === "low")) lines.push("Lands are a floor: add lands before cutting more of them for spells.");
  return lines.join("\n");
}
