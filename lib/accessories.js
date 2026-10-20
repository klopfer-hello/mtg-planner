// Tokens & extras: what you need on the table to play a deck besides the cards.
//
// Battle Screech makes Bird tokens, Thraben Inspector investigates (Clue), a
// planeswalker needs loyalty counters, a Saga lore counters, monarch a marker.
// Two sources, best first:
//   1. Scryfall's `all_parts` of each deck card (cards.all_parts, schema v15):
//      the exact token printings (component 'token') and helper cards (Dungeon,
//      The Monarch, Day // Night, ...). Token details (P/T, colours, text, image)
//      come from the token's own card row (cached in `cards`, layout token).
//   2. The deck card's oracle text and keywords: "create two 1/1 white Bird
//      creature tokens", investigate, amass, counters, dice, coins, designations.
//      Used for the estimate (how many to have ready) and as the offline
//      fallback when a card's all_parts or the token rows are not known yet.
// The maybe board is left out; sideboard cards count, flagged `side`.
// Nothing here waits on the network: missing data is listed in `fetch_ids`
// (non-enumerable) and filled by ensureAccessoryData / the server's background
// fetcher (createAccessoryFetcher), like the Spellbook combos.

import { parseJson as json, transaction, upsertCards } from "./db.js";
import { keywordsOf } from "./cardclass.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";

const COUNT_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twice: 2 };
const COLOUR_WORDS = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
const WUBRG = "WUBRG";
/** Upper bound of a token estimate ("have ~20+"). */
export const ESTIMATE_CAP = 20;
/** Copies assumed for an X / "that many" effect per resolution. */
const VARIABLE_GUESS = 2;
// Cast again from the graveyard / exile: one card resolves twice.
const RECAST = /\b(flashback|retrace|jump-start|rebound|escape|buyback|harmonize)\b/i;
const WORDS_NOT_NAMES = new Set(["Creature", "Artifact", "Enchantment", "Legendary", "Snow", "Land", "Token", "Tokens", "And", "Colorless", "With", "That", "Named", "Tapped"]);

const qty = (r) => Math.max(0, Number(r.quantity) || 0);
const sortColours = (s) => WUBRG.split("").filter((c) => String(s ?? "").includes(c)).join("");
const lc = (s) => String(s ?? "").toLowerCase();
/** Oracle text without reminder text: "(To investigate, create a Clue token. ...)" must not count twice. */
const stripReminder = (text) => String(text ?? "").replace(/\([^()]*\)/g, "");

// ---------------------------------------------------------------------------
// Oracle text: token-making phrases

function countOf(word) {
  const w = lc(word).trim();
  if (/^\d+$/.test(w)) return Number(w);
  return COUNT_WORDS[w] ?? null; // x, that many, a number of → variable
}

