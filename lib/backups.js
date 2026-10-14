// Manual backups of the app database (collection, binders, decks, scans, chats,
// settings/meta, calibration data) and restoring one, triggered from the UI only
// (the Claude MCP tools get no access: a restore replaces everything).
//
// A backup is `VACUUM INTO` (a consistent snapshot while the app keeps running,
// also with other connections writing) gzip-compressed, plus a small JSON
// manifest next to it. The card index, fingerprint images, scan JPEGs and the
// Claude sessions are not part of it: they are rebuilt or not worth keeping.
//
// A restore unpacks the file to a temp file next to the live database (same
// filesystem, so the swap is a rename), validates it (integrity_check, the
// required tables, a schema not newer than this app's), and swapDatabase()
// replaces the file. Anything failing after the live file was moved aside
// moves it back, so a failed restore leaves the current data in place.

import { DatabaseSync } from "node:sqlite";
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/** mtg-planner-YYYYMMDD-HHMMSS[-N][-pre-restore].db.gz (N: same second). */
export const BACKUP_NAME_RE = /^mtg-planner-\d{8}-\d{6}(?:-\d{1,3})?(?:-pre-restore)?\.db\.gz$/;
export const BACKUP_KINDS = ["manual", "pre-restore"];
export const PRE_RESTORE_KEEP = 5;
/** Tables every backup must have (the v0 schema; later ones are added by the migrations). */
export const REQUIRED_TABLES = ["cards", "collection", "decks", "deck_cards", "imports", "chats", "messages"];
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/** Error with an HTTP status for the API layer. */
export class BackupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** BACKUP_DIR (default <db dir>/backups = /data/backups) and BACKUP_KEEP (default 20). */
export function backupConfig(env = process.env) {
  const dbFile = path.resolve(env.DB_FILE || "/data/mtg-planner.db");
  const keep = Number.parseInt(env.BACKUP_KEEP, 10);
  return {
    dir: path.resolve(env.BACKUP_DIR || path.join(path.dirname(dbFile), "backups")),
    keep: Number.isInteger(keep) && keep >= 1 ? keep : 20,
    preRestoreKeep: PRE_RESTORE_KEEP,
  };
}

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** What a database holds, for the manifest and the UI (tables missing in old schemas count 0). */
export function dbCounts(db) {
  const one = (sql) => { try { return Number(Object.values(db.prepare(sql).get() ?? {})[0] ?? 0); } catch { return 0; } };
  return {
    copies: one("SELECT COALESCE(SUM(quantity), 0) FROM collection"),
    printings: one("SELECT COUNT(DISTINCT scryfall_id) FROM collection"),
    decks: one("SELECT COUNT(*) FROM decks"),
    binders: hasTable(db, "binders") ? one("SELECT COUNT(*) FROM binders") : one("SELECT COUNT(DISTINCT lower(binder)) FROM collection WHERE binder <> ''"),
    scans: hasTable(db, "scans") ? one("SELECT COUNT(*) FROM scans") : 0,
    chats: one("SELECT COUNT(*) FROM chats"),
  };
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
/** Local-time stamp YYYYMMDD-HHMMSS (container TZ). */
function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function freeName(dir, now, kind) {
  const suffix = kind === "pre-restore" ? "-pre-restore" : "";
  for (let i = 1; i < 1000; i++) {
    const name = `mtg-planner-${stamp(now)}${i > 1 ? `-${i}` : ""}${suffix}.db.gz`;
    if (!existsSync(path.join(dir, name)) && !existsSync(path.join(dir, manifestName(name)))) return name;
  }
  throw new BackupError(409, "Too many backups in the same second");
}

const manifestName = (name) => name.replace(/\.db\.gz$/, ".json");
const tmpName = (dir, tag) => path.join(dir, `.tmp-${tag}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);

/** Validated absolute path of a stored backup; 400 for a bad name, 404 when missing. */
export function backupPath(dir, name) {
  if (typeof name !== "string" || !BACKUP_NAME_RE.test(name)) throw new BackupError(400, "Invalid backup name");
  const file = path.join(dir, name);
  if (path.dirname(file) !== path.resolve(dir)) throw new BackupError(400, "Invalid backup name");
  if (!existsSync(file)) throw new BackupError(404, "Backup not found");
  return file;
}

/**
 * Snapshot `db` into `dir` as <name>.db.gz + <name>.json and prune old backups
 * of the same kind. Returns the manifest (with `size`).
 * opts: {dir, kind 'manual'|'pre-restore', version, keep, now, protect: names the
 * prune must not delete (the backup a restore is about to apply)}
 */
export async function createBackup(db, { dir, kind = "manual", version = "dev", keep = 20, now = new Date(), protect = [] } = {}) {
  if (!BACKUP_KINDS.includes(kind)) throw new BackupError(400, `kind must be ${BACKUP_KINDS.join(" or ")}`);
  mkdirSync(dir, { recursive: true });
  const name = freeName(dir, now, kind);
  const raw = tmpName(dir, "snap");
  const gz = tmpName(dir, "gz");
  try {
    // One statement = one read transaction: a consistent snapshot even while
    // other connections (the MCP server, ...) write.
    db.prepare("VACUUM INTO ?").run(raw);
    const snap = new DatabaseSync(raw, { readOnly: true });
    let counts, schema;
    try {
      counts = dbCounts(snap);
      schema = snap.prepare("PRAGMA user_version").get().user_version;
    } finally { snap.close(); }
    const dbBytes = statSync(raw).size;
    await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(gz));
    renameSync(gz, path.join(dir, name));
    const manifest = {
      name, kind, created_at: now.toISOString(), app_version: version, schema_version: schema, db_bytes: dbBytes, counts,
    };
    writeFileSync(path.join(dir, manifestName(name)), JSON.stringify(manifest, null, 1) + "\n");
    pruneBackups(dir, { kind, keep: kind === "pre-restore" ? PRE_RESTORE_KEEP : keep, protect });
    return { ...manifest, size: statSync(path.join(dir, name)).size };
  } finally {
    rmSync(raw, { force: true });
    rmSync(gz, { force: true });
  }
}

/** Stored backups, newest first: manifest fields + size (a missing/broken manifest gives a minimal entry). */
export function listBackups(dir) {
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of files) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    let st;
    try { st = statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(path.join(dir, manifestName(name)), "utf8")) ?? {}; } catch { /* no manifest */ }
    out.push({
      app_version: null, schema_version: null, db_bytes: null, counts: null,
      ...manifest,
      name,
      kind: name.endsWith("-pre-restore.db.gz") ? "pre-restore" : "manual",
      created_at: typeof manifest.created_at === "string" ? manifest.created_at : st.mtime.toISOString(),
      size: st.size,
    });
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.name.localeCompare(a.name)));
}

/** Keep the newest `keep` backups of `kind` (names in `protect` are never deleted); returns the deleted names. */
export function pruneBackups(dir, { kind = "manual", keep = 20, protect = [] } = {}) {
  const old = listBackups(dir).filter((b) => b.kind === kind).slice(Math.max(1, keep)).filter((b) => !protect.includes(b.name));
  for (const b of old) deleteBackup(dir, b.name);
  return old.map((b) => b.name);
}

/** Delete a stored backup and its manifest. */
export function deleteBackup(dir, name) {
  const file = backupPath(dir, name);
  rmSync(file, { force: true });
  rmSync(path.join(dir, manifestName(name)), { force: true });
}

/** Counts bytes and fails beyond `max` (gzip bomb guard). */
function byteLimit(max) {
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(new BackupError(400, `The backup unpacks to more than ${Math.round(max / 1024 / 1024)} MB`));
      else cb(null, chunk);
    },
  });
}

/**
 * Gunzip a stored file (path) or an uploaded body (Buffer) to `dest`.
 * Not gzip / truncated / corrupt → BackupError 400.
 */
export async function gunzipToFile(input, dest, { maxBytes = 2 * 1024 ** 3 } = {}) {
  const source = Buffer.isBuffer(input) ? Readable.from([input]) : createReadStream(input);
  try {
    await pipeline(source, createGunzip(), byteLimit(maxBytes), createWriteStream(dest));
  } catch (err) {
    rmSync(dest, { force: true });
    if (err instanceof BackupError) throw err;
    throw new BackupError(400, `Not a valid backup file (gzip: ${err.message})`);
  }
}

/** scan-<id>[-<token>][-strip].jpg; the token (since v0.4) makes the name unique to its scan row. */
export const SCAN_FILE_RE = /^scan-\d+(-[0-9a-f]{8,32})?(?:-strip)?\.jpg$/;
/** Seconds a scan's photo may be written after its row (staging writes it right after the INSERT). */
const LEGACY_FILE_SLACK_MS = 10_000;

/**
 * Whether a restored scan row may keep its image path `f`: a plain scan file
 * name whose file exists. A legacy name without token (scan-<id>.jpg) could
 * belong to a later scan that reused the id, so it is kept only when the file
 * is not newer than the row (created_at + slack; unknown dates: kept).
 */
function keepScanFile(f, createdAt, imageDir) {
  const m = typeof f === "string" ? SCAN_FILE_RE.exec(f) : null;
  if (!m || !imageDir) return false;
  let st;
  try { st = statSync(path.join(imageDir, f)); } catch { return false; }
  if (!st.isFile()) return false;
  if (m[1]) return true;
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || st.mtimeMs <= created + LEGACY_FILE_SLACK_MS;
}

/**
 * Check an unpacked backup before it may replace the live database: SQLite
 * file, PRAGMA integrity_check = ok, the required tables, user_version not
 * newer than `schemaVersion`. Then drops scan image paths that are not plain
 * scan file names or whose file is missing in `imageDir` (scan JPEGs are not
 * part of a backup). Returns {schema_version, counts}.
 */
export function validateBackupDb(file, { schemaVersion, imageDir = null } = {}) {
  const head = Buffer.alloc(100);
  const fd = openSync(file, "r+");
  try {
    const n = readSync(fd, head, 0, 100, 0);
    if (n < 100 || !head.subarray(0, 16).equals(SQLITE_MAGIC)) throw new BackupError(400, "Not a valid backup: the file is not an mtg-planner database");
    // A raw copy of a WAL-mode file (no -wal next to it): switch the header to
    // rollback mode so it opens read-only; openDb() turns WAL back on.
    if (head[18] === 2 || head[19] === 2) writeSync(fd, Buffer.from([1, 1]), 0, 2, 18);
  } finally { closeSync(fd); }

  let ro;
  try {
    ro = new DatabaseSync(file, { readOnly: true });
    const check = ro.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check);
    if (check.length !== 1 || check[0] !== "ok") throw new BackupError(400, `Not a valid backup: integrity check failed (${check.slice(0, 3).join("; ")})`);
    const missing = REQUIRED_TABLES.filter((t) => !hasTable(ro, t));
    if (missing.length) throw new BackupError(400, `Not a valid backup: not an mtg-planner database (missing tables: ${missing.join(", ")})`);
    const version = ro.prepare("PRAGMA user_version").get().user_version;
    if (schemaVersion != null && version > schemaVersion) {
      throw new BackupError(400, `This backup comes from a newer mtg-planner (database schema v${version}; this version knows up to v${schemaVersion}). Update the app first.`);
    }
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(400, `Not a valid backup: ${err.message}`);
  } finally {
    try { ro?.close(); } catch { /* ignore */ }
  }

  const db = new DatabaseSync(file);
  try {
    if (hasTable(db, "scans")) {
      const cols = db.prepare("PRAGMA table_info(scans)").all().map((c) => c.name);
      for (const col of ["image_path", "strip_path"].filter((c) => cols.includes(c))) {
        for (const r of db.prepare(`SELECT id, ${col} AS f${cols.includes("created_at") ? ", created_at" : ""} FROM scans WHERE ${col} IS NOT NULL`).all()) {
          if (!keepScanFile(r.f, r.created_at, imageDir)) db.prepare(`UPDATE scans SET ${col} = NULL WHERE id = ?`).run(r.id);
        }
      }
    }
    return { schema_version: db.prepare("PRAGMA user_version").get().user_version, counts: dbCounts(db) };
  } finally { db.close(); }
}

/**
 * Replace the live database file with `newFile` (synchronous: nothing else
 * runs in between). `close()` closes the app's connection, `open()` opens it
 * again (running the migrations, so older backups are upgraded) and must
 * return the connection. On any failure the previous file (and its -wal/-shm)
 * is moved back, reopened and the error rethrown with `.db` = that connection.
 */
export function swapDatabase({ dbFile, newFile, close, open }) {
  const aside = `${dbFile}.restore-old-${process.pid}-${Date.now()}`;
  const moved = [];
  close();
  let db = null;
  try {
    for (const suf of ["-wal", "-shm"]) {
      if (existsSync(dbFile + suf)) { renameSync(dbFile + suf, aside + suf); moved.push(suf); }
    }
    renameSync(dbFile, aside);
    moved.push("");
    renameSync(newFile, dbFile);
    db = open();
    db.prepare("SELECT COUNT(*) FROM collection").get();
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    if (moved.includes("")) for (const suf of ["", "-wal", "-shm"]) rmSync(dbFile + suf, { force: true });
    for (const suf of moved) renameSync(aside + suf, dbFile + suf);
    let back = null;
    try { back = open(); } catch (reopenErr) { err.reopenError = reopenErr; }
    err.db = back;
    err.rolledBack = true;
    throw err;
  }
  for (const suf of moved) rmSync(aside + suf, { force: true });
  return db;
}
