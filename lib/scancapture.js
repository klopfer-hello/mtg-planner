// Capture log (v0.5.0): every scan the browser sends carries a capture record
// (kind probe = a recognition probe of the ProbeController, manual = a shutter
// shot, auto_claude = an auto-ask scan; quad source, sharpness, stillness).
// It rides along with the scan into features.capture, +1s and duplicate
// answers go into features.capture_events, and records of scans that are
// never staged (undone, failed) land in the meta ring buffer capture_dropped.
// captureLog() exports all of it so the capture thresholds can be re-fit.
// The beta.1 fields (fingerprint distances, arm sources, prev[], the "Same
// card?" chip and dup_of) stay accepted for older records and clients.
// Records are whitelisted (sanitizeCapture): the features column must stay
// small and free of arbitrary client JSON.

import { getAppMeta, setAppMeta } from "./db.js";
import { featuresOf, isPlain, nowIso, parse } from "./scanrow.js";

// ---------------------------------------------------------------------------
// Capture records (probe / shutter / auto-ask scans; beta.1 fields kept for older records)

/** Size cap of one sanitized capture record (JSON bytes). */
export const CAPTURE_MAX_BYTES = 4096;
/** Silent decisions carried in a record's prev[]. */
export const CAPTURE_PREV_MAX = 10;
/** +1s / duplicate answers (and legacy chip answers) kept per scan in features.capture_events. */
export const CAPTURE_EVENTS_MAX = 20;
/** Records of never-staged captures kept in meta capture_dropped. */
export const CAPTURE_DROPPED_MAX = 200;

// Field whitelist: key -> kind. num = finite number (rounded), bool, enum =
// short token, enums/nums = bounded arrays, an object = nested whitelist.
// Unknown keys are dropped; a wrong type drops just that key.
const CAPTURE_SUB = {
  evidence: { card: "bool", empty: "bool", weak: "num", d_empty: "num", d_top: "num" },
  pending: { waited_ms: "num", d_recheck: "num", dropped: "bool", replaced: "bool" },
  chip: { label: "enum", d: "num", d_cap: "num", calibration: "bool" },
};
const CAPTURE_FIELDS = {
  id: "num", kind: "enum", d: "num", d_cap: "num", armed: "enums", watch: "bool", fallback: "bool", quad_source: "enum",
  mad: "num", sharp: "num", variants: "num", calibration: "bool", allow_claude: "bool", watch_checks: "nums",
  evidence: CAPTURE_SUB.evidence, pending: CAPTURE_SUB.pending, chip: CAPTURE_SUB.chip,
  // context the UI may add (detector, orientation, timing, queue)
  det: "enum", state: "enum", orient_conf: "num", jitter: "num", prior_learned: "bool", prior_used: "bool", held: "bool",
  t: "num", ms: "num", queue_ms: "num", queue_len: "num", flushed: "bool", force: "bool", dup_of: "num", source: "enum",
  shot: "enum", strip_w: "num",
};
const ARRAY_MAX = 12;
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
    else if (kind === "enums" || kind === "nums") {
      if (Array.isArray(v)) c = v.slice(0, ARRAY_MAX).map(kind === "enums" ? cleanEnum : cleanNum).filter((x) => x !== undefined);
    } else if (isPlain(kind)) c = isPlain(v) ? cleanFields(v, kind) : undefined;
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/**
 * Whitelist a capture decision record from the client: known fields only
 * (numbers rounded, short enum tokens, bounded arrays), prev[] <= 10 records
 * (the newest kept, no nesting), at most CAPTURE_MAX_BYTES of JSON (older
 * prev entries go first). Returns the clean object, or null for a non-object.
 */
export function sanitizeCapture(raw) {
  if (!isPlain(raw)) return null;
  const out = cleanFields(raw, CAPTURE_FIELDS);
  if (Array.isArray(raw.prev)) {
    const prev = raw.prev.slice(-CAPTURE_PREV_MAX).filter(isPlain).map((r) => cleanFields(r, CAPTURE_FIELDS));
    if (prev.length) out.prev = prev;
  }
  const size = () => Buffer.byteLength(JSON.stringify(out));
  while (out.prev?.length && size() > CAPTURE_MAX_BYTES) out.prev.shift();
  if (out.prev && !out.prev.length) delete out.prev;
  if (size() > CAPTURE_MAX_BYTES) return { kind: out.kind ?? null, truncated: true };
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
