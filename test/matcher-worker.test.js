// The scanner's fingerprint matcher off the event loop: denormalized
// fingerprint metadata (migration + backfill, load without the printings
// join), MatcherWorker request/response, the bounded warm-up wait in
// identify(), shutdown, and the server's /healthz + SIGTERM handling.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fingerprintMetaPending, getMeta, indexBrief, indexStatus, openIndex, refreshIndex, syncFingerprintMeta, warmIndex } from "../lib/cardindex.js";
import { Matcher, MatcherWorker, buildFingerprints, buildFingerprintsInWorker, decodeJpeg, encodeJpeg, hasCjpeg, hasDjpeg, hashQuery, rotate180 } from "../lib/fingerprint.js";
import { identify, identifyOriented, DEFAULT_THRESHOLDS } from "../lib/scanner.js";
import { nameSimilarity } from "../lib/ocr.js";
import { startServer } from "./helpers/server.js";

// Seeded procedural "card" (as in fingerprint.test.js).
function synth(seed, w = 146, h = 204) {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const data = new Uint8Array(w * h * 3);
  const bg = [rnd() * 255, rnd() * 255, rnd() * 255];
  const shapes = Array.from({ length: 14 }, () => ({
    x0: rnd() * w, y0: rnd() * h, rx: 8 + rnd() * w / 3, ry: 8 + rnd() * h / 3, c: [rnd() * 255, rnd() * 255, rnd() * 255], e: rnd() < 0.5,
  }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = bg;
      for (const sh of shapes) {
        const dx = (x - sh.x0) / sh.rx, dy = (y - sh.y0) / sh.ry;
        if (sh.e ? dx * dx + dy * dy < 1 : Math.abs(dx) < 1 && Math.abs(dy) < 1) c = sh.c;
      }
      const shade = 60 * (x / w) - 50 * (y / h);
      data.set(c.map((v) => Math.max(0, Math.min(255, Math.round(v * 0.7 + shade + 40)))), (y * w + x) * 3);
    }
  }
  return { width: w, height: h, channels: 3, data };
}

