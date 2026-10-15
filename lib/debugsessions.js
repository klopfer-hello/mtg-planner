// Scanner "Record session" storage (Scan settings switch, off by default).
//
// While the switch is on, the phone uploads small video frames (~480 px,
// JPEG q70, ~2 fps) and every capture decision record. They let the capture
// controller and the detector be replayed offline on what the user's camera
// actually saw, instead of on a filmed session. The frames are the user's
// own photos: they live only under <db dir>/debug-sessions (env
// DEBUG_SESSIONS_DIR), are listable and deletable through the API, and are
// never part of a backup (lib/backups.js copies the database only).
//
// Layout: <dir>/<session>/session.json {id, started_at}, <seq>.jpg (seq
// zero-padded), records.jsonl ({seq, at, record} per line). Session ids are
// [A-Za-z0-9-]{1,40}, so every path is a plain name below <dir>. Caps: a
// frame ≤ 300 KB, a session ≤ 400 MB, all sessions ≤ 2 GB. Nothing is ever
// pruned automatically: the recordings double as the scanner's regression set,
// so a full store answers 507 and the user deletes sessions in the Scan settings.
//
// All file I/O is async: the first use walks every frame (thousands of files,
// seconds on a cold spinning disk) and a delete removes up to ~13k files, which
// must not stall probes, /healthz or chat on the event loop. Writes are
// serialized per instance (a frame arrives every ~500 ms), so the in-memory
// sizes stay exact.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SESSION_ID_RE = /^[A-Za-z0-9-]{1,40}$/;
export const DEBUG_LIMITS = Object.freeze({
  frameBytes: 300 * 1024,
  recordBytes: 16 * 1024,
  sessionBytes: 400 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  maxSeq: 9_999_999,
});

/** Directory of the recorded sessions (env DEBUG_SESSIONS_DIR, else <db dir>/debug-sessions). */
export const defaultDebugDir = () =>
  process.env.DEBUG_SESSIONS_DIR || path.join(path.dirname(path.resolve(process.env.DB_FILE || "/data/mtg-planner.db")), "debug-sessions");

/** Error with an HTTP status for the API layer. */
export class DebugError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const frameName = (seq) => `${String(seq).padStart(7, "0")}.jpg`;

/** Run fn over items with at most `limit` running at once. */
async function eachLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * The recorded sessions of one directory. Sizes are summed from the files on
 * first use (async, 16 stats at a time) and then tracked in memory.
 */
export class DebugSessions {
  constructor({ dir = defaultDebugDir(), limits = {} } = {}) {
    this.dir = dir;
    this.limits = { ...DEBUG_LIMITS, ...limits };
    this.loading = null; // Promise<Map id -> {bytes, frames, started_at}>
    this.chain = Promise.resolve(); // serializes add/delete
  }

  /** @private */
  load() {
    this.loading ??= (async () => {
      const sizes = new Map();
      let names = [];
      try { names = await readdir(this.dir); } catch { return sizes; }
      for (const id of names) {
        if (!SESSION_ID_RE.test(id)) continue;
        const d = path.join(this.dir, id);
        let bytes = 0, frames = 0, started = null;
        try {
          if (!(await stat(d)).isDirectory()) continue;
          const files = await readdir(d);
          await eachLimit(files, 16, async (f) => {
            try {
              const size = (await stat(path.join(d, f))).size; // read bytes after the await
              bytes += size;
              if (f.endsWith(".jpg")) frames++;
            } catch { /* vanished meanwhile */ }
          });
          started = JSON.parse(await readFile(path.join(d, "session.json"), "utf8")).started_at ?? null;
        } catch { /* partial session: counted as far as it goes */ }
        if (!started) try { started = (await stat(d)).birthtime.toISOString(); } catch { started = null; }
        sizes.set(id, { bytes, frames, started_at: started });
      }
      return sizes;
    })();
    return this.loading;
  }

  /** @private Run fn after every earlier add/delete (one writer at a time). */
  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Bytes of all sessions together. */
  async total() {
    let t = 0;
    for (const s of (await this.load()).values()) t += s.bytes;
    return t;
  }

