// HTTP layer of the backup routes (server.js): create/list/download/delete,
// strict names, restore from a stored backup and from an upload (confirm,
// content type, validation failures leave the data alone), the pre-restore
// safety backup, and the CSRF guard. Real server on a free port, temp DB.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { SCHEMA_VERSION, openDb } from "../lib/db.js";
import { ID, seedCards } from "./fixtures.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let dir, proc, base, backupDir, dbFile;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-backup-api-"));
  dbFile = path.join(dir, "app.db");
  backupDir = path.join(dir, "bk");
  const db = openDb(dbFile);
  seedCards(db);
  db.prepare("INSERT INTO collection (scryfall_id, binder, quantity, source) VALUES (?, 'Box', 3, 'manabox')").run(ID.sol);
  db.prepare("INSERT INTO binders (name, origin) VALUES ('Box', 'manabox')").run();
  db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
      BACKUP_DIR: backupDir, BACKUP_KEEP: "3", SCAN_IMAGE_DIR: path.join(dir, "scans"),
      SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", CLAUDE_CODE_OAUTH_TOKEN: "", APP_VERSION: "9.9.9-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  proc?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

async function call(method, p, json, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers["Content-Type"] ??= "application/json"; }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
const upload = (buf, query = "?confirm=1", type = "application/gzip") =>
  fetch(`${base}/api/backups/restore-upload${query}`, { method: "POST", body: buf, headers: { "Content-Type": type } })
    .then(async (res) => ({ status: res.status, body: await res.json() }));
