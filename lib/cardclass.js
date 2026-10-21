// Card classification for the deck power score and bracket (plan v0.7.0 §4.2,
// §5). Every tag comes from local data only (oracle text, keywords, type line,
// cmc, produced_mana, game_changer and the curated name lists below), so the
// result is memoised per printing (scryfall_id|fetched_at) and a Commander
// Spellbook cache change never makes it stale: Spellbook's per-card flags are
// merged in afterwards, per deck (mergeSpellbook).
//
// Each tag carries its `source` (scryfall | spellbook | list | regex | name)
// and a `why` id, so a user can see (and dispute) why a card counts. Every
// functional tag runs on nonland cards only (front face not a Land): fetchlands,
// Evolving Wilds, Urza's Saga or a transmute land never count as tutors or ramp.
// Land-based fast mana (Ancient Tomb, Gemstone Caverns) comes from FAST_MANA.
//
// The regexes are the plan's, plus a few documented extensions (marked "ext")
// that fixed measured recall gaps against Scryfall Tagger without hurting
// precision (test/cardclass.test.js reports both on a recorded fixture).

import { parseJson } from "./db.js";

/** Tags classifyCard can emit, in display order. */
export const CARD_TAGS = Object.freeze([
  "game_changer", "fast_mana", "ramp", "tutor", "draw_engine", "draw_burst", "cantrip",
  "removal", "counter", "wipe", "free_interaction", "protection", "mld", "extra_turn",
]);

/** Source precedence: a tag found by several sources keeps the highest. */
const SOURCE_RANK = { spellbook: 5, scryfall: 4, list: 3, name: 2, regex: 1 };

/**
 * Normalise a card name for list matching: front face before " // ",
 * lowercase, NFKD without marks, curly quotes / backtick straightened, spaces collapsed.
 * The one copy: lib/spellbook.js uses it for Spellbook's names too.
 */
export function normName(name) {
  return String(name ?? "")
    .split(" // ")[0]
    .normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase().replace(/\s+/g, " ").trim();
}
const nameSet = (names) => Object.freeze(new Set(names.map(normName)));

// Game Changers as of 2026-02-09 (WotC update adding Farewell and Biorhythm;
// recorded from https://api.scryfall.com/cards/search?q=is%3Agamechanger on
// 2026-10-15: 53 cards). Only used where cards.game_changer is NULL (not yet
// fetched) or the deck row is unresolved; the Scryfall flag wins otherwise.
export const GC_FALLBACK = Object.freeze([
  "Ad Nauseam", "Ancient Tomb", "Aura Shards", "Biorhythm", "Bolas's Citadel", "Braids, Cabal Minion",
  "Chrome Mox", "Coalition Victory", "Consecrated Sphinx", "Crop Rotation", "Cyclonic Rift", "Demonic Tutor",
  "Drannith Magistrate", "Enlightened Tutor", "Farewell", "Field of the Dead", "Fierce Guardianship",
  "Force of Will", "Gaea's Cradle", "Gamble", "Gifts Ungiven", "Glacial Chasm", "Grand Arbiter Augustin IV",
  "Grim Monolith", "Humility", "Imperial Seal", "Intuition", "Jeska's Will", "Lion's Eye Diamond",
  "Mana Vault", "Mishra's Workshop", "Mox Diamond", "Mystical Tutor", "Narset, Parter of Veils",
  "Natural Order", "Necropotence", "Notion Thief", "Opposition Agent", "Orcish Bowmasters",
  "Panoptic Mirror", "Rhystic Study", "Seedborn Muse", "Serra's Sanctum", "Smothering Tithe",
  "Survival of the Fittest", "Teferi's Protection", "Tergrid, God of Fright", "Thassa's Oracle",
  "The One Ring", "The Tabernacle at Pendrell Vale", "Underworld Breach", "Vampiric Tutor", "Worldly Tutor",
]);

