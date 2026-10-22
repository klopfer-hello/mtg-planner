// Anchor corpus builder (developer tool, #069; not in the image, not in `npm test`): downloads public decklists,
// resolves every card through Scryfall into the app's `cards` row shape, measures each deck with the app's own code
// (lib/anchorstats.js deckMetrics → lib/cardclass.js, lib/deckstats.js) and writes lib/anchors.json: medians and
// 25–75% bands per format × bracket cell with the corpus size, so the planner can quote "tuned bracket-3 decks run
// 35–38 lands (n=70)" instead of folklore. Re-run a few times a year; the diff of anchors.json is the review.
//
// Sources (only JSON APIs or JSON embedded by the publisher; no HTML scraping of deck sites):
//   Commander b2–b5: Archidekt public deck search (most viewed, user's own bracket label, edited since 2025);
//   Commander precons: WotC decklists via MTGJSON (last 3 years; the bracket-2 baseline);
//   Pauper: official MTGO decklists (Challenge + League 5-0), the JSON the page embeds.
// Politeness: ≥ 350 ms between requests per host, an identifying User-Agent, every raw download cached in
// CACHE_DIR (default /tmp/anchors-cache) so a re-run is offline. Delete the cache to refresh.
//
//   docker run --rm -v "$PWD":/app -w /app node:24-slim node --disable-warning=ExperimentalWarning scripts/anchors.mjs
// Settings (environment): CACHE_DIR, PER_BRACKET (default 70), CEDH (default 45), PAUPER (default 110), OUT.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const UA = "mtg-planner-anchors/1.3 (+https://github.com/klopfer-hello/mtg-planner)";
process.env.SCRYFALL_USER_AGENT ||= UA;
const { fetchCollection, normalizeCard } = await import("../lib/scryfall.js");
const { normName } = await import("../lib/cardclass.js");
const { deckMetrics, aggregate } = await import("../lib/anchorstats.js");

const CACHE = process.env.CACHE_DIR || "/tmp/anchors-cache";
const OUT = process.env.OUT || new URL("../lib/anchors.json", import.meta.url);
const PER_BRACKET = Number(process.env.PER_BRACKET || 70);
const CEDH = Number(process.env.CEDH || 45);
const PAUPER = Number(process.env.PAUPER || 110);
const SINCE = "2025-01-01"; // Archidekt: edited after the bracket system existed (Game Changers, Feb 2025)
const PRECON_YEARS = 3;
const GAP_MS = 350;
mkdirSync(CACHE, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

// ---- polite cached GET ---------------------------------------------------------------------------------------
const last = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, { json = true } = {}) {
  const file = join(CACHE, createHash("sha1").update(url).digest("hex") + (json ? ".json" : ".html"));
  if (existsSync(file)) { const t = readFileSync(file, "utf8"); return json ? JSON.parse(t) : t; }
  const host = new URL(url).host;
  const wait = (last.get(host) || 0) + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 0; ; attempt++) {
    last.set(host, Date.now());
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/html" } });
    if (res.ok) {
      const t = await res.text();
      writeFileSync(file, t);
      return json ? JSON.parse(t) : t;
    }
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`${res.status} ${url}`);
    await sleep(res.status === 429 ? 30_000 : 3000 * (attempt + 1));
  }
}

// ---- sources: each returns [{id, source, cell, url, cards: [{name, board, quantity}]}] -------------------------
async function archidekt(bracket, want) {
  const decks = [];
  const owners = new Map();
  for (let page = 1; decks.length < want && page <= 12; page++) {
    const list = await get(`https://archidekt.com/api/decks/v3/?deckFormat=3&edhBracket=${bracket}&orderBy=-viewCount&pageSize=50&page=${page}`);
    for (const d of list.results || []) {
      if (decks.length >= want) break;
      if (d.edhBracket !== bracket || d.size !== 100 || d.theorycrafted || d.private || d.unlisted) continue;
      if ((d.updatedAt || "") < SINCE || (owners.get(d.owner?.id) || 0) >= 2) continue; // ≤ 2 decks per author
      const full = await get(`https://archidekt.com/api/decks/${d.id}/`).catch((e) => (log("skip", e.message), null));
      if (!full) continue;
      const cats = new Map((full.categories || []).map((c) => [c.name, c]));
      const cards = [];
      for (const c of full.cards || []) {
        const cat = cats.get((c.categories || [])[0]); // Archidekt: the first category decides
        if (cat && !cat.includedInDeck) continue; // maybeboard, sideboard, "considering"
        const name = c.card?.oracleCard?.name;
        if (name) cards.push({ name, board: (c.categories || []).some((n) => cats.get(n)?.isPremier) ? "commander" : "main", quantity: c.quantity });
      }
      const total = cards.reduce((s, c) => s + c.quantity, 0);
      if (total !== 100 || !cards.some((c) => c.board === "commander")) continue;
      owners.set(d.owner?.id, (owners.get(d.owner?.id) || 0) + 1);
      decks.push({ id: `archidekt:${d.id}`, source: "archidekt", cell: `commander:b${bracket}`, url: `https://archidekt.com/decks/${d.id}`, cards });
    }
  }
  log(`archidekt b${bracket}: ${decks.length} decks`);
  return decks;
}

