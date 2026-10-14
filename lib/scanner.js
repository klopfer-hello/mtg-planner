// Card identification for the camera scanner: evidence in, decision out.
//
// Pipeline (research "critic" architecture, AI-free first):
//   1. collector-line OCR of the high-res bottom strip  -> set/number/lang/★•
//   2. local index lookup of those keys (parent sets, promos, The List)
//   3. title OCR in the detected language, fuzzy-matched to printed names
//   4. image fingerprint of the rectified card: verifies the candidates and
//      is the only signal for cards without a collector line (pre-2014)
//   5. decision AUTO / SUGGEST / REVIEW from conservative thresholds
//   6. Claude vision ONLY when the local result is uncertain (REVIEW/failed),
//      under an hourly cap; its answer is re-verified against the index and
//      the fingerprint and never accepted on its own word
//   7. the stored printing is the same set + number in the storage language
//
// Thresholds live in SCAN_THRESHOLDS (env SCAN_THRESHOLDS as JSON overrides
// single keys). They start conservative: everything measured so far comes
// from synthetic captures, and a wrong AUTO costs more than one extra tap.
// Every score and OCR output goes into `features` so calibration scans can
// re-fit them later.

import * as ocrModule from "./ocr.js";
import * as fpModule from "./fingerprint.js";
import * as indexModule from "./cardindex.js";
import { visionCap } from "./claude.js";

/** Default decision thresholds (fingerprint scores: 0 = identical, ~0.5 = unrelated). */
export const DEFAULT_THRESHOLDS = Object.freeze({
  collectorConf: 0.45, // readCollectorLine confidence for an "exact" collector read
  titleAuto: 0.75, // title similarity that confirms a candidate (research: 0.6 had 0 wrong; 0.75 is the safe end)
  titleSuggest: 0.45, // title similarity that makes a candidate plausible
  titleSearchMin: 0.6, // index title search hits used when there is no collector line
  titleNoise: 0.35, // title similarity below this is OCR noise and adds nothing to the rank
  fpAuto: 0.25, // fingerprint name gate: best distance ... (research 0.28)
  fpGap: 0.06, // ... and margin to the best different card (research 0.05)
  fpSuggest: 0.32, // fingerprint distance still worth suggesting
  fpVerify: 0.26, // a candidate's own distance that confirms its art
  fpReject: 0.4, // a candidate's own distance that contradicts it
  competeMargin: 0.12, // rank-score margin below which a different card competes
  fpUniqueMargin: 0.06, // fingerprint-only AUTO: the best printing must beat every other same-art printing of the card by this much
  separatorConf: 0.5, // ★/• classifier confidence needed to set the finish
  claudeFpMax: 0.26, // Claude's printing must be at most this far from the photo (= fpVerify until calibration says otherwise)
  claudeFpSlack: 0.03, // ... and within this of the best fingerprint hit when that hit is a different card
  claudeNameMin: 0.8, // Claude's name must match the printing's name this well
  claudeOnSuggest: false, // also ask Claude when the local result is SUGGEST
  claudeAuto: false, // a verified Claude answer may be AUTO (else SUGGEST)
  maxCandidates: 5,
});

function loadThresholds() {
  const raw = process.env.SCAN_THRESHOLDS;
  if (!raw) return { ...DEFAULT_THRESHOLDS };
  try {
    const o = JSON.parse(raw);
    const out = { ...DEFAULT_THRESHOLDS };
    for (const [k, v] of Object.entries(o || {})) {
      if (k in DEFAULT_THRESHOLDS && typeof v === typeof DEFAULT_THRESHOLDS[k]) out[k] = v;
      else console.warn(`[scanner] SCAN_THRESHOLDS: ignoring ${k}`);
    }
    return out;
  } catch (err) {
    console.warn(`[scanner] SCAN_THRESHOLDS is not valid JSON (${err.message}); using defaults`);
    return { ...DEFAULT_THRESHOLDS };
  }
}

/** Effective thresholds (defaults merged with env SCAN_THRESHOLDS). */
export const SCAN_THRESHOLDS = Object.freeze(loadThresholds());