/** "1/1 white Bird creature" → {pt, colors, names}. */
function describe(desc) {
  const pt = /(\d+|X|\*)\/(\d+|X|\*)/.exec(desc);
  const colors = sortColours(Object.entries(COLOUR_WORDS).filter(([w]) => new RegExp(`\\b${w}\\b`, "i").test(desc)).map(([, c]) => c).join(""));
  const names = (desc.replace(/\bwith\b[\s\S]*$/i, "").match(/\b[A-Z][a-z'-]+\b/g) ?? []).filter((w) => !WORDS_NOT_NAMES.has(w));
  return { pt: pt ? `${pt[1]}/${pt[2]}` : null, colors, names };
}

/**
 * Token-making phrases of one card's oracle text: [{names[], count (per
 * resolution, null = variable), repeatable, pt, colors, copy}]. Covers
 * "create(s) <n> ... token(s)" and the keyword actions that make named tokens
 * (investigate → Clue, amass → Army, incubate → Incubator, living weapon →
 * Germ, afterlife N → Spirit, fabricate → Servo).
 */
export function tokenPhrases(text, keywords = []) {
  const out = [];
  const kw = new Set(keywordsOf({ keywords }).map(lc));
  const clean = stripReminder(text);
  for (const line of clean.split(/\n/)) {
    // Triggered / activated abilities can make tokens again and again.
    const repeatable = /^(whenever|at the beginning|each|during)\b/i.test(line.trim()) || /\}[^:]*:/.test(line.split(/[.]/)[0]);
    const re = /\bcreates?\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+|that many|a number of|twice that many)\s+([^.;]*?)\btokens?\b([^.;]*)/gi;
    let m;
    while ((m = re.exec(line))) {
      const desc = m[2];
      const copy = /\bcop(y|ies)\b/i.test(desc + m[3]) && !/\d\/\d/.test(desc);
      const d = describe(desc);
      const variable = /\bfor each\b/i.test(line) || countOf(m[1]) == null;
      out.push({ names: d.names, count: variable ? null : countOf(m[1]), repeatable, pt: d.pt, colors: d.colors, copy, text: m[0].trim() });
    }
    const inv = /\binvestigates?(?:\s+(twice|x times|(\w+) times))?/i.exec(line);
    if (inv) out.push({ names: ["Clue"], count: inv[1] ? (/twice/i.test(inv[1]) ? 2 : countOf(inv[2] ?? "x")) : 1, repeatable, pt: null, colors: "", copy: false, text: inv[0] });
    const amass = /\bamass(?:\s+[A-Z][a-z]+)?\s+(\d+|x)\b/i.exec(line);
    if (amass) out.push({ names: ["Army"], count: 1, repeatable, pt: "0/0", colors: "", copy: false, text: amass[0] });
    const inc = /\bincubate\s+(\d+|x)\b/i.exec(line);
    if (inc) out.push({ names: ["Incubator"], count: 1, repeatable, pt: null, colors: "", copy: false, text: inc[0] });
  }
  const txt = clean;
  const after = /\bafterlife\s+(\d+)/i.exec(txt);
  if (after) out.push({ names: ["Spirit"], count: Number(after[1]), repeatable: false, pt: "1/1", colors: "WB", copy: false, text: after[0] });
  if (kw.has("living weapon") || /\bliving weapon\b/i.test(txt)) out.push({ names: ["Germ"], count: 1, repeatable: false, pt: "0/0", colors: "B", copy: false, text: "Living weapon" });
  const fab = /\bfabricate\s+(\d+)/i.exec(txt);
  if (fab) out.push({ names: ["Servo"], count: Number(fab[1]), repeatable: false, pt: "1/1", colors: "", copy: false, text: fab[0], optional: true });
  return out;
}

// ---------------------------------------------------------------------------
// Counters, dice and markers

// [key, label, kind, test(text, keywords, row), note?]
const MARKERS = [
  ["plus1", "+1/+1 counters", "counter", (t, k) => /\+1\/\+1 counter|\bconnives?\b|\bamass\b|\bincubate\b/i.test(t) || hasAny(k, ["connive", "adapt", "bolster", "evolve",
    "outlast", "support", "training", "mentor", "monstrosity", "modular", "graft", "reinforce", "unleash", "backup", "renown", "scavenge", "undying",
    "ravenous", "bloodthirst", "riot", "amass", "incubate", "sunburst", "tribute", "fabricate"])],
  ["minus1", "−1/−1 counters", "counter", (t, k) => /-1\/-1 counter|−1\/−1 counter/i.test(t) || hasAny(k, ["wither", "persist", "infect"])],
  ["loyalty", "Loyalty counters (or a die)", "counter", (t, k, r) => /\bPlaneswalker\b/.test(r.type_line ?? "") || /\bloyalty counter/i.test(t)],
  ["poison", "Poison counters", "counter", (t, k) => /\bpoison counter|\btoxic\b|\bpoisonous\b/i.test(t) || hasAny(k, ["infect", "toxic", "poisonous"])],
  ["energy", "Energy counters", "counter", (t) => /\{E\}|\benergy counter/i.test(t)],
  ["experience", "Experience counters", "counter", (t) => /\bexperience counter/i.test(t)],
  ["lore", "Lore counters", "counter", (t, k, r) => /\bSaga\b/.test(r.type_line ?? "") || /\blore counter/i.test(t)],
  ["time", "Time counters", "counter", (t, k) => /\btime counter/i.test(t) || hasAny(k, ["suspend", "vanishing", "impending"])],
  ["proliferate", "Proliferate (extra counters of every kind)", "counter", (t, k) => /\bproliferate/i.test(t) || hasAny(k, ["proliferate"])],
  ["dice", "Dice", "dice", (t) => /\broll(?:s)?\s+(?:a|one|two|three|\w+)?\s*(?:d\d+|(?:four|six|eight|ten|twelve|twenty)-sided di(?:e|ce)|di(?:e|ce))\b/i.test(t)],
  ["coin", "A coin", "dice", (t) => /\bflips?\s+(?:a|one|two|\w+)\s+coins?\b/i.test(t)],
  ["monarch", "The Monarch marker", "designation", (t) => /\bmonarch\b/i.test(t)],
  ["initiative", "The Initiative marker + Undercity dungeon", "designation", (t) => /\bthe initiative\b/i.test(t)],
  ["daynight", "Day/Night marker", "designation", (t, k) => hasAny(k, ["daybound", "nightbound"]) || /\bit becomes (day|night)\b/i.test(t)],
  ["blessing", "City's Blessing marker", "designation", (t, k) => hasAny(k, ["ascend"]) || /\bcity's blessing\b/i.test(t)],
  ["dungeon", "Dungeon cards", "designation", (t) => /\bventure into the dungeon\b/i.test(t)],
  ["ring", "The Ring emblem", "designation", (t) => /\bthe ring tempts you\b/i.test(t)],
  ["speed", "Speed tracker", "designation", (t) => /\bstart your engines\b|\byour speed\b/i.test(t)],
  ["emblem", "Emblems", "other", (t) => /\bemblem\b/i.test(t) && !/\bthe ring tempts you\b/i.test(t)],
  ["facedown", "Face-down card markers", "other", (t, k) => hasAny(k, ["morph", "megamorph", "disguise", "cloak", "manifest", "foretell", "manifest dread"]) || /\bface[- ]down\b|\bmanifests?\b|\bcloaks?\b/i.test(t),
    "Morph, disguise, manifest, cloak, foretell: keep the face-down cards apart (different sleeves or a marker)."],
  ["copies", "Token copies (proxies or markers)", "other", (t, k) => /\btokens? that's a copy\b|\btoken cop(y|ies)\b|\bcopy of (target|that|it|this)[^.]*\btoken\b|\bpopulate\b/i.test(t)
    || hasAny(k, ["embalm", "eternalize", "encore", "myriad", "squad", "offspring", "populate"]),
    "These make tokens that copy a card: a proxy or a spare printing works."],
  ["attraction", "Attractions", "other", (t) => /\battractions?\b/i.test(t)],
  ["sticker", "Sticker sheets", "other", (t) => /\bsticker\b/i.test(t)],
  ["contraption", "Contraptions", "other", (t) => /\bcontraptions?\b|\bassemble\b/i.test(t)],
];
const KNOWN_COUNTERS = new Set(["+1/+1", "-1/-1", "loyalty", "poison", "energy", "experience", "lore", "time"]);
const NOT_COUNTER_WORDS = new Set(["the", "a", "an", "that", "this", "each", "any", "target", "one", "two", "of", "more", "additional", "another", "kind", "those", "such", "same", "single", "or", "and", "your", "its", "their"]);
const hasAny = (keywords, list) => list.some((w) => keywords.has(w));

/** Other named counters of a text ("a shield counter", "three oil counters") as lowercase words. */
export function namedCounters(text) {
  const words = new Set();
  const re = /\b(?:a|an|one|two|three|four|five|six|x|\d+|that many|additional|another)\s+([a-z][a-z-]*)\s+counters?\b/gi;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const w = lc(m[1]);
    if (!NOT_COUNTER_WORDS.has(w) && !KNOWN_COUNTERS.has(w)) words.add(w);
  }
  return [...words];
}

/** Marker keys a card row needs (MARKERS keys and `counter:<word>`). */
export function markersOf(row) {
  const text = stripReminder(row.oracle_text);
  const keywords = new Set(keywordsOf(row).map(lc));
  const keys = [];
  for (const [key, , , test] of MARKERS) if (test(text, keywords, row)) keys.push(key);
  for (const w of namedCounters(text)) keys.push(`counter:${w}`);
  return keys;
}

// ---------------------------------------------------------------------------
// Deck accessories

const tokenKey = (name, pt, colors) => `${lc(name)}|${pt ?? ""}|${colors ?? ""}`;
const partName = (name) => String(name ?? "").split(" // ")[0];

/** Does a token-making phrase name this token (by its name words, e.g. "Bird", "Zombie Army")? */
function phraseNames(phrase, name) {
  const words = new Set(phrase.names.map(lc));
  return partName(name).split(/\s+/).some((w) => words.has(lc(w)));
}

/**
 * Tokens and counters/markers of a deck's card rows (deckDetail rows: board, name,
 * quantity, scryfall_id, oracle_text, keywords, type_line, all_parts, fetched_at).
 * opts.tokensById: Map token scryfall_id → card row (name, type_line, power,
 * toughness, colors, oracle_text, image_small); opts.owned: [{name, power,
 * toughness, colors, binder, quantity}] (token copies in the collection).
 * Returns {status 'ok'|'pending', tokens[], markers[], maybe_skipped, unknown[]} plus a
 * non-enumerable fetch_ids (card + token ids whose data is missing).
 */
export function deckAccessories(rows, { tokensById = new Map(), owned = [] } = {}) {
  const tokens = new Map();
  const markers = new Map();
  const fetchIds = new Set();
  const unknown = [];
  let maybeSkipped = 0;
  const addFrom = (list, row, extra = {}) => {
    const side = row.board === "side";
    const e = list.find((f) => f.name === row.name && Boolean(f.side) === side);
    if (e) { e.quantity += qty(row); return e; }
    const f = { name: row.name, quantity: qty(row), ...(side ? { side: true } : {}), ...extra };
    list.push(f);
    return f;
  };
  const tokenEntry = (key, init) => {
    if (!tokens.has(key)) tokens.set(key, { key, ...init, scryfall_ids: [], from: [], _res: [] });
    return tokens.get(key);
  };

  for (const row of rows) {
    if (row.board === "maybe") { maybeSkipped += qty(row); continue; }
    if (!qty(row)) continue;
    const text = row.oracle_text ?? "";
    if (row.scryfall_id == null || (!text && row.type_line == null)) unknown.push(row.name);
    const parts = json(row.all_parts, null);
    if (row.scryfall_id && parts == null) fetchIds.add(row.scryfall_id);
    const phrases = tokenPhrases(text, row.keywords);
    const recast = RECAST.test(text) ? 2 : 1;
    const used = new Set();
    const add = (entry, phrase) => {
      const resolutions = qty(row) * recast * (phrase?.repeatable ? 2 : 1);
      const count = phrase ? phrase.count : null;
      entry._res.push({ side: row.board === "side", n: (count ?? VARIABLE_GUESS) * resolutions, variable: count == null, repeatable: Boolean(phrase?.repeatable), recast: recast > 1 });
      addFrom(entry.from, row);
    };

    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (/^Emblem\b/.test(p.type_line ?? "")) { markerAdd(markers, p.name === "The Ring" ? "ring" : "emblem", row, addFrom); continue; }
        if (/^Dungeon\b/.test(p.type_line ?? "")) { markerAdd(markers, /undercity/i.test(p.name) ? "initiative" : "dungeon", row, addFrom); continue; }
        if (p.component !== "token") {
          const helper = /monarch/i.test(p.name) ? "monarch" : /initiative/i.test(p.name) ? "initiative" : /day|night/i.test(p.name) ? "daynight"
            : /blessing/i.test(p.name) ? "blessing" : null;
          if (helper) markerAdd(markers, helper, row, addFrom);
          continue;
        }
        const t = tokensById.get(p.id);
        if (!t) fetchIds.add(p.id);
        const name = t?.name ?? p.name;
        const pt = t && t.power != null ? `${t.power}/${t.toughness}` : null;
        const colors = t ? sortColours(t.colors) : null;
        const entry = tokenEntry(tokenKey(name, pt, colors), {
          name, type_line: t?.type_line ?? p.type_line ?? null, pt, colors, oracle_text: t?.oracle_text ?? null,
          image_small: t?.image_small ?? null, source: t ? "scryfall" : "scryfall-name",
        });
        if (!entry.scryfall_ids.includes(p.id)) entry.scryfall_ids.push(p.id);
        // This card's phrases that name this token (else, with one token, every phrase).
        const tokenParts = parts.filter((x) => x.component === "token" && !/^Emblem\b/.test(x.type_line ?? ""));
        let mine = phrases.filter((ph) => !ph.copy && !used.has(ph) && phraseNames(ph, name));
        if (!mine.length && tokenParts.length === 1) mine = phrases.filter((ph) => !ph.copy && !used.has(ph));
        if (!mine.length) add(entry, null);
        for (const ph of mine) { used.add(ph); add(entry, ph); }
      }
    } else {
      // all_parts unknown (offline row, unresolved name, not fetched yet): the text alone.
      for (const ph of phrases) {
        if (ph.copy || !ph.names.length) continue;
        const name = ph.names.join(" ");
        const entry = tokenEntry(tokenKey(name, ph.pt, ph.colors), {
          name, type_line: ph.pt ? `Token Creature — ${name}` : `Token — ${name}`, pt: ph.pt, colors: ph.colors,
          oracle_text: null, image_small: null, source: "text",
        });
        add(entry, ph);
      }
    }
    for (const key of markersOf(row)) markerAdd(markers, key, row, addFrom);
    if (markers.has("dice")) {
      const m = markers.get("dice");
      for (const s of diceSizes(text)) if (!m.sizes.includes(s)) m.sizes.push(s);
      m.sizes.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      if (m.sizes.length) m.label = `Dice (${m.sizes.join(", ")})`;
    }
  }

  // Merge name-only entries (token row not fetched) into a detailed one of the same name.
  for (const t of [...tokens.values()]) {
    if (t.source === "scryfall") continue;
    const twin = [...tokens.values()].find((o) => o !== t && o.source === "scryfall" && lc(o.name) === lc(t.name)
      && (t.pt == null || o.pt === t.pt));
    if (!twin) continue;
    twin._res.push(...t._res);
    for (const f of t.from) {
      const e = twin.from.find((x) => x.name === f.name && Boolean(x.side) === Boolean(f.side));
      if (e) e.quantity += f.quantity; else twin.from.push(f);
    }
    for (const id of t.scryfall_ids) if (!twin.scryfall_ids.includes(id)) twin.scryfall_ids.push(id);
    tokens.delete(t.key);
  }

  const tokenList = [...tokens.values()].map((t) => {
    const main = t._res.filter((r) => !r.side);
    const base = main.length ? main : t._res;
    const total = base.reduce((a, r) => a + r.n, 0);
    const notes = [];
    if (base.some((r) => r.variable)) notes.push("X or variable");
    if (base.some((r) => r.repeatable)) notes.push("repeatable");
    if (base.some((r) => r.recast)) notes.push("cast twice (flashback etc.)");
    if (total > ESTIMATE_CAP) notes.push("capped");
    const own = ownedFor(t, owned);
    const { _res, ...rest } = t;
    return {
      ...rest, estimate: Math.max(1, Math.min(ESTIMATE_CAP, Math.round(total))), estimate_note: notes.join(", ") || null,
      ...(main.length ? {} : { side_only: true }), owned: own,
    };
  }).sort((a, b) => Number(Boolean(a.side_only)) - Number(Boolean(b.side_only)) || b.estimate - a.estimate || a.name.localeCompare(b.name));

  const markerList = [...markers.values()]
    .map((m) => ({ ...m, ...(m.from.every((f) => f.side) ? { side_only: true } : {}) }))
    .sort((a, b) => Number(Boolean(a.side_only)) - Number(Boolean(b.side_only)) || markerRank(a) - markerRank(b) || a.label.localeCompare(b.label));
  const result = { status: fetchIds.size ? "pending" : "ok", tokens: tokenList, markers: markerList, maybe_skipped: maybeSkipped, unknown };
  Object.defineProperty(result, "fetch_ids", { value: [...fetchIds], enumerable: false });
  return result;
}

