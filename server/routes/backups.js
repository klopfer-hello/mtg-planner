// Backups (lib/backups.js): manual snapshots of the app DB, download, delete,
// and restoring a stored or uploaded one. UI only: the collection MCP server
// has no backup tools. A restore swaps app.db; while it runs every other
// state-changing request gets 503 (server.js).

import crypto from "node:crypto";
import { rmSync } from "node:fs";

import {
  backupConfig, backupPath, createBackup, dbCounts, deleteBackup, gunzipToFile, listBackups, restoreLimit, swapDatabase, validateBackupDb,
} from "../../lib/backups.js";
import { SCHEMA_VERSION, openDb, setAppMeta } from "../../lib/db.js";
import { defaultImageDir } from "../../lib/scanrow.js";
import { pruneSpellbookCache, seedSpellbookSettings, spellbookOptedOut } from "../../lib/spellbook.js";
import { HttpError, contentType, decodeParam, readBody, readJson, sendEmpty, sendFile, sendJson } from "../http.js";

const BACKUP = backupConfig();
const UPLOAD_LIMIT = 50 * 1024 * 1024;

const restoreConfirmed = (req, query, body = null) =>
  body?.confirm === true || query.get("confirm") === "1" || req.headers["x-confirm-restore"] === "1";

export function backupRoutes(router, app) {
  /** Why a restore can't run now (work that holds or writes the app DB), or null. */
  function restoreBlocker() {
    if (app.backupBusy) return "a backup or restore is already running";
    if (app.importBusy) return "an import, price refresh or collection change is running";
    if (app.runs.size) return "the planner is answering a chat (its MCP server has the database open)";
    if (app.scanner.scanSlots.used) return "a scan is being identified";
    if (app.guideJobs.size) return "Claude is writing a deck guide";
    // The restore request itself is one of them; any other may still use the current DB after an await.
    if (app.inflight > 1) return "another request is still being answered";
    return null;
  }

  /**
   * Restore from a stored backup (`name`) or an uploaded .db.gz (`upload`
   * Buffer): unpack + validate, take a pre-restore safety backup, swap the file,
   * reopen (migrations upgrade older backups). The live DB stays untouched until
   * the swap, and a failed swap rolls back to it.
   */
  async function restoreBackup({ name = null, upload = null }) {
    const blocker = restoreBlocker();
    if (blocker) throw new HttpError(409, `Can't restore right now: ${blocker}. Try again when it has finished.`);
    app.backupBusy = true;
    app.restoring = true;
    app.importBusy = true; // imports, moves and the scheduler's price refresh wait for us
    const tmp = `${app.dbFile}.restore-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      const source = name ? backupPath(BACKUP.dir, name) : upload;
      const stored = name ? listBackups(BACKUP.dir).find((b) => b.name === name) ?? null : null;
      await gunzipToFile(source, tmp, { maxBytes: restoreLimit(app.dbFile) });
      const checked = validateBackupDb(tmp, { schemaVersion: SCHEMA_VERSION, imageDir: defaultImageDir() });
      const safety = await createBackup(app.db, { dir: BACKUP.dir, kind: "pre-restore", version: app.version, protect: name ? [name] : [] });
      const spellbookOff = spellbookOptedOut(app.db); // the user's opt-out survives the restore
      try {
        app.db = swapDatabase({ dbFile: app.dbFile, newFile: tmp, close: () => app.db.close(), open: () => openDb(app.dbFile) });
      } catch (err) {
        if (err.db) app.db = err.db;
        console.error(`[backup] restore failed, previous database ${err.db ? "restored" : "COULD NOT BE REOPENED"}:`, err);
        if (!err.db) throw new HttpError(500, `Restore failed and the previous database could not be reopened: ${err.message}. Restart the app; safety backup: ${safety.name}`);
        throw new HttpError(500, `Restore failed, nothing was changed: ${err.message}`);
      }
      const db = app.db;
      const restored = {
        name: name ?? null,
        source: name ? "stored" : "upload",
        restored_at: new Date().toISOString(),
        backup: stored,
        schema_version_before_upgrade: checked.schema_version,
        schema_version: db.prepare("PRAGMA user_version").get().user_version,
        counts: dbCounts(db),
      };
      try { setAppMeta(db, "last_restore", JSON.stringify({ at: new Date().toISOString(), from: name ?? "upload", safety_backup: safety.name })); } catch { /* informational */ }
      // The restored DB brings its own Spellbook settings, but an opt-out (in the live DB
      // before the restore, or SPELLBOOK_ENABLED=false) always wins: the stricter one is kept.
      try {
        seedSpellbookSettings(db, process.env, console, { keepOff: spellbookOff });
        pruneSpellbookCache(db);
      } catch (err) { console.warn(`[spellbook] ${err.message}`); }
      console.log(`[backup] restored ${name ?? "an uploaded backup"} (schema v${checked.schema_version} → v${restored.schema_version}); safety backup ${safety.name}`);
      return { restored, safety_backup: safety };
    } finally {
      rmSync(tmp, { force: true });
      app.importBusy = false;
      app.restoring = false;
      app.backupBusy = false;
      app.background.scheduleEnglishPrices();
      app.background.scheduleCardFacts(); // a restored v8 backup lacks the v9 card facts
    }
  }

  router.get("/api/backups", () => ({ backups: listBackups(BACKUP.dir), keep: BACKUP.keep }));
  router.post("/api/backups", async ({ res }) => {
    if (app.backupBusy) throw new HttpError(409, "A backup or restore is already running");
    app.backupBusy = true;
    try {
      sendJson(res, 201, await createBackup(app.db, { dir: BACKUP.dir, kind: "manual", version: app.version, keep: BACKUP.keep }));
    } finally { app.backupBusy = false; }
  });
  router.post("/api/backups/restore-upload", async ({ req, query }) => {
    if (!["application/gzip", "application/x-gzip", "application/octet-stream"].includes(contentType(req))) {
      throw new HttpError(415, "Content-Type must be application/gzip or application/octet-stream");
    }
    if (!restoreConfirmed(req, query)) throw new HttpError(400, "A restore replaces all app data; confirm with confirm=1");
    const buf = await readBody(req, UPLOAD_LIMIT);
    if (!buf.length) throw new HttpError(400, "The uploaded file is empty");
    return restoreBackup({ upload: buf });
  });
  router.get("/api/backups/:name/download", async ({ req, res, params }) => {
    const name = decodeParam(params.name, "Invalid backup name");
    const file = backupPath(BACKUP.dir, name);
    return sendFile(req, res, file, { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
  });
  router.post("/api/backups/:name/restore", async ({ req, query, params }) => {
    const name = decodeParam(params.name, "Invalid backup name");
    const body = await readJson(req);
    backupPath(BACKUP.dir, name);
    if (!restoreConfirmed(req, query, body)) throw new HttpError(400, "A restore replaces all app data; confirm with {confirm: true}");
    return restoreBackup({ name });
  });
  router.delete("/api/backups/:name", ({ res, params }) => {
    const name = decodeParam(params.name, "Invalid backup name");
    if (app.backupBusy) throw new HttpError(409, "A backup or restore is running");
    deleteBackup(BACKUP.dir, name);
    sendEmpty(res);
  });
}