// Fast mana (curated 2026-10-15 from the cEDH staples lists and the plan §5):
// mana that pays for itself on the turn it is played. Lands and spirit guides
// can only come from this list; the cheap rocks/rituals are also caught by the
// net-mana rule below.
export const FAST_MANA = Object.freeze([
  "Sol Ring", "Mana Vault", "Mana Crypt", "Grim Monolith", "Chrome Mox", "Mox Diamond",
  "Mox Opal", "Mox Amber", "Jeweled Lotus", "Lotus Petal", "Lion's Eye Diamond",
  "Ancient Tomb", "Gemstone Caverns", "Mishra's Workshop", "Dark Ritual", "Cabal Ritual", "Rite of Flame",
  "Seething Song", "Pyretic Ritual", "Desperate Ritual", "Culling the Weak", "Simian Spirit Guide",
  "Elvish Spirit Guide", "Mana Geyser", "Jeska's Will",
]);

// Mass land denial (curated 2026-10-15; WotC's definition: "regularly destroy,
// exile, and bounce other lands, keep lands tapped, or change what mana is
// produced by four or more lands per player", Commander Brackets beta). Covers
// the cards the regexes below can't read (orbs, Contamination, Decree, …).
export const MLD_LIST = Object.freeze([
  "Armageddon", "Ravages of War", "Catastrophe", "Jokulhaups", "Obliterate", "Decree of Annihilation",
  "Ruination", "Sunder", "Winter Orb", "Static Orb", "Hokori, Dust Drinker", "Blood Moon",
  "Magus of the Moon", "Back to Basics", "Rising Waters", "Contamination", "Epicenter", "Winter Moon",
  "Harbinger of the Seas", "Stasis", "Price of Glory", "Wildfire", "Devastation", "Boom // Bust",
  "Impending Disaster", "Fall of the Thran", "Keldon Firebombers", "Global Ruin", "Cataclysm",
  "Tectonic Break", "Thoughts of Ruin", "Destructive Flow", "Mana Breach", "Overburden", "Death Cloud",
  "Infernal Darkness", "Apocalypse",
]);

// Free or near-free interaction the alternative-cost regex can't see (no
// "rather than pay" text: Phyrexian mana, 0-cost pacts, evoke, redirection).
// Curated 2026-10-15 from plan §5.
export const FREE_INTERACTION_EXTRA = Object.freeze([
  "Force of Will", "Fierce Guardianship", "Deflecting Swat", "Deadly Rollick", "Snuff Out",
  "Pact of Negation", "Mental Misstep", "Flusterstorm", "Mindbreak Trap", "Daze", "Misdirection",
  "Commandeer", "Subtlety", "Solitude", "Dismember", "Gut Shot", "Mogg Salvage", "Foil", "Thwart",
  "Pyrokinesis", "Sickening Shoal", "Force of Negation", "Force of Despair", "Force of Vigor",
  "Flawless Maneuver",
]);

const GC_SET = nameSet(GC_FALLBACK);
const FAST_SET = nameSet(FAST_MANA);
const MLD_SET = nameSet(MLD_LIST);
const FREE_SET = nameSet(FREE_INTERACTION_EXTRA);

// ---- text helpers ----------------------------------------------------------

/** Oracle text plus keywords (keywords may be a JSON string or an array). */
export function textOf(c) {
  return `${c?.oracle_text || ""}\n${keywordsOf(c).join("\n")}`;
}
/** A card's keywords as an array (stored as JSON text or already an array; [] when unknown). */
export function keywordsOf(c) {
  const kw = parseJson(c?.keywords, []);
  return Array.isArray(kw) ? kw : [];
}
const faceTypes = (c) => String(c?.type_line || "").split(" // ");
/** Front-face type line. */
export const frontType = (c) => faceTypes(c)[0];
/** True when the front face is a Land (MDFC spell // land is not a land). */
export const isLand = (c) => /\bLand\b/.test(frontType(c));
const isPermanentType = (t) => /\b(Artifact|Creature|Enchantment|Planeswalker|Battle|Land)\b/.test(t);

/**
 * Text used for the regexes: oracle text without reminder text, with a back
 * face that is a Land dropped (its "{T}: Add" is not ramp from the spell side).
 */
