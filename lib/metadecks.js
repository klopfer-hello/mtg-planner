// Public tournament lists as a yardstick (plan v1.3.0 #074): official MTGO
// Pauper Challenge and League 5-0 decklists, kept in meta_decks, so the planner
// can say "4 Lightning Bolt in 92% of Burn lists, you run 2" instead of guessing.
//
// Why MTGO: it is WotC's own data (the page embeds the event as JSON: players,
// main deck, sideboard, standings), updated several times a week, and Pauper's
// competitive meta lives there. Archetypes are matched from signature cards,
// curated from the lists themselves (2026-10); a deck needs 3 signature cards,
// otherwise it is "Other". They are computed when read, so a better list
// applies to stored decks too.

import { getAppMeta, nowIso, setAppMeta } from "./db.js";
import { normName } from "./cardclass.js";
import { isBasicLand } from "./deckrules.js";
import { getText } from "./webcache.js";

const SITE = "https://www.mtgo.com";
export const META_TTL_MS = 3 * 24 * 3600 * 1000; // re-check the event list after 3 days
const KEEP_DAYS = 60;
const MAX_NEW_EVENTS = 8;

/** Pauper archetypes: name → signature cards (≥3 present = that archetype; the best match wins). */
export const PAUPER_ARCHETYPES = Object.freeze({
  "Dimir Faeries": ["Spellstutter Sprite", "Faerie Seer", "Ninja of the Deep Hours", "Moon-Circuit Hacker", "Augur of Bolas", "Baleful Strix"],
  "Blue Terror": ["Tolarian Terror", "Cryptic Serpent", "Deem Inferior", "Mental Note", "Thought Scour", "Delver of Secrets"],
  "Dimir Control": ["Murmuring Mystic", "Plunder the Trollshaws", "Thorn of the Black Rose", "Duress", "Spell Pierce", "Snuff Out"],
  "Red Deck Wins": ["Guttersnipe", "Fiery Temper", "Highway Robbery", "Grab the Prize", "Lava Dart", "Fireblast", "Kessig Flamebreather", "Faithless Looting"],
  "Rakdos Madness": ["Kitchen Imp", "Alms of the Vein", "Vampire's Kiss", "Voldaren Epicure", "Highway Robbery", "Grab the Prize"],
  "Affinity": ["Myr Enforcer", "Thoughtcast", "Reckoner's Bargain", "Utrom Monitor", "Refurbished Familiar", "Ichor Wellspring", "Krark-Clan Shaman", "Black Mage's Rod", "Frogmite"],
  "Kuldotha Goblins": ["Clockwork Percussionist", "Burning-Tree Emissary", "Goblin Bushwhacker", "Goblin Tomb Raider", "Rally at the Hornburg", "Experimental Synthesizer", "Kuldotha Rebirth"],
  "Boros Skyfisher": ["Glint Hawk", "Kor Skyfisher", "Pursue the Past", "Ragged Short Spear", "Melded Moxite", "Dispatch", "Thraben Inspector"],
  "Elves": ["Priest of Titania", "Timberwatch Elf", "Birchlore Rangers", "Jaspera Sentinel", "Llanowar Elves", "Fyndhorn Elves", "Elvish Vanguard", "Quirion Ranger", "Winding Way"],
  "Walls Combo": ["Overgrown Battlement", "Gatecreeper Vine", "Generous Ent", "Lead the Stampede", "Masked Vandal", "Saruli Caretaker", "Balustrade Spy", "Wall of Roots", "Mesmeric Fiend"],
  "Bogles": ["Slippery Bogle", "Gladecover Scout", "Ethereal Armor", "Ancestral Mask", "Armadillo Cloak", "Rancor", "Silhana Ledgewalker"],
  "Flicker": ["Ephemerate", "Archaeomancer", "God-Pharaoh's Faithful", "Mnemonic Wall", "Ghostly Flicker", "Stonehorn Dignitary", "Snap"],
  "Bramble Wurm Ramp": ["Bramble Wurm", "Giant's Boulder", "Barrels of Blasting Jelly", "Boulderbranch Golem", "Unfathomable Truths", "Bonder's Ornament", "Pinnacle Kill-Ship", "Ancient Stirrings"],
  "Mono-Black Sacrifice": ["Crypt Rats", "Defile", "Eviscerator's Insight", "Fanatical Offering", "Troll of Khazad-dûm", "Pestilence", "Cauldron Familiar"],
  "Turbo Fog": ["Weather the Storm", "Moment's Peace", "Tangle", "Growth Spiral", "Behold the Multiverse", "Embrace the Paradox"],
  "Glimpse Storm": ["Glimpse the Impossible", "Goblin Anarchomancer", "Manamorphose", "Seething Song", "Desperate Ritual", "Thornscape Familiar"],
  "Eldrazi Chrysalis": ["Writhing Chrysalis", "Eldrazi Repurposer", "Malevolent Rumble", "Jewel Thief", "Arbor Elf", "Wild Growth", "Bannerhide Krushok"],
  "White Weenie": ["Battle Screech", "Novice Inspector", "Lunarch Veteran", "Ramosian Rally", "Salt Road Packbeast", "Search Party Captain"],
});

