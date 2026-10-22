// Goldfish simulator (#070): N seeded solo games over a deck list, so the
// planner can quote evidence ("colour screw 14% → 6%") instead of guessing.
//
// Why so small: no opponent, no stack, no rules engine. A deck is reduced once
// to a tiny card model (land or spell, MV, colour pips, the mana it adds, a few
// role tags from lib/cardclass.js), then every game is plain integer work on
// that model, so 10 000 games of a 100-card deck take well under a second.
// Same list → same seed → same numbers (rows are sorted first, order-free).
//
// Model:
// - Played boards only (commander + main; side, maybe, companion are ignored).
//   An unresolved row (no type_line) is a colourless nonland spell of MV 3.
// - Commander deck = a commander row exists: commanders start in the command
//   zone and are always available; the first mulligan is free (multiplayer).
//   London mulligan: draw 7, keep with 2–5 lands (Commander: 3–5, or 2 + a ramp
//   spell of MV ≤ 2; an MDFC with a land back counts as a land here); at most 2
//   mulligans, the third hand is kept. Bottoming: excess lands beyond 4 first,
//   then the highest-MV spells.
// - Turn 1..turns: draw from turn 2 (+1 per draw engine in play). One land drop:
//   real lands first (MDFC land backs only without one), preferring an untapped
//   land that adds a colour a spell in hand is missing. A land enters tapped when
//   its text says so without "unless"/"if you don't" (conditional = untapped).
// - Mana sources: lands (produced_mana, basic land types, "Add {X}", fetch
//   targets), permanents with "{T}…: Add" (artifacts at once, creatures from the
//   next turn), rituals (fast_mana instants/sorceries, once), land ramp (ramp tag
//   + "search … land … onto the battlefield": one land, tapped when it says so).
//   A source unit pays one pip of any colour in its mask; hybrid pips accept
//   either colour, {2/W} and Phyrexian pips count as the colour. The pip check
//   is greedy (most restrictive pip to the least flexible unit).
// - Casting each turn, until nothing is castable: ramp (ramp/fast_mana tag) first
//   up to turn 4, then the commander, then the cheapest castable spell. Effects:
//   draw_burst +2 cards, cantrip +1, draw_engine permanent +1 per later turn,
//   tutor = a missing combo piece from the library into hand (only with combos).
//
// Metrics (percent of games, one decimal):
// - keep_rate: kept the first 7 (no mulligan); mulligans_avg: mean mulligans taken.
// - lands_on_curve.t3/t4: ≥ 3 lands in play at the end of turn 3 / ≥ 4 at turn 4.
// - color_screw_t4: end of turn 4, a spell in hand with MV ≤ all mana sources in
//   play that the pip check still refuses (the colours, not the amount, are short).
// - flood_t6: end of turn 6, lands in play + lands in hand ≥ 7 and no nonland
//   card in hand castable with all sources in play (nothing left to spend mana on).
// - interaction_t3: a removal/counter/wipe card was drawn (hand or cast) by turn 3.
// - mana_by_turn: median mana available after the land drop, turns 1..8.
// - commander: % cast by turn 2..10, median turn, on_curve = % cast by turn MV.
// - combo: turn all pieces of any given line are in hand/play (commanders count).

import { parseJson } from "./db.js";
import { qtyOf } from "./deckstats.js";
import { classifyCard, frontType, hasTag, isLand, normName } from "./cardclass.js";

const BIT = { W: 1, U: 2, B: 4, R: 8, G: 16, C: 32 };
const ALL = 31;
const POP = Array.from({ length: 64 }, (_, m) => m.toString(2).replace(/0/g, "").length);
const BASIC_BIT = { plains: 1, island: 2, swamp: 4, mountain: 8, forest: 16 };
const FRONT_ONLY = new Set(["modal_dfc", "transform", "adventure", "flip", "reversible_card"]);
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const MAX_UNITS = 256;
const HIST = 64;

const pct = (n, games) => Math.round((n * 1000) / games) / 10;
const strip = (t) => String(t || "").replace(/\([^)]*\)/g, "");
const faceText = (r, i) => strip(String(r.oracle_text || "").split("\n//\n")[i] || "");
const isPermanent = (t) => /\b(Artifact|Creature|Enchantment|Planeswalker|Battle)\b/.test(t);

