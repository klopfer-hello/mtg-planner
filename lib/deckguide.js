// Deck guide (0.9.0): a beginner-friendly, ADHD-friendly guide to one deck, for the deck page and a PDF.
//
// Two layers, so a guide exists even without Claude:
// - FACTS (local, deterministic): commander, colours, curve, card types, value, bracket/score, tokens,
//   key cards, and the TECHNIQUES the deck uses, found by matching card text, keywords and the local
//   card classifier (lib/cardclass.js) against a fixed catalogue with plain-language explanations.
//   Keywords on the cards get a glossary from a fixed list too.
// - STRATEGY (Claude, optional): one headless CLI call (lib/claude.js runGuide, no tools) gets the facts
//   and the decklist and answers with JSON: summary, how it wins, a turn-by-turn plan, mulligan rules,
//   key cards, how THIS deck uses each technique, pitfalls, practice steps, extra glossary terms. The
//   answer is validated and trimmed here; card names it invents are dropped.
// Guides are stored in deck_guides (migration v18), the newest GUIDES_KEEP per deck.

import { classifyCard } from "./cardclass.js";
import { deckDetail, isBasicLand } from "./decks.js";
import { transaction } from "./db.js";

export const GUIDES_KEEP = 5;
export const GUIDE_KINDS = ["facts", "full"];

const COLOUR_NAME = { W: "white", U: "blue", B: "black", R: "red", G: "green" };

// --- techniques ---------------------------------------------------------------
// test(card, ctx) → true when the card uses it; min = cards needed before the deck "uses" it.
const tagged = (...tags) => (c, x) => x.tags.some((t) => tags.includes(t.tag));
const textHas = (re) => (c, x) => re.test(x.text);
const kwHas = (...names) => (c, x) => names.some((n) => x.kw.has(n));

export const TECHNIQUES = [
  { key: "ramp", name: "Ramp", min: 3, test: tagged("ramp", "fast_mana"),
    what: "Cards that give you extra mana or extra lands early. More mana sooner means you can cast your big spells turns before your opponents expect it." },
  { key: "card_draw", name: "Card draw", min: 3, test: tagged("cantrip", "draw_burst", "draw_engine"),
    what: "Cards that let you draw more cards. More cards in hand means more choices and you run out of gas later than your opponents." },
  { key: "removal", name: "Removal", min: 2, test: tagged("removal"),
    what: "Cards that destroy, exile or bounce one threat. Save them for the cards that would beat you, not for the first creature you see." },
  { key: "board_wipe", name: "Board wipes", min: 1, test: tagged("wipe"),
    what: "Cards that clear many creatures at once. Best when your opponents have more on the table than you do." },
  { key: "counterspells", name: "Counterspells", min: 2, test: tagged("counter"),
    what: "Instants that stop a spell while it is being cast. Keep mana open on your opponents' turns to use them." },
  { key: "tutors", name: "Tutors", min: 2, test: tagged("tutor"),
    what: "Cards that search your library for a specific card. Use them to find the piece you need right now, often your win condition." },
  { key: "protection", name: "Protection", min: 2, test: tagged("protection"),
    what: "Cards that keep your important creatures alive (hexproof, indestructible, shields). Hold one back for your commander." },
  { key: "tokens", name: "Tokens", min: 3, test: textHas(/\bcreates?\b[^.]*\btokens?\b/i),
    what: "Cards that create extra creatures or objects. Many small bodies add up, and they feed sacrifice and 'go wide' effects." },
  { key: "counters", name: "+1/+1 counters", min: 3, test: textHas(/\+1\/\+1 counters?/i),
    what: "Counters that make creatures permanently bigger. Spread them out or stack them on one threat." },
  { key: "sacrifice", name: "Sacrifice", min: 3, test: textHas(/\bsacrifice (a|an|another|two|x)\b/i),
    what: "Cards that turn your own creatures or permanents into value when they leave. Sacrifice what would die anyway, never by accident." },
  { key: "graveyard", name: "Graveyard value", min: 3, test: textHas(/\bfrom your graveyard\b|\bflashback\b|\bescape\b|\bunearth\b/i),
    what: "Cards that bring things back from your graveyard. A card that dies is not lost: count your graveyard as a second hand." },
  { key: "blink", name: "Blink (flicker)", min: 2, test: textHas(/\bexile\b[^.]*\breturn\b[^.]*\bto the battlefield\b/i),
    what: "Exiling a creature and returning it at once. It enters again, so its 'when this enters' ability happens again." },
  { key: "lifegain", name: "Life gain", min: 3, test: (c, x) => /\bgain(s)? \d+ life\b|\bgain life\b|\byou gain life\b/i.test(x.text) || x.kw.has("Lifelink"),
    what: "Cards that gain you life. Extra life buys time; some cards also reward you every time you gain it." },
  { key: "evasion", name: "Evasion", min: 4, test: kwHas("Flying", "Menace", "Trample", "Shadow", "Horsemanship", "Skulk") ,
    what: "Creatures that are hard to block (flying, menace, trample). They get damage through even when your opponents have blockers." },
  { key: "equipment", name: "Equipment and Auras", min: 4, test: (c) => /\b(Equipment|Aura)\b/.test(c.type_line || ""),
    what: "Cards you attach to a creature to make it stronger. Put them on a creature that is hard to remove." },
  { key: "landfall", name: "Landfall", min: 2, test: textHas(/\blandfall\b|\bwhenever a land (you control )?enters\b/i),
    what: "Abilities that trigger when a land enters under your control. Play a land every turn, and extra lands give extra triggers." },
  { key: "spellslinger", name: "Spells matter", min: 2, test: textHas(/\bwhenever you cast an instant or sorcery\b|\binstant (and|or) sorcery spells? you cast\b/i),
    what: "Cards that reward casting instants and sorceries. Cheap spells cast in a row add up to big turns." },
  { key: "extra_turns", name: "Extra turns", min: 1, test: tagged("extra_turn"),
    what: "Cards that give you another turn. Strong, but many players find chaining them unfun: check with your group." },
  { key: "mill", name: "Mill", min: 3, test: textHas(/\bmills?\b/i),
    what: "Putting cards from the top of a library into the graveyard. Used to fill your own graveyard or to empty an opponent's library." },
];

