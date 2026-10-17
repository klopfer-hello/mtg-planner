// Scryfall-flavoured search syntax for the owned collection, compiled to SQL.
// Used by both the web UI and the collection MCP server so Claude and the user
// speak the same query language.
//
// Terms are ANDed; prefix a term with "-" to negate it. Quote multi-word values.
//   t:creature  o:"draw a card"  k:flying  c:wu  c=r  c<=bg  c:m  c:c
//   id:bg (colour identity within, for commander)  cmc<=3  mv=2
//   r:mythic  s:mh3  f:commander  is:foil  is:commander  eur>5  usd<1
//   qty>=4  b:"trade binder"  lang:de  src:scan   bare words match the card name
//   avail>=1 (free copies: owned minus what built decks claim)  used>=1 / is:used (in a built deck)

import { cardPrice } from "./db.js";
import { BASIC_LANDS } from "./decks.js";

export const QUERY_HELP = [
  "name words (bare text)", "t:type", 'o:"oracle text"', "k:keyword",
  "c:wu / c=wu / c!=wu / c<=wu / c:m (multicolor) / c:c (colorless) / c:azorius (guild & shard names)", "id:bg (color identity within)",
  "cmc<=3 / mv=2", "r:common|uncommon|rare|mythic", "s:setcode", "f:format (legal in)",
  "is:foil|nonfoil|etched|commander", "eur>5 / usd<1", "qty>=4", "avail>=1 (copies not claimed by built decks; avail<0 = short; basic lands are always free)", "used>=1 or is:used (claimed by a built deck)",
  'b:"binder name"', "lang:en", "src:manabox|scan|app",
  "-term negates", "all terms are ANDed (no OR or parentheses: run one search per alternative)",
].join("; ");

const COLOR_WORDS = {
  white: "W", blue: "U", black: "B", red: "R", green: "G", colorless: "C", multicolor: "M",
  // Guilds, shards, wedges and colleges, as Scryfall accepts them.
  azorius: "WU", dimir: "UB", rakdos: "BR", gruul: "RG", selesnya: "GW",
  orzhov: "WB", izzet: "UR", golgari: "BG", boros: "RW", simic: "GU",
  bant: "GWU", esper: "WUB", grixis: "UBR", jund: "BRG", naya: "RGW",
  abzan: "WBG", jeskai: "URW", sultai: "BGU", mardu: "RWB", temur: "GUR",
  silverquill: "WB", prismari: "UR", witherbloom: "BG", lorehold: "RW", quandrix: "GU",
};
const RARITY = { c: "common", u: "uncommon", r: "rare", m: "mythic", common: "common", uncommon: "uncommon", rare: "rare", mythic: "mythic", special: "special", bonus: "bonus" };
const NUM_OPS = new Set(["=", "<", ">", "<=", ">=", "!="]);
const TOKEN = /(-?)(?:([a-z]+)(:|<=|>=|!=|=|<|>))?(?:"([^"]*)"|(\S+))/gi;

function parseColors(value) {
  const word = COLOR_WORDS[value.toLowerCase()];
  if (word) return word;
  if (/^[wubrgcm]+$/i.test(value)) return value.toUpperCase();
  throw new Error(`Unknown color: ${value} (use letters WUBRG/C/M or a color, guild or shard name)`);
}

function colorClause(column, op, raw) {
  if (op === "!=") return { sql: `NOT (${colorClause(column, "=", raw).sql})`, params: [] };
  const letters = parseColors(raw);
  if (letters === "M") return { sql: `length(${column}) >= 2`, params: [] };
  if (letters === "C" || letters === "") return { sql: `${column} = ''`, params: [] };
  const set = [...new Set(letters.replace(/[CM]/g, ""))];
  if (set.length === 0) return { sql: `${column} = ''`, params: [] };
  const has = set.map((l) => `instr(${column}, '${l}') > 0`);
  const lacks = [..."WUBRG"].filter((l) => !set.includes(l)).map((l) => `instr(${column}, '${l}') = 0`);
  switch (op) {
    case "=": return { sql: [...has, ...lacks].join(" AND "), params: [] };
    case "<=": return { sql: lacks.join(" AND ") || "1", params: [] };
    case "<": return { sql: `${lacks.join(" AND ") || "1"} AND length(${column}) < ${set.length}`, params: [] };
    case ">": return { sql: `${has.join(" AND ")} AND length(${column}) > ${set.length}`, params: [] };
    default: return { sql: has.join(" AND "), params: [] }; // ":" and ">=" → contains all
  }
}