const ID = (i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
const URL_OF = (i) => `https://cards.scryfall.io/small/front/0/0/${ID(i)}.jpg`;
const cardRow = (i, o = {}) => ({
  object: "card", id: ID(i), oracle_id: `o${i}`, name: `Card ${i}`, lang: "en", set: "aaa", collector_number: String(i),
  games: ["paper"], released_at: "2024-01-01", finishes: ["nonfoil"], illustration_id: `ill${i}`, frame: "2015",
  border_color: "black", frame_effects: [], image_status: "highres_scan", image_uris: { small: URL_OF(i), normal: URL_OF(i) }, ...o,
});
const CARDS = [cardRow(1), cardRow(2), cardRow(3), cardRow(4), cardRow(5, { lang: "de", oracle_id: "o1", name: "Card 1", illustration_id: "ill1" })];
const seedOf = (url) => Number(/0*(\d+)\.jpg/.exec(url)[1]);
const fpOpts = { sets: [], keepImages: false, fetchImage: async (url) => Buffer.from(url), decode: async (buf) => synth(seedOf(buf.toString())) };

let dir;
async function makeIndex(name, cards = CARDS) {
  const file = path.join(dir, `${name}.db`);
  const src = path.join(dir, `${name}.jsonl.gz`);
  writeFileSync(src, gzipSync(cards.map((c) => JSON.stringify(c)).join("\n")));
  const idx = openIndex(file);
  await refreshIndex(idx, { source: src, setsSource: [] });
  await buildFingerprints(idx, fpOpts);
  return { idx, file, src };
}

// Turn an index back into the pre-denormalization schema (fingerprints without oracle_id/name).
function downgrade(idx) {
  idx.exec("DROP INDEX fingerprints_meta_pending; ALTER TABLE fingerprints DROP COLUMN name; ALTER TABLE fingerprints DROP COLUMN oracle_id");
}

before(() => { dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-matcher-")); });
after(() => rmSync(dir, { recursive: true, force: true }));

describe("denormalized fingerprint metadata", () => {
  test("new fingerprints carry oracle_id and name; Matcher.load reads no printings", async () => {
    const { idx } = await makeIndex("fresh");
    const rows = idx.prepare("SELECT printing_id, oracle_id, name FROM fingerprints ORDER BY printing_id").all();
    assert.equal(rows.length, 4, "one group per illustration (the de copy maps to Card 1)");
    assert.deepEqual(rows.map((r) => [r.oracle_id, r.name]), [["o1", "Card 1"], ["o2", "Card 2"], ["o3", "Card 3"], ["o4", "Card 4"]]);
    assert.equal(fingerprintMetaPending(idx), false);
    // Without the printings table a join would fail; the load must not need it.
    idx.exec("ALTER TABLE printings RENAME TO printings_away");
    try {
      const m = new Matcher(idx);
      assert.equal(m.load(), 4);
      assert.ok(m.loadMs >= 0);
      const res = m.match(hashQuery(synth(2)), { topK: 3 });
      assert.equal(res[0].printing_id, ID(2));
      assert.equal(res[0].name, "Card 2");
      assert.equal(res[0].oracle_id, "o2");
    } finally {
      idx.exec("ALTER TABLE printings_away RENAME TO printings");
      idx.close();
    }
  });

  test("migration adds the columns; the backfill fills them in batches, idempotently; refresh keeps them current", async () => {
    const { idx, file } = await makeIndex("old");
    downgrade(idx);
    idx.prepare("INSERT INTO fingerprints(key, face, printing_id, hash) VALUES ('gone|x', 0, 'no-such-printing', ?)").run(Buffer.alloc(88));
    idx.close();

    const i2 = openIndex(file); // migrates
    const cols = i2.prepare("PRAGMA table_info(fingerprints)").all().map((c) => c.name);
    assert.ok(cols.includes("oracle_id") && cols.includes("name"));
    assert.equal(fingerprintMetaPending(i2), true);
    const m = new Matcher(i2);
    m.load();
    assert.equal(m.meta.find((x) => x.printing_id === ID(1)).name, null, "not backfilled yet");

    const gen0 = getMeta(i2, "fp_generation");
    const r = await syncFingerprintMeta(i2, { batch: 2 });
    assert.equal(r.updated, 5);
    assert.equal(fingerprintMetaPending(i2), false);
    assert.notEqual(getMeta(i2, "fp_generation"), gen0, "matchers reload");
    const byId = Object.fromEntries(i2.prepare("SELECT printing_id, oracle_id, name FROM fingerprints").all().map((x) => [x.printing_id, x]));
    assert.equal(byId[ID(3)].name, "Card 3");
    assert.equal(byId[ID(3)].oracle_id, "o3");
    assert.equal(byId["no-such-printing"].name, "", "a vanished printing is marked, not retried forever");
    assert.equal((await syncFingerprintMeta(i2)).updated, 0, "idempotent");
    const i3 = openIndex(file);
    assert.equal(i3.prepare("PRAGMA table_info(fingerprints)").all().length, cols.length, "re-open does not migrate again");
    i3.close();

    // A refresh that renames a card updates its fingerprint copy.
    const src = path.join(dir, "old-renamed.jsonl.gz");
    writeFileSync(src, gzipSync(CARDS.map((c) => JSON.stringify(c.id === ID(3) ? { ...c, name: "Card Three" } : c)).join("\n")));
    await refreshIndex(i2, { source: src, setsSource: [] });
    assert.equal(i2.prepare("SELECT name FROM fingerprints WHERE printing_id = ?").get(ID(3)).name, "Card Three");
    const warm = await warmIndex(file);
    assert.ok(warm.ms >= 0 && warm.bytes > 0, JSON.stringify(warm));
    const ac = new AbortController();
    ac.abort();
    assert.equal((await warmIndex(file, { signal: ac.signal })).aborted, true);
    i2.close();
  });
});

describe("MatcherWorker", () => {
  let idx, file;
  before(async () => { ({ idx, file } = await makeIndex("worker")); });
  after(() => { try { idx.close(); } catch { /* closed */ } });

  test("requests and responses match the in-process Matcher", async () => {
    const w = new MatcherWorker(file, { warm: true }).start();
    try {
      assert.equal(await w.whenReady(10000), true);
      const st = w.status();
      assert.equal(st.state, "ready");
      assert.equal(st.size, 4);
      assert.ok(st.load_ms >= 0 && st.ready_ms >= 0);

      const local = new Matcher(idx);
      local.load();
      const q = hashQuery(synth(2));
      const [a, b] = [await w.match(q, { topK: 3 }), local.match(q, { topK: 3 })];
      assert.deepEqual(a.map((r) => [r.printing_id, r.name, r.score, r.printing_ids.sort()]), b.map((r) => [r.printing_id, r.name, r.score, r.printing_ids.sort()]));
      assert.equal(a.bestOther, b.bestOther, "bestOther survives the message");
      assert.equal(w.nameGap(a), local.nameGap(b));

      const sc = await w.scorePrintings(hashQuery(synth(1)), [ID(1), ID(5), "missing"]);
      assert.equal(sc.get(ID(1)).score, 0);
      assert.equal(sc.get(ID(5)).score, 0, "mapped printing scores via its group");
      assert.equal(sc.has("missing"), false);

      assert.equal((await w.indexCall("getPrinting", [ID(3)])).name, "Card 3");
      assert.equal((await w.indexCall("searchTitle", ["Card 4", { limit: 1 }]))[0].id, ID(4));
      await assert.rejects(w.indexCall("setMeta", ["x", "y"]), /not allowed/);

      // The worker reloads when the fingerprint job bumps the generation.
      idx.prepare("DELETE FROM fingerprints WHERE printing_id = ?").run(ID(4));
      idx.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('fp_generation', 'changed')").run();
      await w.match(q);
      assert.equal(w.size, 3);
      await buildFingerprints(idx, fpOpts);

      // Page-cache warm-up ran in its own worker.
      for (let i = 0; i < 100 && w.status().warm?.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(w.status().warm?.state, "done");
    } finally {
      await w.close();
    }
  });

  test("the worker backfills a migrated index before it reports ready", async () => {
    const { idx: i2, file: f2 } = await makeIndex("worker-backfill");
    downgrade(i2);
    i2.close();
    const keep = openIndex(f2); // migrated, values still missing; also keeps the WAL files the read-only connection needs
    assert.equal(fingerprintMetaPending(keep), true);
    const w = new MatcherWorker(f2, { warm: false }).start();
    try {
      assert.equal(await w.whenReady(10000), true);
      assert.equal(w.status().backfill.updated, 4);
      assert.equal(fingerprintMetaPending(keep), false);
      const res = await w.match(hashQuery(synth(3)), { topK: 1 });
      assert.equal(res[0].name, "Card 3", "loaded after the backfill");
    } finally {
      await w.close();
      keep.close();
    }
  });

  test("a scan waits for the warm-up (bounded), then goes on without the fingerprint", async () => {
    const ocr = {
      readCollectorLine: async () => null,
      readTitle: async () => ({ text: "Card 3", confidence: 90 }),
      nameSimilarity,
    };
    const ctx = (matcher) => ({ db: null, idx, matcher, claude: null, ocr, thresholds: DEFAULT_THRESHOLDS });
    const input = { card: Buffer.from([0xff, 0xd8, 1, 2, 3]), strip: null, settings: { storageLang: "en", foil: "auto" } };

    const slow = new MatcherWorker(file, { waitMs: 300, warm: false, workerData: { startDelayMs: 3000 } }).start();
    try {
      const t0 = Date.now();
      const r = await identify(ctx(slow), input);
      const ms = Date.now() - t0;
      assert.ok(ms >= 250 && ms < 2500, `waited ${ms} ms`);
      assert.ok(r.features.errors.some((e) => /warming up/.test(e)), r.features.errors.join("; "));
      assert.equal(r.features.fingerprint, null, "no fingerprint");
      assert.equal(r.printing?.id, ID(3), "the title still identifies the card");
      assert.equal(slow.status().state, "loading");
    } finally {
      await slow.close();
    }

    // A warm-up shorter than the wait: the scan just waits for it.
    const late = new MatcherWorker(file, { waitMs: 10000, warm: false, workerData: { startDelayMs: 400 } }).start();
    try {
      const t0 = Date.now();
      assert.equal(await late.whenReady(), true);
      assert.ok(Date.now() - t0 >= 350);
      if (hasDjpeg() && !spawnSync("cjpeg", ["-version"], { stdio: "ignore" }).error) {
        const img = synth(3, 292, 408);
        const ppm = Buffer.concat([Buffer.from(`P6\n${img.width} ${img.height}\n255\n`), Buffer.from(img.data)]);
        const jpg = spawnSync("cjpeg", ["-quality", "95"], { input: ppm }).stdout;
        const r = await identify(ctx(late), { ...input, card: jpg });
        assert.equal(r.features.fingerprint?.top?.[0]?.printing_id, ID(3));
      }
    } finally {
      await late.close();
    }
  });

  test("upside-down card: the worker hashes the turned pixels; identifyOriented finds the card", { skip: !(hasDjpeg() && hasCjpeg()) && "djpeg/cjpeg not installed" }, async () => {
    const jpg = await encodeJpeg(rotate180(synth(3, 292, 408)), { quality: 95 });
    // Title OCR stub: reads the card only from the turned PGM the retry hands it.
    const ocr = {
      readCollectorLine: async () => null,
      readTitle: async (buf) => ({ text: buf[0] === 0x50 ? "Card 3" : "", confidence: 0.9 }),
      nameSimilarity,
    };
    const w = new MatcherWorker(file, { warm: false }).start();
    try {
      assert.equal(await w.whenReady(10000), true);
      const turned = await w.hashImage(jpg, { rotate: 180 });
      const local = hashQuery(rotate180(await decodeJpeg(jpg)));
      assert.deepEqual(turned.map((h) => h.toString("hex")), local.map((h) => h.toString("hex")), "same hashes as in-process");
      const ctx = { db: null, idx, matcher: w, claude: null, ocr, thresholds: DEFAULT_THRESHOLDS };
      const input = { card: jpg, strip: null, settings: { storageLang: "en", foil: "auto" } };
      const plain = await identify(ctx, input);
      assert.notEqual(plain.printing?.id, ID(3), "as photographed, nothing names it");
      const r = await identifyOriented(ctx, input);
      assert.equal(r.printing?.id, ID(3));
      assert.equal(r.features.rotation, 180);
      assert.equal(r.features.strip_used, "card_top");
      assert.ok(r.features.fingerprint.d1 < 0.1, `d1 ${r.features.fingerprint.d1}`);
      const back = await decodeJpeg(r.upright.card);
      assert.deepEqual([back.width, back.height], [292, 408]);
      assert.equal((await w.hashImage(r.upright.card)).length, 27);
      // A precise capture's 9 variants: the same hashes as in-process.
      const nine = await w.hashImage(r.upright.card, { variants: 9 });
      const nineLocal = hashQuery(await decodeJpeg(r.upright.card), { variants: 9 });
      assert.deepEqual(nine.map((h) => h.toString("hex")), nineLocal.map((h) => h.toString("hex")));
      const again = await w.match(await w.hashImage(r.upright.card), { topK: 1 });
      assert.equal(again[0].printing_id, ID(3), "the stored photo is upright");
    } finally {
      await w.close();
    }
  });

  test("close() terminates the worker and rejects pending requests", async () => {
    const w = new MatcherWorker(file, { warm: false }).start();
    assert.equal(await w.whenReady(10000), true);
    const pending = w.match(hashQuery(synth(1)));
    const closing = w.close();
    await assert.rejects(pending, /closed/);
    await closing;
    assert.equal(w.status().state, "closed");
    assert.equal(w.running, false);
    assert.equal(await w.whenReady(100), false);
    await assert.rejects(w.indexCall("getPrinting", [ID(1)]), /closed/);
  });
});

describe("off the event loop: respawn, fingerprint job, cancelled scans", () => {
  let idx, file;
  before(async () => { ({ idx, file } = await makeIndex("respawn")); });
  after(() => { try { idx.close(); } catch { /* closed */ } });

  test("a crashed worker respawns on its own; lookups wait for it; it gives up after MAX_FAILURES", async () => {
    const w = new MatcherWorker(file, { warm: false, restartMs: 100 }).start();
    try {
      assert.equal(await w.whenReady(10000), true);
      await w.worker.terminate(); // crash: not via close()
      for (let i = 0; i < 50 && w.state !== "error"; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(w.state, "error");
      assert.equal(w.running, false);
      assert.equal(w.available, true, "a respawn is pending");
      assert.equal(await w.whenRunning(5000), true, "respawned without a scan asking");
      assert.equal((await w.indexCall("getPrinting", [ID(2)])).name, "Card 2");
      assert.equal(await w.whenReady(10000), true);
      assert.equal(w.failures, 0, "ready resets the failure count");
      // A per-call error is thrown, not hidden (the server never re-runs it in-process).
      await assert.rejects(w.indexCall("printingsOf", [{ bad: Symbol.for("x") }]));

      w.failures = MatcherWorker.MAX_FAILURES - 1;
      await w.worker.terminate();
      for (let i = 0; i < 50 && w.state !== "error"; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(w.available, false, "gave up: the server falls back to in-process lookups");
      assert.equal(await w.whenRunning(200), false);
    } finally {
      await w.close();
    }
    assert.equal(w.available, false);
  });

  test("indexBrief: the main thread's index summary without COUNT(*)s", () => {
    const full = indexStatus(idx);
    const brief = indexBrief(idx);
    assert.equal(brief.printings, 1);
    assert.equal(brief.last_refresh, full.last_refresh);
    assert.deepEqual(brief.fingerprint_job, full.fingerprint_job);
    assert.equal("fingerprints" in brief, false);
    const empty = openIndex(":memory:");
    assert.equal(indexBrief(empty).printings, 0);
    empty.close();
  });

  test("buildFingerprintsInWorker runs the whole job on its own connection", async () => {
    // A stale group (no printing maps to it) and a non-card group under the old key scheme.
    const ins = idx.prepare("INSERT INTO fingerprints(key, illustration_id, face, frame, printing_id, hash, oracle_id, name) SELECT ?, illustration_id, face, frame, printing_id, hash, oracle_id, name FROM fingerprints LIMIT 1");
    ins.run("stale|key");
    const before = idx.prepare("SELECT COUNT(*) n FROM fingerprints").get().n;
    const gen = getMeta(idx, "fp_generation");
    const progress = [];
    const job = await buildFingerprintsInWorker(file, { sets: [], keepImages: false, onProgress: (p) => progress.push(p.phase) });
    assert.equal(job.state, "done");
    assert.equal(job.total, 4);
    assert.equal(job.done, 4);
    assert.equal(job.fetched, 0, "everything was hashed already");
    assert.ok(progress.includes("hash"));
    assert.equal(idx.prepare("SELECT COUNT(*) n FROM fingerprints").get().n, before - 1, "stale group deleted in the worker");
    assert.notEqual(getMeta(idx, "fp_generation"), gen);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(buildFingerprintsInWorker(file, { signal: ac.signal }));
  });

  test("a cancelled scan skips or aborts the Claude fallback", async () => {
    const ocr = { readCollectorLine: async () => null, readTitle: async () => null, nameSimilarity };
    const cap = { enabled: () => true, take: () => true, release: () => {} };
    let seen = null;
    const runVision = ({ signal }) => new Promise((resolve) => {
      seen = signal;
      signal.addEventListener("abort", () => resolve({ error: "Cancelled", json: null }), { once: true });
    });
    const input = { card: Buffer.from([0xff, 0xd8, 1, 2, 3]), strip: null, settings: { storageLang: "en", foil: "auto" } };
    const ctx = (signal) => ({ db: null, idx, matcher: null, signal, claude: { runVision, cap }, ocr, thresholds: DEFAULT_THRESHOLDS });

    const gone = new AbortController();
    gone.abort();
    let r = await identify(ctx(gone.signal), input);
    assert.equal(r.features.claude?.skipped, "cancelled");
    assert.equal(seen, null, "no Claude call for a client that left");

    const leaving = new AbortController();
    const p = identify(ctx(leaving.signal), input);
    for (let i = 0; i < 100 && !seen; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(seen, leaving.signal, "runVision gets the request's signal");
    leaving.abort();
    r = await p;
    assert.equal(r.features.claude?.error, "Cancelled");
  });
});

describe("server: matcher preload, /healthz and shutdown", () => {
  test("resumes an unfinished fingerprint job in a worker; progress reaches /api/index/status", async () => {
    const { idx, file } = await makeIndex("server-job");
    const job = JSON.parse(getMeta(idx, "fingerprint_job"));
    idx.prepare("UPDATE meta SET value = ? WHERE key = 'fingerprint_job'").run(JSON.stringify({ ...job, state: "paused" }));
    idx.close();
    // SCAN_AUTO_INDEX as inherited (default on): the paused job must resume at boot.
    const srv = await startServer({
      name: "matcher-job",
      env: { INDEX_DB_FILE: file, SCAN_AUTO_INDEX: process.env.SCAN_AUTO_INDEX, FP_KEEP_IMAGES: "false", FP_INDEX_SETS: "" },
    });
    const { base, proc } = srv;
    const exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
    try {
      let st = null;
      for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
        try { st = await (await fetch(`${base}/api/index/status`)).json(); } catch { /* starting */ }
        if (st?.last_job) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(st?.last_job?.kind, "fingerprints", srv.log());
      assert.equal(st.last_job.ok, true, srv.log());
      assert.equal(st.last_job.result.state, "done");
      assert.equal(st.fingerprint_job.state, "done");
      assert.match(srv.log(), /fingerprints job finished/);
      proc.kill("SIGTERM");
      assert.equal(await exited, 0, srv.log());
    } finally {
      await srv.stop();
    }
  });

  test("reports scanner.matcher loading → ready and exits cleanly on SIGTERM", async () => {
    const { idx, file } = await makeIndex("server");
    idx.close();
    const srv = await startServer({ name: "matcher", env: { INDEX_DB_FILE: file } });
    const { base, proc } = srv;
    const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
    try {
      let matcher = null;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          const h = await (await fetch(`${base}/healthz`)).json();
          matcher = h.scanner?.matcher;
          assert.ok(["idle", "loading", "ready"].includes(matcher?.state), JSON.stringify(matcher));
          if (matcher.state === "ready") break;
        } catch (err) { if (err.code === "ERR_ASSERTION") throw err; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(matcher?.state, "ready", srv.log());
      assert.equal(matcher.size, 4);
      assert.ok(matcher.load_ms >= 0);
      const t0 = Date.now();
      proc.kill("SIGTERM");
      const { code } = await exited;
      assert.equal(code, 0, srv.log());
      assert.ok(Date.now() - t0 < 5000);
      assert.match(srv.log(), /matcher ready: 4 fingerprints/);
    } finally {
      await srv.stop();
    }
  });
});