function rulesText(c) {
  const faces = String(c?.oracle_text || "").split("\n//\n");
  const types = faceTypes(c);
  const kept = faces.filter((_, i) => i === 0 || !/\bLand\b/.test(types[i] || ""));
  return kept.join("\n").replace(/\([^)]*\)/g, "");
}
const frontText = (c) => String(c?.oracle_text || "").split("\n//\n")[0].replace(/\([^)]*\)/g, "");
const sentences = (t) => t.split(/(?<=[.!?])\s+|\n/).filter(Boolean);

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** Largest amount of mana one "Add …" clause produces (0 when there is none). */
function netManaAdded(text) {
  let best = 0;
  for (const m of text.matchAll(/\bAdd ([^.]*)/g)) {
    const clause = m[1];
    if (/\bfor each\b/i.test(clause)) continue; // scales with counters (Everflowing Chalice): not fast
    const symbols = (clause.match(/\{[WUBRGC0-9]\}/g) || []).length;
    const word = /\b(one|two|three|four|five|six|seven|eight|nine|ten) mana\b/i.exec(clause);
    best = Math.max(best, symbols, word ? WORD_NUM[word[1].toLowerCase()] : 0);
  }
  return best;
}

// ---- regexes (plan §4.2/§5; "ext" = measured extension) --------------------

