// Text helpers of the collection MCP server: tool errors, argument parsing and
// the one-line card / deck / binder formats the tools share.

export class ToolError extends Error {}

import { nameMatch } from "../lib/db.js";

export { likeEsc, nameArgs, nameMatch, parseJson } from "../lib/db.js";

export const int = (v, def, min, max) => {
  const n = Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.trunc(Number(v)) : def;
  return Math.min(max, Math.max(min, n));
};

const COLOR_NAMES = { W: "white", U: "blue", B: "black", R: "red", G: "green" };
export const colorLabel = (ci) => (ci ? `${ci} (${[...ci].map((l) => COLOR_NAMES[l] ?? l).join("/")})` : "colorless");

// Main card type of the front face; creature wins over artifact/enchantment.
const TYPE_PRIORITY = ["Creature", "Planeswalker", "Battle", "Land", "Instant", "Sorcery", "Artifact", "Enchantment"];
export function mainType(typeLine) {
  const front = String(typeLine || "").split(" // ")[0];
  return TYPE_PRIORITY.find((t) => front.includes(t)) ?? "Other";
}

export const setNum = (r) => `${String(r.set_code || "?").toUpperCase()} #${r.collector_number ?? "?"}`;
export const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " / ");

// Owned rows (all printings) matching a card name, case-insensitively and by
// the front face of double-faced / split cards ("Name // Back").
export const OWNED_BY_NAME = `
  SELECT c.scryfall_id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number,
         col.finish, col.language, col.condition, col.binder, col.quantity, c.prices
    FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
   WHERE ${nameMatch()}
   ORDER BY col.quantity DESC, c.set_code, c.collector_number`;


export const eurText = (v) => (v == null ? "no EUR price" : `€${v.toFixed(2)}`);

/** "in locked binder X of #2 Deck 2x, ..." for allocation reserve().boxes. */
export const boxText = (boxes) => boxes.map((b) => `in locked binder ${b.binder}${b.deck_name ? ` of #${b.deck_id} ${b.deck_name}` : " (no deck)"} ${b.quantity}x`).join(", ");

/** One line of list_decks / collection_overview. */
export const deckLine = (k) =>
  `#${k.id} ${k.name}${k.format ? ` [${k.format}]` : ""} — ${k.status ?? "idea"}, ${k.card_count} cards, value €${(k.value_eur ?? 0).toFixed(2)}` +
  `${k.to_buy_count ? `, to buy ${k.to_buy_count} (€${(k.to_buy_eur ?? 0).toFixed(2)})` : ""}` +
  `${k.in_use_count ? (k.status === "built"
    ? `, ${k.in_use_count} shared with other built decks (buy extra to play both)`
    : `, ${k.in_use_count} in other built decks (can be moved)`) : ""}` +
  `${k.conflict_count ? `, ${k.conflict_count} CONFLICTS with other built decks` : ""}` +
  `, source ${k.source}, updated ${k.updated_at}` +
  `${k.bracket != null ? ` · B${k.bracket_partial && k.bracket_declared == null ? "≥" : ""}${k.bracket}` : ""}` +
  `${k.score != null ? ` · ${k.score_partial ? "≥" : ""}${k.score.toFixed(1)}/10` : ""}` +
  `${k.legal === false ? " · not Commander-legal" : ""}`;