function numberClause(expr, op, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${raw}`);
  const sqlOp = op === ":" ? "=" : op;
  if (!NUM_OPS.has(sqlOp)) throw new Error(`Bad operator ${op}`);
  return { sql: `${expr} ${sqlOp} ?`, params: [n] };
}

const like = (expr, v) => ({ sql: `${expr} LIKE ?`, params: [`%${v}%`] });
// Price of the owned finish, with the same fallbacks as cardPrice(): the
// finish's own price, the plain price, then any other finish.
const FINISH_SUFFIX = "CASE col.finish WHEN 'foil' THEN '_foil' WHEN 'etched' THEN '_etched' ELSE '' END";
// A foreign printing without its own EUR price uses its English twin's (the
// `*_en` keys lib/prices.js copies in), before any USD price, like eurOf().
const PRICE_KEY = (cur, keyExpr) => cur === "eur"
  ? `json_extract(c.prices, ${keyExpr}), json_extract(c.prices, ${keyExpr} || '_en')`
  : `json_extract(c.prices, ${keyExpr})`;
const FINISH_PRICE = (cur) => `CAST(COALESCE(${PRICE_KEY(cur, `'$.${cur}' || ${FINISH_SUFFIX}`)}, ${PRICE_KEY(cur, `'$.${cur}'`)}) AS REAL)`;
const ANY_PRICE = (cur) => `CAST(COALESCE(${PRICE_KEY(cur, `'$.${cur}_foil'`)}, ${PRICE_KEY(cur, `'$.${cur}_etched'`)}) AS REAL)`;
const FINISH_PRICE_ANY = (cur) => `COALESCE(${FINISH_PRICE(cur)}, ${ANY_PRICE(cur)})`;
// Sort/representative value: eur when known, else usd (mixed scale, as shown).
// Allocation (lib/decks.js): every owned copy of the oracle card, and the copies
// built decks claim (commander+main+side). Correlated on the outer c.oracle_id.
export const OWNED_ALL_SQL = `(SELECT COALESCE(SUM(col2.quantity), 0) FROM collection col2 JOIN cards c2 ON c2.scryfall_id = col2.scryfall_id
  WHERE c2.oracle_id = c.oracle_id)`;
export const BUILT_DEMAND_SQL = `(SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
  JOIN cards c3 ON c3.scryfall_id = dc.scryfall_id
  WHERE d.status = 'built' AND dc.board IN ('commander', 'main', 'side') AND c3.oracle_id = c.oracle_id)`;
// Basic lands never conflict: their built demand doesn't reduce what is free.
const BASIC_SQL = `lower(c.name) IN (${[...BASIC_LANDS].map((n) => `'${n.replace(/'/g, "''")}'`).join(", ")})`;
const AVAIL_SQL = `(${OWNED_ALL_SQL} - CASE WHEN ${BASIC_SQL} THEN 0 ELSE ${BUILT_DEMAND_SQL} END)`;

const ROW_PRICE = `COALESCE(${FINISH_PRICE("eur")}, ${FINISH_PRICE("usd")}, ${ANY_PRICE("eur")}, ${ANY_PRICE("usd")}, 0)`;

/** Compile a query to { where: {sql, params}, having: {sql, params} }. */
export function compileQuery(q = "") {
  const where = [];
  const whereParams = [];
  const having = [];
  const havingParams = [];
  for (const m of String(q).matchAll(TOKEN)) {
    const [, neg, keyRaw, op, quoted, bare] = m;
    const value = quoted ?? bare ?? "";
    const key = keyRaw?.toLowerCase();
    let clause;
    let isHaving = false;
    if (!key) {
      if (!value) continue;
      clause = like("c.name", value);
    } else {
      switch (key) {
        case "n": case "name": clause = like("c.name", value); break;
        case "t": case "type": clause = like("c.type_line", value); break;
        case "o": case "oracle": case "text": clause = like("c.oracle_text", value); break;
        case "k": case "kw": case "keyword": clause = like("c.keywords", `"${value}`); break;
        case "c": case "color": clause = colorClause("c.colors", op, value); break;
        case "id": case "ci": case "identity": clause = colorClause("c.color_identity", op === ":" ? "<=" : op, value); break;
        // cmc NULL = unknown: the comparison is NULL, so it matches no filter, negated or not.
        case "cmc": case "mv": clause = numberClause("c.cmc", op, value); break;
        case "r": case "rarity": {
          const r = RARITY[value.toLowerCase()];
          if (!r) throw new Error(`Unknown rarity: ${value}`);
          clause = { sql: "c.rarity = ?", params: [r] };
          break;
        }
        case "s": case "e": case "set": clause = { sql: "c.set_code = ?", params: [value.toLowerCase()] }; break;
        case "f": case "format": case "legal":
          clause = { sql: "json_extract(c.legalities, '$.' || ?) IN ('legal', 'restricted')", params: [value.toLowerCase()] };
          break;
        case "is": {
          const v = value.toLowerCase();
          if (v === "foil" || v === "etched") clause = { sql: "col.finish = ?", params: [v] };
          else if (v === "nonfoil") clause = { sql: "col.finish = 'normal'", params: [] };
          else if (v === "commander") {
            clause = { sql: "((c.type_line LIKE '%Legendary%' AND c.type_line LIKE '%Creature%') OR c.oracle_text LIKE '%can be your commander%')", params: [] };
          } else if (v === "used") clause = { sql: `${BUILT_DEMAND_SQL} > 0`, params: [] };
          else throw new Error(`Unknown is: value ${value}`);
          break;
        }
        case "eur": case "usd": clause = numberClause(FINISH_PRICE_ANY(key), op, value); break;
        case "qty": case "count": clause = numberClause("SUM(col.quantity)", op, value); isHaving = true; break;
        case "avail": case "available": case "free": clause = numberClause(AVAIL_SQL, op, value); break;
        case "used": {
          const v = value.toLowerCase();
          if (op === ":" && ["yes", "true", "y"].includes(v)) clause = { sql: `${BUILT_DEMAND_SQL} > 0`, params: [] };
          else if (op === ":" && ["no", "false", "n"].includes(v)) clause = { sql: `${BUILT_DEMAND_SQL} = 0`, params: [] };
          else clause = numberClause(BUILT_DEMAND_SQL, op, value);
          break;
        }
        case "b": case "binder": clause = like("col.binder", value); break;
        case "lang": clause = { sql: "col.language = ?", params: [value.toLowerCase()] }; break;
        case "src": case "source": clause = { sql: "col.source = ?", params: [value.toLowerCase()] }; break;
        default: throw new Error(`Unknown search key "${key}". Supported: ${QUERY_HELP}`);
      }
    }
    const sql = neg ? `NOT (${clause.sql})` : `(${clause.sql})`;
    if (isHaving) { having.push(sql); havingParams.push(...clause.params); }
    else { where.push(sql); whereParams.push(...clause.params); }
  }
  return {
    where: { sql: where.join(" AND ") || "1", params: whereParams },
    having: { sql: having.join(" AND ") || "1", params: havingParams },
  };
}

