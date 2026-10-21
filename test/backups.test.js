// lib/backups.js: snapshots (also while another connection writes), listing,
// retention, name validation, validation of a backup before a restore, the
// file swap with its rollback, and restoring an older-schema backup.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { SCHEMA_VERSION, openDb } from "../lib/db.js";
import {
  BACKUP_NAME_RE, BackupError, PRE_RESTORE_KEEP, backupConfig, backupPath, createBackup, dbCounts, deleteBackup, gunzipToFile, listBackups, pruneBackups,
  restoreLimit, swapDatabase, validateBackupDb,
} from "../lib/backups.js";
import { ID, seedCards, seedCollection } from "./fixtures.js";

let root;
before(() => { root = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-backups-")); });
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** Fresh seeded app DB + backup dir in its own folder. */
function fixture() {
  const dir = path.join(root, `case-${++n}`);
  mkdirSync(dir);
  const file = path.join(dir, "mtg-planner.db");
  const db = openDb(file);
  seedCards(db);
  seedCollection(db, [[ID.sol, 2, { binder: "Box" }], [ID.lightning, 3]]);
  db.prepare("INSERT INTO binders (name, origin) VALUES ('Box', 'manabox') ON CONFLICT DO NOTHING").run();
  db.prepare("INSERT INTO decks (name) VALUES ('Plan')").run();
  db.prepare("INSERT INTO chats (id, title) VALUES ('c1', 'Hi')").run();
  return { dir, file, db, backups: path.join(dir, "backups") };
}

const expectBackupError = (status, re) => (err) => {
  assert.ok(err instanceof BackupError, `expected BackupError, got ${err}`);
  assert.equal(err.status, status);
  if (re) assert.match(err.message, re);
  return true;
};

async function unpack(file, dest) {
  await gunzipToFile(file, dest);
  return new DatabaseSync(dest, { readOnly: true });
}

describe("createBackup / listBackups / retention", () => {
  test("writes a gzip snapshot + manifest with counts, schema and version", async () => {
    const f = fixture();
    const m = await createBackup(f.db, { dir: f.backups, version: "1.2.3", now: new Date(2026, 9, 14, 12, 30, 5) });
    assert.equal(m.name, "mtg-planner-20261014-123005.db.gz");
    assert.match(m.name, BACKUP_NAME_RE);
    assert.equal(m.kind, "manual");
    assert.equal(m.app_version, "1.2.3");
    assert.equal(m.schema_version, SCHEMA_VERSION);
    assert.deepEqual(m.counts, { copies: 5, printings: 2, decks: 1, binders: 1, scans: 0, chats: 1 });
    assert.ok(m.size > 0 && m.db_bytes > m.size);
    const manifest = JSON.parse(readFileSync(path.join(f.backups, "mtg-planner-20261014-123005.json"), "utf8"));
    assert.deepEqual(manifest.counts, m.counts);
    // No temp files left behind.
    assert.deepEqual(readdirSync(f.backups).sort(), ["mtg-planner-20261014-123005.db.gz", "mtg-planner-20261014-123005.json"]);
    const snap = await unpack(path.join(f.backups, m.name), path.join(f.dir, "check.db"));
    assert.equal(snap.prepare("SELECT SUM(quantity) AS n FROM collection").get().n, 5);
    snap.close();
    // Same second: a suffix, never an overwrite.
    const again = await createBackup(f.db, { dir: f.backups, now: new Date(2026, 9, 14, 12, 30, 5) });
    assert.equal(again.name, "mtg-planner-20261014-123005-2.db.gz");
    f.db.close();
  });

  test("snapshot is consistent while another connection keeps writing", async () => {
    const f = fixture();
    // Each write transaction adds two messages: a torn snapshot would show an odd count.
    const worker = new Worker(`
      const { DatabaseSync } = require("node:sqlite");
      const { workerData, parentPort } = require("node:worker_threads");
      const db = new DatabaseSync(workerData.file);
      db.exec("PRAGMA busy_timeout = 10000");
      const ins = db.prepare("INSERT INTO messages (chat_id, role, content) VALUES ('c1', 'user', ?)");
      const stopAt = Date.now() + workerData.ms;
      let tx = 0;
      parentPort.postMessage("started");
      while (Date.now() < stopAt) {
        db.exec("BEGIN IMMEDIATE");
        ins.run("a" + tx); ins.run("b" + tx);
        db.exec("COMMIT");
        tx++;
      }
      db.close();
      parentPort.postMessage(tx);
    `, { eval: true, workerData: { file: f.file, ms: 1500 } });
    const done = new Promise((resolve, reject) => {
      worker.on("message", (msg) => { if (msg !== "started") resolve(msg); });
      worker.on("error", reject);
    });
    await new Promise((resolve) => worker.once("message", resolve));
    const made = [];
    for (let i = 0; i < 4; i++) {
      made.push(await createBackup(f.db, { dir: f.backups, now: new Date(2026, 0, 1, 0, 0, i) }));
      await new Promise((r) => setTimeout(r, 50));
    }
    const writes = await done;
    assert.ok(writes > 0, "the writer ran");
    const seen = [];
    for (const [i, m] of made.entries()) {
      const snap = await unpack(path.join(f.backups, m.name), path.join(f.dir, `snap-${i}.db`));
      assert.equal(snap.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      const count = snap.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
      assert.equal(count % 2, 0, "no half-written transaction in the snapshot");
      seen.push(count);
      snap.close();
    }
    assert.ok(seen.at(-1) > 0, "snapshots taken while writing contain writes");
    f.db.close();
  });

  test("list newest first with size; retention per kind; delete", async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) await createBackup(f.db, { dir: f.backups, keep: 3, now: new Date(2026, 0, 1, 10, 0, i) });
    for (let i = 0; i < 7; i++) await createBackup(f.db, { dir: f.backups, kind: "pre-restore", now: new Date(2026, 0, 2, 10, 0, i) });
    const list = listBackups(f.backups);
    const manual = list.filter((b) => b.kind === "manual").map((b) => b.name);
    const pre = list.filter((b) => b.kind === "pre-restore").map((b) => b.name);
    assert.deepEqual(manual, ["mtg-planner-20260101-100003.db.gz", "mtg-planner-20260101-100002.db.gz", "mtg-planner-20260101-100001.db.gz"]);
    assert.equal(pre.length, 5, "pre-restore backups: last 5");
    assert.equal(pre[0], "mtg-planner-20260102-100006-pre-restore.db.gz");
    assert.equal(list[0].kind, "pre-restore", "newest first across kinds");
    assert.ok(list.every((b) => b.size > 0 && b.counts?.copies === 5));
    // Retention never touches the other kind.
    assert.deepEqual(pruneBackups(f.backups, { kind: "manual", keep: 1 }).length, 2);
    assert.equal(listBackups(f.backups).filter((b) => b.kind === "pre-restore").length, 5);
    // Foreign files are ignored; a backup without manifest still lists.
    writeFileSync(path.join(f.backups, "notes.txt"), "x");
    writeFileSync(path.join(f.backups, "mtg-planner-20250101-000000.db.gz"), gzipSync(Buffer.from("x")));
    const bare = listBackups(f.backups).find((b) => b.name === "mtg-planner-20250101-000000.db.gz");
    assert.equal(bare.kind, "manual");
    assert.equal(bare.counts, null);
    deleteBackup(f.backups, "mtg-planner-20260101-100003.db.gz");
    assert.ok(!existsSync(path.join(f.backups, "mtg-planner-20260101-100003.json")));
    assert.throws(() => deleteBackup(f.backups, "mtg-planner-20260101-100003.db.gz"), expectBackupError(404));
    f.db.close();
  });

  test("backupConfig: BACKUP_DIR / BACKUP_KEEP with defaults", () => {
    assert.deepEqual(backupConfig({}), { dir: "/data/backups", keep: 20, preRestoreKeep: 5 });
    assert.deepEqual(backupConfig({ DB_FILE: "/x/app.db", BACKUP_KEEP: "3" }), { dir: "/x/backups", keep: 3, preRestoreKeep: 5 });
    assert.equal(backupConfig({ BACKUP_DIR: "/b", BACKUP_KEEP: "0" }).keep, 20);
    assert.equal(backupConfig({ BACKUP_DIR: "/b" }).dir, "/b");
  });

  test("backupPath: strict names, no traversal", () => {
    const dir = path.join(root, "names");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "mtg-planner-20261014-120000.db.gz"), "x");
    assert.equal(backupPath(dir, "mtg-planner-20261014-120000.db.gz"), path.join(dir, "mtg-planner-20261014-120000.db.gz"));
    for (const bad of ["../mtg-planner.db", "..", "mtg-planner-20261014-120000.db.gz/..", "/etc/passwd", "mtg-planner-20261014-120000.db",
      "x/mtg-planner-20261014-120000.db.gz", "mtg-planner-2026101-120000.db.gz", "mtg-planner-20261014-120000.json", "", null]) {
      assert.throws(() => backupPath(dir, bad), expectBackupError(400), String(bad));
    }
    assert.throws(() => backupPath(dir, "mtg-planner-20261014-120001.db.gz"), expectBackupError(404));
  });
});