/** Colour mask of 'WU', ['W','U'] or a JSON array text. */
function maskOf(v) {
  let list = v;
  if (typeof v === "string") list = v.trim().startsWith("[") ? parseJson(v, []) : v.split("");
  let m = 0;
  for (const c of Array.isArray(list) ? list : []) m |= BIT[String(c).toUpperCase()] || 0;
  return m;
}
const basicsMask = (t) => {
  let m = 0;
  for (const [, b] of String(t || "").matchAll(/\b(Plains|Island|Swamp|Mountain|Forest)\b/gi)) m |= BASIC_BIT[b.toLowerCase()];
  return m;
};
/** Colours named in "Add …" clauses; "any colour" = the deck identity. */
function addMask(text, identity) {
  let m = 0;
  for (const [, clause] of text.matchAll(/\bAdd ([^.\n]*)/g)) {
    for (const [, c] of clause.matchAll(/\{([WUBRGC])\}/g)) m |= BIT[c];
    if (/any colou?r|any type/i.test(clause)) m |= identity;
  }
  return m;
}
/** Mana one activation adds: the longest run of symbols ({C}{C} = 2; "{R} or {G}" = 1), or "two mana". */
function manaAmount(text) {
  let best = 0;
  for (const [, clause] of text.matchAll(/\bAdd ([^.\n]*)/g)) {
    for (const run of clause.match(/(?:\{[WUBRGC]\})+/g) || []) best = Math.max(best, run.length / 3);
    const w = /\b(one|two|three|four|five) mana\b/i.exec(clause);
    if (w) best = Math.max(best, WORD_NUM[w[1].toLowerCase()]);
  }
  return Math.max(1, best);
}
/** Colour pips of a cost as masks, most restrictive first ({W/U} = W|U, {C} = C, generic none). */
function pipMasks(cost) {
  const out = [];
  for (const [, sym] of String(cost ?? "").matchAll(/\{([^}]*)\}/g)) {
    const s = sym.toUpperCase();
    let m = 0;
    if (s === "C") m = BIT.C;
    else for (const p of s.replace(/^H(?=[WUBRG]$)/, "").split("/")) if (p !== "C" && BIT[p]) m |= BIT[p];
    if (m) out.push(m);
  }
  return out.sort((a, b) => POP[a] - POP[b]);
}
const castCost = (r) => {
  const parts = String(r.mana_cost ?? "").split(" // ");
  return r.layout === "split" ? parts.join("") : FRONT_ONLY.has(r.layout) || r.layout == null ? parts[0] : r.mana_cost;
};
const entersTapped = (t) => /enters (?:the battlefield )?tapped|onto the battlefield tapped/i.test(t) && !/\bunless\b|if you don't/i.test(t);
const LAND_SEARCH = /search your library for [^.]*\b(?:lands?|Plains|Island|Swamp|Mountain|Forest)\b[^.]*onto the battlefield( tapped)?/i;

/** Mana a land face makes: produced_mana, its basic types, "Add {X}", fetch targets; C when none is known. */
function landMask(r, text, typeLine, identity) {
  let m = maskOf(parseJson(r.produced_mana, [])) | basicsMask(typeLine) | addMask(text, identity);
  if (/search your library for/i.test(text)) m |= basicsMask(text) || (/land card/i.test(text) ? identity : 0);
  return m || BIT.C;
}