// --- glossary -----------------------------------------------------------------
export const KEYWORDS = {
  Flying: "Can only be blocked by creatures with flying or reach.",
  Reach: "Can block creatures with flying.",
  Trample: "Damage beyond what kills the blocker goes through to the player.",
  Deathtouch: "Any damage it deals to a creature destroys that creature.",
  Lifelink: "Damage it deals also gains you that much life.",
  Haste: "Can attack and use tap abilities the turn it comes out.",
  Vigilance: "Attacking doesn't tap it, so it can still block.",
  "First strike": "Deals combat damage before creatures without first strike.",
  "Double strike": "Deals combat damage twice: first-strike damage and regular damage.",
  Menace: "Can't be blocked except by two or more creatures.",
  Hexproof: "Can't be the target of your opponents' spells or abilities.",
  Indestructible: "Damage and 'destroy' effects don't kill it.",
  Ward: "Opponents must pay the ward cost when they target it, or their spell is countered.",
  Flash: "You may cast it any time you could cast an instant.",
  Defender: "Can't attack.",
  Prowess: "Gets +1/+1 until end of turn whenever you cast a noncreature spell.",
  Flashback: "You may cast it from your graveyard for its flashback cost, then it is exiled.",
  Cycling: "Pay the cycling cost and discard it to draw a card.",
  Scry: "Look at the top cards of your library, keep any on top and put the rest on the bottom.",
  Surveil: "Look at the top cards, put any into your graveyard and the rest back on top.",
  Equip: "Pay the equip cost to attach the Equipment to one of your creatures (only when you could cast a sorcery).",
  Enchant: "Says what this Aura can be attached to.",
  Kicker: "You may pay an extra cost when casting it for a stronger effect.",
  Convoke: "Your creatures can tap to help pay for it.",
  Cascade: "When you cast it, reveal cards until a cheaper nonland card and cast that for free.",
  Landfall: "Triggers whenever a land enters under your control.",
  Protection: "Can't be blocked, targeted, damaged or enchanted by anything with the named quality.",
  Shroud: "Can't be the target of any spells or abilities, not even yours.",
  Persist: "When it dies without a -1/-1 counter, it returns with a -1/-1 counter.",
  Undying: "When it dies without a +1/+1 counter, it returns with a +1/+1 counter.",
  Mill: "Put cards from the top of a library into the graveyard.",
  Treasure: "A token you can sacrifice for one mana of any colour.",
  Food: "A token you can pay 2 for, tap and sacrifice to gain 3 life.",
  Clue: "A token you can pay 2 for and sacrifice to draw a card.",
  Partner: "Two commanders with partner can lead the deck together.",
  Affinity: "Costs less for each permanent of the named kind you control.",
  Delve: "Exile cards from your graveyard to help pay for it.",
  Storm: "Copy it for each spell cast before it this turn.",
  Ninjutsu: "Swap an unblocked attacker back to your hand to put this creature in attacking.",
  Raid: "Gets a bonus if you attacked this turn.",
  Morph: "Can be cast face down as a 2/2 for 3, then turned face up for its morph cost.",
};
const TERMS = {
  "Mana value": "The total mana in a card's cost (a {2}{G} card has mana value 3).",
  "Mana curve": "How many cards you have at each mana value. A good curve gives you something to cast every turn.",
  Mulligan: "Shuffling your opening hand away for a new one (with one card fewer to keep) when it can't work.",
  Commander: "The legendary creature your deck is built around. It starts in the command zone and returns there; each recast costs 2 more.",
  "Colour identity": "All mana symbols on your commander. Every card in the deck must fit inside it.",
  "Bracket": "A 1-5 power label so players can find games of similar strength (1 = casual, 5 = highest power).",
};