const SORTS = {
  name: "c.name COLLATE NOCASE",
  cmc: "c.cmc",
  price: "price_value",
  qty: "qty",
  set: "c.set_code",
  rarity: "CASE c.rarity WHEN 'mythic' THEN 4 WHEN 'rare' THEN 3 WHEN 'uncommon' THEN 2 ELSE 1 END",
};

/**
 * Search owned cards. group = "card" (one row per oracle card, all printings
 * summed) or "printing" (one row per Scryfall printing). binder: only copies
 * in that binder ('' = Unsorted). Rows carry `used` (copies built decks claim) and
 * `avail` (all owned copies of the card minus used), both per oracle card.
 *
 * The single MAX() aggregate makes SQLite take the bare columns (printing,
 * prices, image, finish) from the most valuable owned row of each group, so
 * the shown printing and price match the price sort.
 */
export function searchCollection(db, { q = "", group = "card", sort = "name", dir, limit = 60, offset = 0, binder = null, section = null } = {}) {
  const { where, having } = compileQuery(q);
  // Exact binder filter (case-insensitive; '' = Unsorted), unlike the b: substring search.
  if (binder != null) { where.sql = `(${where.sql}) AND col.binder = ? COLLATE NOCASE`; where.params.push(String(binder)); }
  // One section of collectionSections: {by, key}.
  if (section) { where.sql = `(${where.sql}) AND ${sectionKeySql(section.by)} = ?`; where.params.push(String(section.key)); }
  const groupBy = group === "printing" ? "c.scryfall_id" : "c.oracle_id";
  const direction = (dir || (sort === "price" || sort === "qty" || sort === "rarity" ? "desc" : "asc")) === "desc" ? "DESC" : "ASC";
  let order = SORTS[sort] || SORTS.name;
  // The direction must apply to the collector number too, not just the set.
  if (sort === "set") order = `c.set_code ${direction}, CAST(c.collector_number AS INTEGER)`;
  // An unknown mana value (cmc NULL: not fetched, or no cmc on the card) sorts last either way.
  if (sort === "cmc") order = "c.cmc IS NULL, c.cmc";
  const base = `
    FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
    WHERE ${where.sql}
    GROUP BY ${groupBy}
    HAVING ${having.sql}`;
  const params = [...where.params, ...having.params];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${base})`).get(...params).n;
  const rows = db.prepare(
    `SELECT c.scryfall_id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
            c.type_line, c.mana_cost, c.cmc, c.colors, c.color_identity, c.oracle_text, c.prices,
            c.image_small, c.image_normal, col.finish, MAX(${ROW_PRICE}) AS price_value, SUM(col.quantity) AS qty,
            GROUP_CONCAT(DISTINCT col.finish) AS finishes, GROUP_CONCAT(DISTINCT col.language) AS languages,
            GROUP_CONCAT(DISTINCT NULLIF(col.binder, '')) AS binders, GROUP_CONCAT(DISTINCT col.source) AS sources,
            COUNT(DISTINCT c.scryfall_id) AS printing_count, ${BUILT_DEMAND_SQL} AS used, ${AVAIL_SQL} AS avail
     ${base}
     ORDER BY ${order} ${direction}, c.name COLLATE NOCASE
     LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(Number(limit) || 60, 500), Number(offset) || 0);
  return { total, rows };
}