/** The per-card model, computed once per deck row (classifyCard never runs in the game loop). */
function factsOf(r, identity) {
  const f = {
    name: r.name, n: normName(r.name), land: false, mdfc: false, tapped: false, mask: 0, amt: 1,
    cmc: 3, pips: [], generic: 3, ramp: false, cheapRamp: false, rock: 0, rockMask: 0, rockAmt: 0,
    ritual: 0, ritualMask: 0, landRamp: false, rampTapped: false, rampMask: 0, draw: 0, engine: false,
    tutor: false, interact: false,
  };
  if (!r.type_line) return f; // unresolved: colourless MV-3 spell
  const types = String(r.type_line).split(" // ");
  const front = frontType(r);
  f.cmc = Math.max(0, Math.floor(Number(r.cmc) || 0));
  f.pips = pipMasks(castCost(r));
  f.generic = Math.max(0, f.cmc - f.pips.length);
  if (isLand(r)) {
    const t = faceText(r, 0);
    Object.assign(f, { land: true, tapped: entersTapped(t), mask: landMask(r, t, front, identity), amt: /\{T\}[^.]*: Add/.test(t) ? manaAmount(t) : 1 });
    return f;
  }
  const back = types.findIndex((t, i) => i > 0 && /\bLand\b/.test(t));
  if (r.layout === "modal_dfc" && back > 0) {
    const t = faceText(r, back);
    Object.assign(f, { mdfc: true, tapped: entersTapped(t), mask: landMask(r, t, types[back], identity) });
  }
  const tags = classifyCard(r);
  const text = faceText(r, 0);
  f.ramp = hasTag(tags, "ramp") || hasTag(tags, "fast_mana");
  if (isPermanent(front) && /\{T\}(?:,[^:]*)?: Add/.test(text)) {
    f.rock = /\bCreature\b/.test(front) ? 2 : 1;
    f.rockMask = maskOf(parseJson(r.produced_mana, [])) | addMask(text, identity) || BIT.C;
    f.rockAmt = manaAmount(text);
  } else if (/\b(Instant|Sorcery)\b/.test(front) && hasTag(tags, "fast_mana") && /\bAdd\b/.test(text)) {
    f.ritual = manaAmount(text);
    f.ritualMask = addMask(text, identity) || BIT.C;
  }
  const ls = hasTag(tags, "ramp") && LAND_SEARCH.exec(text);
  if (ls) Object.assign(f, { landRamp: true, rampTapped: !!ls[1], rampMask: basicsMask(ls[0].replace(/^search your library for/i, "")) || identity });
  f.cheapRamp = f.ramp && f.cmc <= 2;
  f.draw = hasTag(tags, "draw_burst") ? 2 : hasTag(tags, "cantrip") ? 1 : 0;
  if (hasTag(tags, "draw_engine")) {
    if (isPermanent(front)) f.engine = true;
    else f.draw = 2; // a wheel
  }
  f.tutor = hasTag(tags, "tutor");
  f.interact = hasTag(tags, "removal") || hasTag(tags, "counter") || hasTag(tags, "wipe");
  return f;
}