const KIND_RANK = { counter: 0, dice: 1, designation: 2, other: 3 };
const markerRank = (m) => KIND_RANK[m.kind] ?? 9;

const DIE_WORDS = { four: 4, six: 6, eight: 8, ten: 10, twelve: 12, twenty: 20 };
/** Die sizes a text rolls ("d20", "six-sided die" → d6). */
export function diceSizes(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/\bd(4|6|8|10|12|20)\b/g)) out.add(`d${m[1]}`);
  for (const m of String(text ?? "").matchAll(/\b(four|six|eight|ten|twelve|twenty)-sided di/gi)) out.add(`d${DIE_WORDS[m[1].toLowerCase()]}`);
  return [...out];
}

function markerAdd(markers, key, row, addFrom) {
  if (!markers.has(key)) {
    const def = MARKERS.find((m) => m[0] === key);
    const word = key.startsWith("counter:") ? key.slice(8) : null;
    markers.set(key, {
      key, label: def ? def[1] : `${word[0].toUpperCase()}${word.slice(1)} counters`, kind: def ? def[2] : "counter",
      ...(def?.[4] ? { note: def[4] } : {}), ...(key === "dice" ? { sizes: [] } : {}), from: [],
    });
  }
  const m = markers.get(key);
  if (!m.from.some((f) => f.name === row.name && Boolean(f.side) === (row.board === "side"))) addFrom(m.from, row);
}