// ---------------------------------------------------------------------------
// Sections: the binder detail page groups a (big) binder into collapsible
// sections by set, colour, rarity or card type. Each section loads its cards on
// demand through searchCollection({section}), so a binder with thousands of
// copies only renders the section headers first.

// Front face, supertypes + types only ("Legendary Creature — Elf" -> "Legendary Creature"):
// a subtype must never count as a type ("Island" contains "land").
const FRONT_TYPES = `(SELECT CASE WHEN instr(f, '—') > 0 THEN substr(f, 1, instr(f, '—') - 1) ELSE f END
  FROM (SELECT CASE WHEN instr(COALESCE(c.type_line, ''), ' // ') > 0 THEN substr(c.type_line, 1, instr(c.type_line, ' // ') - 1)
                    ELSE COALESCE(c.type_line, '') END AS f))`;
// Same order as the UI's mainType: the first type that matches wins (Artifact Creature = Creature).
const TYPE_KEYS = ["creature", "planeswalker", "battle", "instant", "sorcery", "artifact", "enchantment", "land"];
const TYPE_KEY_SQL = `(SELECT CASE ${TYPE_KEYS.map((t) => `WHEN ft LIKE '%${t}%' THEN '${t}'`).join(" ")} ELSE 'other' END
  FROM (SELECT ${FRONT_TYPES} AS ft))`;