const M15_RELEASE = "2014-07-18";
const FINISH_OF = (f) => (f === "nonfoil" ? "normal" : f);
const round = (x, n = 3) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(n));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Small serialisable view of a printing for candidates/variants lists. */
export function printingSummary(p, extra = {}) {
  if (!p) return null;
  return {
    id: p.id,
    oracle_id: p.oracle_id,
    name: p.name,
    printed_name: p.printed_name ?? null,
    set_code: p.set_code,
    set_name: p.set_name ?? null,
    collector_number: p.collector_number,
    lang: p.lang,
    rarity: p.rarity ?? null,
    released_at: p.released_at ?? null,
    finishes: p.finishes ?? [],
    promo_types: p.promo_types ?? [],
    image_small: p.image_small ?? p.faces?.[0]?.image_small ?? null,
    image_normal: p.image_normal ?? p.faces?.[0]?.image_normal ?? null,
    ...extra,
  };
}

// Names a title OCR can be compared with: the printed (localized) name for
// non-English printings, the English name otherwise, plus each face's name.
function titleNames(p) {
  const names = [];
  const localized = p.lang && p.lang !== "en";
  const push = (printed, english) => {
    if (localized) { if (printed) names.push(printed); else if (english) names.push(english); }
    else if (english) names.push(english);
  };
  push(p.printed_name, p.name);
  for (const f of p.faces || []) push(f.printed_name, f.name);
  if (!localized && p.name?.includes(" // ")) names.push(p.name.split(" // ")[0]);
  return [...new Set(names)];
}

function bestSim(sim, text, names) {
  let best = 0;
  for (const n of names) best = Math.max(best, sim(text, n));
  return best;
}

// Whether the reference fingerprints are complete (the background job has
// finished). A partial index makes the one hashed sibling look unique.
async function fingerprintsComplete(ctx, index, idx) {
  if (typeof ctx.fingerprintsComplete === "boolean") return ctx.fingerprintsComplete;
  if (typeof index.getMeta !== "function") return true; // stub index in tests
  try {
    const job = JSON.parse((await index.getMeta(idx, "fingerprint_job")) || "null");
    return job?.state === "done";
  } catch {
    return false;
  }
}

async function timed(timings, key, fn) {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings[key] = Math.round(performance.now() - t0);
  }
}

/**
 * Identify a scanned card.
 * @param ctx {db, idx, matcher, claude: {runVision, cap?}, ocr?, fp?, index?, thresholds?, signal?}
 *   (signal: the client gave up; skips/aborts the Claude fallback)
 *   (ocr/fp/index default to lib/ocr.js, lib/fingerprint.js, lib/cardindex.js; index
 *   functions may return promises: the server runs the lookups in the matcher worker)
 * @param input {card: Buffer, strip: Buffer, settings: {storageLang, foil, setHint?, allowClaude?, langHint?}}
 */