async function precons() {
  const idx = await get("https://mtgjson.com/api/v5/DeckList.json");
  const since = new Date(Date.now() - PRECON_YEARS * 365.25 * 864e5).toISOString().slice(0, 10);
  const decks = [];
  for (const d of idx.data.filter((x) => x.type === "Commander Deck" && (x.releaseDate || "") >= since)) {
    const { data } = await get(`https://mtgjson.com/api/v5/decks/${d.fileName}.json`);
    const cards = [
      ...(data.commander || []).map((c) => ({ name: c.name, board: "commander", quantity: c.count || 1 })),
      ...(data.mainBoard || []).map((c) => ({ name: c.name, board: "main", quantity: c.count || 1 })),
    ];
    if (cards.reduce((s, c) => s + c.quantity, 0) !== 100) continue;
    decks.push({ id: `mtgjson:${d.fileName}`, source: "mtgjson", cell: "commander:precon", url: d.source, cards });
  }
  log(`mtgjson precons: ${decks.length} decks`);
  return decks;
}

async function mtgoPauper(want) {
  const index = await get("https://www.mtgo.com/decklists", { json: false });
  const pages = [...new Set([...index.matchAll(/href="(\/decklist\/pauper-(?:challenge|league)-[^"]+)"/g)].map((m) => m[1]))];
  const decks = [];
  for (const p of pages) {
    if (decks.length >= want) break;
    const html = await get(`https://www.mtgo.com${p}`, { json: false });
    const m = /window\.MTGO\.decklists\.data = (\{.*\});\s*$/m.exec(html);
    if (!m) { log("no data in", p); continue; }
    const ev = JSON.parse(m[1]);
    // Challenges list the top 32: keep the top 16 so a few days of events, not one, make the sample.
    const rank = new Map((ev.standings || []).map((s) => [s.loginid, Number(s.rank)]));
    for (const d of ev.decklists || []) {
      if (decks.length >= want) break;
      if (/challenge/.test(p) && (rank.get(d.loginid) ?? 99) > 16) continue;
      const cards = [
        ...(d.main_deck || []).map((c) => ({ name: c.card_attributes.card_name, board: "main", quantity: Number(c.qty) })),
        ...(d.sideboard_deck || []).map((c) => ({ name: c.card_attributes.card_name, board: "side", quantity: Number(c.qty) })),
      ];
      if (cards.filter((c) => c.board === "main").reduce((s, c) => s + c.quantity, 0) < 60) continue;
      decks.push({ id: `mtgo:${d.decktournamentid}`, source: "mtgo", cell: "pauper", url: `https://www.mtgo.com${p}`, cards });
    }
  }
  log(`mtgo pauper: ${decks.length} decks from ${pages.length} pages listed`);
  return decks;
}

// ---- card facts: Scryfall /cards/collection by name, normalised rows cached by normName ------------------------
const CARDS_FILE = join(CACHE, "cards.json");
// Front face only: /cards/collection misses full "A // B" names of adventures, rooms and splits; MTGO writes "Fire/Ice".
const lookupName = (n) => String(n).split(/\s*\/\/?\s*/)[0];
async function resolveCards(names) {
  const cache = existsSync(CARDS_FILE) ? JSON.parse(readFileSync(CARDS_FILE, "utf8")) : {};
  const missing = [...new Set(names.map(normName))].filter((k) => !(k in cache));
  const byKey = new Map(names.map((n) => [normName(n), n]));
  if (missing.length) {
    log(`scryfall: ${missing.length} names to resolve`);
    const { cards, notFound } = await fetchCollection(missing.map((k) => ({ name: lookupName(byKey.get(k)) })),
      (done, all) => done % 750 === 0 && log(`scryfall ${done}/${all}`));
    for (const c of cards) {
      const row = normalizeCard(c);
      for (const k of [normName(c.name), ...(c.card_faces || []).map((f) => normName(f.name))]) cache[k] ??= row;
    }
    for (const nf of notFound) cache[normName(nf.name)] ??= null;
    for (const k of missing) if (!(k in cache)) cache[k] = null;
    writeFileSync(CARDS_FILE, JSON.stringify(cache));
    if (notFound.length) log(`scryfall not found: ${notFound.map((n) => n.name).join(", ")}`);
  }
  return cache;
}

// ---- run -----------------------------------------------------------------------------------------------------
const decks = [
  ...await precons(),
  ...await archidekt(2, PER_BRACKET), ...await archidekt(3, PER_BRACKET), ...await archidekt(4, PER_BRACKET),
  ...await archidekt(5, CEDH),
  ...await mtgoPauper(PAUPER),
];
const cards = await resolveCards(decks.flatMap((d) => d.cards.map((c) => c.name)));

const byCell = new Map();
const used = new Map();
let dropped = 0;
for (const d of decks) {
  const unknown = d.cards.filter((c) => !cards[normName(c.name)]).reduce((s, c) => s + c.quantity, 0);
  if (unknown > 2) { dropped++; log(`drop ${d.id}: ${unknown} unresolved cards`); continue; }
  const rows = d.cards.filter((c) => cards[normName(c.name)]).map((c) => ({ ...cards[normName(c.name)], board: c.board, quantity: c.quantity }));
  const m = deckMetrics(rows);
  const cells = [d.cell];
  if (d.cell === "commander:precon") cells.push("commander:b2"); // the precon baseline is bracket 2
  if (/^commander:(b[234]|precon)$/.test(d.cell)) cells.push("commander"); // format-wide = casual/tuned, never cEDH
  for (const c of new Set(cells)) { if (!byCell.has(c)) byCell.set(c, []); byCell.get(c).push(m); }
  used.set(d.source, (used.get(d.source) || 0) + 1);
}

// Optional per-identity-size view: medians only, for the metrics that depend on colours.
function byColors(list) {
  const out = {};
  for (const k of [...new Set(list.map((m) => m.colors))].sort()) {
    const sub = list.filter((m) => m.colors === k);
    const a = aggregate(sub).metrics;
    out[k] = { n: sub.length, lands: a.lands?.median ?? null, ramp: a.ramp?.median ?? null, fixing_lands: a.fixing_lands?.median ?? null };
  }
  return out;
}
const ORDER = ["commander", "commander:precon", "commander:b2", "commander:b3", "commander:b4", "commander:b5", "pauper"];
const cellsOut = {};
for (const k of ORDER.filter((k) => byCell.has(k))) cellsOut[k] = { ...aggregate(byCell.get(k)), by_colors: byColors(byCell.get(k)) };

const anchors = {
  generated_at: new Date().toISOString().slice(0, 10),
  version: 1,
  sources: [
    { name: "Archidekt", url: "https://archidekt.com", decks: used.get("archidekt") || 0,
      note: `public Commander decks, most viewed, authors' own bracket label (2-5), edited since ${SINCE}, exactly 100 cards, no maybe/side, at most 2 per author` },
    { name: "MTGJSON (Wizards of the Coast precons)", url: "https://mtgjson.com", decks: used.get("mtgjson") || 0,
      note: `Commander precons of the last ${PRECON_YEARS} years; cell commander:precon, also counted in commander:b2` },
    { name: "MTGO decklists (Wizards of the Coast)", url: "https://www.mtgo.com/decklists", decks: used.get("mtgo") || 0,
      note: "recent Pauper Challenge top 16 and League 5-0 lists, main + sideboard" },
  ],
  note: "commander = brackets 2-4 + precons (cEDH only in commander:b5); copies counted; ramp includes fast mana; draw = engines + bursts; avg_mv nonland without commander; fixing_lands only for 2+ colours",
  cells: cellsOut,
};
// One line per metric / colour group: a re-run's diff shows exactly which numbers moved.
const flat = (json) => json.replace(/\{\n\s+([^{}[\]]*?)\n\s*\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`);
writeFileSync(OUT, flat(JSON.stringify(anchors, null, 1)) + "\n");
const SHOW = ["lands", "ramp", "draw", "removal", "wipes", "protection", "recursion", "cheap_plays", "avg_mv", "fixing_lands"];
console.log(["cell", "n", ...SHOW].join("\t"));
for (const [k, c] of Object.entries(cellsOut)) console.log([k, c.n, ...SHOW.map((s) => c.metrics[s] ? `${c.metrics[s].median} (${c.metrics[s].p25}-${c.metrics[s].p75})` : "-")].join("\t"));
log(`done: ${decks.length} decks fetched, ${dropped} dropped`);