const SECTION_KEY_SQL = {
  set: "COALESCE(c.set_code, '')",
  // W U B R G, M = multicolour, C = colourless non-land, L = colourless land.
  color: `CASE WHEN length(c.colors) > 1 THEN 'M' WHEN c.colors <> '' THEN c.colors
    WHEN ${TYPE_KEY_SQL} = 'land' THEN 'L' ELSE 'C' END`,
  rarity: "CASE WHEN c.rarity IN ('mythic', 'rare', 'uncommon', 'common') THEN c.rarity ELSE 'special' END",
  type: TYPE_KEY_SQL,
};
export const SECTION_BYS = Object.keys(SECTION_KEY_SQL);

const ORDERED_LABELS = {
  color: [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["M", "Multicolour"], ["C", "Colourless"], ["L", "Lands"]],
  rarity: [["mythic", "Mythic"], ["rare", "Rare"], ["uncommon", "Uncommon"], ["common", "Common"], ["special", "Special"]],
  type: [...TYPE_KEYS, "other"].map((t) => [t, t === "other" ? "Other" : `${t[0].toUpperCase()}${t.slice(1)}s`.replace("Sorcerys", "Sorceries")]),
};

function sectionKeySql(by) {
  const sql = SECTION_KEY_SQL[by];
  if (!sql) throw new Error(`Unknown section: ${by}. Use ${SECTION_BYS.join(", ")}`);
  return sql;
}

/**
 * Section headers of a collection view (same q / group / binder as searchCollection):
 * {by, sections: [{key, label, cards (rows the section lists), copies, value_eur}]}.
 * Sets are sorted by name, the other groupings in their natural order. A card shows in
 * every section it has copies in (a card with printings from two sets is in both).
 */
export function collectionSections(db, { q = "", group = "card", binder = null, by = "set" } = {}) {
  const keySql = sectionKeySql(by);
  const { where, having } = compileQuery(q);
  if (binder != null) { where.sql = `(${where.sql}) AND col.binder = ? COLLATE NOCASE`; where.params.push(String(binder)); }
  const groupBy = group === "printing" ? "c.scryfall_id" : "c.oracle_id";
  const groups = db.prepare(
    `SELECT ${keySql} AS k, ${groupBy} AS g, MAX(c.set_name) AS set_name, SUM(col.quantity) AS qty
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE ${where.sql}
      GROUP BY k, g
     HAVING ${having.sql}`,
  ).all(...where.params, ...having.params);
  const sections = new Map();
  for (const r of groups) {
    let s = sections.get(r.k);
    if (!s) sections.set(r.k, (s = { key: r.k, label: r.set_name || r.k.toUpperCase() || "Unknown set", cards: 0, copies: 0, value: 0, groups: new Set() }));
    s.cards += 1;
    s.copies += r.qty;
    s.groups.add(r.g);
  }
  // Values: each copy at its finish's EUR price (like stats), only copies of listed groups.
  const priced = db.prepare(
    `SELECT ${keySql} AS k, ${groupBy} AS g, col.finish, col.quantity, c.prices
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id WHERE ${where.sql}`,
  ).all(...where.params);
  for (const r of priced) {
    const s = sections.get(r.k);
    if (!s || !s.groups.has(r.g)) continue;
    const p = cardPrice(r, r.finish);
    if (p && p.currency === "€") s.value += p.value * r.quantity;
  }
  const order = ORDERED_LABELS[by];
  const list = [...sections.values()].map(({ groups: _g, value, ...s }) => ({
    ...s, label: order ? order.find(([k]) => k === s.key)?.[1] ?? s.label : s.label, value_eur: Math.round(value * 100) / 100,
  }));
  if (order) list.sort((a, b) => order.findIndex(([k]) => k === a.key) - order.findIndex(([k]) => k === b.key));
  else list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return { by, sections: list };
}