/** Owned token copies matching a token: same name; P/T and colours too when both sides know them. */
function ownedFor(t, owned) {
  const binders = new Map();
  let quantity = 0;
  for (const o of owned) {
    if (lc(partName(o.name)) !== lc(partName(t.name))) continue;
    const pt = o.power != null ? `${o.power}/${o.toughness}` : null;
    if (t.pt && pt && t.pt !== pt) continue;
    if (t.colors != null && t.source !== "scryfall-name" && o.power != null && sortColours(o.colors) !== t.colors) continue;
    quantity += o.quantity;
    const k = lc(o.binder);
    const b = binders.get(k) ?? { binder: o.binder ?? "", quantity: 0 };
    b.quantity += o.quantity;
    binders.set(k, b);
  }
  return { quantity, binders: [...binders.values()].sort((a, b) => b.quantity - a.quantity) };
}

// ---------------------------------------------------------------------------
// DB glue

/** Token card rows by id, from the cards table. */
function tokenRows(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const stmt = db.prepare("SELECT scryfall_id, name, type_line, power, toughness, colors, oracle_text, image_small, layout, fetched_at FROM cards WHERE scryfall_id = ?");
  for (const id of ids) {
    const r = stmt.get(id);
    if (r && r.fetched_at !== "") out.set(id, r);
  }
  return out;
}

