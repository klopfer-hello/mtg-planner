// Scanner learning report: what the labelled scans (lib/scans.js: implicit and
// explicit confirmations, corrections, calibration truths, commits) say about
// the identification thresholds. It never changes a threshold: AUTO needs
// several conditions at once (lib/scanner.js decide step), so a relaxed value
// is only a candidate to replay through the scanner regression gate first,
// then to set as SCAN_THRESHOLDS JSON (see docs/scanner.md).
//
// Every number is measured on the DETECTED printing's evidence (the best
// candidate's title similarity and fingerprint distance, the fingerprint name
// gate's d1/gap, the collector line confidence), so "confirmed" (a SUGGEST the
// user kept) and "wrong" (any detection the user corrected) sit on one axis:
// a threshold can move as far as the confirmed values go without passing a
// wrong one.

import { SCAN_THRESHOLDS } from "./scanner.js";
import { LABEL_SOURCES, exportCalibration } from "./scans.js";

/** Evidence metrics, the threshold each one meets for AUTO, and its histogram range. */
export const LEARNING_METRICS = Object.freeze([
  { key: "title", threshold: "titleAuto", dir: "min", lo: 0, hi: 1, step: 0.05, label: "title similarity" },
  { key: "fp", threshold: "fpVerify", dir: "max", lo: 0, hi: 0.5, step: 0.02, label: "art distance" },
  { key: "d1", threshold: "fpAuto", dir: "max", lo: 0, hi: 0.5, step: 0.02, label: "fingerprint best distance" },
  { key: "gap", threshold: "fpGap", dir: "min", lo: 0, hi: 0.3, step: 0.02, label: "fingerprint gap to the next card" },
  { key: "collector", threshold: "collectorConf", dir: "min", lo: 0, hi: 1, step: 0.05, label: "collector line confidence" },
]);

/** Confirmed SUGGEST examples below which the report says it needs more data. */
export const LEARNING_MIN_EXAMPLES = 30;

const round = (v, d = 4) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Evidence of one detection for its detected printing (null = not measured). */
export function evidenceOf(features, printingId) {
  const f = features && typeof features === "object" ? features : {};
  const best = Array.isArray(f.candidates) ? f.candidates.find((c) => c?.id === printingId) ?? null : null;
  return {
    title: round(best?.title), fp: round(best?.fp), d1: round(f.fingerprint?.d1), gap: round(f.fingerprint?.gap),
    collector: f.collector ? round(f.collector.confidence) : null, line: Boolean(f.collector),
  };
}

// Reason texts of the decision without card names / set codes / counts, so they can be tallied.
const normReason = (s) => String(s)
  .replace(/^competing card .*/, "competing card")
  .replace(/^fingerprint says .*/, "fingerprint names another card")
  .replace(/^also [A-Z0-9]+$/, "same number in another set")
  .replace(/^\d+ printings share this art$/, "printings share this art");

/**
 * Why a detection stayed below AUTO: the thresholds its evidence misses
 * (keys of DEFAULT_THRESHOLDS, or 'no title read' / 'no collector line' /
 * 'no fingerprint') plus the decision's own reasons. A near-miss list, not the
 * exact decision path.
 */
export function blockersOf(ev, reasons = [], T = SCAN_THRESHOLDS) {
  const out = [];
  if (ev.title == null) out.push("no title read");
  else if (ev.title < T.titleAuto) out.push("titleAuto");
  if (!ev.line) out.push("no collector line");
  else if (ev.collector == null || ev.collector < T.collectorConf) out.push("collectorConf");
  if (ev.fp == null) out.push("no fingerprint");
  else if (ev.fp > T.fpVerify) out.push("fpVerify");
  if (ev.d1 != null && ev.d1 > T.fpAuto) out.push("fpAuto");
  if (ev.gap != null && ev.gap < T.fpGap) out.push("fpGap");
  for (const r of reasons) out.push(normReason(r));
  return [...new Set(out)];
}

function histogram(m, groups) {
  const n = Math.round((m.hi - m.lo) / m.step);
  const bins = Array.from({ length: n }, (_, i) => ({ from: round(m.lo + i * m.step, 3), to: round(m.lo + (i + 1) * m.step, 3), confirmed: 0, auto: 0, wrong: 0 }));
  for (const [name, values] of Object.entries(groups)) {
    for (const v of values) {
      const i = Math.min(n - 1, Math.max(0, Math.floor((v - m.lo) / m.step + 1e-9)));
      bins[i][name]++;
    }
  }
  return bins.filter((b) => b.confirmed || b.auto || b.wrong);
}

