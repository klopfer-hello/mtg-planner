// Deck rules that need no database: boards and statuses, basic lands, the
// allocation key of a card, the stored format, decklist text parsing
// (ManaBox / MTGA / Moxfield) and commander pairing (partner, friends forever,
// background, doctor's companion). DeckError carries an HTTP status.

import { keywordsOf, textOf } from "./cardclass.js";
import { StatusError } from "./errors.js";

export const BOARDS = ["commander", "main", "side", "maybe"];
/** Boards whose copies a built deck claims. */
export const CLAIM_BOARDS = ["commander", "main", "side"];
export const DECK_STATUSES = ["idea", "built"];
/** SQL sort key of deck_cards rows `dc` in board order (commander, main, side, maybe). */
export const BOARD_ORDER_SQL = "CASE dc.board WHEN 'commander' THEN 0 WHEN 'main' THEN 1 WHEN 'side' THEN 2 ELSE 3 END";
export const BASIC_LANDS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes",
  "snow-covered plains", "snow-covered island", "snow-covered swamp", "snow-covered mountain", "snow-covered forest"]);
export const isBasicLand = (name) => BASIC_LANDS.has(String(name || "").toLowerCase());

/** Allocation key of a card: its oracle id, else (unresolved deck rows) its lower-cased name. */
export const cardKey = (oracleId, name) => oracleId ?? `name:${String(name || "").toLowerCase()}`;

/** Canonical stored format: trimmed + lowercase ("Commander " -> "commander"), null when empty. */
export function normalizeFormat(format) {
  return typeof format === "string" && format.trim() ? format.trim().toLowerCase().slice(0, 50) : null;
}
/** True for a deck whose stored format is commander. */
export const isCommanderFormat = (deck) => normalizeFormat(deck?.format) === "commander";

/** Deck edit error with an HTTP status for the API layer. */
export class DeckError extends StatusError {}

const SECTION = [
  [/^(commanders?|command zone)\b/i, "commander"],
  [/^(sideboard|side)\b/i, "side"],
  [/^(maybe(board)?|considering)\b/i, "maybe"],
  [/^companions?\b/i, "companion"],
  [/^(deck|main(board|deck)?)\b/i, "main"],
];
// "1 Sol Ring", "1x Sol Ring (C21) 263", "SB: 2 Duress", "1 Arcane Signet (CMM) 1015 *F*"
const LINE = /^(?:(SB|CMDR):\s*)?(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([^\s*]+))?)?(?:\s+\*[A-Z]+\*)*\s*$/;

/**
 * Parse a text decklist (ManaBox / MTGA / Moxfield style). A `Companion`
 * section's cards go to the side board with `companion: true` (a companion is
 * not part of the 99); the copy MTGA also lists in the Sideboard is dropped.
 */
export function parseDecklist(text) {
  let board = "main";
  const items = [];
  const errors = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const section = SECTION.find(([re]) => re.test(line) && !/^\d/.test(line));
    if (section && line.replace(/[:\s]/g, "").length <= 14) { board = section[1]; continue; }
    const m = line.match(LINE);
    if (!m) { errors.push(line); continue; }
    const [, prefix, qty, name, set, number] = m;
    const companion = !prefix && board === "companion";
    items.push({
      quantity: parseInt(qty, 10),
      name: name.trim(),
      set: set?.toLowerCase(),
      collector_number: number,
      board: prefix === "SB" || companion ? "side" : prefix === "CMDR" ? "commander" : board,
      ...(companion ? { companion: true } : {}),
      // ManaBox / Moxfield foil markers (used by the collection list import; decks ignore them)
      ...(/\*F\*/i.test(line) ? { finish: "foil" } : /\*E\*/i.test(line) ? { finish: "etched" } : {}),
    });
  }
  // MTGA exports list the companion in the Companion section AND the sideboard.
  for (const comp of items.filter((i) => i.companion)) {
    let left = comp.quantity;
    for (const it of items) {
      if (left <= 0) break;
      if (it.companion || it.board !== "side" || it.name.toLowerCase() !== comp.name.toLowerCase()) continue;
      const n = Math.min(left, it.quantity);
      it.quantity -= n;
      left -= n;
    }
  }
  return { items: items.filter((i) => i.quantity > 0), errors };
}

// Partner pairs: plain Partner / Friends forever on both sides, "Partner with X"
// naming each other, "Partner—V" with the same V, "Choose a Background" + a
// Background, or Doctor's companion + a Time Lord Doctor.
const norm = (x) => String(x || "").trim().toLowerCase();
/** Partner abilities from the oracle text (keywords only when there is no text). */
function partnerInfo(c) {
  const info = { generic: false, with: [], variants: [] };
  let lines = String(c?.oracle_text || "").split("\n");
  if (!c?.oracle_text) {
    const kw = keywordsOf(c);
    // "Partner with" as a bare keyword names nobody we can check: never pairs.
    if (kw.some((k) => norm(k) === "partner with")) return info;
    lines = kw;
  }
  for (const raw of lines) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    const w = /^Partner with (.+)$/i.exec(line);
    if (w) { info.with.push(norm(w[1])); continue; }
    for (const part of line.split(",").map((p) => p.trim())) {
      const v = /^Partner\s*[—–-]\s*(.+)$/i.exec(part);
      if (v) info.variants.push(norm(v[1]));
      else if (/^Partner$/i.test(part)) info.generic = true;
    }
  }
  return info;
}
const nameMatches = (wanted, card) => {
  const n = norm(card?.name);
  return wanted === n || wanted === norm(n.split(" // ")[0]);
};
/** True when two commanders can lead one deck together (Partner, Partner with, Friends forever, Background, Doctor). */
export function canPair(a, b) {
  const pa = partnerInfo(a), pb = partnerInfo(b);
  if (pa.generic && pb.generic) return true;
  if (pa.with.some((w) => nameMatches(w, b)) && pb.with.some((w) => nameMatches(w, a))) return true;
  if (pa.variants.some((v) => pb.variants.includes(v))) return true;
  const ta = textOf(a), tb = textOf(b);
  if (/\bFriends forever\b/i.test(ta) && /\bFriends forever\b/i.test(tb)) return true;
  const bg = (x) => /\bBackground\b/.test(String(x?.type_line || ""));
  if ((/Choose a Background/i.test(ta) && bg(b)) || (/Choose a Background/i.test(tb) && bg(a))) return true;
  const doctor = (x) => /Time Lord Doctor/i.test(String(x?.type_line || ""));
  if ((/Doctor's companion/i.test(ta) && doctor(b)) || (/Doctor's companion/i.test(tb) && doctor(a))) return true;
  return false;
}