/** Token copies in the collection (any binder): [{name, power, toughness, colors, binder, quantity}]. */
export function ownedTokens(db) {
  return db.prepare(
    `SELECT c.name, c.power, c.toughness, c.colors, col.binder, SUM(col.quantity) AS quantity
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.layout IN ('token', 'double_faced_token') OR c.type_line LIKE 'Token%'
      GROUP BY c.scryfall_id, col.binder COLLATE NOCASE`,
  ).all();
}

/**
 * deckAccessories for card rows (they need all_parts; rows without it are read
 * from the cards table by scryfall_id), with the token rows and owned tokens from `db`.
 */
export function accessoriesForRows(db, rows) {
  const withParts = rows.map((r) => (r.all_parts !== undefined || !r.scryfall_id ? r
    : { ...r, all_parts: db.prepare("SELECT all_parts FROM cards WHERE scryfall_id = ?").get(r.scryfall_id)?.all_parts ?? null }));
  const ids = new Set();
  for (const r of withParts) {
    if (r.board === "maybe") continue;
    for (const p of json(r.all_parts, [])) if (p.component === "token") ids.add(p.id);
  }
  return deckAccessories(withParts, { tokensById: tokenRows(db, [...ids]), owned: ownedTokens(db) });
}

/**
 * Fetch the card rows `ids` (deck cards without all_parts, token printings) from
 * Scryfall's /cards/collection (≤75 per request, 2 req/s) and upsert them.
 * `write(fn)` wraps the write (the server's exclusive()); returns {fetched, not_found[]}.
 */