const SIGNATURES = Object.entries(PAUPER_ARCHETYPES).map(([name, cards]) => [name, new Set(cards.map(normName))]);

/** Archetype of a card list ([{name, quantity, board}] or names): the signature set with the most hits (≥ 3), else "Other". */
export function pauperArchetype(cards) {
  const names = new Set(cards.filter((c) => typeof c === "string" || c.board !== "side").map((c) => normName(typeof c === "string" ? c : c.name)));
  let best = "Other", hits = 2;
  for (const [name, sig] of SIGNATURES) {
    let n = 0;
    for (const s of sig) if (names.has(s)) n++;
    if (n > hits) { best = name; hits = n; }
  }
  return best;
}

/** The decks of one MTGO event page (the embedded `window.MTGO.decklists.data` JSON). */
export function parseMtgoEvent(html) {
  const at = html.indexOf("window.MTGO.decklists.data =");
  if (at < 0) throw new Error("no decklist data on the page");
  const start = at + "window.MTGO.decklists.data =".length;
  const data = JSON.parse(html.slice(start, html.indexOf(";\n", start)).trim());
  const rank = new Map((data.standings || []).map((s) => [String(s.loginid), s.rank]));
  const cards = (list) => (list || []).map((c) => ({ name: c.card_attributes?.card_name, quantity: Number(c.qty) || 0 })).filter((c) => c.name && c.quantity);
  return {
    event: data.description || data.site_name, date: String(data.starttime || "").slice(0, 10), format: String(data.format || "").replace(/^C/, "").toLowerCase(),
    decks: (data.decklists || []).map((d) => ({
      player: d.player, placing: rank.get(String(d.loginid)) != null ? String(rank.get(String(d.loginid))) : /league/i.test(data.description || "") ? "5-0" : null,
      main: cards(d.main_deck), side: cards(d.sideboard_deck),
    })),
  };
}

/**
 * Fetch the newest events of a format from mtgo.com/decklists that are not stored yet (at most
 * MAX_NEW_EVENTS per call, one request at a time), store their decks and drop events older than
 * KEEP_DAYS. Skipped while the last check is younger than META_TTL_MS unless `force`. Never throws:
 * returns {checked, added, error?}.
 */