export async function identify(ctx, { card, strip, settings = {} } = {}) {
  const T = ctx.thresholds ?? SCAN_THRESHOLDS;
  const ocr = ctx.ocr ?? ocrModule;
  const fp = ctx.fp ?? fpModule;
  const index = ctx.index ?? indexModule;
  const idx = ctx.idx;
  const sim = ocr.nameSimilarity ?? ocrModule.nameSimilarity;
  const storageLang = settings.storageLang || "en";
  const foilMode = ["foil", "nonfoil", "auto"].includes(settings.foil) ? settings.foil : "auto";
  const setHint = settings.setHint ? String(settings.setHint).toLowerCase().trim() : null;
  const t0 = performance.now();
  const timings = {};
  const errors = [];
  const features = { settings: { storageLang, foil: foilMode, setHint }, thresholds: T, errors };

  // 1. Collector OCR and query hashing run side by side.
  const [line, hashes] = await Promise.all([
    strip
      ? timed(timings, "collector", () => ocr.readCollectorLine(strip, { setCodes: () => index.setCodes(idx) }))
        .catch((err) => { errors.push(`collector: ${err.message}`); return null; })
      : null,
    card && ctx.matcher
      // A MatcherWorker hashes off the event loop (and waits for its warm-up).
      ? timed(timings, "hash", async () => (typeof ctx.matcher.hashImage === "function"
        ? ctx.matcher.hashImage(card)
        : fp.hashQuery(await fp.decodeJpeg(card))))
        .catch((err) => { errors.push(`hash: ${err.message}`); return null; })
      : null,
  ]);
  features.collector = line ? {
    raw: line.raw, format: line.format, rarity: line.rarity, number: line.number, numberCandidates: line.numberCandidates,
    total: line.total, legacyCandidates: line.legacyCandidates, setCandidates: line.setCandidates?.slice(0, 6),
    langCode: line.langCode, lang: line.lang, separator: line.separator, separatorConfidence: line.separatorConfidence,
    separatorRel: line.separatorRel ?? null, confidence: line.confidence,
  } : null;

  // 2. Candidates from the collector line.
  const cands = new Map(); // id -> candidate
  const add = (p, patch) => {
    if (!p?.id) return null;
    let c = cands.get(p.id);
    if (!c) { c = { p, ocr: null, title: null, fp: null, via: null, from: new Set() }; cands.set(p.id, c); }
    if (patch.ocr != null && (c.ocr == null || patch.ocr > c.ocr)) { c.ocr = patch.ocr; c.via = patch.via; }
    if (patch.from) c.from.add(patch.from);
    return c;
  };
  const modernLine = line && (line.format === "m15" || line.format === "mom") && line.setCandidates?.length && line.number;
  const legacyLine = line && !modernLine && line.number && line.total;
  if (modernLine) {
    const numbers = (line.numberCandidates?.length ? line.numberCandidates : [line.number]).slice(0, 3);
    for (const [si, sc] of line.setCandidates.slice(0, 4).entries()) {
      for (const [ni, n] of numbers.entries()) {
        let rows = await index.lookupCollector(idx, { set: sc.code, number: n, lang: line.lang || undefined });
        if (!rows.length && line.lang) rows = await index.lookupCollector(idx, { set: sc.code, number: n });
        rows.forEach((p, ri) => add(p, {
          ocr: (sc.score ?? 1) * (ni === 0 ? 1 : 0.8) * (ri === 0 ? 1 : 0.98),
          via: { set: sc.code, setIdx: si, setCost: sc.cost ?? 0, number: n, numberIdx: ni, rank: ri },
          from: "collector",
        }));
      }
    }
  } else if (legacyLine) {
    const legacy = line.legacyCandidates?.length ? line.legacyCandidates : [{ number: line.number, total: line.total, score: 1 }];
    for (const [li, lc] of legacy.slice(0, 3).entries()) {
      const rows = await index.lookupLegacyNumber(idx, { number: lc.number, total: lc.total });
      rows.forEach((p, ri) => add(p, {
        ocr: (lc.score ?? 1) * (li === 0 ? 1 : 0.8) * (p.size_match === "printed_size" ? 1 : 0.9),
        via: { legacy: true, number: lc.number, total: lc.total, numberIdx: li, rank: ri },
        from: "legacy",
      }));
    }
  }
  features.collector_candidates = cands.size;

  // 3. Title OCR in the language the collector line printed (else hint / English).
  const titleLang = line?.lang || settings.langHint || "en";
  let title = null;
  if (card) {
    title = await timed(timings, "title", () => ocr.readTitle(card, { lang: titleLang }))
      .catch((err) => { errors.push(`title: ${err.message}`); return null; });
  }
  const titleText = title?.text?.trim() || "";
  features.title = title ? { text: titleText, confidence: title.confidence, lang: titleLang } : null;

  // No collector candidates: the title can still name the card. With
  // collector candidates the hits only feed the REVIEW picker (`extras`).
  const hadLine = cands.size > 0;
  let titleHitsAll = [];
  if (titleText.length >= 3) {
    try {
      titleHitsAll = (await index.searchTitle(idx, titleText, { limit: 5 })).filter((h) => h.score >= T.titleSearchMin);
    } catch (err) { errors.push(`searchTitle: ${err.message}`); }
    features.title_hits = titleHitsAll.map((h) => ({ id: h.id, oracle_id: h.oracle_id, name: h.name, lang: h.lang, score: h.score }));
  }
  const titleHits = hadLine ? [] : titleHitsAll;

  // 4. Fingerprint: global top-K (name gate) + distances of the candidates.
  let fpResults = [];
  let d1 = null, gap = null;
  const fpById = new Map();
  if (hashes?.length) {
    await timed(timings, "fingerprint", async () => {
      try {
        fpResults = (await ctx.matcher.match(hashes, { topK: 20 })) || [];
        d1 = fpResults[0]?.score ?? null;
        gap = fpResults.length ? ctx.matcher.nameGap(fpResults) : null;
        for (const r of fpResults) {
          for (const id of r.printing_ids?.length ? r.printing_ids : [r.printing_id]) {
            if (!fpById.has(id) || fpById.get(id) > r.score) fpById.set(id, r.score);
          }
        }
        // Without collector candidates, the best fingerprint groups ARE the candidates.
        if (!cands.size) {
          const near = fpResults.filter((r) => r.score <= T.fpSuggest + 0.04).slice(0, 8);
          for (const r of near) {
            const ids = (r.printing_ids?.length ? r.printing_ids : [r.printing_id]).slice(0, 60);
            for (const id of ids) add(await index.getPrinting(idx, id), { from: "fingerprint" });
          }
        }
        // Title-search hits: the printings of that card that share a fingerprint group.
        for (const h of titleHits) {
          const p = await index.getPrinting(idx, h.id);
          if (p) add(p, { from: "title" });
        }
        const ids = [...cands.keys()];
        if (ids.length && typeof ctx.matcher.scorePrintings === "function") {
          for (const [id, v] of await ctx.matcher.scorePrintings(hashes, ids.slice(0, 400))) {
            const s = typeof v === "number" ? v : v?.score;
            if (s != null && (!fpById.has(id) || fpById.get(id) > s)) fpById.set(id, s);
          }
        }
      } catch (err) {
        errors.push(`fingerprint: ${err.message}`);
      }
    });
  } else {
    for (const h of titleHits) add(await index.getPrinting(idx, h.id), { from: "title" });
  }
  const fpTop = fpResults[0] ?? null;
  // A misread collector line fills `cands` with the wrong cards only; keep
  // the best fingerprint groups and title hits around for the picker.
  const extras = [];
  if (hadLine) {
    const seenExtra = new Set();
    const pushExtra = async (id, patch) => {
      if (!id || cands.has(id) || seenExtra.has(id)) return;
      const p = await index.getPrinting(idx, id);
      if (p) { seenExtra.add(id); extras.push({ p, rank: null, ocr: null, title: null, fp: null, ...patch }); }
    };
    for (const r of fpResults.filter((x) => x.score <= T.fpSuggest).slice(0, 3)) await pushExtra(r.printing_id, { fp: round(r.score, 4) });
    for (const h of titleHitsAll.slice(0, 2)) await pushExtra(h.id, { title: h.score });
  }
  const nameGate = d1 != null && gap != null && d1 <= T.fpAuto && gap >= T.fpGap;
  features.fingerprint = hashes ? {
    d1: round(d1, 4), gap: round(gap, 4), name_gate: nameGate,
    top: fpResults.slice(0, 5).map((r) => ({ printing_id: r.printing_id, oracle_id: r.oracle_id, name: r.name, face: r.face, score: round(r.score, 4) })),
  } : null;

  // 5. Score every candidate.
  const preferLang = [line?.lang, storageLang, "en"].filter(Boolean);
  for (const c of cands.values()) {
    if (titleText) c.title = round(bestSim(sim, titleText, titleNames(c.p)));
    if (fpById.has(c.p.id)) c.fp = round(fpById.get(c.p.id), 4);
    const fpConf = c.fp == null ? 0 : clamp01((T.fpReject - c.fp) / (T.fpReject - 0.1));
    c.fpConf = fpConf;
    const hint = setHint && (c.p.set_code === setHint || c.p.parent_set_code === setHint) ? 0.15 : 0;
    const titleHit = titleHits.find((h) => h.oracle_id === c.p.oracle_id);
    // Same-art twins in other languages tie on OCR number and art; a small
    // bonus for the printed / storage / English language picks among them
    // (it is far below competeMargin, so it never decides between cards).
    const lp = preferLang.indexOf(c.p.lang);
    const langBonus = lp < 0 ? 0 : 0.01 * (preferLang.length - lp);
    const titleScore = c.title != null ? (c.title >= T.titleNoise ? c.title : 0) : (titleHit ? titleHit.score * 0.5 : 0);
    c.rank = (c.ocr ?? 0) + titleScore + fpConf + hint + langBonus
      - (c.fp != null && c.fp > T.fpReject ? 0.5 : 0);
  }
  const langPos = (p) => { const i = preferLang.indexOf(p.lang); return i < 0 ? preferLang.length : i; };
  const ranked = [...cands.values()].sort((a, b) =>
    b.rank - a.rank
    || (a.via?.rank ?? 99) - (b.via?.rank ?? 99)
    || langPos(a.p) - langPos(b.p)
    || String(b.p.released_at || "").localeCompare(String(a.p.released_at || "")));

  // 6. Decide.
  let status = "failed";
  let best = ranked[0] ?? null;
  const reasons = [];
  let method = null;
  if (best) {
    // Same card, same printed line (promo / List / other language) is a twin,
    // not a competitor: default to the base printing, offer the rest as variants.
    const competitor = ranked.find((c) => c.p.oracle_id !== best.p.oracle_id && c.rank >= best.rank - T.competeMargin);
    const conflict = nameGate && fpTop?.oracle_id && fpTop.oracle_id !== best.p.oracle_id;
    const titleOk = best.title != null && best.title >= T.titleAuto;
    const titleWeak = best.title != null && best.title >= T.titleSuggest;
    const fpOk = best.fp != null && best.fp <= T.fpVerify;
    const fpBad = best.fp != null && best.fp > T.fpReject;
    if (competitor) reasons.push(`competing card ${competitor.p.name}`);
    if (conflict) reasons.push(`fingerprint says ${fpTop.name}`);
    if (fpBad) reasons.push("art does not match");

    if (best.from.has("collector")) {
      const v = best.via;
      const exact = v.setIdx === 0 && v.numberIdx === 0 && (v.setCost ?? 0) === 0 && (line.confidence ?? 0) >= T.collectorConf;
      if (!exact) reasons.push("collector read uncertain");
      if (exact && (titleOk || fpOk) && !fpBad && !conflict && !competitor) status = "auto";
      else if (!fpBad && !conflict && !competitor && (exact || titleWeak || fpOk)) status = "suggest";
      else status = "review";
      method = fpOk ? (titleOk || exact ? "ocr+fingerprint" : "fingerprint") : "ocr";
    } else if (best.from.has("legacy")) {
      // "nnn/ttt" names no set and no language: title AND art must agree.
      // A same-card printing in another set whose art could not be scored is
      // not ruled out by a good fingerprint of this one.
      const otherPrinting = ranked.find((c) => c !== best && c.p.set_code !== best.p.set_code
        && (c.rank >= best.rank - T.competeMargin || (c.p.oracle_id === best.p.oracle_id && c.fp == null && best.fp != null)));
      if (otherPrinting) reasons.push(`also ${otherPrinting.p.set_code.toUpperCase()}`);
      if (titleOk && fpOk && !otherPrinting && !competitor && !conflict) status = "auto";
      else if ((titleWeak || fpOk) && !fpBad && !competitor && !conflict) status = "suggest";
      else status = "review";
      method = fpOk ? "ocr+fingerprint" : "ocr";
    } else {
      // Fingerprint (and title) only: the name gate names the card; the exact
      // printing is only known if a single set/number remains (or the set hint
      // picks it). "Remains" is judged against the INDEX, not the fingerprint
      // neighbourhood: every printing of the card with the same illustration
      // must be hashed and lose to the best one by fpUniqueMargin.
      const sameCard = ranked.filter((c) => c.p.oracle_id === best.p.oracle_id && c.fp != null && c.fp <= best.fp + 0.02);
      const keyOf = (p) => `${p.set_code}/${p.collector_number}`;
      const keys = new Set(sameCard.map((c) => keyOf(c.p)));
      const hinted = setHint ? sameCard.filter((c) => c.p.set_code === setHint || c.p.parent_set_code === setHint) : [];
      const hintUnique = new Set(hinted.map((c) => keyOf(c.p))).size === 1;
      if (hinted.length && hinted[0] !== best) best = hinted[0];
      let indexUnique = keys.size <= 1 && best.fp != null;
      if (indexUnique && !hintUnique) {
        try {
          const ill = best.p.illustration_id;
          const siblings = (await index.printingsOf(idx, best.p.oracle_id))
            .filter((p) => keyOf(p) !== keyOf(best.p) && (!ill || !p.illustration_id || p.illustration_id === ill));
          const sibScores = siblings.length && hashes?.length && typeof ctx.matcher?.scorePrintings === "function"
            ? await ctx.matcher.scorePrintings(hashes, siblings.map((p) => p.id).slice(0, 400)) : new Map();
          const scoreOf = (id) => { const v = sibScores.get(id) ?? fpById.get(id); return typeof v === "number" ? v : v?.score ?? null; };
          const close = new Set();
          for (const p of siblings) {
            const s = scoreOf(p.id);
            if (s == null || s - best.fp < T.fpUniqueMargin) close.add(keyOf(p));
          }
          if (close.size) {
            indexUnique = false;
            reasons.push(`${close.size + 1} printings share this art`);
          }
          if (features.fingerprint) features.fingerprint.same_art = { siblings: siblings.length, close: [...close].slice(0, 10) };
        } catch (err) {
          indexUnique = false;
          errors.push(`uniqueness: ${err.message}`);
        }
      }
      const unique = hintUnique || indexUnique;
      if (!unique && keys.size > 1) reasons.push(`${keys.size} printings share this art`);
      const fpDone = await fingerprintsComplete(ctx, index, idx);
      if (!fpDone) reasons.push("fingerprint index incomplete");
      const fpName = nameGate && fpTop?.oracle_id === best.p.oracle_id;
      const onlyPrinting = async (p) => {
        try { return new Set((await index.printingsOf(idx, p.oracle_id)).map((x) => `${x.set_code}/${x.collector_number}`)).size === 1; } catch { return false; }
      };
      if (fpName && unique && titleOk && fpDone) status = "auto";
      else if (fpName && !competitor) status = "suggest";
      else if (best.from.has("title") && titleOk && !competitor && !conflict && !fpBad && (await onlyPrinting(best.p))) status = "suggest"; // the title names a card with one printing
      else if (best.fp != null && best.fp <= T.fpSuggest) status = "review";
      else if (best.from.has("title") && titleOk) status = "review";
      else status = ranked.length ? "review" : "failed";
      method = best.fp != null ? "fingerprint" : "ocr";
    }
  }
  features.local = { status, reasons, best: best ? best.p.id : null };

  // 7. Claude fallback for uncertain results, verified like any other evidence.
  let claudeUsed = false;
  let claudeFoil = null;
  let claudeOffer = null;
  const wantClaude = status === "review" || status === "failed" || (status === "suggest" && T.claudeOnSuggest);
  if (wantClaude && settings.allowClaude !== false && ctx.claude?.runVision && card) {
    const cap = ctx.claude.cap ?? visionCap;
    if (ctx.signal?.aborted) features.claude = { skipped: "cancelled" };
    else if (!cap.enabled()) features.claude = { skipped: "disabled" };
    else if (!cap.take()) features.claude = { skipped: "hourly cap reached", resets_at: cap.resetsAt?.() ?? null };
    else {
      claudeUsed = true;
      const images = [{ media_type: "image/jpeg", data: card.toString("base64") }];
      if (strip) images.push({ media_type: "image/jpeg", data: strip.toString("base64") });
      const answer = await timed(timings, "claude", () => ctx.claude.runVision({ images, signal: ctx.signal }))
        .catch((err) => ({ error: err.message, json: null }));
      const verdict = answer?.json ? await verifyClaude(answer.json, { idx, index, sim, T, hashes, matcher: ctx.matcher, cands, fpById, titleText, nameGate, fpTop, d1 }) : { ok: false, reason: answer?.error || "no answer" };
      features.claude = { answer: answer?.json ?? null, error: answer?.error ?? null, cost_usd: answer?.costUsd ?? null, verdict: { ok: verdict.ok, reason: verdict.reason ?? null, fp: verdict.fp ?? null, printing_id: verdict.printing?.id ?? null } };
      // Rejected but existing in the index under that name: offer it in the picker, never as the result.
      if (!verdict.ok && verdict.printing) claudeOffer = verdict.printing;
      if (answer?.busy) { claudeUsed = false; cap.release?.(); } // never started: give the call back
      if (verdict.ok) {
        const c = add(verdict.printing, { from: "claude" });
        c.fp = verdict.fp ?? c.fp;
        c.rank = Math.max(...[...cands.values()].map((x) => x.rank), 0) + 0.01;
        best = c;
        status = T.claudeAuto && verdict.fp != null && verdict.fp <= T.fpVerify ? "auto" : "suggest";
        method = "claude";
        const fi = answer.json.foil_indicator;
        if (fi === "star" || fi === "dot") claudeFoil = fi;
      }
    }
  }

  if (!best) {
    return {
      status: "failed", printing: null, store: null, finish: null, finishSource: null, lang_detected: line?.lang ?? null,
      method: method ?? null, confidence: 0, candidates: claudeOffer ? [printingSummary(claudeOffer, { claude: true })] : [], variants: [], features,
      timings: { ...timings, total: Math.round(performance.now() - t0) }, claude_used: claudeUsed,
    };
  }

  // 8. Finish, storage printing, variants, candidate list.
  const printing = best.p;
  const fromLine = best.from.has("collector") && modernLine && String(printing.released_at || "9999") >= M15_RELEASE;
  const fin = decideFinish(printing, { line: fromLine ? line : null, claudeFoil, foilMode, T });
  let store = (await index.storagePrinting(idx, printing, storageLang)) || printing;
  const storeFinishes = (store.finishes?.length ? store.finishes : printing.finishes || ["nonfoil"]).map(FINISH_OF);
  let finish = fin.finish;
  let finishSource = fin.source;
  if (!storeFinishes.includes(finish)) {
    if (storeFinishes.length === 1) { finish = storeFinishes[0]; finishSource = "finishes"; }
  }
  let variants = [];
  try { variants = ((await index.variantsOf(idx, printing)) || []).map((p) => printingSummary(p)); } catch (err) { errors.push(`variants: ${err.message}`); }
  const seen = new Set();
  const offer = claudeOffer ? [{ p: claudeOffer, rank: null, ocr: null, title: null, fp: null, claude: true }] : [];
  const extraC = extras.filter((e) => !cands.has(e.p.id));
  const uncertain = status === "review" || status === "suggest";
  const candidates = [best, ...offer, ...(uncertain ? extraC : []), ...ranked.filter((c) => c !== best), ...(uncertain ? [] : extraC)]
    .filter((c) => (seen.has(c.p.id) ? false : seen.add(c.p.id)))
    .slice(0, T.maxCandidates)
    .map((c) => printingSummary(c.p, { score: round(c.rank), ocr: c.ocr != null ? round(c.ocr) : null, title: c.title, fp: c.fp, ...(c.claude ? { claude: true } : {}) }));
  // A ★ read with a foil-only promo twin (prerelease, promo pack) on the same
  // line: the star cannot tell the base foil from the promo, so ask.
  if (status === "auto" && method !== "claude" && fromLine && line?.separator === "star"
      && (line.separatorConfidence ?? 0) >= T.separatorConf
      && variants.some((v) => v.finishes?.length && v.finishes.every((f) => f !== "nonfoil"))) {
    status = "suggest";
    reasons.push("foil: may be the promo variant");
  }
  features.candidates = [...cands.values()].sort((a, b) => b.rank - a.rank).slice(0, 12)
    .map((c) => ({ id: c.p.id, set: c.p.set_code, cn: c.p.collector_number, lang: c.p.lang, ocr: round(c.ocr), title: c.title, fp: c.fp, rank: round(c.rank), from: [...c.from] }));
  features.finish = fin;

  const ocrE = best.from.has("collector") || best.from.has("legacy") ? clamp01(best.ocr ?? 0) * clamp01((line?.confidence ?? 0) + 0.3) : 0;
  const confidence = round(Math.min(0.99, 1 - (1 - ocrE) * (1 - 0.9 * (best.title ?? 0)) * (1 - 0.9 * (best.fpConf ?? 0))));

  return {
    status,
    printing,
    store,
    finish,
    finishSource,
    lang_detected: printing.lang,
    method,
    confidence,
    candidates,
    variants,
    features,
    timings: { ...timings, total: Math.round(performance.now() - t0) },
    claude_used: claudeUsed,
  };
}