export async function fetchAccessoryCards(db, ids, { timeoutMs = 10_000, write = (fn) => fn() } = {}) {
  if (!ids.length) return { fetched: 0, not_found: [] };
  const conn = typeof db === "function" ? db : () => db;
  const { cards, notFound } = await fetchCollection(ids.map((id) => ({ id })), undefined, { signal: AbortSignal.timeout(timeoutMs) });
  const rows = cards.map(normalizeCard);
  await write(() => { const d = conn(); transaction(d, () => upsertCards(d, rows)); });
  const got = new Set(rows.map((r) => r.scryfall_id));
  return { fetched: rows.length, not_found: ids.filter((id) => !got.has(id)), scryfall_not_found: notFound.length };
}

/**
 * Make sure the accessory data of `rows` is cached: up to two rounds (the deck
 * cards' all_parts, then the tokens they name). Errors and timeouts are
 * swallowed (the caller shows what it has). For the MCP tools and evaluate.
 */
export async function ensureAccessoryData(db, rows, { timeoutMs = 8000 } = {}) {
  const until = Date.now() + timeoutMs;
  const tried = new Set();
  for (let round = 0; round < 2; round++) {
    const ids = accessoriesForRows(db, rows.map(({ all_parts: _p, ...r }) => r)).fetch_ids.filter((id) => !tried.has(id));
    const left = until - Date.now();
    if (!ids.length || left < 500) return;
    ids.forEach((id) => tried.add(id));
    try { await fetchAccessoryCards(db, ids, { timeoutMs: left }); } catch { return; }
  }
}