const binderNames = async () => (await call("GET", "/api/binders")).body.binders.map((b) => b.name);
const copies = async () => (await call("GET", "/api/stats")).body.total_cards;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("backup API", () => {
  let first;

  test("POST /api/backups creates one (201 manifest), GET lists it newest first", async () => {
    let r = await call("GET", "/api/backups");
    assert.deepEqual(r.body, { backups: [], keep: 3 });
    r = await call("POST", "/api/backups");
    assert.equal(r.status, 201);
    first = r.body;
    assert.match(first.name, /^mtg-planner-\d{8}-\d{6}\.db\.gz$/);
    assert.equal(first.kind, "manual");
    assert.equal(first.app_version, "9.9.9-test");
    assert.equal(first.schema_version, SCHEMA_VERSION);
    assert.deepEqual(first.counts, { copies: 3, printings: 1, decks: 0, binders: 1, scans: 0, chats: 0 });
    assert.ok(first.size > 0);
    r = await call("GET", "/api/backups");
    assert.deepEqual(r.body.backups.map((b) => b.name), [first.name]);
    assert.equal(r.body.backups[0].size, first.size);
  });

  test("retention keeps BACKUP_KEEP manual backups", async () => {
    for (let i = 0; i < 3; i++) { await wait(1000); assert.equal((await call("POST", "/api/backups")).status, 201); }
    const names = (await call("GET", "/api/backups")).body.backups.map((b) => b.name);
    assert.equal(names.length, 3);
    assert.ok(!names.includes(first.name), "the oldest one was pruned");
    first = (await call("GET", "/api/backups")).body.backups[0];
  });

  test("download: attachment, gzip of a SQLite database", async () => {
    const res = await fetch(`${base}/api/backups/${first.name}/download`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/gzip");
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="${first.name}"`);
    const raw = gunzipSync(Buffer.from(await res.arrayBuffer()));
    assert.equal(raw.subarray(0, 15).toString("latin1"), "SQLite format 3");
  });

  test("names are validated strictly (400), unknown valid names are 404, no traversal", async () => {
    for (const bad of ["..%2Fapp.db", "..%2F..%2Fetc%2Fpasswd", "app.db", "mtg-planner-20261014-120000.json", "mtg-planner-20261014-120000.db.gz%00"]) {
      assert.equal((await call("GET", `/api/backups/${bad}/download`)).status, 400, bad);
      assert.equal((await call("DELETE", `/api/backups/${bad}`)).status, 400, bad);
      assert.equal((await call("POST", `/api/backups/${bad}/restore`, { confirm: true })).status, 400, bad);
    }
    // A dot-segment is resolved by the URL parser before routing: never a file.
    assert.equal((await call("GET", "/api/backups/%2E%2E/download")).status, 404);
    assert.equal((await call("GET", "/api/backups/mtg-planner-20000101-000000.db.gz/download")).status, 404);
    assert.equal((await call("POST", "/api/backups/mtg-planner-20000101-000000.db.gz/restore", { confirm: true })).status, 404);
  });

  test("CSRF / content-type guards", async () => {
    assert.equal((await call("POST", "/api/backups", undefined, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await call("POST", `/api/backups/${first.name}/restore`, { confirm: true }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await call("POST", `/api/backups/${first.name}/restore`, { confirm: true }, { "Content-Type": "text/plain" })).status, 415);
    const r = await upload(gzipSync(Buffer.from("x")), "?confirm=1", "text/plain");
    assert.equal(r.status, 415);
  });

  test("restore from a stored backup: needs confirm, takes a safety backup, brings the data back", async () => {
    assert.equal((await call("POST", "/api/binders", { name: "After" })).status, 201);
    assert.deepEqual(await binderNames(), ["After", "Box"]);
    let r = await call("POST", `/api/backups/${first.name}/restore`, {});
    assert.equal(r.status, 400);
    assert.match(r.body.error, /confirm/);
    assert.deepEqual(await binderNames(), ["After", "Box"], "nothing changed without confirm");

    r = await call("POST", `/api/backups/${first.name}/restore`, { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.restored.name, first.name);
    assert.equal(r.body.restored.backup.name, first.name);
    assert.deepEqual(r.body.restored.counts, first.counts);
    assert.equal(r.body.safety_backup.kind, "pre-restore");
    assert.match(r.body.safety_backup.name, /-pre-restore\.db\.gz$/);
    assert.equal(r.body.safety_backup.counts.binders, 2, "the safety backup has the state before the restore");
    assert.deepEqual(await binderNames(), ["Box"]);
    // The app keeps working on the restored DB (writes too).
    assert.equal((await call("POST", "/api/binders", { name: "Later" })).status, 201);
    const list = (await call("GET", "/api/backups")).body.backups;
    assert.ok(list.some((b) => b.kind === "pre-restore"));
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes("restore")), [], "no temp/aside files left");
  });

  test("restore from an uploaded file (an older-schema backup is migrated)", async () => {
    // Build a v6-schema copy with different content.
    const oldFile = path.join(dir, "upload-src.db");
    const db = openDb(oldFile);
    seedCards(db);
    db.prepare("INSERT INTO collection (scryfall_id, binder, quantity, source) VALUES (?, 'Uploaded', 7, 'app')").run(ID.lightning);
    db.prepare("INSERT INTO binders (name) VALUES ('Uploaded')").run();
    db.exec("ALTER TABLE decks DROP COLUMN manabox_binder; ALTER TABLE decks DROP COLUMN box_binder; PRAGMA user_version = 6; PRAGMA journal_mode = DELETE");
    db.close();
    const gz = gzipSync(readFileSync(oldFile));

    assert.equal((await upload(gz, "")).status, 400, "confirm required");
    // Confirmed by header instead of query, sent as octet-stream.
    const res = await fetch(`${base}/api/backups/restore-upload`, {
      method: "POST", body: gz, headers: { "Content-Type": "application/octet-stream", "X-Confirm-Restore": "1" },
    });
    const r = { status: res.status, body: await res.json() };
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.restored.source, "upload");
    assert.equal(r.body.restored.schema_version_before_upgrade, 6);
    assert.equal(r.body.restored.schema_version, SCHEMA_VERSION);
    assert.deepEqual(await binderNames(), ["Uploaded"]);
    assert.equal(await copies(), 7);
  });

  test("the combo-check opt-out survives restoring a backup without (or with an enabled) Spellbook setting", async () => {
    let s = (await call("PATCH", "/api/settings", { spellbook_enabled: false })).body;
    assert.equal(s.spellbook_enabled, false);
    for (const stored of [null, { enabled: true }]) {
      const src = path.join(dir, `sb-src-${stored ? "on" : "none"}.db`);
      const db = openDb(src);
      seedCards(db);
      if (stored) db.prepare("INSERT INTO meta (key, value) VALUES ('spellbook_settings', ?)").run(JSON.stringify(stored));
      db.exec("PRAGMA journal_mode = DELETE");
      db.close();
      const r = await upload(gzipSync(readFileSync(src)));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      s = (await call("GET", "/api/settings")).body;
      assert.equal(s.spellbook_enabled, false, `stored ${JSON.stringify(stored)}`);
    }
  });

  test("invalid uploads are refused with 400 and the current data stays", async () => {
    const before = await copies();
    const cases = [
      [Buffer.from("not gzip at all"), /gzip/],
      [gzipSync(Buffer.from("hello, not a database".repeat(20))), /not an mtg-planner database/],
    ];
    const foreign = path.join(dir, "foreign.db");
    const f = new DatabaseSync(foreign);
    f.exec("CREATE TABLE notes (x); PRAGMA journal_mode = DELETE");
    f.close();
    cases.push([gzipSync(readFileSync(foreign)), /missing tables/]);
    const newer = path.join(dir, "newer.db");
    const n = openDb(newer);
    n.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}; PRAGMA journal_mode = DELETE`);
    n.close();
    cases.push([gzipSync(readFileSync(newer)), /newer mtg-planner/]);
    for (const [buf, re] of cases) {
      const r = await upload(buf);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, re);
    }
    assert.equal(await copies(), before);
    assert.equal((await upload(Buffer.alloc(0))).status, 400);
    assert.deepEqual(readdirSync(dir).filter((x) => x.includes(".restore-")), [], "temp files removed");
  });

  test("restoring the oldest pre-restore backup does not prune it away", async () => {
    const src = (await call("GET", "/api/backups")).body.backups.find((b) => b.kind === "manual");
    const gz = readFileSync(path.join(backupDir, src.name));
    for (const f of readdirSync(backupDir).filter((x) => x.includes("-pre-restore"))) rmSync(path.join(backupDir, f));
    for (let d = 1; d <= 5; d++) {
      const name = `mtg-planner-2025010${d}-000000-pre-restore.db.gz`;
      writeFileSync(path.join(backupDir, name), gz);
      writeFileSync(path.join(backupDir, name.replace(/\.db\.gz$/, ".json")),
        JSON.stringify({ ...src, name, kind: "pre-restore", created_at: `2025-01-0${d}T00:00:00.000Z` }));
    }
    const oldest = "mtg-planner-20250101-000000-pre-restore.db.gz";
    const r = await call("POST", `/api/backups/${oldest}/restore`, { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const names = (await call("GET", "/api/backups")).body.backups.map((b) => b.name);
    assert.ok(names.includes(oldest), "the restored backup is still listed");
  });

  test("DELETE removes a backup (204), then 404", async () => {
    const name = (await call("GET", "/api/backups")).body.backups.find((b) => b.kind === "manual").name;
    assert.equal((await call("DELETE", `/api/backups/${name}`)).status, 204);
    assert.equal((await call("DELETE", `/api/backups/${name}`)).status, 404);
    assert.ok(!(await call("GET", "/api/backups")).body.backups.some((b) => b.name === name));
    writeFileSync(path.join(backupDir, "unrelated.txt"), "x");
    assert.equal((await call("DELETE", "/api/backups/unrelated.txt")).status, 400);
  });
});