/**
 * How far one threshold could move toward the confirmed SUGGEST values without
 * letting a wrong detection's value pass: {value, gained, wrong_passing: 0} or
 * null when no confirmed value lies beyond the threshold (or a wrong one is closer).
 */
export function relaxOf(m, threshold, confirmed, wrong) {
  const passes = (v, t) => (m.dir === "min" ? v >= t : v <= t);
  const beyond = confirmed.filter((v) => !passes(v, threshold))
    .sort((a, b) => (m.dir === "min" ? b - a : a - b)); // nearest to the threshold first
  let best = null;
  for (const v of beyond) {
    // values between v and the threshold would pass too: no wrong one may be among them
    const between = (x) => !passes(x, threshold) && passes(x, v);
    if (wrong.some(between)) break;
    best = { value: v, gained: beyond.filter(between).length, wrong_passing: 0 };
  }
  return best;
}

/**
 * The learning report (GET /api/scans/learning): labelled examples by source,
 * outcomes (AUTO kept/corrected, SUGGEST confirmed/corrected, REVIEW best
 * guess right/wrong), what kept confirmed SUGGESTs from AUTO, and per metric a
 * histogram (confirmed SUGGEST / correct AUTO / wrong) with the safe relax.
 */
export function learningReport(db, { T = SCAN_THRESHOLDS } = {}) {
  const examples = exportCalibration(db);
  const bySource = Object.fromEntries(LABEL_SOURCES.map((s) => [s, 0]));
  const outcomes = { auto_kept: 0, auto_corrected: 0, suggest_confirmed: 0, suggest_corrected: 0, review_right: 0, review_corrected: 0, failed: 0 };
  const implicit = { kept: 0, later_corrected: 0 }; // implicit confirmations kept / overridden by a correction
  const blocked = new Map();
  const values = Object.fromEntries(LEARNING_METRICS.map((m) => [m.key, { confirmed: [], auto: [], wrong: [] }]));
  let detectedN = 0;
  for (const e of examples) {
    if (e.source in bySource) bySource[e.source]++;
    if (e.manual || !e.detected) continue;
    const status = e.detected.status;
    if (status === "failed" || !e.detected.printing_id) { outcomes.failed++; continue; }
    detectedN++;
    const right = e.correct_printing === true;
    const f = e.features || {};
    if (e.source === "implicit") implicit.kept++;
    if (f.confirm?.after === "implicit" && !right) implicit.later_corrected++;
    const key = status === "auto" ? (right ? "auto_kept" : "auto_corrected")
      : status === "suggest" ? (right ? "suggest_confirmed" : "suggest_corrected")
        : right ? "review_right" : "review_corrected";
    outcomes[key]++;
    const ev = evidenceOf(f, e.detected.printing_id);
    const group = !right ? "wrong" : status === "suggest" ? "confirmed" : status === "auto" ? "auto" : null;
    if (group) for (const m of LEARNING_METRICS) if (ev[m.key] != null) values[m.key][group].push(ev[m.key]);
    if (status === "suggest" && right) {
      for (const b of blockersOf(ev, f.local?.reasons ?? [], T)) blocked.set(b, (blocked.get(b) ?? 0) + 1);
    }
  }
  const blockedBy = [...blocked.entries()].map(([key, count]) => ({ key, count, ...(key in T ? { threshold: T[key] } : {}) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const metrics = LEARNING_METRICS.map((m) => {
    const v = values[m.key];
    return {
      key: m.key, label: m.label, threshold: m.threshold, value: T[m.threshold], dir: m.dir,
      bins: histogram(m, v), relax: relaxOf(m, T[m.threshold], v.confirmed, v.wrong),
    };
  });
  const auto = outcomes.auto_kept + outcomes.auto_corrected;
  const suggest = outcomes.suggest_confirmed + outcomes.suggest_corrected;
  return {
    labelled: examples.length,
    detected: detectedN,
    by_source: bySource,
    outcomes,
    rates: {
      auto_precision: auto ? round(outcomes.auto_kept / auto, 3) : null,
      suggest_right: suggest ? round(outcomes.suggest_confirmed / suggest, 3) : null,
    },
    implicit,
    blocked_by: blockedBy,
    top_reason: blockedBy[0] ?? null,
    metrics,
    enough_data: outcomes.suggest_confirmed >= LEARNING_MIN_EXAMPLES,
    min_examples: LEARNING_MIN_EXAMPLES,
    note: "Thresholds are not changed automatically. A relax value only looks at one metric; replay it through the regression gate before setting SCAN_THRESHOLDS.",
  };
}