describe("validateBackupDb", () => {
  test("refuses corrupt gzip, non-SQLite, foreign databases, newer schemas, failed integrity", async () => {
    const dir = path.join(root, "invalid");
    mkdirSync(dir);
    const out = path.join(dir, "out.db");
    // Corrupt / truncated gzip.
    await assert.rejects(gunzipToFile(Buffer.from("definitely not gzip"), out), expectBackupError(400, /gzip/));
    const good = gzipSync(Buffer.alloc(10000, 7));
    await assert.rejects(gunzipToFile(good.subarray(0, good.length - 20), out), expectBackupError(400));
    assert.ok(!existsSync(out), "no partial file left");
    // Unpack bomb guard.
    await assert.rejects(gunzipToFile(gzipSync(Buffer.alloc(5000)), out, { maxBytes: 1000 }), expectBackupError(400, /more than/));
    // A restore's limit: 4× the live DB, at least 512 MB.
    const MB = 1024 ** 2;
    assert.equal(restoreLimit(path.join(dir, "missing.db")), 512 * MB);
    writeFileSync(path.join(dir, "big.db"), Buffer.alloc(1)); // tiny live DB: the floor
    assert.equal(restoreLimit(path.join(dir, "big.db")), 512 * MB);
    // Not SQLite.
    await gunzipToFile(gzipSync(Buffer.from("x".repeat(500))), out);
    assert.throws(() => validateBackupDb(out, { schemaVersion: SCHEMA_VERSION }), expectBackupError(400, /not an mtg-planner database/));
    // SQLite, but another app's tables.
    rmSync(out);
    const other = new DatabaseSync(out);
    other.exec("CREATE TABLE notes (x)");
    other.close();
    assert.throws(() => validateBackupDb(out, { schemaVersion: SCHEMA_VERSION }), expectBackupError(400, /missing tables/));
    // Newer schema than this app.
    rmSync(out);
    const newer = openDb(out);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();
    assert.throws(() => validateBackupDb(out, { schemaVersion: SCHEMA_VERSION }), expectBackupError(400, /newer mtg-planner/));
    // Integrity failure: clobber a b-tree page.
    rmSync(out);
    const big = openDb(out);
    seedCards(big);
    big.exec("PRAGMA journal_mode = DELETE");
    big.close();
    const bytes = readFileSync(out);
    const pageSize = bytes.readUInt16BE(16) || 65536;
    for (let p = 1; p * pageSize < bytes.length; p++) bytes.fill(0xff, p * pageSize + 8, p * pageSize + 64);
    writeFileSync(out, bytes);
    assert.throws(() => validateBackupDb(out, { schemaVersion: SCHEMA_VERSION }), expectBackupError(400));
  });

  test("accepts a raw WAL-mode copy; drops scan image paths that are unsafe or missing", () => {
    const dir = path.join(root, "valid");
    const images = path.join(dir, "scans");
    mkdirSync(images, { recursive: true });
    writeFileSync(path.join(images, "scan-1.jpg"), "jpg");
    const file = path.join(dir, "copy.db");
    const db = openDb(file);
    const ins = db.prepare("INSERT INTO scans (created_at, updated_at, image_path, strip_path) VALUES ('t', 't', ?, ?)");
    ins.run("scan-1.jpg", "scan-1-strip.jpg");
    ins.run("../../mtg-planner.db", "/etc/passwd");
    db.close(); // WAL header stays (bytes 18/19 = 2)
    assert.equal(readFileSync(file)[18], 2);
    const r = validateBackupDb(file, { schemaVersion: SCHEMA_VERSION, imageDir: images });
    assert.equal(r.schema_version, SCHEMA_VERSION);
    assert.equal(r.counts.scans, 2);
    const check = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(check.prepare("SELECT image_path, strip_path FROM scans ORDER BY id").all().map((x) => [x.image_path, x.strip_path]),
      [["scan-1.jpg", null], [null, null]]);
    check.close();
  });
});

