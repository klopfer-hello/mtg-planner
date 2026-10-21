// Card fingerprints: PNM parsing, area resampling, dHash layout, matcher and
// the background build job (image fetch and JPEG decode are stubbed). The
// djpeg round trip runs only where libjpeg-turbo-progs is installed.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { openIndex, refreshIndex, indexStatus } from "../lib/cardindex.js";
import {
  FP_BYTES, Matcher, areaResample, buildFingerprints, checkJpegSize, cropRows, decodeJpeg, encodeJpeg, fetchImage, fingerprintKey,
  hashCard, hashQuery, jpegSize, parsePnm, rotate180, score, uprightJpegs,
} from "../lib/fingerprint.js";
// synth(): seeded procedural "card": shaded background with coloured rectangles
// and ellipses (gradients keep dHash bits from depending on noise in flat areas).
import { synth } from "./helpers/images.js";
import { hasBinary } from "../lib/ocr.js";

const HAS_DJPEG = await hasBinary("djpeg");
const HAS_CJPEG = await hasBinary("cjpeg");

// A "phone capture": upscale to w×h with a small shift, brightness change and noise.
function capture(src, { w = 1000, h = 1400, shift = 0.01, gain = 1.08, noise = 12, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, Math.floor(((x / w) + shift) * src.width)));
      const sy = Math.min(src.height - 1, Math.max(0, Math.floor(((y / h) + shift) * src.height)));
      for (let c = 0; c < 3; c++) {
        const v = src.data[(sy * src.width + sx) * 3 + c] * gain + (rnd() - 0.5) * noise;
        data[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { width: w, height: h, channels: 3, data };
}

describe("fetchImage", () => {
  test("a redirect chain longer than 5 hops is refused (no network: refused before any request)", async () => {
    await assert.rejects(fetchImage("https://cards.scryfall.io/x.jpg", { hops: 6 }), /too many redirects/);
  });
});

describe("pixels", () => {
  test("parsePnm reads P5/P6 headers with comments", () => {
    const p6 = Buffer.concat([Buffer.from("P6\n# made by test\n2 1\n255\n"), Buffer.from([1, 2, 3, 4, 5, 6])]);
    const img = parsePnm(p6);
    assert.deepEqual([img.width, img.height, img.channels, [...img.data]], [2, 1, 3, [1, 2, 3, 4, 5, 6]]);
    const p5 = parsePnm(Buffer.concat([Buffer.from("P5 3 1 255\n"), Buffer.from([7, 8, 9])]));
    assert.deepEqual([p5.channels, [...p5.data]], [1, [7, 8, 9]]);
    assert.throws(() => parsePnm(Buffer.from("P3\n1 1\n255\n0 0 0")), /unsupported/);
    assert.throws(() => parsePnm(Buffer.from("P5\n4 4\n255\n\x00")), /truncated/);
  });

  test("areaResample averages exactly and clamps out-of-range regions", () => {
    const img = { width: 2, height: 1, channels: 1, data: Uint8Array.from([0, 100]) };
    assert.deepEqual([...areaResample(img, [0, 0, 1, 1], 1, 1)].map(Math.round), [50, 50, 50]);
    const shifted = areaResample(img, [0.5, 0, 1.5, 1], 1, 1); // half outside → edge pixel repeats
    assert.equal(Math.round(shifted[0]), 100);
  });
});

describe("hashing", () => {
  test("88-byte reference hash, 27 query variants, self distance 0", () => {
    const a = synth(1);
    const h = hashCard(a);
    assert.equal(h.length, FP_BYTES);
    const q = hashQuery(a);
    assert.equal(q.length, 27);
    assert.equal(score(h, h), 0);
    assert.equal(score(q[13], h), 0, "centre variant equals the reference hash");
  });

  test("same card through a capture is close, other cards are far", () => {
    const refs = [1, 2, 3, 4, 5].map((i) => hashCard(synth(i)));
    const q = hashQuery(capture(synth(3), { seed: 7 }));
    const d = refs.map((r) => Math.min(...q.map((v) => score(v, r))));
    assert.ok(d[2] < 0.2, `true match distance ${d[2]}`);
    for (const [i, x] of d.entries()) if (i !== 2) assert.ok(x > d[2] + 0.1, `impostor ${i} at ${x}`);
  });

  test("rotate180 / cropRows: pixel order, channels kept", () => {
    const rgb = { width: 2, height: 2, channels: 3, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) };
    assert.deepEqual([...rotate180(rgb).data], [10, 11, 12, 7, 8, 9, 4, 5, 6, 1, 2, 3]);
    const gray = { width: 3, height: 1, channels: 1, data: Uint8Array.from([1, 2, 3]) };
    assert.deepEqual([...rotate180(gray).data], [3, 2, 1]);
    const img = synth(5);
    assert.deepEqual(rotate180(rotate180(img)).data, img.data);
    const band = cropRows(img, 0.85, 1);
    assert.deepEqual([band.width, band.height, band.channels], [146, 31, 3]);
    assert.deepEqual(band.data.subarray(0, 6), img.data.subarray(173 * 146 * 3, 173 * 146 * 3 + 6));
  });

  test("an upside-down capture matches its card only once turned back", () => {
    const refs = [1, 2, 3, 4, 5].map((i) => hashCard(synth(i)));
    const upside = rotate180(capture(synth(3), { seed: 11 }));
    const best = (q) => refs.map((r, i) => ({ i: i + 1, d: Math.min(...q.map((h) => score(h, r))) })).sort((a, b) => a.d - b.d)[0];
    const as = best(hashQuery(upside));
    assert.ok(as.d > 0.3, `as photographed: ${as.d.toFixed(3)} to card ${as.i}`);
    const turned = best(hashQuery(rotate180(upside)));
    assert.equal(turned.i, 3);
    assert.ok(turned.d < 0.15, `turned back: ${turned.d.toFixed(3)}`);
  });

  test("gray input is accepted", () => {
    const g = synth(9);
    const gray = new Uint8Array(g.width * g.height);
    for (let i = 0; i < gray.length; i++) gray[i] = g.data[i * 3];
    assert.equal(hashCard({ width: g.width, height: g.height, channels: 1, data: gray }).length, FP_BYTES);
  });
});