// --- facts --------------------------------------------------------------------
const kwSet = (card) => {
  let kw = card?.keywords ?? [];
  if (typeof kw === "string") { try { kw = JSON.parse(kw); } catch { kw = []; } }
  return new Set(Array.isArray(kw) ? kw : []);
};
const textOf = (c) => `${c.type_line ?? ""}\n${c.oracle_text ?? ""}`;
const short = (s, n) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : "");

/**
 * The deterministic part of a guide for one deck (commander + main; side/maybe ignored): {deck, colours,
 * commander[], counts, curve, types, value_eur, power, techniques[{key, name, what, cards[]}],
 * glossary[{term, meaning}], tokens[], key_cards[{name, why, image}], lands}. null for an unknown deck.
 */
export function guideFacts(db, deckId) {
  let d;
  try { d = deckDetail(db, deckId); } catch { return null; }
  if (!d) return null;
  const play = d.cards.filter((c) => c.board === "commander" || c.board === "main");
  const commander = d.cards.filter((c) => c.board === "commander").map((c) => ({ name: c.name, image: c.image_normal ?? c.image_small ?? null, type_line: c.type_line ?? null, oracle_text: c.oracle_text ?? null }));
  const ctx = play.map((c) => ({ c, tags: c.scryfall_id ? classifyCard(c) : [], text: textOf(c), kw: kwSet(c) }));
  const techniques = [];
  for (const t of TECHNIQUES) {
    const cards = ctx.filter((x) => !isBasicLand(x.c.name) && t.test(x.c, x)).map((x) => x.c.name);
    const uniq = [...new Set(cards)];
    if (uniq.length >= t.min) techniques.push({ key: t.key, name: t.name, what: t.what, cards: uniq.slice(0, 12), count: uniq.length });
  }
  techniques.sort((a, b) => b.count - a.count);
  const kwCount = new Map();
  for (const x of ctx) for (const k of x.kw) kwCount.set(k, (kwCount.get(k) ?? 0) + 1);
  const glossary = [...kwCount.entries()].filter(([k]) => KEYWORDS[k]).sort((a, b) => b[1] - a[1]).map(([k]) => ({ term: k, meaning: KEYWORDS[k] }));
  const unknownKeywords = [...kwCount.keys()].filter((k) => !KEYWORDS[k]).slice(0, 20);
  const commanderDeck = Boolean(d.power?.commander);
  for (const term of ["Mana value", "Mana curve", "Mulligan", ...(commanderDeck ? ["Commander", "Colour identity", "Bracket"] : [])]) glossary.push({ term, meaning: TERMS[term] });

  // Local key cards: the commander, Game Changers, cards in several techniques, then the most valuable.
  const inTech = new Map();
  for (const t of techniques) for (const n of t.cards) inTech.set(n, [...(inTech.get(n) ?? []), t.name]);
  const keyCards = [];
  const addKey = (c, why) => { if (c && !keyCards.some((k) => k.name === c.name) && keyCards.length < 8) keyCards.push({ name: c.name, why, image: c.image_normal ?? c.image_small ?? null }); };
  for (const c of d.cards.filter((x) => x.board === "commander")) addKey(c, "Your commander: the deck is built around it.");
  for (const x of ctx) if (x.tags.some((t) => t.tag === "game_changer")) addKey(x.c, "A Game Changer: one of the strongest cards in the format.");
  for (const x of ctx) if ((inTech.get(x.c.name) ?? []).length >= 2 && !isBasicLand(x.c.name)) addKey(x.c, `Does several jobs: ${inTech.get(x.c.name).join(", ").toLowerCase()}.`);
  for (const c of [...play].filter((c) => !isBasicLand(c.name) && !/\bLand\b/.test(c.type_line || "")).sort((a, b) => (b.eur ?? 0) - (a.eur ?? 0)).slice(0, 4)) addKey(c, "One of the most powerful (and priciest) cards here.");

  const identity = d.stats?.colours?.identity ?? "";
  return {
    deck: { id: d.id, name: d.name, format: d.format ?? null, status: d.status, notes: d.description ?? null },
    commander,
    colours: { identity, names: identity.split("").map((x) => COLOUR_NAME[x]).filter(Boolean) },
    counts: { cards: d.stats?.total ?? play.reduce((a, c) => a + c.quantity, 0), lands: d.stats?.lands ?? null, avg_mv: d.stats?.avg_mv ?? null },
    curve: d.stats?.curve ? { buckets: d.stats.curve.buckets, creature: d.stats.curve.creature, other: d.stats.curve.other } : null,
    types: d.stats?.types ?? null,
    value_eur: d.value?.total_eur ?? d.value?.deck_eur ?? null,
    power: commanderDeck ? {
      bracket: d.power?.bracket?.display ?? null, bracket_label: d.power?.bracket?.label ?? null, bracket_meaning: d.power?.bracket?.meaning ?? null,
      score: d.power?.score?.display ?? null,
    } : null,
    techniques,
    glossary,
    unknown_keywords: unknownKeywords,
    tokens: (d.accessories?.tokens ?? []).slice(0, 10).map((t) => ({ name: t.name, pt: t.pt ?? null, estimate: t.estimate ?? null })),
    combos: (d.combos?.items ?? []).slice(0, 5).map((c) => ({ cards: c.cards ?? c.uses ?? [], result: c.result ?? c.produces ?? null })),
    key_cards: keyCards,
    list: play.map((c) => ({ q: c.quantity, name: c.name, board: c.board, type: c.type_line ?? null, cost: c.mana_cost ?? null, text: short(c.oracle_text, 220), image: c.image_normal ?? c.image_small ?? null })),
  };
}