const RE = {
  // ramp
  rampLandSearch: /search your library for [^.]*\bland cards?\b[^.]*onto the battlefield/i,
  rampTypeSearch: /search your library for [^.]*\b(?:Plains|Island|Swamp|Mountain|Forest)\b[^.]*onto the battlefield/i, // ext: Farseek, Nature's Lore
  rampTapAdd: /\{T\}[^.]*: Add/,
  rampExtraLand: /play (?:an|two|\w+) additional lands?/i, // "two" is ext: Azusa
  // ext: a land-for-land trade is no ramp (Crop Rotation, Scapeshift); Harrow (1 for 2) still is
  rampLandCost: /sacrifice any number of lands|sacrifice a land\b[^]*search your library for a land card/i,
  rampLandFromHand: /put (?:a|up to \w+) lands? cards? from your hand onto the battlefield/i,
  // tutor
  tutor: /search your library (?:and\/or graveyard )?for (?:a|an|one|two|three|four|X|up to \w+|any number of) (?![^.]*\b(?:basic )?land\b)(?![^.]*\b(?:Plains|Island|Swamp|Mountain|Forest)\b)[^.]*?card/i,
  tutorDest: /into your hand|on top\b|from the top|onto the battlefield/i,
  // draw ("additional" is ext: Sylvan Library)
  // "draw", not "draws": an opponent drawing (Orcish Bowmasters, Smothering Tithe) is no engine
  drawEngine: /(?:whenever|at the beginning of)[^.]*\bdraw (?:a|\w+)(?: additional)? cards?/i,
  wheel: /each player discards their hand.*draws/is,
  drawBurst: /draws? (?:two|three|four|five|seven|X|that many|\d+) cards/i,
  drawOne: /\bdraws? a card\b/i,
  // removal ("up to one other target" is ext: Solitude)
  removal: /(?:destroy|exile) (?:up to \w+ |any number of |X |two |three )?(?:other |another )?target [^.]*?(?:creature|artifact|enchantment|planeswalker|nonland permanent|permanent)/i,
  graveyardHate: /\bcards? from\b|graveyard/i,
  blink: /\bthen return\b|return (?:it|them|those cards|that card|the exiled card) to the battlefield/i, // blink (Ghostly Flicker, Flickerwisp) is no removal
  bounce: /return (?:up to \w+ )?target [^.]*nonland permanent[^.]* to its owner's hand/i,
  bounceCreature: /return (?:up to \w+ )?target (?:[\w-]+ )?creature[^.]* to its owner's hand/i, // ext
  tuck: /owner of target [^.]*permanent shuffles it into|put target [^.]*(?:creature|permanent) on (?:the )?(?:top|bottom) of its owner's library/i, // ext: Chaos Warp, Condemn
  edict: /target (?:creature|player|opponent) sacrifices(?! [^.]*\blands?\b)/i, // a land edict (Epicenter) is no removal; "opponent" is ext
  edictEach: /each (?:opponent|player) sacrifices (?:a|an|one|two|three) (?:creatures?|attacking creatures?|nonland permanents?|artifacts?|enchantments?|planeswalkers?)\b/i, // ext
  burn: /deals? (?:\d+ |X |that much )?damage (?:equal to [^.]*? )?to (?:any target|(?:up to one |another )?target (?:creature|planeswalker|attacking|blocking))/i, // ext
  fight: /\bfights? (?:up to one |another )?target (?:[\w-]+ )?creature/i, // ext
  shrink: /target creature (?:an opponent controls )?gets -(?:\d+|X)\/-(?:\d+|X)/i, // ext
  // counter
  counter: /counter target [^.]*spell/i,
  counterExile: /exile (?:any number of )?target spells?\b/i, // ext: Mindbreak Trap
  // wipes ("-X", adjective before creatures, damage/bounce sweepers are ext)
  wipeAll: /(?:destroy|exile) all (?:other )?(?:[\w-]+ )?(?:creatures|nonland permanents|artifacts|enchantments)/i,
  wipeMinus: /(?:all|each) (?:other )?creatures? (?:\w+ )?gets? -(?:\d|X)/i,
  wipeOpp: /creatures (?:your opponents control|you don't control) get -(?:\d|X)/i, // ext
  wipeDamage: /deals? [^.]*damage[^.]* to each (?:other )?creature(?! you control)/i, // ext
  wipeBounce: /return all (?:other )?(?:[\w-]+ )?(?:nonland permanents|creatures)[^.]* to (?:their|its) owner(?:'s|s')? hands?/i, // ext
  wipeEach: /(?:destroy|exile) each (?:other )?(?:nonland )?(?:permanent|creature|artifact|enchantment)s?\b(?! you control)/i, // ext: Ugin
  // free interaction
  freeCost: /rather than pay [^.]*mana cost|without paying (?:its|this spell's) mana cost|If you control a commander, you may cast/i,
  // protection
  protection: /(?:creatures|permanents) you control (?:gain|have) (?:hexproof|indestructible|protection)|phase out/i,
  // mass land denial
  mldAll: /(?:destroy|exile|return) all (?:non-?basic )?lands/i,
  mldSacrifice: /each (?:player|opponent) sacrifices (?:all|\w+) lands/i,
  // a sentence whose subject is ALL (nonbasic/snow/one type of) lands; never
  // "target land(s)" / "that land" (Chandra's Revolution, Stensia Innkeeper)
  mldNoUntap: /(?:^|[.;]\s+)(?:non-?basic |snow )?(?:lands|islands|plains|swamps|mountains|forests)(?: (?:you don't control|your opponents control))? don't untap/im,
  mldNonbasic: /nonbasic lands are \w+/i,
  // extra turns ("two extra turns" is ext: Time Stretch)
  extraTurn: /takes? (?:an|two|\w+) extra turns?|\bgift an extra turn/i,
};

// ---- classification --------------------------------------------------------

function add(out, tag, source, why) {
  const prev = out.get(tag);
  if (!prev || SOURCE_RANK[source] > SOURCE_RANK[prev.source]) out.set(tag, { tag, source, why });
}
const finish = (out) => Object.freeze(
  [...out.values()].sort((a, b) => CARD_TAGS.indexOf(a.tag) - CARD_TAGS.indexOf(b.tag)).map(Object.freeze),
);

function classifyUncached(c) {
  const out = new Map();
  const nm = normName(c?.name);
  const land = isLand(c);
  const front = frontType(c);
  const text = rulesText(c);
  const permanent = isPermanentType(front);
  const instantOrSorcery = /\b(Instant|Sorcery)\b/.test(front);
  const cmc = c?.cmc == null ? null : Number(c.cmc);
  const kw = keywordsOf(c).map((k) => String(k).toLowerCase());

  // Game Changer: the Scryfall flag wins; the name list only fills unknowns.
  if (c?.game_changer === 1 || c?.game_changer === true) add(out, "game_changer", "scryfall", "gc_flag");
  else if (c?.game_changer == null && GC_SET.has(nm)) add(out, "game_changer", "list", "gc_list");

  if (FAST_SET.has(nm)) add(out, "fast_mana", "list", "fast_mana_list");
  if (MLD_SET.has(nm)) add(out, "mld", "list", "mld_list");
  if (FREE_SET.has(nm)) add(out, "free_interaction", "list", "free_list");

  if (land) return finish(out);

  // fast mana: cheap, untapped, nets mana on the turn it is played
  const ft = frontText(c);
  if (cmc != null && cmc <= 1 && netManaAdded(ft) > cmc && !/enters (?:the battlefield )?tapped/i.test(ft)) {
    add(out, "fast_mana", "regex", "fast_mana_net");
  }
  const fast = out.has("fast_mana");

  // ramp
  if (!RE.rampLandCost.test(text)) {
    if (RE.rampLandSearch.test(text)) add(out, "ramp", "regex", "ramp_land_search");
    else if (RE.rampTypeSearch.test(text)) add(out, "ramp", "regex", "ramp_type_search");
  }
  if (permanent && !fast && cmc != null && cmc <= 3) {
    const produced = parseJson(c?.produced_mana, null);
    if (Array.isArray(produced) && produced.length) add(out, "ramp", "scryfall", "ramp_produced_mana");
    else if (RE.rampTapAdd.test(ft)) add(out, "ramp", "regex", "ramp_mana_ability");
  }
  if (RE.rampExtraLand.test(text)) add(out, "ramp", "regex", "ramp_extra_land");
  if (RE.rampLandFromHand.test(text)) add(out, "ramp", "regex", "ramp_land_from_hand");

  // tutors
  // the destination may follow in the next sentences (Gifts Ungiven, Intuition)
  const sents = sentences(text);
  for (let i = 0; i < sents.length; i++) {
    const m = RE.tutor.exec(sents[i]);
    const rest = [sents[i].slice(m?.index ?? 0), sents[i + 1] || "", sents[i + 2] || ""].join(" ");
    if (m && RE.tutorDest.test(rest)) { add(out, "tutor", "regex", "tutor_search"); break; }
  }
  if (!out.has("tutor") && kw.includes("transmute")) add(out, "tutor", "regex", "tutor_transmute");

  // card draw
  if (permanent && RE.drawEngine.test(text)) add(out, "draw_engine", "regex", "draw_engine_trigger");
  if (RE.wheel.test(text)) add(out, "draw_engine", "regex", "draw_wheel");
  if (RE.drawBurst.test(text)) add(out, "draw_burst", "regex", "draw_burst");
  if (instantOrSorcery && !out.has("draw_burst") && !out.has("draw_engine") && RE.drawOne.test(text)
    && !/for each [^.]*draw a card|draw a card for each/i.test(text)) {
    add(out, "cantrip", "regex", "cantrip");
  }

  // removal
  const ss = sentences(text);
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (RE.removal.test(s) && !RE.graveyardHate.test(s) && !RE.blink.test(`${s} ${ss[i + 1] || ""}`)) { add(out, "removal", "regex", "removal_destroy_exile"); break; }
  }
  if (RE.bounce.test(text) || RE.bounceCreature.test(text)) add(out, "removal", "regex", "removal_bounce");
  if (RE.tuck.test(text)) add(out, "removal", "regex", "removal_tuck");
  if (RE.edict.test(text)) add(out, "removal", "regex", "removal_edict");
  if (RE.edictEach.test(text)) add(out, "removal", "regex", "removal_edict_each");
  if (RE.burn.test(text)) add(out, "removal", "regex", "removal_damage");
  if (RE.fight.test(text)) add(out, "removal", "regex", "removal_fight");
  if (RE.shrink.test(text)) add(out, "removal", "regex", "removal_shrink");

  if (RE.counter.test(text) || RE.counterExile.test(text)) add(out, "counter", "regex", "counter_spell");

  if (RE.wipeAll.test(text)) add(out, "wipe", "regex", "wipe_all");
  else if (RE.wipeMinus.test(text) || RE.wipeOpp.test(text)) add(out, "wipe", "regex", "wipe_minus");
  else if (RE.wipeDamage.test(text)) add(out, "wipe", "regex", "wipe_damage");
  else if (RE.wipeBounce.test(text)) add(out, "wipe", "regex", "wipe_bounce");
  else if (RE.wipeEach.test(text)) add(out, "wipe", "regex", "wipe_each");
  else if (out.has("removal") && kw.includes("overload")) add(out, "wipe", "regex", "wipe_overload");

  if ((out.has("removal") || out.has("counter") || out.has("wipe")) && RE.freeCost.test(text)) {
    add(out, "free_interaction", "regex", "free_alt_cost");
  }

  if (/\bInstant\b/.test(front) && RE.protection.test(text)) add(out, "protection", "regex", "protection_instant");

  if (RE.mldAll.test(text)) add(out, "mld", "regex", "mld_all_lands");
  else if (RE.mldSacrifice.test(text)) add(out, "mld", "regex", "mld_sacrifice");
  else if (RE.mldNoUntap.test(text)) add(out, "mld", "regex", "mld_no_untap");
  else if (RE.mldNonbasic.test(text)) add(out, "mld", "regex", "mld_nonbasic");

  for (const s of sentences(text)) {
    const m = RE.extraTurn.exec(s);
    if (m && !/\bskip/i.test(s.slice(0, m.index))) { add(out, "extra_turn", "regex", "extra_turn_text"); break; }
  }
  return finish(out);
}

const MEMO_MAX = 50000;
const memo = new Map();

/**
 * Classify one card row (the app `cards` table shape: name, type_line, cmc,
 * oracle_text, keywords, produced_mana, game_changer, layout). Returns a frozen
 * array of {tag, source, why}, memoised per scryfall_id|fetched_at.
 */
export function classifyCard(card) {
  if (!card) return Object.freeze([]);
  const key = card.scryfall_id ? `${card.scryfall_id}|${card.fetched_at ?? ""}` : null;
  if (key && memo.has(key)) return memo.get(key);
  const tags = classifyUncached(card);
  if (key) {
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(key, tags);
  }
  return tags;
}

/**
 * Tags for an unresolved deck row (only its typed name is known): the
 * GC_FALLBACK, MLD_LIST and FAST_MANA lists, source 'name'. `known` is false
 * when the name is on none of them (the bracket is then partial).
 */
export function classifyByName(name) {
  const nm = normName(name);
  const tags = [];
  if (GC_SET.has(nm)) tags.push({ tag: "game_changer", source: "name", why: "gc_list" });
  if (FAST_SET.has(nm)) tags.push({ tag: "fast_mana", source: "name", why: "fast_mana_list" });
  if (MLD_SET.has(nm)) tags.push({ tag: "mld", source: "name", why: "mld_list" });
  return { tags, known: tags.length > 0 };
}

/**
 * Merge Commander Spellbook's per-card flags ({gameChanger, massLandDenial,
 * extraTurn}) into a classifyCard result, per deck. Spellbook outranks every
 * other source; the memoised array is never mutated.
 */
export function mergeSpellbook(tags, flags = {}) {
  const out = new Map((tags || []).map((t) => [t.tag, t]));
  if (flags.gameChanger) add(out, "game_changer", "spellbook", "spellbook_game_changer");
  if (flags.massLandDenial) add(out, "mld", "spellbook", "spellbook_mld");
  if (flags.extraTurn) add(out, "extra_turn", "spellbook", "spellbook_extra_turn");
  return finish(out);
}

/** The {tag, source, why} entry for `tag`, or null. */
export const tagOf = (tags, tag) => (tags || []).find((t) => t.tag === tag) || null;
/** True when `tags` contains `tag`. */
export const hasTag = (tags, tag) => !!tagOf(tags, tag);

/** Clears the memo (tests). */
export function clearClassifyMemo() { memo.clear(); }