// Minimal index: 8 printings in two sets, one German copy sharing an English
// illustration (mapped, not hashed), one placeholder, one DFC.
let dir, idx;
const ID = (i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
const URL_OF = (i, face = "front") => `https://cards.scryfall.io/small/${face}/0/0/${ID(i)}.jpg`;
function cardRow(i, o = {}) {
  return {
    object: "card", id: ID(i), oracle_id: `o${i}`, name: `Card ${i}`, lang: "en", set: "aaa", collector_number: String(i),
    games: ["paper"], released_at: "2024-01-01", finishes: ["nonfoil"], illustration_id: `ill${i}`, frame: "2015",
    border_color: "black", frame_effects: [], image_status: "highres_scan", image_uris: { small: URL_OF(i), normal: URL_OF(i) }, ...o,
  };
}
const CARDS = [
  cardRow(1), cardRow(2), cardRow(3), cardRow(4),
  cardRow(5, { set: "bbb" }),
  cardRow(6, { lang: "de", oracle_id: "o1", name: "Card 1", illustration_id: "ill1", image_status: "lowres" }),
  cardRow(7, { lang: "fr", oracle_id: "o2", name: "Card 2", illustration_id: "ill2", image_status: "placeholder" }),
  cardRow(8, { oracle_id: "o1", name: "Card 1", illustration_id: "ill1", frame_effects: ["showcase"] }),
  cardRow(9, {
    image_uris: undefined, illustration_id: undefined, layout: "transform",
    card_faces: [
      { name: "Front", illustration_id: "ill9a", image_uris: { small: URL_OF(9), normal: URL_OF(9) } },
      { name: "Back", illustration_id: "ill9b", image_uris: { small: URL_OF(9, "back"), normal: URL_OF(9, "back") } },
    ],
  }),
];
// Each fetched URL decodes to its own synthetic image (seed from the URL).
const seedOf = (url) => {
  const m = /0*(\d+)\.jpg/.exec(url);
  return Number(m[1]) * (url.includes("/back/") ? 100 : 1);
};

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-"));
  const file = path.join(dir, "all.jsonl.gz");
  writeFileSync(file, gzipSync(CARDS.map((c) => JSON.stringify(c)).join("\n")));
  idx = openIndex(path.join(dir, "cardindex.db"));
  await refreshIndex(idx, { source: file, setsSource: [] });
});
after(() => { try { idx.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

describe("buildFingerprints + Matcher", () => {
  const fetched = [];
  const opts = (extra = {}) => ({
    keepImages: true,
    imageDir: path.join(dir, "images"),
    fetchImage: async (url) => { fetched.push(url); return Buffer.from(url); },
    decode: async (buf) => synth(seedOf(buf.toString())),
    ...extra,
  });

  test("fingerprintKey groups by illustration + look", () => {
    const p = { id: "x", frame: "2015", border_color: "black", full_art: 0, frame_effects: '["showcase","legendary"]' };
    assert.equal(fingerprintKey(p, 0, "ill"), "ill|2015|black|0|legendary,showcase");
    assert.equal(fingerprintKey({ ...p, frame_effects: [] }, 1, null), "x:1|2015|black|0|");
    // Art cards / front cards / tokens reuse the illustration but get their own group.
    assert.equal(fingerprintKey({ ...p, frame_effects: [], layout: "art_series" }, 0, "ill"), "ill|2015|black|0||art_series");
    assert.equal(fingerprintKey({ ...p, frame_effects: [], layout: "normal" }, 0, "ill"), "ill|2015|black|0|");
  });

  test("set-restricted run hashes only that scope", async () => {
    const job = await buildFingerprints(idx, opts({ sets: ["bbb"] }));
    assert.equal(job.state, "done");
    assert.equal(job.total, 1);
    assert.deepEqual(fetched, [URL_OF(5)]);
  });

  test("full run: one hash per group, placeholders/other languages mapped, resumable", async () => {
    fetched.length = 0;
    const job = await buildFingerprints(idx, opts({ sets: [] }));
    assert.equal(job.state, "done");
    // groups: 1,2,3,4,5 (+5 already done), 8 showcase, 9 front, 9 back = 8
    assert.equal(job.total, 8);
    assert.equal(job.errors, 0);
    assert.ok(!fetched.includes(URL_OF(6)), "German copy of an English illustration is not fetched");
    assert.ok(!fetched.includes(URL_OF(7)), "placeholder images are never fetched");
    assert.ok(!fetched.includes(URL_OF(5)), "already hashed keys are skipped");
    assert.equal(indexStatus(idx).fingerprints, 8);
    assert.equal(indexStatus(idx).fingerprint_job.state, "done");
    const maps = idx.prepare("SELECT printing_id, face, key FROM printing_fp ORDER BY printing_id, face").all();
    const keyOf = (i, f = 0) => maps.find((m) => m.printing_id === ID(i) && m.face === f)?.key;
    assert.equal(keyOf(6), keyOf(1), "de copy shares the en fingerprint");
    assert.equal(keyOf(7), keyOf(2), "placeholder fr copy maps to the en fingerprint");
    assert.notEqual(keyOf(8), keyOf(1), "showcase frame is its own group");
    assert.ok(keyOf(9, 1) && keyOf(9, 1) !== keyOf(9, 0), "DFC faces hashed separately");
    assert.equal(idx.prepare("SELECT 1 FROM sqlite_master WHERE name = 'printing_fp_new'").get(), undefined, "the staging map was swapped in and dropped");

    fetched.length = 0;
    const again = await buildFingerprints(idx, opts({ sets: [], fetchImage: async () => { throw new Error("must not fetch"); } }));
    assert.equal(again.done, 8);
    assert.deepEqual(fetched, []);
  });

  test("cached images are re-hashed without downloading", async () => {
    idx.exec("DELETE FROM fingerprints");
    const job = await buildFingerprints(idx, opts({ sets: [], fetchImage: async () => { throw new Error("must not fetch"); } }));
    assert.equal(job.done, 8);
    assert.equal(job.fetched, 0);
  });

  test("Matcher finds the captured card, expands printings, reports the name gap", () => {
    const m = new Matcher(idx);
    assert.equal(m.load(), 8);
    const res = m.match(hashQuery(capture(synth(2), { seed: 3 })), { topK: 5 });
    assert.equal(res.length, 5);
    assert.equal(res[0].printing_id, ID(2));
    assert.equal(res[0].oracle_id, "o2");
    assert.deepEqual(res[0].printing_ids.sort(), [ID(2), ID(7)]);
    assert.ok(res[0].score < 0.2);
    assert.ok(res.every((r, i) => i === 0 || r.score >= res[i - 1].score));
    assert.ok(m.nameGap(res) > 0.1);

    const back = m.match(hashQuery(capture(synth(900), { seed: 4 })), { topK: 3 });
    assert.equal(back[0].printing_id, ID(9));
    assert.equal(back[0].face, 1);

    const sc = m.scorePrintings(hashQuery(synth(1)), [ID(1), ID(6), ID(3), "missing"]);
    assert.equal(sc.get(ID(1)).score, 0);
    assert.equal(sc.get(ID(6)).score, 0, "mapped printing scores via its group");
    assert.ok(sc.get(ID(3)).score > 0.2);
    assert.equal(sc.has("missing"), false);
  });

  test("Matcher reloads after the job adds hashes; same-card hits don't count for the gap", () => {
    const m = new Matcher(idx);
    m.load();
    // printing 8 (showcase) is the same oracle card as 1: the gap must skip it.
    const res = m.match(hashQuery(synth(1)), { topK: 8 });
    assert.equal(res[0].oracle_id, "o1");
    const otherBest = res.find((r) => r.oracle_id !== "o1").score;
    assert.equal(+m.nameGap(res).toFixed(6), +(otherBest - res[0].score).toFixed(6));
    idx.prepare("DELETE FROM fingerprints WHERE printing_id = ?").run(ID(4));
    idx.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('fp_generation', 'changed')").run();
    m.match(hashQuery(synth(1)));
    assert.equal(m.size, 7);
  });

  test("an aborted job is left paused and resumes later", async () => {
    idx.exec("DELETE FROM fingerprints");
    const ac = new AbortController();
    let count = 0;
    const job = await buildFingerprints(idx, opts({
      sets: [], signal: ac.signal, keepImages: false,
      fetchImage: async (url) => { if (++count === 2) ac.abort(); return Buffer.from(url); },
    }));
    assert.equal(job.state, "paused");
    assert.ok(job.done < 8);
    const resumed = await buildFingerprints(idx, opts({ sets: [], keepImages: false }));
    assert.equal(resumed.state, "done");
    assert.equal(resumed.done, 8);
  });

  test("repeated errors stop every worker before the job reports the error", async () => {
    idx.exec("DELETE FROM fingerprints");
    let calls = 0;
    await assert.rejects(buildFingerprints(idx, opts({
      sets: [], keepImages: false, concurrency: 2, maxConsecutiveErrors: 3,
      fetchImage: async () => { calls++; await new Promise((r) => setTimeout(r, 1)); throw new Error("offline"); },
    })), /repeated errors/);
    const after = calls;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, after, "no orphaned worker keeps fetching");
    assert.equal(indexStatus(idx).fingerprint_job.state, "error");
    await buildFingerprints(idx, opts({ sets: [], keepImages: false }));
  });

  test("an art card sharing the illustration never becomes the real card's reference", async () => {
    const d2 = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-"));
    try {
      const file = path.join(d2, "all.jsonl.gz");
      const art = cardRow(21, { set: "aart", layout: "art_series", oracle_id: "o-art", name: "Card 20 // Card 20", illustration_id: "ill20" });
      const real = cardRow(20, { illustration_id: "ill20", layout: "normal" });
      writeFileSync(file, gzipSync([art, real].map((c) => JSON.stringify(c)).join("\n")));
      const i2 = openIndex(path.join(d2, "cardindex.db"));
      await refreshIndex(i2, { source: file, setsSource: [] });
      const job = await buildFingerprints(i2, opts({ sets: [], keepImages: false }));
      assert.equal(job.total, 2, "art card and real card are separate groups");
      const ref = i2.prepare("SELECT f.printing_id FROM printing_fp m JOIN fingerprints f ON f.key = m.key WHERE m.printing_id = ?").get(ID(20));
      assert.equal(ref.printing_id, ID(20));
      i2.close();
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

describe("JPEG size guard", () => {
  // SOI + SOF0 declaring w x h, nothing else (djpeg would emit a full gray raster for this).
  const fakeJpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  test("jpegSize reads the frame header; oversized declarations are refused before decoding", async () => {
    assert.deepEqual(jpegSize(fakeJpeg(1000, 1400)), { width: 1000, height: 1400 });
    assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
    assert.deepEqual(checkJpegSize(fakeJpeg(1000, 1400)), { width: 1000, height: 1400 });
    assert.throws(() => checkJpegSize(fakeJpeg(40000, 40000)), /too large/);
    await assert.rejects(decodeJpeg(fakeJpeg(40000, 40000)), /too large/);
    await assert.rejects(decodeJpeg(Buffer.from("not a jpeg")), /not a JPEG/);
  });
});

describe("djpeg", { skip: !HAS_DJPEG && "djpeg not installed" }, () => {
  test("uprightJpegs: an upside-down card JPEG comes back upright, plus its top band as the strip", async (t) => {
    if (!HAS_CJPEG) return t.skip("cjpeg not installed");
    const upright = capture(synth(6), { w: 300, h: 420, noise: 0, shift: 0 });
    const jpg = await encodeJpeg(rotate180(upright), { quality: 95 });
    assert.deepEqual(jpg.subarray(0, 2), Buffer.from([0xff, 0xd8]));
    const out = await uprightJpegs(jpg);
    const card = await decodeJpeg(out.card);
    const strip = await decodeJpeg(out.strip);
    assert.deepEqual([card.width, card.height, strip.width, strip.height], [300, 420, 300, 63]);
    assert.ok(score(hashCard(card), hashCard(upright)) < 0.06, "upright again");
    const want = cropRows(upright, 0.85, 1);
    let diff = 0;
    for (let i = 0; i < want.data.length; i++) diff += Math.abs(want.data[i] - strip.data[i]);
    assert.ok(diff / want.data.length < 8, `strip = the upright card's bottom band (mean diff ${(diff / want.data.length).toFixed(1)})`);
    const gray = await encodeJpeg({ width: 8, height: 8, channels: 1, data: new Uint8Array(64).fill(100) });
    assert.equal((await decodeJpeg(gray)).channels, 1);
    await assert.rejects(uprightJpegs(Buffer.from("nope")), /JPEG/);
  });

  test("decodeJpeg round-trips a cjpeg-encoded image", async (t) => {
    if (!HAS_CJPEG) return t.skip("cjpeg not installed");
    const img = synth(4, 64, 88);
    const ppm = Buffer.concat([Buffer.from(`P6\n${img.width} ${img.height}\n255\n`), Buffer.from(img.data)]);
    const jpg = spawnSync("cjpeg", ["-quality", "95"], { input: ppm }).stdout;
    const out = await decodeJpeg(jpg);
    assert.deepEqual([out.width, out.height, out.channels], [64, 88, 3]);
    assert.ok(score(hashCard(out), hashCard(img)) < 0.08);
    const gray = await decodeJpeg(jpg, { gray: true, scale: "1/2" });
    assert.deepEqual([gray.width, gray.height, gray.channels], [32, 44, 1]);
    await assert.rejects(decodeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xd9])), /djpeg exited|truncated|bad PNM/);
  });
});