export async function refreshMetaDecks(db, { format = "pauper", force = false, signal, pauseMs = 400 } = {}) {
  const key = `meta_decks_checked:${format}`;
  const last = getAppMeta(db, key);
  if (!force && last && Date.now() - Date.parse(last) < META_TTL_MS) return { checked: false, added: 0 };
  let added = 0;
  try {
    const index = await getText(`${SITE}/decklists`, { signal });
    const links = [...new Set([...index.matchAll(new RegExp(`href="(/decklist/${format}-(?:challenge|league|showcase|preliminary)[^"]*)"`, "g"))].map((m) => m[1]))];
    const known = new Set(db.prepare("SELECT DISTINCT event FROM meta_decks WHERE source = 'mtgo'").all().map((r) => r.event));
    const put = db.prepare(`INSERT OR IGNORE INTO meta_decks (source, format, event, event_date, player, placing, archetype, cards, fetched_at)
      VALUES ('mtgo', ?, ?, ?, ?, ?, ?, ?, ?)`);
    let fetched = 0;
    for (const link of links) {
      if (fetched >= MAX_NEW_EVENTS) break;
      const slug = link.split("/").pop();
      if (known.has(slug)) continue;
      const ev = parseMtgoEvent(await getText(`${SITE}${link}`, { signal }));
      fetched++;
      for (const d of ev.decks) {
        const r = put.run(format, slug, ev.date, d.player, d.placing, pauperArchetype(d.main), JSON.stringify({ main: d.main, side: d.side }), nowIso());
        added += Number(r.changes);
      }
      if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
    }
    db.prepare("DELETE FROM meta_decks WHERE format = ? AND event_date < date('now', ?)").run(format, `-${KEEP_DAYS} days`);
    setAppMeta(db, key, nowIso());
    return { checked: true, added };
  } catch (err) {
    return { checked: true, added, error: err.message };
  }
}

/** Stored meta decks of a format: [{event, date, player, placing, archetype, main, side}]. */
export function metaDecks(db, format = "pauper") {
  return db.prepare("SELECT event, event_date, player, placing, cards FROM meta_decks WHERE format = ? ORDER BY event_date DESC, id").all(format)
    .map((r) => { const c = JSON.parse(r.cards); return { event: r.event, date: r.event_date, player: r.player, placing: r.placing, archetype: pauperArchetype(c.main), main: c.main, side: c.side }; });
}

/** Share of each archetype: [{archetype, decks, pct}], most played first. */
export function archetypeShares(decks) {
  const m = new Map();
  for (const d of decks) m.set(d.archetype, (m.get(d.archetype) ?? 0) + 1);
  return [...m].map(([archetype, n]) => ({ archetype, decks: n, pct: Math.round((n / decks.length) * 1000) / 10 })).sort((a, b) => b.decks - a.decks);
}

/**
 * A deck (deck_cards rows) against the meta: its archetype, the peer lists (same archetype when ≥ 5,
 * else all), staples it misses (in ≥ 50% of peers), cards it runs fewer of than peers usually do,
 * and its cards that ≤ 10% of peers play. Inclusion % and median copies per card.
 */
export function compareToMeta(decks, rows) {
  const main = rows.filter((r) => r.board === "main" || r.board === "commander");
  const archetype = pauperArchetype(main);
  const same = decks.filter((d) => d.archetype === archetype);
  const peers = archetype !== "Other" && same.length >= 5 ? same : decks;
  const stat = new Map();
  for (const d of peers) {
    for (const c of d.main) {
      const k = normName(c.name);
      const e = stat.get(k) ?? { name: c.name, decks: 0, copies: [] };
      e.decks++; e.copies.push(c.quantity);
      stat.set(k, e);
    }
  }
  const mine = new Map();
  for (const r of main) mine.set(normName(r.card_name || r.name), (mine.get(normName(r.card_name || r.name)) ?? 0) + Number(r.quantity || 0));
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const all = [...stat.values()].map((e) => ({ name: e.name, pct: Math.round((e.decks / peers.length) * 100), copies: median(e.copies), mine: mine.get(normName(e.name)) ?? 0 }))
    .filter((e) => !isBasicLand(e.name)).sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  return {
    archetype, peers: peers.length, peers_archetype: peers === same ? archetype : "all decks",
    missing: all.filter((e) => e.pct >= 50 && e.mine === 0).slice(0, 12),
    fewer: all.filter((e) => e.pct >= 50 && e.mine > 0 && e.mine < e.copies).slice(0, 8),
    rare: [...mine.keys()].filter((k) => !isBasicLand(k) && ((stat.get(k)?.decks ?? 0) / peers.length) <= 0.1)
      .map((k) => main.find((r) => normName(r.card_name || r.name) === k)?.name ?? k).slice(0, 8),
  };
}
