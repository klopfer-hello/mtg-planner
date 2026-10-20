// Scan rows: the shared pieces of the scanner's staging list (lib/scans.js),
// its capture log, labels and commit: the API view of a row, row lookups,
// finishes and conditions, and where the scan photos live (plain file names in
// the image dir only: a restored backup must never point a scan at another
// file). ScanError carries an HTTP status.

import path from "node:path";
import { unlinkSync } from "node:fs";
import { StatusError } from "./errors.js";

export const CONDITIONS = ["mint", "near_mint", "excellent", "good", "light_played", "played", "poor"];
export const FINISHES = ["normal", "foil", "etched"];

/** Directory for stored scan JPEGs (env SCAN_IMAGE_DIR, else <db dir>/scans). */
export const defaultImageDir = () =>
  process.env.SCAN_IMAGE_DIR || path.join(path.dirname(path.resolve(process.env.DB_FILE || "/data/mtg-planner.db")), "scans");

// Stored image names are plain file names in the image dir (a restored backup
// must never point a scan at another file).
export const safeFile = (f) => typeof f === "string" && f !== "" && path.basename(f) === f && f !== "." && f !== "..";

/** Error with an HTTP status for the API layer. */
export class ScanError extends StatusError {}

export const nowIso = () => new Date().toISOString();

export const parse = (s, fallback) => {
  if (s == null || s === "") return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
export const FINISH_OF = (f) => (f === "nonfoil" ? "normal" : f);
/** Accept Scryfall's "nonfoil" for the collection's "normal". */
export const normFinish = (f) => (f == null ? f : FINISH_OF(String(f)));
export const finishesOf = (p) => (p?.finishes?.length ? p.finishes : ["nonfoil"]).map(FINISH_OF);

/** API view of a scans row (JSON columns parsed; features only on request). */
export function scanRow(r, { features = false } = {}) {
  if (!r) return null;
  const out = {
    ...r,
    finishes: parse(r.finishes, []),
    candidates: parse(r.candidates, []),
    variants: parse(r.variants, []),
    calibration: Boolean(r.calibration),
    calibration_truth: parse(r.calibration_truth, null),
    committed_to: parse(r.committed_to, null),
    has_image: Boolean(r.image_path),
    has_strip: Boolean(r.strip_path),
    result_status: r.match_status, // alias: auto | suggest | review | confirmed | manual
  };
  delete out.strip_path;
  if (features) out.features = parse(r.features, null);
  else delete out.features;
  return out;
}

export function getRow(db, id) {
  return db.prepare("SELECT * FROM scans WHERE id = ?").get(Number(id));
}

export function requireStaged(db, id) {
  const row = getRow(db, id);
  if (!row) throw new ScanError(404, "Scan not found");
  if (row.status !== "staged") throw new ScanError(409, "Scan is already committed");
  return row;
}

export const isPlain = (v) => v != null && typeof v === "object" && !Array.isArray(v);

export const featuresOf = (row) => {
  const f = parse(row.features, null);
  return isPlain(f) ? f : {};
};

export function getScan(db, id, opts) {
  return scanRow(getRow(db, id), opts);
}

/** Absolute path of a scan's stored card image, or null. */
export function scanImagePath(db, id, { imageDir = defaultImageDir() } = {}) {
  const row = getRow(db, id);
  return safeFile(row?.image_path) ? path.join(imageDir, row.image_path) : null;
}

/** Absolute path of a scan's stored collector-line strip (the high-res bottom crop), or null. */
export function scanStripPath(db, id, { imageDir = defaultImageDir() } = {}) {
  const row = getRow(db, id);
  return safeFile(row?.strip_path) ? path.join(imageDir, row.strip_path) : null;
}

export function removeFiles(row, imageDir) {
  for (const f of [row.image_path, row.strip_path]) {
    if (!safeFile(f)) continue;
    try { unlinkSync(path.join(imageDir, f)); } catch { /* already gone */ }
  }
}
