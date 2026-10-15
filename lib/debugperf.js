// Scanner performance beacons (POST/GET /api/debug/perf).
//
// Why it exists: the scanner's cost depends on the phone (camera resolution,
// GPU vs CPU canvas readback, CPU speed), and a slow phone gives no clue why
// it is slow. While the camera runs with a Record session on (or ?scandebug=1),
// the page posts a small summary every ~5 s (frame-analysis timings, frame
// intervals, long tasks, probe round trips, the granted camera size, UA, cores,
// device memory). Opt-in: nothing is sent during normal scanning.
//
// Storage: one JSON line per beacon in <db dir>/debug-perf.jsonl (env
// DEBUG_PERF_FILE), at most `max` (500) entries kept: the file is rewritten
// with the newest `max` lines once it holds 20 % more. Entries are validated
// (known keys only, finite numbers, short strings, ≤ 4 KB). No photos, not
// part of a backup (lib/backups.js copies the database only).

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PERF_LIMITS = Object.freeze({ entryBytes: 4096, max: 500, string: 300, keys: 40, depth: 3, array: 16 });

/** File of the perf beacons (env DEBUG_PERF_FILE, else <db dir>/debug-perf.jsonl). */
export const defaultPerfFile = () =>
  process.env.DEBUG_PERF_FILE || path.join(path.dirname(path.resolve(process.env.DB_FILE || "/data/mtg-planner.db")), "debug-perf.jsonl");

/** Error with an HTTP status for the API layer. */
export class PerfError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Top-level keys a beacon may carry (anything else is dropped).
const TOP_KEYS = new Set([
  "v", "session", "ua", "platform", "dpr", "cores", "memory", "screen", "video", "worker", "detect_worker", "pixel_worker",
  "grab_mode", "encoder", "window_ms", "analyze", "main", "grab", "detect", "sharp", "interval", "gap", "raf", "long_tasks",
  "long_task_ms", "probe_rtt", "probe_capture", "probes", "dropped_frames", "decoded_frames", "record", "visible", "errors",
  "wgrab", "wsharp", "probe_crop", "frame_path", "res", "probe_read", "probe_job",
]);

const KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;

function clean(v, depth, lim) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  if (typeof v === "string") return v.slice(0, lim.string);
  if (depth >= lim.depth) return undefined;
  if (Array.isArray(v)) return v.slice(0, lim.array).map((x) => clean(x, depth + 1, lim)).filter((x) => x !== undefined);
  if (typeof v === "object") {
    const out = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (!KEY_RE.test(k) || n >= lim.keys) continue;
      const c = clean(x, depth + 1, lim);
      if (c !== undefined) { out[k] = c; n++; }
    }
    return out;
  }
  return undefined;
}

/**
 * Validate one beacon: a plain object; known top-level keys only; numbers
 * finite (rounded to 3 decimals), strings ≤ 300 chars, nesting ≤ 3, ≤ 40 keys
 * per object. Throws PerfError 400 (not an object) / 413 (> entryBytes).
 * @returns {object} the cleaned entry (without `at`)
 */
export function sanitizePerf(body, limits = PERF_LIMITS) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PerfError(400, "Expected a JSON object");
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!TOP_KEYS.has(k)) continue;
    const c = clean(v, 1, limits);
    if (c !== undefined) out[k] = c;
  }
  if (!Object.keys(out).length) throw new PerfError(400, "No known perf fields");
  if (Buffer.byteLength(JSON.stringify(out)) > limits.entryBytes) throw new PerfError(413, "Perf entry too large");
  return out;
}

/** Ring buffer of perf beacons in one JSON-lines file. */
export class DebugPerf {
  /** @param {{file?: string, max?: number}} [opts] */
  constructor({ file = defaultPerfFile(), max = PERF_LIMITS.max } = {}) {
    this.file = file;
    this.max = max;
    this.lines = null; // loaded lazily
    this.chain = Promise.resolve(); // serializes add/compact
  }

  /** @private */
  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** @private */
  async load() {
    if (this.lines) return this.lines;
    try {
      this.lines = (await readFile(this.file, "utf8")).split("\n").filter((l) => l.trim());
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.lines = [];
    }
    return this.lines;
  }

  /**
   * Store one beacon ({at} added). The file keeps the newest `max` entries.
   * @returns {Promise<object>} the stored entry
   */
  async add(body, { now = Date.now() } = {}) {
    const entry = { at: new Date(now).toISOString(), ...sanitizePerf(body) };
    return this.serial(async () => {
      const lines = await this.load();
      const line = JSON.stringify(entry);
      await mkdir(path.dirname(this.file), { recursive: true });
      lines.push(line);
      if (lines.length > Math.ceil(this.max * 1.2)) {
        this.lines = lines.slice(-this.max);
        await writeFile(this.file, this.lines.join("\n") + "\n");
      } else await appendFile(this.file, line + "\n");
      return entry;
    });
  }

  /** Newest first, at most `limit` (1..max) entries; unparsable lines are skipped. */
  list({ limit = 100 } = {}) {
    return this.serial(async () => {
      const lines = await this.load();
      const n = Math.max(1, Math.min(this.max, Math.floor(Number(limit)) || 100));
      const out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        try { out.push(JSON.parse(lines[i])); } catch { /* skip a torn line */ }
      }
      return out;
    });
  }
}