// --- Claude part ---------------------------------------------------------------
export const GUIDE_SYSTEM = `You write short deck guides for Magic: The Gathering beginners who may have ADHD. Write in English.
Rules: plain words, short sentences, no jargon without explaining it, no walls of text. Every bullet at most 18 words.
Talk to the player as "you". Only mention cards that are in the decklist. Be concrete about THIS deck.
Answer with ONLY one JSON object, no prose, no code fences, with exactly these keys:
{"summary": "2 sentences: what the deck does and how it feels to play",
 "how_it_wins": ["2-4 bullets"],
 "game_plan": {"early": ["3-4 bullets, turns 1-3"], "mid": ["3-4 bullets, turns 4-6"], "late": ["2-4 bullets, turn 7+"]},
 "mulligan": {"keep": ["2-4 bullets"], "ship": ["2-3 bullets"]},
 "key_cards": [{"name": "exact card name", "why": "one sentence"}],
 "techniques": [{"key": "a technique key from the facts", "tip": "one or two sentences: how this deck uses it"}],
 "pitfalls": ["3-5 common beginner mistakes with this deck"],
 "practice": ["3-5 steps to learn the deck, e.g. goldfish games, what to watch for"],
 "glossary": [{"term": "a game term or keyword used in the deck that the facts do not explain", "meaning": "one sentence"}]}
key_cards: 4-8 cards. techniques: one entry per technique key listed in the facts.`;

