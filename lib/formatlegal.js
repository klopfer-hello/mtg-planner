// Legality of 60-card constructed decks (Pauper first: the user plays Pauper
// and Commander, plan v1.3.0 #074). Commander legality stays in lib/power.js;
// this covers the other formats Scryfall reports legalities for, with the same
// result shape {ok, problems[{rule, text, cards}], unchecked, notes} so the
// deck page badge, get_deck/save_deck text and the eval read both alike.

import { parseJson } from "./db.js";
import { isBasicLand } from "./deckrules.js";
import { qtyOf } from "./deckstats.js";

/** Stored formats with 60-card rules (Scryfall legality keys). */
export const CONSTRUCTED_FORMATS = new Set(["pauper", "standard", "pioneer", "modern", "legacy", "vintage", "premodern"]);
const LABEL = { pauper: "Pauper", standard: "Standard", pioneer: "Pioneer", modern: "Modern", legacy: "Legacy", vintage: "Vintage", premodern: "Premodern" };
/** Display name of a format ("pauper" → "Pauper"). */
export const formatLabel = (format) => LABEL[format] ?? (format ? format[0].toUpperCase() + format.slice(1) : "Commander");

// "A deck can have any number of cards named X" / "up to seven cards named X".
const anyNumber = (r) => /deck can have any number of cards named|deck can have up to \w+ cards named/i.test(r.oracle_text || "");
const fmtNames = (names) => (names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", "));

/**
 * Problems of a constructed deck: main < 60, sideboard > 15, more than 4 copies (basics and "any number"
 * cards excepted; vintage restricted = 1), cards not legal / banned in the format. Unresolved rows
 * (no card data) are counted in `unchecked`. Maybe board is ignored.
 */
export function constructedLegality(format, rows) {
  const problems = [], notes = [];
  const counted = (rows || []).filter((r) => r.board === "main" || r.board === "side");
  const main = counted.filter((r) => r.board === "main").reduce((a, r) => a + qtyOf(r), 0);
  const side = counted.filter((r) => r.board === "side").reduce((a, r) => a + qtyOf(r), 0);
  const known = counted.filter((r) => r.type_line);
  const unchecked = counted.filter((r) => !r.type_line).reduce((a, r) => a + qtyOf(r), 0);
  if (unchecked) notes.push(`${unchecked} unknown cards not checked`);

  const banned = [], notLegal = [], restricted = [];
  for (const r of known) {
    const l = parseJson(r.legalities, {})[format];
    if (l === "banned") banned.push(r.name);
    else if (l === "restricted") restricted.push(r);
    else if (l !== "legal" && !isBasicLand(r.name)) notLegal.push(r.name);
  }
  const uniq = (a) => [...new Set(a)];
  if (banned.length) problems.push({ rule: "banned", text: `Banned in ${formatLabel(format)}: ${fmtNames(uniq(banned))}`, cards: uniq(banned) });
  if (notLegal.length) problems.push({ rule: "not_legal", text: `Not legal in ${formatLabel(format)}: ${fmtNames(uniq(notLegal))}`, cards: uniq(notLegal) });

  const per = new Map();
  for (const r of counted) {
    const k = (r.card_name || r.name).toLowerCase();
    const e = per.get(k) ?? { name: r.card_name || r.name, n: 0, row: r };
    e.n += qtyOf(r);
    per.set(k, e);
  }
  const limitOf = (e) => (isBasicLand(e.name) || anyNumber(e.row) ? Infinity : restricted.some((r) => r.name === e.row.name) ? 1 : 4);
  const over = [...per.values()].filter((e) => e.n > limitOf(e)).map((e) => `${e.n}x ${e.name}`);
  if (over.length) problems.push({ rule: "copies", text: `Too many copies: ${fmtNames(over)}`, cards: over.map((s) => s.replace(/^\d+x /, "")) });
  if (main < 60) problems.push({ rule: "size", text: `${main} main deck cards, at least 60`, cards: [] });
  if (side > 15) problems.push({ rule: "sideboard", text: `${side} sideboard cards, at most 15`, cards: [] });
  return { ok: problems.length === 0, format, problems, unchecked, notes };
}