describe("restored scan image paths", () => {
  test("token names are kept; a legacy name whose file is newer than the scan row is dropped", () => {
    const dir = path.join(root, "legacy");
    const images = path.join(dir, "scans");
    mkdirSync(images, { recursive: true });
    for (const f of ["scan-1-0123456789ab.jpg", "scan-2.jpg", "scan-3.jpg"]) writeFileSync(path.join(images, f), "jpg");
    // scan-3.jpg was written by a later scan that reused id 3.
    utimesSync(path.join(images, "scan-3.jpg"), new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
    utimesSync(path.join(images, "scan-2.jpg"), new Date("2026-01-01T00:00:01Z"), new Date("2026-01-01T00:00:01Z"));
    const file = path.join(dir, "copy.db");
    const db = openDb(file);
    const ins = db.prepare("INSERT INTO scans (id, created_at, updated_at, image_path) VALUES (?, ?, ?, ?)");
    ins.run(1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "scan-1-0123456789ab.jpg");
    ins.run(2, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "scan-2.jpg");
    ins.run(3, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "scan-3.jpg");
    db.close();
    validateBackupDb(file, { schemaVersion: SCHEMA_VERSION, imageDir: images });
    const check = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(check.prepare("SELECT image_path FROM scans ORDER BY id").all().map((x) => x.image_path),
      ["scan-1-0123456789ab.jpg", "scan-2.jpg", null]);
    check.close();
  });
});

describe("pruneBackups protect", () => {
  test("a pre-restore safety backup never prunes the backup being restored", async () => {
    const f = fixture();
    for (let d = 1; d <= PRE_RESTORE_KEEP; d++) await createBackup(f.db, { dir: f.backups, kind: "pre-restore", now: new Date(2026, 0, d) });
    const oldest = "mtg-planner-20260101-000000-pre-restore.db.gz";
    await createBackup(f.db, { dir: f.backups, kind: "pre-restore", now: new Date(2026, 1, 1), protect: [oldest] });
    assert.ok(listBackups(f.backups).some((b) => b.name === oldest), "the restore source is kept");
    await createBackup(f.db, { dir: f.backups, kind: "pre-restore", now: new Date(2026, 1, 2) });
    assert.equal(listBackups(f.backups).filter((b) => b.kind === "pre-restore").length, PRE_RESTORE_KEEP, "pruned normally afterwards");
  });
});

describe("swapDatabase", () => {
  test("replaces the live file, removes stale -wal/-shm, reopens", async () => {
    const f = fixture();
    await createBackup(f.db, { dir: f.backups, now: new Date(2026, 0, 1) });
    f.db.prepare("DELETE FROM collection").run();
    const tmp = path.join(f.dir, "restore.tmp");
    await gunzipToFile(path.join(f.backups, "mtg-planner-20260101-000000.db.gz"), tmp);
    validateBackupDb(tmp, { schemaVersion: SCHEMA_VERSION });
    let live = f.db;
    live = swapDatabase({ dbFile: f.file, newFile: tmp, close: () => live.close(), open: () => openDb(f.file) });
    assert.equal(dbCounts(live).copies, 5);
    assert.ok(!existsSync(tmp));
    assert.deepEqual(readdirSync(f.dir).filter((x) => x.includes("restore-old")), [], "the old file is removed after success");
    live.close();
  });

  test("a failure after moving the live file aside rolls back to it", async () => {
    const f = fixture();
    await createBackup(f.db, { dir: f.backups, now: new Date(2026, 0, 1) });
    f.db.prepare("INSERT INTO decks (name) VALUES ('Newer')").run();
    const tmp = path.join(f.dir, "restore.tmp");
    await gunzipToFile(path.join(f.backups, "mtg-planner-20260101-000000.db.gz"), tmp);
    let opens = 0;
    let err;
    try {
      swapDatabase({
        dbFile: f.file, newFile: tmp, close: () => f.db.close(),
        open: () => { if (++opens === 1) throw new Error("boom: migration failed"); return openDb(f.file); },
      });
    } catch (e) { err = e; }
    assert.match(err?.message ?? "", /boom/);
    assert.equal(err.rolledBack, true);
    assert.ok(err.db, "the previous database is open again");
    assert.deepEqual(err.db.prepare("SELECT name FROM decks ORDER BY id").all().map((r) => r.name), ["Plan", "Newer"], "current data intact");
    assert.deepEqual(readdirSync(f.dir).filter((x) => x.includes("restore-old")), []);
    err.db.close();
  });

  test("an older-schema (v3) backup is upgraded by the migrations on reopen", async () => {
    const f = fixture();
    // Downgrade a copy to the v3 shape: no binders/manabox_snapshot, no deck status columns.
    const oldFile = path.join(f.dir, "old.db");
    f.db.prepare("VACUUM INTO ?").run(oldFile);
    const old = new DatabaseSync(oldFile);
    old.exec(`DROP TABLE binders; DROP TABLE manabox_snapshot;
      ALTER TABLE decks DROP COLUMN status; ALTER TABLE decks DROP COLUMN manabox_binder; ALTER TABLE decks DROP COLUMN box_binder;
      INSERT INTO decks (name, source) VALUES ('Synced', 'manabox');
      PRAGMA user_version = 3`);
    old.close();
    const gz = path.join(f.dir, "old.db.gz");
    writeFileSync(gz, gzipSync(readFileSync(oldFile)));
    const tmp = path.join(f.dir, "restore.tmp");
    await gunzipToFile(gz, tmp);
    const info = validateBackupDb(tmp, { schemaVersion: SCHEMA_VERSION });
    assert.equal(info.schema_version, 3);
    assert.equal(info.counts.binders, 1, "binders counted from collection names in old schemas");
    let live = f.db;
    live = swapDatabase({ dbFile: f.file, newFile: tmp, close: () => live.close(), open: () => openDb(f.file) });
    assert.equal(live.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    assert.deepEqual(live.prepare("SELECT name FROM binders").all().map((r) => r.name), ["Box"], "binders backfilled (v4)");
    assert.deepEqual(live.prepare("SELECT name, status, manabox_binder FROM decks ORDER BY id").all().map((r) => [r.name, r.status, r.manabox_binder]),
      [["Plan", "idea", null], ["Synced", "built", "Synced"]], "v6/v7 deck columns");
    live.close();
  });
});
