// Scryfall-flavoured search syntax for the owned collection, compiled to SQL.
// Used by both the web UI and the collection MCP server so Claude and the user
// speak the same query language.
//
// Terms are ANDed; prefix a term with "-" to negate it. Quote multi-word values.
//   t:creature  o:"draw a card"  k:flying  c:wu  c=r  c<=bg  c:m  c:c
//   id:bg (colour identity within, for commander)  cmc<=3  mv=2
//   r:mythic  s:mh3  f:commander  is:foil  is:commander  eur>5  usd<1
//   qty>=4  b:"trade binder"  lang:de  src:scan   bare words match the card name

export const QUERY_HELP = [
  "name words (bare text)", "t:type", 'o:"oracle text"', "k:keyword",
  "c:wu / c=wu / c!=wu / c<=wu / c:m (multicolor) / c:c (colorless) / c:azorius (guild & shard names)", "id:bg (color identity within)",
  "cmc<=3 / mv=2", "r:common|uncommon|rare|mythic", "s:setcode", "f:format (legal in)",
  "is:foil|nonfoil|etched|commander", "eur>5 / usd<1", "qty>=4", 'b:"binder name"', "lang:en", "src:manabox|scan",
  "-term negates",
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
const FINISH_PRICE = (cur) => `CAST(COALESCE(json_extract(c.prices, '$.${cur}' || ${FINISH_SUFFIX}), json_extract(c.prices, '$.${cur}')) AS REAL)`;
const ANY_PRICE = (cur) => `CAST(COALESCE(json_extract(c.prices, '$.${cur}_foil'), json_extract(c.prices, '$.${cur}_etched')) AS REAL)`;
const FINISH_PRICE_ANY = (cur) => `COALESCE(${FINISH_PRICE(cur)}, ${ANY_PRICE(cur)})`;
// Sort/representative value: eur when known, else usd (mixed scale, as shown).
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
          } else throw new Error(`Unknown is: value ${value}`);
          break;
        }
        case "eur": case "usd": clause = numberClause(FINISH_PRICE_ANY(key), op, value); break;
        case "qty": case "count": clause = numberClause("SUM(col.quantity)", op, value); isHaving = true; break;
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
 * summed) or "printing" (one row per Scryfall printing).
 *
 * The single MAX() aggregate makes SQLite take the bare columns (printing,
 * prices, image, finish) from the most valuable owned row of each group, so
 * the shown printing and price match the price sort.
 */
export function searchCollection(db, { q = "", group = "card", sort = "name", dir, limit = 60, offset = 0 } = {}) {
  const { where, having } = compileQuery(q);
  const groupBy = group === "printing" ? "c.scryfall_id" : "c.oracle_id";
  const direction = (dir || (sort === "price" || sort === "qty" || sort === "rarity" ? "desc" : "asc")) === "desc" ? "DESC" : "ASC";
  let order = SORTS[sort] || SORTS.name;
  // The direction must apply to the collector number too, not just the set.
  if (sort === "set") order = `c.set_code ${direction}, CAST(c.collector_number AS INTEGER)`;
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
            GROUP_CONCAT(DISTINCT col.finish) AS finishes,
            GROUP_CONCAT(DISTINCT NULLIF(col.binder, '')) AS binders, GROUP_CONCAT(DISTINCT col.source) AS sources,
            COUNT(DISTINCT c.scryfall_id) AS printing_count
     ${base}
     ORDER BY ${order} ${direction}, c.name COLLATE NOCASE
     LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(Number(limit) || 60, 500), Number(offset) || 0);
  return { total, rows };
}
