// Record-session storage (lib/debugsessions.js): safe ids and names, JPEG
// check, per-frame / per-session / total caps (507, never pruned),
// records.jsonl, retried frames, list and delete, serialized async writes.
// Offline, temp dir.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DebugError, DebugSessions, SESSION_ID_RE } from "../lib/debugsessions.js";

const jpeg = (n) => { const b = Buffer.alloc(n, 7); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; };
let dir;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-debug-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const status = async (fn) => { try { await fn(); } catch (e) { assert.ok(e instanceof DebugError, e.message); return e.status; } return 0; };

describe("DebugSessions", async () => {
  test("stores frames as <seq>.jpg and records as JSON lines; lists sessions", async () => {
    const s = new DebugSessions({ dir });
    await s.add({ session: "s-1", seq: 0, frame: jpeg(1000), now: Date.parse("2026-10-14T10:00:00Z") });
    await s.add({ session: "s-1", seq: 1, frame: jpeg(1000), record: { kind: "new", d: 0.2 } });
    await s.add({ session: "s-1", seq: 2, record: { kind: "silent" } });
    const files = readdirSync(path.join(dir, "s-1")).sort();
    assert.deepEqual(files, ["0000000.jpg", "0000001.jpg", "records.jsonl", "session.json"]);
    const lines = readFileSync(path.join(dir, "s-1", "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.seq, l.record.kind]), [[1, "new"], [2, "silent"]]);
    const [row] = (await s.list());
    assert.equal(row.id, "s-1");
    assert.equal(row.frames, 2);
    assert.equal(row.started_at, "2026-10-14T10:00:00.000Z");
    // a fresh instance sums the same from disk
    const again = (await new DebugSessions({ dir }).list())[0];
    assert.deepEqual(again, row);
  });

  test("validates ids, seq, JPEG magic and sizes", async () => {
    const s = new DebugSessions({ dir });
    for (const id of ["", "../x", "a/b", "a.b", "x".repeat(41), "..", 5, null]) {
      assert.equal(await status(() => s.add({ session: id, seq: 0, frame: jpeg(100) })), 400, String(id));
    }
    assert.ok(SESSION_ID_RE.test("A-z-09"));
    assert.equal(await status(() => s.add({ session: "a", seq: -1, frame: jpeg(100) })), 400);
    assert.equal(await status(() => s.add({ session: "a", seq: 1.5, frame: jpeg(100) })), 400);
    assert.equal(await status(() => s.add({ session: "a", seq: "1", frame: jpeg(100) })), 400);
    assert.equal(await status(() => s.add({ session: "a", seq: 0, frame: Buffer.from("not a jpeg at all") })), 400);
    assert.equal(await status(() => s.add({ session: "a", seq: 0 })), 400, "frame or record required");
    assert.equal(await status(() => s.add({ session: "a", seq: 0, frame: jpeg(300 * 1024 + 1) })), 413);
    assert.equal(await status(() => s.add({ session: "a", seq: 0, record: { x: "y".repeat(20000) } })), 413);
    assert.equal(existsSync(path.join(dir, "a")), false, "nothing written for rejected uploads");
    assert.equal(await status(() => s.delete("../etc")), 400);
  });

  test("a retried frame (same seq) is ignored, not counted twice", async () => {
    const s = new DebugSessions({ dir });
    assert.equal((await s.add({ session: "r", seq: 3, frame: jpeg(500) })).stored, true);
    assert.equal((await s.add({ session: "r", seq: 3, frame: jpeg(900) })).stored, false);
    assert.equal((await s.list())[0].frames, 1);
    assert.equal(readFileSync(path.join(dir, "r", "0000003.jpg")).length, 500);
  });

  test("per-session cap refuses; a full store refuses too and never prunes a recording", async () => {
    const s = new DebugSessions({ dir, limits: { sessionBytes: 5000, totalBytes: 8000 } });
    let t = Date.parse("2026-10-14T10:00:00Z");
    await s.add({ session: "old", seq: 0, frame: jpeg(3000), now: t });
    await s.add({ session: "mid", seq: 0, frame: jpeg(3000), now: (t += 1000) });
    assert.equal(await status(() => s.add({ session: "mid", seq: 1, frame: jpeg(3000) })), 413, "session full");
    assert.equal(await status(() => s.add({ session: "new", seq: 0, frame: jpeg(3000), now: (t += 1000) })), 507);
    assert.deepEqual((await s.list()).map((x) => x.id), ["mid", "old"]);
    assert.equal(existsSync(path.join(dir, "old")), true, "the oldest recording is kept");
    assert.equal(existsSync(path.join(dir, "new")), false);
    // The user deletes one: room again.
    assert.equal(await s.delete("old"), true);
    assert.equal((await s.add({ session: "new", seq: 0, frame: jpeg(3000), now: t })).stored, true);
  });

  test("concurrent uploads are serialized: sizes stay exact", async () => {
    const s = new DebugSessions({ dir });
    await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((seq) => s.add({ session: "c", seq, frame: jpeg(1000), record: { seq } })));
    const fresh = (await new DebugSessions({ dir }).list())[0];
    assert.deepEqual((await s.list())[0], fresh);
    assert.equal(fresh.frames, 8);
  });

  test("delete removes the directory; unknown sessions report false", async () => {
    const s = new DebugSessions({ dir });
    await s.add({ session: "gone", seq: 0, frame: jpeg(100) });
    assert.equal(await s.delete("gone"), true);
    assert.equal(existsSync(path.join(dir, "gone")), false);
    assert.equal(await s.delete("gone"), false);
    assert.deepEqual((await s.list()), []);
  });
});
