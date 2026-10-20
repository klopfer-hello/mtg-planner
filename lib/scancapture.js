// Capture log (v0.5.0): every scan the browser sends carries a capture record
// (kind probe = a recognition probe of the ProbeController, manual = a shutter
// shot, auto_claude = an auto-ask scan; quad source, sharpness, stillness).
// It rides along with the scan into features.capture, +1s and duplicate
// answers go into features.capture_events, and records of scans that are
// never staged (undone, failed) land in the meta ring buffer capture_dropped.
// captureLog() exports all of it so the capture thresholds can be re-fit.
// Stored records of older clients (beta.1 fields like prev[], the "Same
// card?" chip, dup_of) stay as they are; new records keep current fields only.
// Records are whitelisted (sanitizeCapture): the features column must stay
// small and free of arbitrary client JSON.

import { getAppMeta, setAppMeta } from "./db.js";
import { featuresOf, isPlain, nowIso, parse } from "./scanrow.js";

// ---------------------------------------------------------------------------
// Capture records (probe / shutter / auto-ask scans)

/** Size cap of one sanitized capture record (JSON bytes). */
export const CAPTURE_MAX_BYTES = 4096;
/** +1s / duplicate answers kept per scan in features.capture_events. */
export const CAPTURE_EVENTS_MAX = 20;
/** Records of never-staged captures kept in meta capture_dropped. */
export const CAPTURE_DROPPED_MAX = 200;

// Field whitelist: key -> kind. num = finite number (rounded), bool, enum =
// short token. Unknown keys are dropped; a wrong type drops just that key.
const CAPTURE_FIELDS = {
  id: "num", kind: "enum", d: "num", fallback: "bool", quad_source: "enum",
  mad: "num", sharp: "num", variants: "num", calibration: "bool", allow_claude: "bool",
  // context the UI may add (detector, orientation, timing)
  det: "enum", state: "enum", orient_conf: "num", jitter: "num", prior_learned: "bool",
  t: "num", ms: "num", force: "bool", source: "enum", shot: "enum", strip_w: "num",
};
const cleanNum = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : undefined);
const cleanEnum = (v) => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,32}$/.test(v) ? v : undefined);

function cleanFields(raw, spec) {
  const out = {};
  for (const [k, kind] of Object.entries(spec)) {
    const v = raw[k];
    if (v === undefined) continue;
    let c;
    if (v === null) c = null;
    else if (kind === "num") c = cleanNum(v);
    else if (kind === "bool") c = typeof v === "boolean" ? v : undefined;
    else if (kind === "enum") c = cleanEnum(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/**
 * Whitelist a capture decision record from the client: known fields only
 * (numbers rounded, short enum tokens), at most CAPTURE_MAX_BYTES of JSON.
 * Returns the clean object, or null for a non-object.
 */
export function sanitizeCapture(raw) {
  if (!isPlain(raw)) return null;
  const out = cleanFields(raw, CAPTURE_FIELDS);
  if (Buffer.byteLength(JSON.stringify(out)) > CAPTURE_MAX_BYTES) return { kind: out.kind ?? null, truncated: true };
  return out;
}

// Append an event to a scan's features.capture_events (newest CAPTURE_EVENTS_MAX kept).
export function appendCaptureEvent(db, row, event) {
  const f = featuresOf(row);
  const events = Array.isArray(f.capture_events) ? f.capture_events : [];
  events.push(event);
  f.capture_events = events.slice(-CAPTURE_EVENTS_MAX);
  db.prepare("UPDATE scans SET features = ? WHERE id = ?").run(JSON.stringify(f), row.id);
}

// A capture record whose scan never became (or stopped being) a row: meta ring buffer.
export function recordDropped(db, entry) {
  if (!entry.capture) return;
  try {
    const list = parse(getAppMeta(db, "capture_dropped"), []);
    const ring = Array.isArray(list) ? list : [];
    ring.push({ at: nowIso(), ...entry });
    setAppMeta(db, "capture_dropped", JSON.stringify(ring.slice(-CAPTURE_DROPPED_MAX)));
  } catch (err) {
    console.warn(`[scans] capture record not kept: ${err.message}`);
  }
}

/**
 * Every capture record: features.capture + capture_events of every scan
 * (staged and committed) that has one, plus the dropped records (undone or
 * never staged). For re-fitting the capture thresholds offline.
 */
export function captureLog(db) {
  const scans = [];
  for (const r of db.prepare("SELECT * FROM scans ORDER BY id").all()) {
    const f = featuresOf(r);
    if (!f.capture && !f.capture_events) continue;
    scans.push({
      id: r.id, status: r.status, match_status: r.match_status, created_at: r.created_at, printing_id: r.printing_id ?? null,
      store_printing_id: r.store_printing_id ?? null, name: r.name ?? null, finish: r.finish, quantity: r.quantity,
      calibration_truth: parse(r.calibration_truth, null), dup_of: f.dup_of ?? null,
      capture: f.capture ?? null, capture_events: f.capture_events ?? [],
    });
  }
  const dropped = parse(getAppMeta(db, "capture_dropped"), []);
  return { scans, dropped: Array.isArray(dropped) ? dropped : [] };
}