/**
 * Background fetcher for the server: ensure(ids) queues missing ids (debounced,
 * one batch at a time, outside any lock; writes through opts.write), status(ids)
 * → 'pending' (queued or in flight) | 'unavailable' (disabled, not found, or
 * failed: retried after retryMs). opts: {db (function), write, enabled(), log, retryMs}.
 */
export function createAccessoryFetcher({ db, write = (fn) => fn(), enabled = () => true, log = console, retryMs = 5 * 60_000, delayMs = 300, busyRetryMs = 5000 } = {}) {
  const queued = new Set();
  const failed = new Map(); // id -> retry after (ms epoch), Infinity = not found
  let running = false;
  let timer = null;
  let wait = delayMs;
  const run = async () => {
    timer = null;
    if (running || !queued.size) return;
    running = true;
    const ids = [...queued].slice(0, 300);
    try {
      const r = await fetchAccessoryCards(db, ids, { write, timeoutMs: 20_000 });
      for (const id of r.not_found) failed.set(id, Infinity);
      ids.forEach((id) => queued.delete(id));
    } catch (err) {
      // The app was busy (409) or restoring (503): keep the ids queued and try again soon.
      if (err.status === 409 || err.status === 503) wait = busyRetryMs;
      else {
        for (const id of ids) { queued.delete(id); failed.set(id, Date.now() + retryMs); }
        log?.warn?.(`[tokens] fetch failed: ${err.message}`);
      }
    } finally {
      running = false;
      if (queued.size) { timer = setTimeout(run, wait); timer.unref?.(); }
      wait = delayMs;
    }
  };
  const blocked = (id) => (failed.get(id) ?? 0) > Date.now();
  return {
    ensure(ids) {
      if (!enabled()) return;
      let added = false;
      for (const id of ids) if (!blocked(id) && !queued.has(id)) { queued.add(id); added = true; }
      if (added && !timer && !running) { timer = setTimeout(run, delayMs); timer.unref?.(); }
    },
    status(ids) {
      if (!ids.length) return "ok";
      if (!enabled()) return "unavailable";
      return ids.every(blocked) ? "unavailable" : "pending";
    },
    pending: () => [...queued],
  };
}

// ---------------------------------------------------------------------------
// Text (MCP)

/** One compact "Tokens & extras:" line (null when the deck needs nothing). */
export function accessoriesText(acc) {
  if (!acc || (!acc.tokens?.length && !acc.markers?.length)) return null;
  const tokens = acc.tokens.slice(0, 8).map((t) => {
    const desc = [t.pt, t.colors || (t.pt ? "colorless" : "")].filter(Boolean).join(" ");
    const own = t.owned?.quantity ? `, own ${t.owned.quantity}${t.owned.binders[0]?.binder ? ` in ${t.owned.binders[0].binder}` : ""}` : "";
    return `${t.name}${desc ? ` ${desc}` : ""} ~${t.estimate}${t.estimate >= ESTIMATE_CAP ? "+" : ""}${own}${t.side_only ? " (side)" : ""}`;
  });
  if (acc.tokens.length > 8) tokens.push(`+${acc.tokens.length - 8} more`);
  const markers = acc.markers.slice(0, 8).map((m) => m.label.replace(/ \(.*\)$/, ""));
  const parts = [];
  if (tokens.length) parts.push(`tokens ${tokens.join("; ")}`);
  if (markers.length) parts.push(`also ${markers.join(", ")}`);
  const note = acc.status === "pending" || acc.status === "unavailable" ? " (token details partly from card text)" : "";
  return `Tokens & extras: ${parts.join(". ")}.${note}`;
}
