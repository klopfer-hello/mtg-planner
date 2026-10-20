// Confirmations and labelled examples (self-learning data)
//
// A SUGGEST row ("probably right: please confirm") that the user scans past
// counts as confirmed: when the next card of the same scan session is staged
// (probe or shutter) or a +1 lands on another row of that session, every
// untouched SUGGEST row of the session becomes 'confirmed' with
// features.confirm {source:'implicit', at, by}. "Untouched" = still SUGGEST,
// has a printing, last action not an edit. A new row of the SAME card (oracle)
// never confirms: a second probe of one physical card that resolves to another
// printing must not settle the first guess. Undoing the stage / +1 that
// caused it reverts the implicit confirmation (undoLast), unless the user
// confirmed or fixed the row in between. updated_at / last_action / undo of
// the confirmed row stay as they are (undoLast keeps acting on the newest row).
//
// Every confirmation is also a labelled example in calibration_truth with a
// `source`: implicit | user (Confirm button, or the picker kept the detected
// printing) | correction (the picker / truth chose another printing) |
// calibration (recordTruth) | commit (a committed row nobody touched: the
// user put it into the collection as it was). A commit refreshes the
// implicit/user/correction/commit labels from the row's final printing and
// finish. Only calibration rows (calibration = 1, or a legacy truth without
// source) keep their images after a commit. lib/learning.js reads the labels.

import { transaction } from "./db.js";
import { featuresOf, isPlain, parse } from "./scanrow.js";

/** Label sources, least trusted first. */
export const LABEL_SOURCES = ["commit", "implicit", "user", "correction", "calibration"];
/** Sources a commit may refresh (the row's final state is the truth). */
export const REFRESHED_SOURCES = new Set(["commit", "implicit", "user", "correction"]);

export const sessionOf = (row) => {
  const f = featuresOf(row);
  return f.session ?? f.probe?.session ?? null;
};
// A truth recorded on purpose (calibration mode, or older rows): never overwritten by a confirmation.
export const isCalibrationTruth = (t) => isPlain(t) && (t.source == null || t.source === "calibration");
// Atomic write (node:sqlite has no nested transactions: run inline inside an open one).
export const atomic = (db, fn) => (db.isTransaction ? fn() : transaction(db, fn));

/** The label of a row as it stands (detected-language printing + finish), tagged with its source. */
export function labelOf(row, source, at) {
  const detected = featuresOf(row).result ?? null;
  return {
    printing_id: row.printing_id, finish: row.finish, oracle_id: row.oracle_id ?? null, name: row.name ?? null,
    set_code: row.set_code ?? null, collector_number: row.collector_number ?? null, lang: row.lang_detected ?? null,
    recorded_at: at, source, detected_status: detected?.status ?? null,
  };
}

// Label source of a user action that settles the printing: the detected one kept → user, another → correction.
export const userSource = (row, printingId) => {
  const detectedId = featuresOf(row).result?.printing_id ?? null;
  return detectedId && printingId && detectedId !== printingId ? "correction" : "user";
};

/**
 * Implicitly confirm the untouched SUGGEST rows of a scan session (see above).
 * `by` = {scan, created_at, action:'stage'|'increment', q?}: what caused it
 * (undoLast reverts it). `except` = the row that triggered it; `oracleId` =
 * its card (rows of the same card are left alone). Returns [{id, name, printing_id}].
 */
export function confirmImplicitly(db, { session, except = null, oracleId = null, by = null, now = Date.now() } = {}) {
  if (!session) return [];
  const at = new Date(now).toISOString();
  const rows = db.prepare(`SELECT * FROM scans WHERE status = 'staged' AND match_status = 'suggest' AND printing_id IS NOT NULL
    AND id IS NOT ? AND COALESCE(json_extract(features, '$.session'), json_extract(features, '$.probe.session')) = ?
    ORDER BY id`).all(except, session);
  const out = [];
  const upd = db.prepare("UPDATE scans SET match_status = 'confirmed', features = ?, calibration_truth = ? WHERE id = ?");
  for (const r of rows) {
    if (r.last_action === "edit") continue;
    if (oracleId && r.oracle_id === oracleId) continue;
    const f = featuresOf(r);
    f.confirm = { source: "implicit", at, by };
    const truth = parse(r.calibration_truth, null);
    upd.run(JSON.stringify(f), isCalibrationTruth(truth) ? r.calibration_truth : JSON.stringify(labelOf(r, "implicit", at)), r.id);
    out.push({ id: r.id, name: r.name ?? null, printing_id: r.printing_id });
  }
  return out;
}

// undoLast: take back the implicit confirmations `match(by)` caused (rows still confirmed implicitly).
export function revertImplicit(db, match) {
  const rows = db.prepare(`SELECT * FROM scans WHERE status = 'staged' AND match_status = 'confirmed'
    AND json_extract(features, '$.confirm.source') = 'implicit'`).all();
  const out = [];
  for (const r of rows) {
    const f = featuresOf(r);
    if (!isPlain(f.confirm?.by) || !match(f.confirm.by)) continue;
    delete f.confirm;
    const truth = parse(r.calibration_truth, null);
    const keepTruth = isPlain(truth) && truth.source !== "implicit";
    db.prepare("UPDATE scans SET match_status = 'suggest', features = ?, calibration_truth = ? WHERE id = ?")
      .run(JSON.stringify(f), keepTruth ? r.calibration_truth : null, r.id);
    out.push(r.id);
  }
  return out;
}

/**
 * Every labelled scan: detection result, features and truth. `source` says
 * where the truth came from (LABEL_SOURCES; older truths count as
 * 'calibration'). opts.sources: only these sources (default all).
 */
export function exportCalibration(db, { sources = null } = {}) {
  const want = Array.isArray(sources) && sources.length ? new Set(sources) : null;
  return db.prepare("SELECT * FROM scans WHERE calibration_truth IS NOT NULL ORDER BY id").all().map((r) => {
    const features = parse(r.features, {});
    const truth = parse(r.calibration_truth, null);
    const source = isPlain(truth) ? truth.source ?? "calibration" : null;
    if (want && !want.has(source)) return null;
    const detected = features?.result ?? null;
    // Manually staged rows (picked by name) were never detected.
    const manual = Boolean(features?.manual) || detected?.status === "manual";
    return {
      id: r.id,
      created_at: r.created_at,
      status: r.status,
      source,
      truth,
      detected,
      correct_printing: detected && truth && !manual ? detected.printing_id === truth.printing_id : null,
      correct_finish: detected && truth && !manual && detected.printing_id ? detected.finish === truth.finish : null,
      manual,
      features,
    };
  }).filter(Boolean);
}