/** FNV-1a over the sorted "board:name×qty" list: the default seed. */
function listSeed(rows) {
  const qty = new Map();
  for (const r of rows) { const k = `${r.board}:${normName(r.name)}`; qty.set(k, (qty.get(k) || 0) + qtyOf(r)); }
  let h = 0x811c9dc5;
  for (const ch of [...qty].map(([k, q]) => `${k}x${q}`).sort().join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** First turn (1..) by which at least half of the games got there, or null. */
function median(hist, games) {
  let sum = 0;
  for (let t = 1; t < hist.length; t++) if ((sum += hist[t]) * 2 >= games) return t;
  return null;
}
const byTurn = (hist, t, games) => { let s = 0; for (let i = 1; i <= Math.min(t, hist.length - 1); i++) s += hist[i]; return pct(s, games); };

/**
 * Goldfish `games` seeded solo games of deck rows (deckDetail `cards` shape) for
 * `turns` turns. combos: arrays of card names (a line counts when all are in hand
 * or play). Returns {games, seed, turns, cards, lands, commander_deck, keep_rate,
 * mulligans_avg, lands_on_curve{t3, t4}, color_screw_t4, flood_t6, interaction_t3,
 * mana_by_turn[T1..T8], commander{name, mv, by_turn{2..10}, median_turn, on_curve}|null,
 * combo{lines, median_turn, by_t6, by_t8}|null}; percentages 0–100.
 */
export function simulateDeck(rows, { games = 10000, seed, combos = [], turns = 10 } = {}) {
  games = Math.max(1, Math.floor(games) || 1);
  turns = Math.max(1, Math.floor(turns) || 10);
  const played = (rows || [])
    .filter((r) => (r.board === "commander" || r.board === "main") && !r.companion && qtyOf(r) > 0)
    .sort((a, b) => (a.board + normName(a.name)).localeCompare(b.board + normName(b.name)) || qtyOf(a) - qtyOf(b));
  seed = seed == null ? listSeed(played) : Number(seed) >>> 0;
  const cmdRows = played.filter((r) => r.board === "commander");
  const isCmd = cmdRows.length > 0;
  const identity = (isCmd ? cmdRows : played).reduce((m, r) => m | (maskOf(r.color_identity) & ALL), 0) || ALL;

  const F = played.map((r) => factsOf(r, identity));
  const cmdIds = [], lib0 = [];
  played.forEach((r, i) => (r.board === "commander" ? cmdIds.push(i) : lib0.push(...Array(qtyOf(r)).fill(i))));
  const lines = (combos || []).map((names) => (names || []).map((nm) => {
    const n = normName(nm);
    return F.flatMap((f, i) => (f.n === n ? [i] : []));
  })).filter((ps) => ps.length && ps.every((ids) => ids.length));

  const N = lib0.length;
  const deck = Int32Array.from(lib0), lib = new Int32Array(N + 8);
  const rnd = mulberry32(seed);
  const have = new Uint16Array(F.length);
  const used = new Uint8Array(MAX_UNITS);
  const units = [], full = [], hand = [], bottom = [];
  const srcMask = [], srcAmt = [], srcReady = [];
  let libLen = 0, ptr = 0;

  const stat = { keep: 0, mull: 0, t3: 0, t4: 0, screw: 0, flood: 0, inter: 0 };
  const manaHist = Array.from({ length: 8 }, () => new Uint32Array(HIST));
  const cmdHist = new Uint32Array(turns + 1), comboHist = new Uint32Array(turns + 1);

  /** 0 = payable from `u` (marks `used`), 1 = colours short, 2 = amount short. */
  function pay(u, f) {
    const n = u.length;
    if (n < f.cmc) return 2;
    used.fill(0, 0, n);
    for (const pip of f.pips) {
      let pick = -1, pp = 99;
      for (let i = 0; i < n; i++) if (!used[i] && (u[i] & pip) && POP[u[i]] < pp) { pick = i; pp = POP[u[i]]; }
      if (pick < 0) return 1;
      used[pick] = 1;
    }
    let g = f.generic;
    for (let p = 0; g > 0 && p <= 6; p++) for (let i = 0; g > 0 && i < n; i++) if (!used[i] && POP[u[i]] === p) { used[i] = 1; g--; }
    return g > 0 ? 2 : 0;
  }
  const spend = () => { let k = 0; for (let i = 0; i < units.length; i++) if (!used[i]) units[k++] = units[i]; units.length = k; };
  const addSource = (mask, amt, ready, t) => {
    srcMask.push(mask); srcAmt.push(amt); srcReady.push(ready);
    if (ready <= t) for (let a = 0; a < amt && units.length < MAX_UNITS; a++) units.push(mask);
  };
  const draw = (k) => { while (k-- > 0 && ptr < libLen) { const id = lib[ptr++]; hand.push(id); have[id]++; } };
  const fullUnits = () => {
    full.length = 0;
    for (let s = 0; s < srcMask.length; s++) for (let a = 0; a < srcAmt[s] && full.length < MAX_UNITS; a++) full.push(srcMask[s]);
    return full;
  };
  const assembled = () => lines.some((ps) => ps.every((ids) => ids.some((i) => have[i] > 0)));
  /** Tutor: the missing piece of the closest line, from the library into hand. */
  function tutor() {
    let best = null, miss = 1e9;
    for (const ps of lines) {
      const m = ps.filter((ids) => !ids.some((i) => have[i] > 0));
      if (m.length && m.length < miss) { best = m; miss = m.length; }
    }
    for (const ids of best || []) {
      for (let j = ptr; j < libLen; j++) {
        if (!ids.includes(lib[j])) continue;
        const id = lib[j];
        lib.copyWithin(j, j + 1, libLen); libLen--;
        hand.push(id); have[id]++;
        return;
      }
    }
  }

  const landy = (id) => F[id].land || F[id].mdfc;

  for (let g = 0; g < games; g++) {
    // ---- mulligans ----
    let mulls = 0;
    for (;;) {
      for (let i = N - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const x = deck[i]; deck[i] = deck[j]; deck[j] = x; }
      hand.length = 0;
      for (let i = 0; i < Math.min(7, N); i++) hand.push(deck[i]);
      let l = 0, cheap = false;
      for (const id of hand) if (landy(id)) l++; else if (F[id].cheapRamp) cheap = true;
      const keep = isCmd ? (l >= 3 && l <= 5) || (l === 2 && cheap) : l >= 2 && l <= 5;
      if (keep || mulls === 2) break;
      mulls++;
    }
    if (mulls === 0) stat.keep++;
    stat.mull += mulls;
    bottom.length = 0;
    for (let k = isCmd ? Math.max(0, mulls - 1) : mulls; k > 0 && hand.length; k--) {
      let hi = hand.filter(landy).length > 4 ? hand.findIndex(landy) : -1;
      if (hi < 0) for (let i = 0; i < hand.length; i++) if (!landy(hand[i]) && (hi < 0 || F[hand[i]].cmc > F[hand[hi]].cmc)) hi = i;
      if (hi < 0) hi = 0;
      bottom.push(hand[hi]); hand.splice(hi, 1);
    }
    libLen = 0; ptr = 0;
    for (let i = Math.min(7, N); i < N; i++) lib[libLen++] = deck[i];
    for (const id of bottom) lib[libLen++] = id;
    have.fill(0);
    for (const id of hand) have[id]++;
    for (const id of cmdIds) have[id] = 1;

    // ---- turns ----
    srcMask.length = srcAmt.length = srcReady.length = 0;
    const zone = cmdIds.map(() => true);
    let lands = 0, engines = 0, interCast = false, cmdTurn = 0, comboTurn = 0;
    for (let t = 1; t <= turns; t++) {
      units.length = 0;
      if (t > 1) draw(1 + engines);
      // land drop
      let covered = 0, needed = 0;
      for (const m of srcMask) covered |= m;
      for (const id of hand) if (!F[id].land) for (const p of F[id].pips) if (!(p & covered)) needed |= p;
      let pick = -1, score = -1;
      for (const want of [true, false]) {
        for (let i = 0; i < hand.length; i++) {
          const f = F[hand[i]];
          if (!(want ? f.land : f.mdfc)) continue;
          const s = (f.mask & needed ? 2 : 0) + (f.tapped ? 0 : 1);
          if (s > score) { pick = i; score = s; }
        }
        if (pick >= 0) break;
      }
      for (let s = 0; s < srcMask.length; s++) if (srcReady[s] <= t) for (let a = 0; a < srcAmt[s] && units.length < MAX_UNITS; a++) units.push(srcMask[s]);
      if (pick >= 0) {
        const f = F[hand[pick]];
        hand.splice(pick, 1); lands++;
        addSource(f.mask, f.amt, f.tapped ? t + 1 : t, t);
      }
      if (t <= 8) manaHist[t - 1][Math.min(units.length, HIST - 1)]++;
      // casting
      for (;;) {
        let best = -1, bestCmc = 1e9, cmd = -1;
        if (t <= 4) for (let i = 0; i < hand.length; i++) {
          const f = F[hand[i]];
          if (f.ramp && !f.land && f.cmc < bestCmc && pay(units, f) === 0) { best = i; bestCmc = f.cmc; }
        }
        if (best < 0) for (let k = 0; k < cmdIds.length; k++) if (zone[k] && pay(units, F[cmdIds[k]]) === 0) { cmd = k; break; }
        if (best < 0 && cmd < 0) for (let i = 0; i < hand.length; i++) {
          const f = F[hand[i]];
          if (!f.land && f.cmc < bestCmc && pay(units, f) === 0) { best = i; bestCmc = f.cmc; }
        }
        if (best < 0 && cmd < 0) break;
        const id = cmd >= 0 ? cmdIds[cmd] : hand[best];
        const f = F[id];
        pay(units, f); spend();
        if (cmd >= 0) { zone[cmd] = false; if (cmd === 0) cmdTurn = t; } else hand.splice(best, 1);
        if (f.rock) addSource(f.rockMask, f.rockAmt, f.rock === 2 ? t + 1 : t, t);
        for (let a = 0; a < f.ritual; a++) units.push(f.ritualMask);
        if (f.landRamp) { lands++; addSource(f.rampMask, 1, f.rampTapped ? t + 1 : t, t); }
        if (f.engine) engines++;
        draw(f.draw);
        if (f.tutor && lines.length) tutor();
        if (f.interact) interCast = true;
      }
      // end of turn
      if (t === 3) {
        if (lands >= 3) stat.t3++;
        if (interCast || hand.some((id) => F[id].interact)) stat.inter++;
      } else if (t === 4) {
        if (lands >= 4) stat.t4++;
        const u = fullUnits();
        if (hand.some((id) => !F[id].land && F[id].cmc <= u.length && pay(u, F[id]) === 1)) stat.screw++;
      } else if (t === 6) {
        const u = fullUnits();
        let inHand = 0, spell = false;
        for (const id of hand) if (F[id].land) inHand++; else if (pay(u, F[id]) === 0) spell = true;
        if (lands + inHand >= 7 && !spell) stat.flood++;
      }
      if (!comboTurn && lines.length && assembled()) comboTurn = t;
    }
    cmdHist[cmdTurn]++;
    comboHist[comboTurn]++;
  }

  const cmdF = isCmd ? F[cmdIds[0]] : null;
  const mv = cmdF ? cmdF.cmc : 0;
  return {
    games, seed, turns, cards: N, lands: lib0.filter((i) => F[i].land).length, commander_deck: isCmd,
    keep_rate: pct(stat.keep, games),
    mulligans_avg: Math.round((stat.mull / games) * 100) / 100,
    lands_on_curve: { t3: pct(stat.t3, games), t4: pct(stat.t4, games) },
    color_screw_t4: pct(stat.screw, games),
    flood_t6: pct(stat.flood, games),
    interaction_t3: pct(stat.inter, games),
    mana_by_turn: manaHist.slice(0, Math.min(8, turns)).map((h) => { let s = 0, m = 0; while (m < HIST - 1 && (s += h[m]) * 2 < games) m++; return m; }),
    commander: cmdF && {
      name: cmdF.name, mv,
      by_turn: Object.fromEntries(Array.from({ length: Math.max(0, Math.min(10, turns) - 1) }, (_, i) => [i + 2, byTurn(cmdHist, i + 2, games)])),
      median_turn: median(cmdHist, games),
      on_curve: byTurn(cmdHist, Math.max(1, mv), games),
    },
    combo: (combos || []).length ? {
      lines: lines.length, median_turn: median(comboHist, games),
      by_t6: byTurn(comboHist, 6, games), by_t8: byTurn(comboHist, 8, games),
    } : null,
  };
}

/** 2–4 compact lines of a simulateDeck result for a tool answer. */
export function simulationText(r) {
  const p = (n) => `${Math.round(n)}%`;
  const out = [
    `Goldfish (${r.games} games, seed ${r.seed}, ${r.cards} cards, ${r.lands} lands): keep ${p(r.keep_rate)} (avg ${r.mulligans_avg} mulligans) · lands on curve T3 ${p(r.lands_on_curve.t3)} / T4 ${p(r.lands_on_curve.t4)} · colour screw T4 ${p(r.color_screw_t4)} · flood T6 ${p(r.flood_t6)} · interaction by T3 ${p(r.interaction_t3)}`,
    `Median mana T1–T${r.mana_by_turn.length}: ${r.mana_by_turn.join("/")}`,
  ];
  const c = r.commander;
  if (c) {
    const on = Math.max(1, c.mv), early = c.by_turn[on - 1];
    out.push(`Commander ${c.name} (MV ${c.mv}): cast by T${on} ${p(c.on_curve)} (median ${c.median_turn ? `T${c.median_turn}` : `after T${r.turns}`})${early == null ? "" : `, by T${on - 1} ${p(early)}`}`);
  }
  const k = r.combo;
  if (k) out.push(k.lines ? `Combo (${k.lines} line${k.lines === 1 ? "" : "s"}): assembled median ${k.median_turn ? `T${k.median_turn}` : `after T${r.turns}`}, by T6 ${p(k.by_t6)} / by T8 ${p(k.by_t8)}` : "Combo: no given line is fully in the deck");
  return out.join("\n");
}