  /** Sessions, newest first: [{id, frames, bytes, started_at}]. */
  async list() {
    return [...(await this.load()).entries()]
      .map(([id, s]) => ({ id, frames: s.frames, bytes: s.bytes, started_at: s.started_at }))
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || b.id.localeCompare(a.id));
  }

  /** Delete a session (all its files). Resolves false when it doesn't exist. */
  async delete(id) {
    if (!SESSION_ID_RE.test(String(id))) throw new DebugError(400, "Invalid session id");
    return this.serial(async () => {
      const sizes = await this.load();
      const d = path.join(this.dir, id);
      if (!sizes.has(id) && !existsSync(d)) return false;
      sizes.delete(id);
      await rm(d, { recursive: true, force: true });
      return true;
    });
  }

  /**
   * Store one frame and/or one decision record of `session`.
   * frame: JPEG Buffer (≤ limits.frameBytes) or null; record: any JSON value
   * (≤ limits.recordBytes serialized) or undefined. A frame whose seq is
   * already stored is ignored (a retried upload). 413 when this session is
   * full, 507 when all sessions together are (nothing is pruned). Resolves {stored}.
   */
  async add({ session, seq, frame = null, record, now = Date.now() } = {}) {
    if (typeof session !== "string" || !SESSION_ID_RE.test(session)) throw new DebugError(400, "session must match [A-Za-z0-9-]{1,40}");
    if (!Number.isInteger(seq) || seq < 0 || seq > this.limits.maxSeq) throw new DebugError(400, "seq must be a non-negative integer");
    if (frame != null) {
      if (!Buffer.isBuffer(frame) || frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8 || frame[2] !== 0xff) {
        throw new DebugError(400, "jpeg is not a JPEG image");
      }
      if (frame.length > this.limits.frameBytes) throw new DebugError(413, `Frame too large (max ${Math.round(this.limits.frameBytes / 1024)} KB)`);
    }
    let line = null;
    if (record !== undefined) {
      line = JSON.stringify({ seq, at: new Date(now).toISOString(), record }) + "\n";
      if (Buffer.byteLength(line) > this.limits.recordBytes) throw new DebugError(413, `Record too large (max ${Math.round(this.limits.recordBytes / 1024)} KB)`);
    }
    if (frame == null && line == null) throw new DebugError(400, "jpeg or record is required");

    return this.serial(async () => {
      const sizes = await this.load();
      const d = path.join(this.dir, session);
      let s = sizes.get(session);
      const framePath = frame ? path.join(d, frameName(seq)) : null;
      const dupFrame = framePath && existsSync(framePath);
      const adding = (frame && !dupFrame ? frame.length : 0) + (line ? Buffer.byteLength(line) : 0);
      if ((s?.bytes ?? 0) + adding > this.limits.sessionBytes) {
        throw new DebugError(413, `This recording is full (${Math.round(this.limits.sessionBytes / 1024 / 1024)} MB); start a new session`);
      }
      if ((await this.total()) + adding > this.limits.totalBytes) {
        throw new DebugError(507, "Recording storage is full; delete old recordings in the Scan settings");
      }

      if (!s) {
        await mkdir(d, { recursive: true });
        const started = new Date(now).toISOString();
        const meta = JSON.stringify({ id: session, started_at: started }) + "\n";
        try { await writeFile(path.join(d, "session.json"), meta, { flag: "wx" }); } catch { /* exists already */ }
        s = { bytes: Buffer.byteLength(meta), frames: 0, started_at: started };
        sizes.set(session, s);
      }
      let stored = false;
      if (frame && !dupFrame) {
        try {
          await writeFile(framePath, frame, { flag: "wx" });
          s.bytes += frame.length;
          s.frames++;
          stored = true;
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      }
      if (line) {
        await appendFile(path.join(d, "records.jsonl"), line);
        s.bytes += Buffer.byteLength(line);
        stored = true;
      }
      return { stored };
    });
  }
}
