// Rules knowledge for the planner (plan v1.3.0 #071): Scryfall's rulings per
// card and WotC's Comprehensive Rules, searchable by words or rule number, so
// "does Blood Artist see creatures that die with it?" is answered with the
// ruling and rule 603.10a instead of from memory.
//
// The CR text is a free download (magic.wizards.com/en/rules links the current
// .txt, a few updates a year); it is split into one row per rule (examples
// stay with their rule) plus the glossary, kept in rules_fts and re-checked
// every 30 days. Without network the bundled copy of the scryfall MCP server
// (RULES_FALLBACK_FILE) fills an empty table. Rulings are cached per oracle id
// for 30 days.

import { existsSync, readFileSync } from "node:fs";
import { getAppMeta, nameArgs, nameMatch, nowIso, setAppMeta, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard, scryfall } from "./scryfall.js";
import { getText } from "./webcache.js";

const TTL_MS = 30 * 24 * 3600 * 1000;
const RULES_PAGE = process.env.RULES_PAGE_URL || "https://magic.wizards.com/en/rules";
const FALLBACK = process.env.RULES_FALLBACK_FILE || "/opt/scryfall-mcp/mtgrules.txt";
const RULE_LINE = /^(\d{3}(?:\.\d+[a-z]?)?)\.?\s+(.+)$/;
// BOM, line separator (glossary) and no-break space (blank glossary lines), built from char codes.
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`), LSEP = new RegExp(String.fromCharCode(0x2028), "g"), NBSP = new RegExp(String.fromCharCode(0xa0), "g");
const EOL = /\r?\n/;

/**
 * Split the CR text into [{rule_no, text}]: numbered rules (example lines appended to their rule; the table of
 * contents is dropped by keeping the longest text per number) and glossary entries (rule_no "glossary").
 */
export function parseRules(raw) {
  const lines = String(raw).replace(BOM, "").replace(LSEP, " ").split(EOL).map((l) => l.replace(NBSP, " ").trimEnd());
  const glossaryAt = lines.lastIndexOf("Glossary");
  const creditsAt = lines.lastIndexOf("Credits");
  const body = glossaryAt > 0 ? lines.slice(0, glossaryAt) : lines;
  const rules = new Map();
  let last = null;
  for (const line of body) {
    const m = RULE_LINE.exec(line);
    if (m) {
      last = m[1];
      if ((rules.get(last)?.length ?? 0) < m[2].length) rules.set(last, m[2]);
    } else if (last && /^Example:/.test(line)) rules.set(last, `${rules.get(last)} ${line}`);
  }
  const out = [...rules].map(([rule_no, text]) => ({ rule_no, text }));
  if (glossaryAt > 0) {
    const gloss = lines.slice(glossaryAt + 1, creditsAt > glossaryAt ? creditsAt : undefined);
    let block = [];
    const flush = () => { if (block.length >= 2) out.push({ rule_no: "glossary", text: `${block[0]}: ${block.slice(1).join(" ")}` }); block = []; };
    for (const line of gloss) { if (line.trim()) block.push(line.trim()); else flush(); }
    flush();
  }
  return out;
}

/**
 * Make sure rules_fts holds the current CR (checked every 30 days). Returns {rules, source, error?}; never
 * throws: on a network error an empty table is filled from the bundled fallback file, a full one is kept.
 */
export async function ensureRules(db, { signal, force = false } = {}) {
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM rules_fts").get().n;
  const checked = getAppMeta(db, "rules_checked_at");
  if (!force && count() && checked && Date.now() - Date.parse(checked) < TTL_MS) return { rules: count(), source: getAppMeta(db, "rules_source") };
  let raw = null, source = null, error = null;
  try {
    const page = await getText(RULES_PAGE, { signal });
    // The file name has a space ("MagicCompRules 20260925.txt").
    const href = /https:\/\/media\.wizards\.com\/[^"'<>]*?MagicCompRules[^"'<>]*?\.txt/.exec(page)?.[0];
    if (!href) throw new Error("no rules .txt link on the rules page");
    source = href.replace(/ /g, "%20");
    if (source === getAppMeta(db, "rules_source") && count()) { setAppMeta(db, "rules_checked_at", nowIso()); return { rules: count(), source }; }
    raw = await getText(source, { signal });
  } catch (err) {
    error = err.message;
    if (count()) return { rules: count(), source: getAppMeta(db, "rules_source"), error };
    if (existsSync(FALLBACK)) { raw = readFileSync(FALLBACK, "utf8"); source = FALLBACK; }
  }
  if (!raw) return { rules: 0, source: null, error: error ?? "no rules text" };
  const rows = parseRules(raw);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM rules_fts");
    const put = db.prepare("INSERT INTO rules_fts (rule_no, text) VALUES (?, ?)");
    for (const r of rows) put.run(r.rule_no, r.text);
    setAppMeta(db, "rules_source", source);
    // The bundled copy is as old as the image: try the web again next time instead of in 30 days.
    if (source !== FALLBACK) setAppMeta(db, "rules_checked_at", nowIso());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { rules: rows.length, source, ...(error ? { error } : {}) };
}

/**
 * Rules matching a rule number ("603.10", its sub-rules too) or words (stemmed, all words, best first). Returns
 * [{rule_no, text}] (at most `limit`).
 */
export function rulesLookup(db, query, { limit = 6 } = {}) {
  const q = String(query || "").trim();
  if (/^\d{3}(?:\.\d+[a-z]?)?\.?$/.test(q)) {
    const no = q.replace(/\.$/, "");
    return db.prepare("SELECT rule_no, text FROM rules_fts WHERE rule_no = ? OR rule_no LIKE ? ORDER BY length(rule_no), rule_no LIMIT ?")
      .all(no, `${no}%`, limit);
  }
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return [];
  const match = `text : (${words.map((w) => `"${w}"*`).join(" ")})`;
  return db.prepare("SELECT rule_no, text FROM rules_fts WHERE rules_fts MATCH ? ORDER BY bm25(rules_fts) LIMIT ?").all(match, limit);
}

/**
 * Scryfall rulings of a card by name ({name, rulings: [{date, text}]} or null when the card is unknown), cached
 * per oracle id for 30 days; a card missing locally is looked up first. Throws only when Scryfall fails and
 * nothing is cached.
 */
export async function cardRulings(db, name, { signal } = {}) {
  const pick = db.prepare(`SELECT scryfall_id, oracle_id, name FROM cards WHERE ${nameMatch("name")} AND oracle_id IS NOT NULL ORDER BY fetched_at DESC LIMIT 1`);
  let card = pick.get(...nameArgs(name));
  if (!card) {
    const { cards } = await fetchCollection([{ name }], undefined, { signal });
    upsertCards(db, cards.map(normalizeCard));
    card = pick.get(...nameArgs(name));
    if (!card) return null;
  }
  const cached = db.prepare("SELECT rulings, fetched_at FROM card_rulings WHERE oracle_id = ?").get(card.oracle_id);
  if (cached && Date.now() - Date.parse(cached.fetched_at) < TTL_MS) return { name: card.name, rulings: JSON.parse(cached.rulings) };
  try {
    const data = await scryfall(`/cards/${card.scryfall_id}/rulings`, { signal });
    const rulings = (data.data || []).map((r) => ({ date: r.published_at, text: r.comment }));
    db.prepare("INSERT OR REPLACE INTO card_rulings (oracle_id, rulings, fetched_at) VALUES (?, ?, ?)").run(card.oracle_id, JSON.stringify(rulings), nowIso());
    return { name: card.name, rulings };
  } catch (err) {
    if (cached) return { name: card.name, rulings: JSON.parse(cached.rulings), stale: true };
    throw err;
  }
}