/**
 * Finish of the physical card: a single-finish printing decides it; else the
 * ★/• separator (modern lines only, when the classifier is sure); else what
 * Claude read; else the session toggle.
 */
export function decideFinish(printing, { line = null, claudeFoil = null, foilMode = "auto", T = SCAN_THRESHOLDS } = {}) {
  const fins = (printing?.finishes?.length ? printing.finishes : ["nonfoil"]).map(FINISH_OF);
  if (fins.length === 1) return { finish: fins[0], source: "finishes" };
  const premium = fins.includes("foil") ? "foil" : fins.includes("etched") ? "etched" : "foil";
  const fromGlyph = (g, source) => {
    if (g === "star" && (fins.includes("foil") || fins.includes("etched"))) return { finish: premium, source };
    if (g === "dot" && fins.includes("normal")) return { finish: "normal", source };
    return null;
  };
  if (line?.separator && (line.separatorConfidence ?? 0) >= T.separatorConf) {
    const r = fromGlyph(line.separator, "star");
    if (r) return r;
  }
  if (claudeFoil) {
    const r = fromGlyph(claudeFoil, "claude");
    if (r) return r;
  }
  if (foilMode === "foil") return { finish: premium, source: "toggle" };
  return { finish: fins.includes("normal") ? "normal" : fins[0], source: "toggle" };
}