/** The user prompt: the facts (without images) and the decklist. */
export function guidePrompt(facts) {
  const lines = [];
  lines.push(`Deck: ${facts.deck.name}${facts.deck.format ? ` (format: ${facts.deck.format})` : ""}`);
  if (facts.commander.length) lines.push(`Commander: ${facts.commander.map((c) => c.name).join(" + ")}`);
  if (facts.colours.names.length) lines.push(`Colours: ${facts.colours.names.join(", ")}`);
  lines.push(`Cards: ${facts.counts.cards}, lands: ${facts.counts.lands ?? "?"}, average mana value: ${facts.counts.avg_mv ?? "?"}`);
  if (facts.types) lines.push(`Card types: ${Object.entries(facts.types).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (facts.power) lines.push(`Commander bracket: ${facts.power.bracket} (${facts.power.bracket_label}: ${facts.power.bracket_meaning}); power score ${facts.power.score}/10`);
  if (facts.techniques.length) {
    lines.push("Techniques found (key: cards):");
    for (const t of facts.techniques) lines.push(`- ${t.key} (${t.name}): ${t.cards.join(", ")}`);
  }
  if (facts.tokens.length) lines.push(`Tokens it makes: ${facts.tokens.map((t) => t.name).join(", ")}`);
  if (facts.unknown_keywords.length) lines.push(`Keywords without an explanation yet (explain them in glossary): ${facts.unknown_keywords.join(", ")}`);
  if (facts.deck.notes) lines.push(`The player's own notes:\n${short(facts.deck.notes, 1500)}`);
  lines.push("", "Decklist (count, name, type, cost, rules text):");
  for (const c of facts.list) lines.push(`${c.q} ${c.name}${c.board === "commander" ? " [commander]" : ""} | ${c.type ?? ""} | ${c.cost ?? ""} | ${(c.text ?? "").replace(/\n/g, " ")}`);
  return lines.join("\n");
}

const str = (v, n = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const strList = (v, max, n = 200) => (Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, max) : []);

/** Claude's JSON → the guide's strategy sections (trimmed, capped; unknown cards and technique keys dropped). */
export function cleanStrategy(json, facts) {
  if (!json || typeof json !== "object") return null;
  const names = new Map(facts.list.map((c) => [c.name.toLowerCase(), c.name]));
  for (const c of facts.list) { const front = c.name.split(" // ")[0].toLowerCase(); if (!names.has(front)) names.set(front, c.name); }
  const keys = new Set(facts.techniques.map((t) => t.key));
  const gp = json.game_plan && typeof json.game_plan === "object" ? json.game_plan : {};
  const mull = json.mulligan && typeof json.mulligan === "object" ? json.mulligan : {};
  const out = {
    summary: str(json.summary, 500),
    how_it_wins: strList(json.how_it_wins, 5),
    game_plan: { early: strList(gp.early, 5), mid: strList(gp.mid, 5), late: strList(gp.late, 5) },
    mulligan: { keep: strList(mull.keep, 5), ship: strList(mull.ship, 4) },
    key_cards: (Array.isArray(json.key_cards) ? json.key_cards : [])
      .map((k) => ({ name: names.get(str(k?.name, 150).toLowerCase()) ?? null, why: str(k?.why, 220) }))
      .filter((k) => k.name && k.why).slice(0, 8),
    technique_tips: Object.fromEntries((Array.isArray(json.techniques) ? json.techniques : [])
      .map((t) => [str(t?.key, 40), str(t?.tip, 320)]).filter(([k, tip]) => keys.has(k) && tip)),
    pitfalls: strList(json.pitfalls, 6),
    practice: strList(json.practice, 6),
    glossary: (Array.isArray(json.glossary) ? json.glossary : [])
      .map((g) => ({ term: str(g?.term, 40), meaning: str(g?.meaning, 220) })).filter((g) => g.term && g.meaning).slice(0, 12),
  };
  if (!out.summary && !out.how_it_wins.length) return null;
  return out;
}

/**
 * The guide as shown and printed: facts + strategy merged. Claude's key cards win (with the local
 * images); its glossary terms are added after the fixed ones (no duplicates); each technique gets its tip.
 */
export function composeGuide(facts, strategy = null) {
  const img = new Map([...facts.list.map((c) => [c.name, c.image]), ...facts.key_cards.map((k) => [k.name, k.image])]);
  const listImg = (name) => img.get(name) ?? null;
  const keyCards = strategy?.key_cards?.length ? strategy.key_cards.map((k) => ({ ...k, image: listImg(k.name) })) : facts.key_cards;
  const terms = new Set(facts.glossary.map((g) => g.term.toLowerCase()));
  const glossary = [...facts.glossary, ...(strategy?.glossary ?? []).filter((g) => !terms.has(g.term.toLowerCase()))];
  const { list: _list, unknown_keywords: _u, ...rest } = facts;
  return {
    ...rest,
    key_cards: keyCards,
    techniques: facts.techniques.map((t) => ({ ...t, tip: strategy?.technique_tips?.[t.key] ?? null })),
    glossary,
    strategy: strategy ? {
      summary: strategy.summary, how_it_wins: strategy.how_it_wins, game_plan: strategy.game_plan, mulligan: strategy.mulligan,
      pitfalls: strategy.pitfalls, practice: strategy.practice,
    } : null,
  };
}

// --- storage ------------------------------------------------------------------
const latestVersionId = (db, deckId) => db.prepare("SELECT MAX(id) AS v FROM deck_versions WHERE deck_id = ?").get(deckId)?.v ?? null;

/** Store a guide (kind facts|full) and keep the newest GUIDES_KEEP of the deck. Returns its row. */
export function saveGuide(db, deckId, { kind, guide, model = null, costUsd = null, deckVersionId = undefined }) {
  if (!GUIDE_KINDS.includes(kind)) throw new Error(`kind must be ${GUIDE_KINDS.join(" or ")}`);
  return transaction(db, () => {
    if (!db.prepare("SELECT 1 FROM decks WHERE id = ?").get(deckId)) return null; // deleted meanwhile
    const at = new Date().toISOString();
    const v = deckVersionId === undefined ? latestVersionId(db, deckId) : deckVersionId;
    const id = Number(db.prepare("INSERT INTO deck_guides (deck_id, created_at, deck_version_id, kind, model, cost_usd, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(deckId, at, v, kind, model, costUsd, JSON.stringify(guide)).lastInsertRowid);
    db.prepare(`DELETE FROM deck_guides WHERE deck_id = ? AND id NOT IN (SELECT id FROM deck_guides WHERE deck_id = ? ORDER BY id DESC LIMIT ?)`)
      .run(deckId, deckId, GUIDES_KEEP);
    return { id, deck_id: deckId, created_at: at, deck_version_id: v, kind, model, cost_usd: costUsd, guide };
  });
}

/** The newest guide of a deck plus `stale` (the deck has a newer history version), or null. */
export function latestGuide(db, deckId) {
  const r = db.prepare("SELECT * FROM deck_guides WHERE deck_id = ? ORDER BY id DESC LIMIT 1").get(deckId);
  if (!r) return null;
  let guide = null;
  try { guide = JSON.parse(r.data); } catch { guide = null; }
  const v = latestVersionId(db, deckId);
  return { id: r.id, deck_id: r.deck_id, created_at: r.created_at, deck_version_id: r.deck_version_id, kind: r.kind, model: r.model,
    cost_usd: r.cost_usd, guide, stale: v != null && r.deck_version_id != null && v > r.deck_version_id };
}

/**
 * Make a guide: facts always; with `runGuide` (lib/claude.js) also Claude's strategy. Resolves
 * {row, error}: a Claude failure still stores the facts-only guide and reports the error.
 */
export async function generateGuide(db, deckId, { runGuide = null, signal, model = null } = {}) {
  const facts = guideFacts(db, deckId);
  if (!facts) return { row: null, error: "Deck not found" };
  const versionAtStart = latestVersionId(db, deckId);
  let strategy = null, error = null, costUsd = null;
  if (runGuide) {
    const r = await runGuide({ prompt: guidePrompt(facts), system: GUIDE_SYSTEM, signal });
    costUsd = r?.costUsd ?? null;
    if (r?.error) error = r.error;
    else {
      strategy = cleanStrategy(r?.json, facts);
      if (!strategy) error = "Claude's answer was not a usable guide";
    }
  }
  const row = saveGuide(db, deckId, {
    kind: strategy ? "full" : "facts", guide: composeGuide(facts, strategy), model: strategy ? model : null, costUsd, deckVersionId: versionAtStart,
  });
  return { row, error };
}