/**
 * Check Claude's answer against the local index and the photo's fingerprint.
 * Accepts only a printing that (a) exists in the index for the claimed
 * set + number, (b) carries the claimed name, and (c) matches the photo's
 * fingerprint, or, without a reference hash, is backed by local OCR evidence.
 */
export async function verifyClaude(ans, { idx, index, sim, T, hashes, matcher, cands, fpById, titleText = "", nameGate = false, fpTop = null, d1 = null }) {
  const set = typeof ans.set_code === "string" ? ans.set_code.trim().toLowerCase() : null;
  const cn = ans.collector_number != null ? String(ans.collector_number).trim() : null;
  const lang = typeof ans.language === "string" ? ans.language.trim().toLowerCase() : null;
  const english = typeof ans.english_name === "string" ? ans.english_name.trim() : "";
  const printed = typeof ans.printed_name === "string" ? ans.printed_name.trim() : "";
  if (!english && !printed) return { ok: false, reason: "no name" };
  const nameScore = (p) => Math.max(
    english ? bestSim(sim, english, [p.name, ...(p.faces || []).map((f) => f.name)].filter(Boolean)) : 0,
    printed ? bestSim(sim, printed, [p.printed_name || p.name, ...(p.faces || []).map((f) => f.printed_name || f.name)].filter(Boolean)) : 0,
  );
  let rows = [];
  if (set && cn) {
    rows = await index.lookupCollector(idx, { set, number: cn, lang: lang || undefined });
    if (!rows.length && lang) rows = await index.lookupCollector(idx, { set, number: cn });
  }
  // 1998-2014 cards print only "nnn/ttt": a number without a set still pins
  // the printing when exactly one set has this card under that number.
  if (!rows.length && !set && cn && english && typeof index.searchTitle === "function") {
    try {
      const hit = (await index.searchTitle(idx, english, { lang: "en", limit: 3 })).find((h) => h.score >= 0.9);
      const digits = String(parseInt(cn.replace(/^\D+/, ""), 10));
      const same = hit ? (await index.printingsOf(idx, hit.oracle_id)).filter((p) => String(p.cn_digits ?? parseInt(p.collector_number, 10)) === digits) : [];
      if (new Set(same.map((p) => p.set_code)).size === 1) rows = same;
    } catch { rows = []; }
  }
  if (!rows.length) return { ok: false, reason: set && cn ? `${set}/${cn} not in the index` : "no set/number" };
  const named = rows.filter((p) => nameScore(p) >= T.claudeNameMin);
  if (!named.length) return { ok: false, reason: `name does not match ${set ?? "?"}/${cn}` };
  // Prefer the claimed language, then the base printing (index order).
  named.sort((a, b) => (a.lang === lang ? 0 : 1) - (b.lang === lang ? 0 : 1));
  const p = named[0];
  let fp = fpById.get(p.id) ?? null;
  if (fp == null && hashes?.length && matcher && typeof matcher.scorePrintings === "function") {
    try {
      const v = (await matcher.scorePrintings(hashes, named.map((x) => x.id))).get(p.id);
      fp = typeof v === "number" ? v : v?.score ?? null;
    } catch { fp = null; }
  }
  // The fingerprint confidently names a different card: local evidence wins.
  const fpOther = fpTop?.oracle_id && fpTop.oracle_id !== p.oracle_id;
  if (nameGate && fpOther) return { ok: false, reason: `fingerprint says ${fpTop.name || "another card"}`, fp, printing: p };
  if (fp != null) {
    if (fp > T.claudeFpMax) return { ok: false, reason: `art does not match (${fp.toFixed(3)})`, fp, printing: p };
    if (fpOther && d1 != null && fp > d1 + T.claudeFpSlack) {
      return { ok: false, reason: `art is closer to ${fpTop.name || "another card"} (${fp.toFixed(3)} vs ${d1.toFixed(3)})`, fp, printing: p };
    }
    return { ok: true, printing: p, fp };
  }
  // No reference hash for this printing: only accept with local OCR backing
  // (a collector/title candidate, or our own title OCR naming this card).
  const local = cands.get(p.id);
  if (local && ((local.ocr ?? 0) > 0 || (local.title ?? 0) >= T.titleSuggest)) return { ok: true, printing: p, fp: null };
  if (titleText && bestSim(sim, titleText, titleNames(p)) >= T.titleAuto) return { ok: true, printing: p, fp: null, via: "title" };
  return { ok: false, reason: "no fingerprint and no OCR evidence to verify", printing: p };
}
