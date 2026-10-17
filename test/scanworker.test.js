// Scanner work off the main thread: the worker client (scanlib createScanWorker)
// on a fake Worker, the worker module's ops (public/scanworker.js, loaded with a
// stand-in `self`; node has no OffscreenCanvas, so its raw-RGBA path runs),
// captureCard through a worker and inline, analyzeAsync vs analyze, and the
// small pure helpers. Procedural frames only.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  bytesToBase64, cameraPlan, CAMERA_RESOLUTIONS, captureCard, chooseCloneRotation, cloneMatches, cloneRelation, cloneToWork, createDetAnalyzer, createScanWorker, glareMap,
  glareSummary, grabRegions, grayThumb, isAndroid, openCamera, regionPlan, regionQuad, CAPTURE_DEFAULTS, rotateGray, stripSharpness, warpQuad, workSize,
} from "../public/scanlib.js";
import { detect } from "../public/det/detect.mjs";
import { BoxPrior, PRIOR_STORAGE_KEY } from "../public/det/track.mjs";
import { addNoise, background, drawCard, makeCard, placeCard } from "./helpers/detscenes.js";

// ---------------------------------------------------------------------------
// helpers

/**
 * Canvas stand-in: drawImage (5/9 args, nearest sample; setTransform affine, dest at 0,0), get/putImageData,
 * toBlob (fake bytes), toDataURL.
 */
function makeCanvas(w, h) {
  const c = { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), blobs: 0 };
  c.buf = new Uint8ClampedArray(c.width * c.height * 4);
  let T = [1, 0, 0, 1, 0, 0];
  const ctx = {
    setTransform(...m) { T = m; },
    drawImage(src, ...a) {
      const S = src.frame ? src.frame : { w: src.width, h: src.height, d: src.buf };
      let sx = 0, sy = 0, sw = S.w, sh = S.h, dw, dh;
      if (a.length === 4) [, , dw, dh] = a; else [sx, sy, sw, sh, , , dw, dh] = a;
      dw = Math.round(dw); dh = Math.round(dh);
      const [ta, tb, tc, td, te, tf] = T;
      if (!(ta === 1 && tb === 0 && tc === 0 && td === 1 && te === 0 && tf === 0)) {
        const det = ta * td - tb * tc;
        for (let j = 0; j < c.height; j++) for (let i = 0; i < c.width; i++) {
          const X = i + 0.5 - te, Y = j + 0.5 - tf, u = (td * X - tc * Y) / det, v = (-tb * X + ta * Y) / det;
          if (u < 0 || v < 0 || u >= dw || v >= dh) continue;
          const x = Math.min(S.w - 1, Math.floor(sx + (u * sw) / dw)), y = Math.min(S.h - 1, Math.floor(sy + (v * sh) / dh));
          const si = (y * S.w + x) * 4, di = (j * c.width + i) * 4;
          c.buf[di] = S.d[si]; c.buf[di + 1] = S.d[si + 1]; c.buf[di + 2] = S.d[si + 2]; c.buf[di + 3] = 255;
        }
        return;
      }
      for (let j = 0; j < Math.min(dh, c.height); j++) for (let i = 0; i < Math.min(dw, c.width); i++) {
        const x = Math.min(S.w - 1, Math.floor(sx + ((i + 0.5) * sw) / dw)), y = Math.min(S.h - 1, Math.floor(sy + ((j + 0.5) * sh) / dh));
        const si = (y * S.w + x) * 4, di = (j * c.width + i) * 4;
        c.buf[di] = S.d[si]; c.buf[di + 1] = S.d[si + 1]; c.buf[di + 2] = S.d[si + 2]; c.buf[di + 3] = 255;
      }
    },
    getImageData(x, y, w2, h2) {
      const data = new Uint8ClampedArray(w2 * h2 * 4);
      for (let r = 0; r < h2; r++) data.set(c.buf.subarray(((y + r) * c.width + x) * 4, ((y + r) * c.width + x + w2) * 4), r * w2 * 4);
      return { width: w2, height: h2, data };
    },
    putImageData(id) { c.buf.set(id.data.subarray(0, c.buf.length)); },
  };
  c.getContext = () => ctx;
  // "JPEG": a marker + the size + quality x100 + the first pixel's red, so tests can tell which
  // image was encoded; quality x30 padding bytes make a higher quality longer
  c.toBlob = (cb, type, q = 0.92) => {
    c.blobs++;
    const head = [0xff, 0xd8, c.width & 255, c.width >> 8, c.height & 255, c.height >> 8, Math.round(q * 100), c.buf[0]];
    cb(new Blob([new Uint8Array([...head, ...new Array(Math.round(q * 30)).fill(0)])]));
  };
  c.toDataURL = () => `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 1]).toString("base64")}`;
  return c;
}

const VW = 1080, VH = 1920;
const QUAD = placeCard(VW / 2, VH / 2, VW * 0.6, 2, 0.004);
let scene;
before(() => {
  const img = background("cloth", VW, VH, 11);
  drawCard(img, makeCard(11), QUAD);
  scene = addNoise(img, 3, 4);
  // node has no ImageData; the inline JPEG path puts pixels into a canvas
  globalThis.ImageData ??= class ImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
});

/** Fake Worker: the test drives its messages. */
class FakeWorker {
  constructor(url, opts) { this.url = String(url); this.opts = opts; this.sent = []; this.terminated = false; FakeWorker.last = this; }
  postMessage(m, transfer) { this.sent.push({ m, transfer }); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
}

// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  test("bytesToBase64 matches Buffer for empty, small and > 32 KB inputs", () => {
    for (const n of [0, 1, 2, 3, 100, 0x8000, 0x8000 * 3 + 7]) {
      const b = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 255);
      assert.equal(bytesToBase64(b), Buffer.from(b).toString("base64"), String(n));
    }
  });

  test("glareSummary rounds regions and maps the advice text", () => {
    const g = { regions: { collector: 0.01234, title: 0, art: 0, typeLine: 0, textBox: 0 }, fraction: 0.00456 };
    const s = glareSummary(g);
    assert.equal(s.code, "glare-collector");
    assert.match(s.advice, /bottom line/);
    assert.equal(s.regions.collector, 0.012);
    assert.equal(s.fraction, 0.005);
    const t = glareSummary({ regions: { collector: 0, title: 0, art: 0, typeLine: 0.2, textBox: 0 }, fraction: 0 }, { typeLine: Infinity });
    assert.equal(t.code, "ok");
    assert.equal(t.advice, null);
  });
});

describe("createScanWorker (client)", () => {
  test("no Worker: unavailable, calls reject", async () => {
    const w = createScanWorker({ WorkerCtor: undefined });
    assert.equal(w.available(), false);
    assert.equal(w.state, "off");
    await assert.rejects(w.call("detect", {}), /unavailable/);
  });

  test("loading until the worker says ready; a module worker; replies resolve/reject by id", async () => {
    const w = createScanWorker({ WorkerCtor: FakeWorker, url: "x.js" });
    const fw = FakeWorker.last;
    assert.deepEqual(fw.opts, { type: "module" });
    assert.equal(w.available(), false);
    assert.equal(w.state, "loading");
    fw.emit({ ready: true, encoder: true });
    assert.equal(w.available(), true);
    assert.equal(w.encoder, true);
    const buf = new ArrayBuffer(8);
    const a = w.call("detect", { img: 1 }, [buf]), b = w.call("glare", {});
    assert.equal(fw.sent.length, 2);
    assert.equal(fw.sent[0].m.op, "detect");
    assert.equal(fw.sent[0].m.img, 1);
    assert.deepEqual(fw.sent[0].transfer, [buf]);
    fw.emit({ id: fw.sent[1].m.id, ok: false, error: "nope" });
    fw.emit({ id: fw.sent[0].m.id, ok: true, result: { r: 5 } });
    assert.deepEqual(await a, { r: 5 });
    await assert.rejects(b, /nope/);
    fw.emit({ id: 999, ok: true }); // unknown id: ignored
    assert.equal(w.available(), true, "a failed job does not turn the worker off");
  });

  test("a worker error rejects every pending job and turns it off for good", async () => {
    const w = createScanWorker({ WorkerCtor: FakeWorker });
    const fw = FakeWorker.last;
    fw.emit({ ready: true });
    const p = w.call("probe", {});
    fw.onerror({ preventDefault() {} });
    await assert.rejects(p, /failed/);
    assert.equal(w.available(), false);
    assert.equal(fw.terminated, true);
    await assert.rejects(w.call("detect", {}), /unavailable/);
  });

  test("a job that never answers times out and turns the worker off", async () => {
    const w = createScanWorker({ WorkerCtor: FakeWorker, timeoutMs: 20 });
    FakeWorker.last.emit({ ready: true });
    await assert.rejects(w.call("detect", {}), /timeout/);
    assert.equal(w.state, "off");
  });
});

describe("scanworker.js ops", () => {
  let posted, send;
  before(async () => {
    posted = [];
    globalThis.self = { postMessage: (m, transfer) => posted.push({ m, transfer }) };
    await import("../public/scanworker.js");
    send = async (m) => {
      const n = posted.length;
      globalThis.self.onmessage({ data: m });
      for (let i = 0; i < 200 && posted.length === n; i++) await new Promise((r) => setTimeout(r, 5));
      return posted[posted.length - 1];
    };
  });

  test("announces ready (no OffscreenCanvas in node: no encoder)", () => {
    assert.deepEqual(posted[0].m, { ready: true, encoder: false });
  });

  test("detect: same result as in-process, pixels transferred back", async () => {
    const W = 480, H = 853, q = placeCard(W / 2, H / 2, W * 0.6, 3, 0.004);
    const img = background("cloth", W, H, 4);
    drawCard(img, makeCard(4), q);
    const ref = detect({ w: W, h: H, d: new Uint8ClampedArray(img.d) }, {});
    const d = new Uint8ClampedArray(img.d);
    const { m, transfer } = await send({ id: 1, op: "detect", img: { w: W, h: H, d }, opts: {} });
    assert.equal(m.ok, true);
    assert.equal(m.result.r.found, ref.found);
    assert.deepEqual(m.result.r.corners, ref.corners);
    assert.equal(m.result.d.length, W * H * 4);
    assert.equal(transfer[0], m.result.d.buffer);
    assert.ok(Number.isFinite(m.result.ms));
  });

  test("probe (raw path) warps card and strip; glareLast measures that card once", async () => {
    const card = { img: { w: VW, h: VH, d: new Uint8ClampedArray(scene.d) }, q: QUAD, outW: 1000, outH: 1400, quality: 0.85 };
    const strip = { img: { w: VW, h: VH, d: new Uint8ClampedArray(scene.d) }, q: QUAD, outW: 400, outH: 100, quality: 0.92 };
    const { m } = await send({ id: 2, op: "probe", card, strip, glare: true });
    assert.equal(m.ok, true);
    assert.equal(m.result.raw, true);
    assert.deepEqual([m.result.card.w, m.result.card.h, m.result.card.d.length], [1000, 1400, 1000 * 1400 * 4]);
    assert.deepEqual([m.result.strip.w, m.result.strip.h], [400, 100]);
    const expect = glareSummary(glareMap(warpQuad(scene, QUAD, 1000, 1400)));
    const g = await send({ id: 3, op: "glareLast" });
    assert.deepEqual(g.m.result, expect);
    const again = await send({ id: 4, op: "glareLast" });
    assert.equal(again.m.result, null, "only once per probe");
  });

  test("glare warps + measures; an unknown op answers an error", async () => {
    const { m } = await send({ id: 5, op: "glare", img: { w: VW, h: VH, d: new Uint8ClampedArray(scene.d) }, q: QUAD, outW: 500, outH: 700, limits: { typeLine: Infinity } });
    assert.deepEqual(m.result, glareSummary(glareMap(warpQuad(scene, QUAD, 500, 700)), { typeLine: Infinity }));
    const bad = await send({ id: 6, op: "nope" });
    assert.equal(bad.m.ok, false);
    assert.match(bad.m.error, /unknown op/);
  });
});

describe("captureCard", () => {
  const video = () => ({ videoWidth: VW, videoHeight: VH, frame: scene });

  test("inline (no worker): card 1000x1400 + strip, JPEGs via toBlob, glare as a promise", async () => {
    const shot = await captureCard(video(), null, QUAD, { preferPhoto: false, makeCanvas, glare: true });
    assert.equal(shot.kind, "video");
    assert.equal(shot.worker, false);
    const card = Buffer.from(shot.card, "base64");
    assert.deepEqual([card[0], card[1], card[2] | (card[3] << 8), card[4] | (card[5] << 8)], [0xff, 0xd8, 1000, 1400]);
    const strip = Buffer.from(shot.strip, "base64");
    assert.deepEqual([strip[2] | (strip[3] << 8), strip[4] | (strip[5] << 8)], shot.stripSize);
    assert.ok(shot.stripSize[0] >= 600, `strip ${shot.stripSize}`);
    assert.match(shot.cardPreview, /^data:image\/jpeg;base64,/);
    const g = await shot.glare;
    assert.ok(g && typeof g.code === "string" && Number.isFinite(g.fraction));
    assert.ok(Number.isFinite(shot.ms.grab) && Number.isFinite(shot.ms.total));
  });

  test("with a ready worker: pixels transferred to 'probe', glare from 'glareLast', JPEGs from the worker", async () => {
    const calls = [];
    const pixels = {
      available: () => true,
      call: async (op, payload, transfer) => {
        calls.push({ op, payload, transfer });
        if (op === "probe") return { card: "Q0FSRA==", strip: "U1RSSVA=" };
        return { code: "ok", advice: null, regions: {}, fraction: 0 };
      },
    };
    const shot = await captureCard(video(), null, QUAD, { preferPhoto: false, makeCanvas, glare: true, pixels });
    assert.deepEqual(calls.map((c) => c.op), ["probe", "glareLast"]);
    const p = calls[0].payload;
    assert.deepEqual([p.card.outW, p.card.outH, p.card.quality, p.strip.quality, p.glare], [1000, 1400, 0.85, 0.92, true]);
    assert.deepEqual([p.strip.outW, p.strip.outH], shot.stripSize);
    assert.deepEqual(calls[0].transfer, [p.card.img.d.buffer, p.strip.img.d.buffer]);
    // the card region is read at full video resolution here (the card is < 1.3x 1000 px wide: never upscaled)
    assert.ok(p.card.img.w >= 648 && p.card.img.w < 700, String(p.card.img.w));
    assert.equal(shot.card, "Q0FSRA==");
    assert.equal(shot.strip, "U1RSSVA=");
    assert.equal(shot.worker, true);
    assert.deepEqual(await shot.glare, { code: "ok", advice: null, regions: {}, fraction: 0 });
  });

  test("a worker without an encoder sends RGBA back: encoded here with toBlob; no glare job when not asked", async () => {
    const calls = [];
    const pixels = {
      available: () => true,
      call: async (op, payload) => {
        calls.push(op);
        return { raw: true, card: warpQuad(payload.card.img, payload.card.q, 1000, 1400), strip: warpQuad(payload.strip.img, payload.strip.q, payload.strip.outW, payload.strip.outH) };
      },
    };
    const shot = await captureCard(video(), null, QUAD, { preferPhoto: false, makeCanvas, pixels });
    assert.deepEqual(calls, ["probe"]);
    assert.equal(shot.glare, null);
    const card = Buffer.from(shot.card, "base64");
    assert.equal(card[2] | (card[3] << 8), 1000);
  });

  test("a failed worker job (timeout, crash, close) reads the pixels again and finishes inline: the shot is not lost", async () => {
    for (const err of ["scan worker timeout", "scan worker failed", "scan worker closed"]) {
      const calls = [];
      const pixels = { available: () => true, call: async (op) => { calls.push(op); throw new Error(err); } };
      const shot = await captureCard(video(), null, QUAD, { preferPhoto: false, makeCanvas, glare: true, pixels });
      assert.deepEqual(calls, ["probe", "glareLast"], err);
      assert.equal(shot.worker, false, err);
      const card = Buffer.from(shot.card, "base64");
      assert.deepEqual([card[2] | (card[3] << 8), card[4] | (card[5] << 8)], [1000, 1400], err);
      const strip = Buffer.from(shot.strip, "base64");
      assert.deepEqual([strip[2] | (strip[3] << 8), strip[4] | (strip[5] << 8)], shot.stripSize, err);
      const g = await shot.glare;
      assert.ok(g && typeof g.code === "string", "glare measured inline");
    }
  });
});

describe("createDetAnalyzer: analyzeAsync", () => {
  const W = 720, H = 1280, q = placeCard(W * 0.45, H * 0.52, W * 0.55, 6, 0.01);
  const frames = [1, 2, 3].map((n) => {
    const img = background("cloth", W, H, 21);
    drawCard(img, makeCard(21), q);
    return addNoise(img, n, 4);
  });
  const storage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

  test("with a detect worker gives the same frames as analyze(); timing says where detect ran", async () => {
    const vA = { videoWidth: W, videoHeight: H, frame: frames[0] }, vB = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const jobs = [];
    const detectWorker = {
      available: () => true,
      call: async (op, { img, opts }, transfer) => {
        jobs.push({ op, transfer });
        const r = structuredClone(detect(img, opts));
        await new Promise((res) => setTimeout(res, 2));
        return { r, d: img.d, ms: 1.5 };
      },
    };
    const a = createDetAnalyzer(vA, { makeCanvas, storage: storage() });
    const b = createDetAnalyzer(vB, { makeCanvas, storage: storage(), detectWorker });
    for (let i = 0; i < 8; i++) {
      vA.frame = vB.frame = frames[i % 3];
      const t = 1000 + i * 125;
      const oa = a.analyze(t), ob = await b.analyzeAsync(t);
      for (const k of ["found", "weak", "accepted", "stable", "mode", "blank", "sharp"]) assert.deepEqual(ob[k], oa[k], `${k} @${i}`);
      assert.deepEqual(ob.corners, oa.corners, `corners @${i}`);
      assert.deepEqual(Array.from(ob.cardThumb || []), Array.from(oa.cardThumb || []));
      assert.equal(oa.timing.worker, false);
      assert.equal(ob.timing.worker, true);
      assert.equal(ob.timing.detect, 1.5);
      assert.ok(ob.timing.main <= ob.ms + 0.01);
    }
    assert.equal(jobs.length, 8);
    assert.ok(jobs.every((j) => j.op === "detect" && j.transfer.length === 1));
    assert.ok(a.analyze(9999).stable, "the card was tracked to stable");
  });

  test("with a detect worker the prior-free check runs there too and a wrong learned box sleeps like analyze()", async () => {
    // a box learned off the card (centred enough to be learned), the card lies elsewhere
    const box = new BoxPrior();
    for (let i = 0; i < 3; i++) box.add(placeCard(W * 0.58 + i, H * 0.42, W * 0.4).map(([x, y]) => [x * (480 / W), y * (480 / W)]), 480, 853, true);
    assert.ok(box.learned);
    const saved = JSON.stringify(box.toJSON());
    const mkStore = () => { const s = storage(); s.setItem(PRIOR_STORAGE_KEY, saved); return s; };
    const jobs = [];
    const detectWorker = {
      available: () => true,
      call: async (op, { img, opts }) => { jobs.push(opts); return { r: structuredClone(detect(img, opts)), d: img.d, ms: 1 }; },
    };
    const vA = { videoWidth: W, videoHeight: H, frame: frames[0] }, vB = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const a = createDetAnalyzer(vA, { makeCanvas, storage: mkStore() }), b = createDetAnalyzer(vB, { makeCanvas, storage: mkStore(), detectWorker });
    a.prior.confirmed = b.prior.confirmed = true;
    for (let i = 0; i < 30; i++) {
      vA.frame = vB.frame = frames[i % 3];
      const oa = a.analyze(i * 125), ob = await b.analyzeAsync(i * 125);
      assert.equal(ob.priorLearned, oa.priorLearned, `@${i}`);
      assert.deepEqual(ob.corners, oa.corners, `corners @${i}`);
    }
    assert.ok(a.prior.slept && b.prior.slept === a.prior.slept, `${a.prior.slept} / ${b.prior.slept}`);
    assert.ok(jobs.some((o) => o.mode === "box") && jobs.some((o) => !o.mode), "box detect + prior-free check");
  });

  test("a failing detect worker drops that frame (null), an unavailable one falls back to analyze()", async () => {
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    let ok = false;
    const detectWorker = { available: () => ok, call: async () => { throw new Error("gone"); } };
    const an = createDetAnalyzer(v, { makeCanvas, storage: storage(), detectWorker });
    const o = await an.analyzeAsync(0);
    assert.ok(o && o.timing.worker === false, "not ready yet: inline");
    ok = true;
    assert.equal(await an.analyzeAsync(125), null);
  });

  test("glare hint through the pixel worker: one job at a time, its answer shows on a later frame", async () => {
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const jobs = [];
    let release;
    const pixels = {
      available: () => true,
      call: (op, payload) => { jobs.push({ op, payload }); return new Promise((res) => { release = () => res({ code: "glare-art", advice: "Reflection on the picture: tilt slightly", regions: { art: 0.1 }, fraction: 0.01 }); }); },
    };
    const an = createDetAnalyzer(v, { makeCanvas, storage: storage(), pixels, glareDelayMs: 0, glareEveryMs: 0 });
    let o;
    for (let i = 0; i < 10; i++) { v.frame = frames[i % 3]; o = an.analyze(1000 + i * 125); }
    assert.ok(o.stable);
    assert.equal(jobs.length, 1, "no second job while one is pending");
    assert.equal(jobs[0].op, "glare");
    assert.deepEqual([jobs[0].payload.outW, jobs[0].payload.outH], [500, 700]);
    assert.equal(jobs[0].payload.limits.typeLine, Infinity, "the stable-track hint ignores the type line");
    assert.equal(o.glare.code, "ok");
    release();
    await new Promise((r) => setTimeout(r, 0));
    o = an.analyze(3000);
    assert.equal(o.glare.code, "glare-art");
    assert.match(o.glare.advice, /picture/);
  });

  test("grabMode auto times both canvases on the first frames, then keeps one; frameJpegAsync encodes the work frame", async () => {
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const an = createDetAnalyzer(v, { makeCanvas, storage: storage(), grabMode: "auto" });
    const modes = [];
    for (let i = 0; i < 20; i++) modes.push(an.analyze(i * 125).timing.mode);
    assert.ok(modes.slice(0, 16).includes("gpu") && modes.slice(0, 16).includes("cpu"), modes.join());
    const info = an.grabInfo();
    assert.ok(["cpu", "gpu"].includes(info.mode), JSON.stringify(info));
    assert.ok(modes.slice(16).every((m) => m === info.mode));
    const j = Buffer.from(await an.frameJpegAsync(0.7), "base64");
    assert.deepEqual([j[2] | (j[3] << 8), j[4] | (j[5] << 8)], [480, 853]);
    const fixed = createDetAnalyzer(v, { makeCanvas, storage: storage() });
    assert.equal(fixed.analyze(0).timing.mode, "cpu");
    assert.equal(fixed.grabInfo().mode, "cpu");
  });

  test("frameJpegAsync fallback: a too-long JPEG is re-encoded from the frame of the call, not a later one", async () => {
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const an = createDetAnalyzer(v, { makeCanvas, storage: storage() });
    an.analyze(0);
    const dec = (b64) => Buffer.from(b64, "base64");
    const ref = dec(await an.frameJpegAsync(0.7));
    assert.equal(ref[6], 70);
    assert.notEqual(ref[7], 0, "the scene's first pixel is not black");
    const max = Math.ceil(ref.length / 3) * 4 - 1; // q0.7 is just too long, q0.5 fits
    const p = an.frameJpegAsync(0.7, { fallback: 0.5, maxLen: max });
    // the analysis loop draws the next (black) frame into the shared work canvas before the retry
    v.frame = { w: W, h: H, d: new Uint8ClampedArray(W * H * 4) };
    an.analyze(125);
    const j = dec(await p);
    assert.equal(j[6], 50, "the q0.5 retry");
    assert.equal(j[7], ref[7], "same pixels as the q0.7 attempt");
    assert.equal(await an.frameJpegAsync(0.7, { fallback: 0.5, maxLen: 8 }), null, "still too long: null");
    assert.equal(dec(await an.frameJpegAsync(0.7, { fallback: 0.5, maxLen: 1e6 }))[6], 70, "fits: no retry");
  });
});

// The frame paths: the analyzer with the real worker module (loaded above) behind a client that
// calls its onmessage directly; camera frames are fake VideoFrames ({displayWidth, displayHeight,
// frame: RGBA}) from a ReadableStream, read by the worker through the test canvas.
describe("frame path 'track' (camera frames read in the detect worker)", () => {
  const W = 720, H = 1280, q = placeCard(W * 0.45, H * 0.52, W * 0.55, 6, 0.01);
  const frames = [1, 2, 3].map((n) => {
    const img = background("cloth", W, H, 21);
    drawCard(img, makeCard(21), q);
    return addNoise(img, n, 4);
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const vf = (img, extra = {}) => ({ displayWidth: img.w, displayHeight: img.h, frame: img, closed: false, close() { this.closed = true; }, ...extra });
  let ctl;

  function workerClient() {
    const pending = new Map();
    let seq = 1000;
    globalThis.self.postMessage = (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.res(m.result); else p.rej(new Error(m.error));
    };
    globalThis.self.__mkCanvas = makeCanvas;
    const client = {
      calls: [],
      available: () => true,
      encoder: true,
      call(op, payload = {}) {
        client.calls.push(op);
        const id = ++seq;
        return new Promise((res, rej) => { pending.set(id, { res, rej }); globalThis.self.onmessage({ data: { ...payload, id, op } }); });
      },
    };
    return client;
  }

  const camTrack = () => ({ readyState: "live", stream: new ReadableStream({ start(c) { ctl = c; } }) });
  before(() => {
    globalThis.MediaStreamTrackProcessor = class { constructor({ track }) { this.readable = track.stream; } };
  });
  after(() => {
    delete globalThis.MediaStreamTrackProcessor;
    delete globalThis.self.__mkCanvas;
  });

  test("same analysis as the main path; no frame read on the page; old frames closed; crop and frameJpeg from the worker's frame", async () => {
    const dw = workerClient();
    const vA = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const vB = { videoWidth: W, videoHeight: H }; // no pixels: a read on the page would throw
    const a = createDetAnalyzer(vA, { makeCanvas, storage: null, glare: false });
    const b = createDetAnalyzer(vB, { makeCanvas, storage: null, glare: false, detectWorker: dw, frames: "track", track: camTrack() });
    assert.equal(await b.analyzeAsync(0), null, "the first call attaches the track");
    assert.equal(b.grabInfo().path, "track");
    assert.equal(await b.analyzeAsync(50), null, "no frame yet");
    const sent = [];
    for (let i = 0; i < 8; i++) {
      const f = vf(frames[i % 3]);
      sent.push(f);
      ctl.enqueue(f);
      await tick();
      vA.frame = frames[i % 3];
      const t = 1000 + i * 125;
      const oa = a.analyze(t), ob = await b.analyzeAsync(t);
      for (const k of ["found", "weak", "accepted", "stable", "mode", "blank", "sharp"]) assert.deepEqual(ob[k], oa[k], `${k} @${i}`);
      assert.deepEqual(ob.corners, oa.corners, `corners @${i}`);
      assert.deepEqual(Array.from(ob.cardThumb || []), Array.from(oa.cardThumb || []));
      assert.equal(ob.timing.path, "track");
      assert.equal(ob.timing.grab, 0, "nothing read on the page");
      assert.ok(Number.isFinite(ob.timing.wgrab));
    }
    assert.ok(a.analyze(9999).stable, "the card was tracked to stable");
    assert.ok(sent.slice(0, -1).every((f) => f.closed), "every frame but the analysed one is closed");
    assert.equal(sent.at(-1).closed, false);
    assert.equal(await b.analyzeAsync(5000), null, "no new frame: nothing analysed twice");
    // probe crop: the newest frame's region at the asked size, same pixels as a read on the page
    const rect = { x: 100.5, y: 200, w: 400, h: 560, dw: 300, dh: 420 };
    const [img] = await b.crop([rect]);
    const ref = makeCanvas(300, 420);
    ref.getContext().drawImage({ frame: sent.at(-1).frame }, rect.x, rect.y, rect.w, rect.h, 0, 0, 300, 420);
    assert.deepEqual([img.w, img.h], [300, 420]);
    assert.deepEqual(img.d, ref.getContext().getImageData(0, 0, 300, 420).data);
    const j = Buffer.from(await b.frameJpegAsync(0.7), "base64");
    assert.deepEqual([j[2] | (j[3] << 8), j[4] | (j[5] << 8)], [480, 853], "the worker's 480 px work frame");
    b.close();
    await tick();
    assert.equal(sent.at(-1).closed, true, "close() detaches: the held frame is closed");
  });

  test("a rotated frame turns the track path off for good (no createImageBitmap here: main)", async () => {
    const dw = workerClient();
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const b = createDetAnalyzer(v, { makeCanvas, storage: null, glare: false, detectWorker: dw, frames: "track", track: camTrack() });
    await b.analyzeAsync(0);
    ctl.enqueue(vf({ w: H, h: W, d: new Uint8ClampedArray(W * H * 4) }, { displayWidth: H, displayHeight: W, rotation: 90 }));
    await tick();
    assert.equal(await b.analyzeAsync(100), null);
    assert.deepEqual([b.grabInfo().path, b.grabInfo().why], ["main", "track:orientation"]);
    assert.ok(dw.calls.includes("detach"));
    const o = await b.analyzeAsync(200);
    assert.equal(o.timing.path, "main");
    assert.equal(o.timing.worker, true, "detect still runs in the worker");
  });

  test("auto never takes the track path (beta.2 stalled the Pixel's camera); off Chromium it stays on the page's read", async () => {
    const dw = workerClient();
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const b = createDetAnalyzer(v, { makeCanvas, storage: null, glare: false, detectWorker: dw, frames: "auto", track: camTrack(), chromium: false });
    const o = await b.analyzeAsync(0);
    assert.equal(o.timing.path, "main");
    assert.equal(b.path, "main");
    assert.deepEqual(dw.calls, ["detect"]);
  });

  test("auto without MediaStreamTrackProcessor (Safari, Firefox) stays on the page's read", async () => {
    const saved = globalThis.MediaStreamTrackProcessor;
    delete globalThis.MediaStreamTrackProcessor;
    try {
      const dw = workerClient();
      const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
      const b = createDetAnalyzer(v, { makeCanvas, storage: null, glare: false, detectWorker: dw, frames: "auto", track: camTrack() });
      const o = await b.analyzeAsync(0);
      assert.equal(o.timing.path, "main");
      assert.equal(b.path, "main");
      assert.deepEqual(dw.calls, ["detect"]);
    } finally { globalThis.MediaStreamTrackProcessor = saved; }
  });
});

// The analysis clone (0.6.2-beta.3): a clone of the camera track constrained to the work size, shown
// in a hidden <video>, is what the analyzer draws; the 4K video is never read per frame.
describe("frame path 'clone' (work frame from a small clone of the camera track)", () => {
  const W = 1080, H = 1920, q = placeCard(W * 0.45, H * 0.52, W * 0.55, 6, 0.01);
  const frames = [1, 2, 3].map((n) => {
    const img = background("cloth", W, H, 21);
    drawCard(img, makeCard(21), q);
    return addNoise(img, n, 4);
  });
  const ws = workSize(W, H);
  // the clone's frame = the video frame at the work size (what crop-and-scale delivers)
  const small = (img, w = ws.W, h = ws.H) => {
    const c = makeCanvas(w, h);
    c.getContext().drawImage({ frame: img }, 0, 0, w, h);
    return { w, h, d: c.getContext().getImageData(0, 0, w, h).data };
  };
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  let savedMS;
  before(() => { savedMS = globalThis.MediaStream; globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } }; });
  after(() => { globalThis.MediaStream = savedMS; });

  /** A camera track whose clone() obeys applyConstraints ({width, height} ideal); `bad` changes the original too. */
  function camTrack({ bad = false, noClone = false, settings = { width: W, height: H } } = {}) {
    const t = {
      readyState: "live", settings: { ...settings }, applied: [], clones: [],
      getSettings() { return { ...this.settings }; },
      async applyConstraints(c) { this.applied.push(c); },
    };
    if (!noClone) {
      t.clone = () => {
        const c = {
          stopped: false, settings: { ...t.settings, resizeMode: "none" },
          getSettings() { return { ...this.settings }; },
          async applyConstraints(k) {
            this.settings = { ...this.settings, width: k.width.ideal, height: k.height.ideal, resizeMode: k.resizeMode };
            if (bad) t.settings = { ...t.settings, width: k.width.ideal, height: k.height.ideal };
          },
          stop() { this.stopped = true; },
        };
        t.clones.push(c);
        return c;
      };
    }
    return t;
  }
  /** The hidden clone <video>: srcObject set -> it shows `size(track)` frames; rVFC driven by the test. */
  function cloneVideo({ size = (tr) => [tr.settings.width, tr.settings.height] } = {}) {
    return {
      videoWidth: 0, videoHeight: 0, frame: null, cbs: [], played: 0, attrs: {},
      _src: null,
      get srcObject() { return this._src; },
      set srcObject(s) {
        this._src = s;
        if (s) [this.videoWidth, this.videoHeight] = size(s.tracks[0]);
        else this.videoWidth = this.videoHeight = 0;
      },
      play() { this.played++; return Promise.resolve(); },
      pause() {},
      setAttribute(k, val) { this.attrs[k] = val; },
      requestVideoFrameCallback(cb) { this.cbs.push(cb); return this.cbs.length; },
      fire() { const cbs = this.cbs.splice(0); for (const cb of cbs) cb(); },
    };
  }

  test("draws the clone, never the 4K video; same analysis as the video's work frame; the beacon info", async () => {
    const tr = camTrack(), cv = cloneVideo();
    const vA = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const vB = { videoWidth: W, videoHeight: H, frame: frames[0] };
    let t = 1000;
    const a = createDetAnalyzer(vA, { makeCanvas, storage: null, glare: false });
    const b = createDetAnalyzer(vB, { makeCanvas, storage: null, glare: false, frames: "auto", chromium: true, track: tr, cloneVideo: cv, now: () => t });
    const first = b.analyze(t); // starts the clone; this frame still comes from the video
    assert.equal(first.timing.path, "main");
    delete vB.frame; // from now on a read of the 4K video would throw
    await tick();
    assert.equal(tr.clones.length, 1);
    assert.deepEqual(tr.clones[0].settings, { width: ws.W, height: ws.H, resizeMode: "crop-and-scale" });
    assert.deepEqual(tr.settings, { width: W, height: H }, "the original keeps its size");
    assert.equal(cv.attrs.playsinline, "");
    assert.equal(b.grabInfo().clone.state, "ready");
    a.analyze(t);
    for (let i = 0; i < 8; i++) {
      t = 1100 + i * 125;
      cv.frame = small(frames[i % 3]);
      cv.fire();
      vA.frame = frames[i % 3];
      const oa = a.analyze(t), ob = b.analyze(t);
      for (const k of ["found", "weak", "accepted", "stable", "mode", "blank", "sharp"]) assert.deepEqual(ob[k], oa[k], `${k} @${i}`);
      assert.deepEqual(ob.corners, oa.corners, `corners in video px @${i}`);
      assert.equal(ob.timing.path, "clone");
    }
    const info = b.grabInfo();
    assert.equal(info.path, "clone");
    assert.equal(info.why, null);
    assert.deepEqual([info.clone.w, info.clone.h, info.clone.ask_w, info.clone.ask_h], [ws.W, ws.H, ws.W, ws.H]);
    assert.deepEqual([info.clone.ow0, info.clone.oh0, info.clone.ow1, info.clone.oh1], [W, H, W, H]);
    assert.equal(info.clone.resize, "crop-and-scale");
    assert.ok(info.clone.frames >= 8 && Number.isFinite(info.clone.setup_ms));
    b.close();
    assert.equal(tr.clones[0].stopped, true);
    assert.equal(cv.srcObject, null);
  });

  test("the size is asked in the track's own convention (landscape settings for a portrait video)", async () => {
    const tr = camTrack({ settings: { width: H, height: W } }), cv = cloneVideo({ size: (c) => [c.settings.height, c.settings.width] });
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const b = createDetAnalyzer(v, { makeCanvas, storage: null, glare: false, frames: "clone", track: tr, cloneVideo: cv });
    b.analyze(0);
    await tick();
    assert.deepEqual([tr.clones[0].settings.width, tr.clones[0].settings.height], [ws.H, ws.W]);
    assert.equal(b.grabInfo().clone.state, "ready");
    assert.equal(b.path, "clone");
  });

  test("falls back to the video for good: original resized (and restored), not scaled, other view, unsupported", async () => {
    const cases = [
      [{ bad: true }, {}, "clone:orig-changed"],
      [{}, { size: () => [W, H] }, "clone:not-scaled"],
      [{}, { size: () => [ws.W, Math.round(ws.W * 1.5)] }, "clone:aspect"],
      [{ noClone: true }, {}, "clone:unsupported"],
    ];
    for (const [to, vo, why] of cases) {
      const tr = camTrack(to), cv = cloneVideo(vo);
      const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
      const b = createDetAnalyzer(v, { makeCanvas, storage: null, glare: false, frames: "clone", track: tr, cloneVideo: cv });
      b.analyze(0);
      await tick();
      const o = b.analyze(125);
      assert.equal(o.timing.path, "main", why);
      assert.deepEqual([b.path, b.grabInfo().why], ["main", why]);
      if (tr.clones.length) assert.equal(tr.clones[0].stopped, true, `${why}: clone stopped`);
      if (to.bad) assert.deepEqual(tr.applied.at(-1), { width: { ideal: W }, height: { ideal: H } }, "the original's size asked back");
    }
  });

  test("auto off Chromium never clones; a clone that stops delivering frames is dropped (no stale frames)", async () => {
    const tr0 = camTrack(), cv0 = cloneVideo();
    const v0 = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const b0 = createDetAnalyzer(v0, { makeCanvas, storage: null, glare: false, frames: "auto", chromium: false, track: tr0, cloneVideo: cv0 });
    b0.analyze(0);
    await tick();
    assert.equal(tr0.clones.length, 0);
    assert.notEqual(b0.path, "clone");
    assert.equal(b0.grabInfo().clone, null);

    let t = 0;
    const tr = camTrack(), cv = cloneVideo();
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const b = createDetAnalyzer(v, { makeCanvas, storage: null, glare: false, frames: "clone", track: tr, cloneVideo: cv, now: () => t });
    b.analyze(t);
    await tick();
    cv.frame = small(frames[1]);
    cv.fire();
    t = 500;
    assert.equal(b.analyze(t).timing.path, "clone");
    t = 1600; // no clone frame for 1.6 s: this frame from the video
    assert.equal(b.analyze(t).timing.path, "main");
    assert.equal(b.path, "clone");
    t = 3600;
    assert.equal(b.analyze(t).timing.path, "main");
    assert.deepEqual([b.path, b.grabInfo().why], ["main", "clone:stalled"]);
    assert.equal(tr.clones[0].stopped, true);
  });

  /** RGBA {w, h, d} turned clockwise by rot (0/90/180/270). */
  const rotateRgba = (img, rot) => {
    const { w, h, d } = img, r = ((rot % 360) + 360) % 360, ow = r === 90 || r === 270 ? h : w, oh = r === 90 || r === 270 ? w : h;
    const out = new Uint8ClampedArray(d.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [nx, ny] = r === 90 ? [h - 1 - y, x] : r === 270 ? [y, w - 1 - x] : r === 180 ? [w - 1 - x, h - 1 - y] : [x, y];
      out.set(d.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * ow + nx) * 4);
    }
    return { w: ow, h: oh, d: out };
  };

  // Pixel 9 / Chrome 155 (0.7.0-beta.1 beacon): the clone of a portrait 2160x3840 track came as 853x480
  // landscape. The rotation is checked once on gray thumbnails, then the clone is drawn turned.
  for (const rot of [90, 270]) {
    test(`a landscape clone of a portrait video (turned ${rot} deg) is drawn turned: same corners in video px`, async () => {
      const tr = camTrack(), cv = cloneVideo({ size: (c) => [c.settings.height, c.settings.width] });
      const vA = { videoWidth: W, videoHeight: H, frame: frames[0] };
      const vB = { videoWidth: W, videoHeight: H, frame: frames[0] };
      let t = 1000;
      const a = createDetAnalyzer(vA, { makeCanvas, storage: null, glare: false });
      const b = createDetAnalyzer(vB, { makeCanvas, storage: null, glare: false, frames: "clone", track: tr, cloneVideo: cv, now: () => t });
      b.analyze(t);
      await tick();
      assert.deepEqual([cv.videoWidth, cv.videoHeight], [ws.H, ws.W], "the clone is landscape");
      assert.equal(b.grabInfo().clone.state, "verify");
      assert.equal(b.grabInfo().clone.rel, "swapped");
      // the clone shows the video turned the other way (rotating it by `rot` gives the video's view)
      const cloneFrame = (img) => rotateRgba(small(img), 360 - rot);
      cv.frame = cloneFrame(frames[0]);
      t = 1050;
      cv.fire();
      const o1 = b.analyze(t); // this frame from the video; the rotation is checked on it
      assert.equal(o1.timing.path, "main");
      const info = b.grabInfo().clone;
      assert.equal(info.state, "ready", JSON.stringify(info));
      assert.equal(info.rot, rot);
      assert.ok(info.rot_margin >= 0.2 && info.rot_score >= 0.5, JSON.stringify(info));
      delete vB.frame; // from now on a read of the 4K video would throw
      a.analyze(1000);
      a.analyze(t);
      for (let i = 0; i < 8; i++) {
        t = 1100 + i * 125;
        cv.frame = cloneFrame(frames[i % 3]);
        cv.fire();
        vA.frame = frames[i % 3];
        const oa = a.analyze(t), ob = b.analyze(t);
        assert.equal(ob.timing.path, "clone");
        for (const k of ["found", "accepted", "stable", "mode", "blank", "sharp"]) assert.deepEqual(ob[k], oa[k], `${k} @${i}`);
        assert.deepEqual(ob.corners, oa.corners, `corners in video px @${i}`);
      }
      assert.ok(b.analyze(t).found);
      assert.deepEqual(tr.applied, [], "the original track is never constrained");
      b.close();
    });
  }

  test("a rotation that stays unclear (flat scene) falls back to the video: clone:rotation-unclear", async () => {
    let t = 0;
    const flat = { w: W, h: H, d: new Uint8ClampedArray(W * H * 4).fill(128) };
    const tr = camTrack(), cv = cloneVideo({ size: (c) => [c.settings.height, c.settings.width] });
    const v = { videoWidth: W, videoHeight: H, frame: flat };
    const b = createDetAnalyzer(v, { makeCanvas, storage: null, glare: false, frames: "clone", track: tr, cloneVideo: cv, now: () => t });
    b.analyze(t);
    await tick();
    cv.frame = rotateRgba(small(flat), 90);
    for (let i = 0; i < 40 && b.path === "clone"; i++) { t += 150; cv.fire(); assert.equal(b.analyze(t).timing.path, "main"); }
    assert.deepEqual([b.path, b.grabInfo().why], ["main", "clone:rotation-unclear"]);
    assert.equal(b.grabInfo().clone.rot_why, "flat");
    assert.equal(tr.clones[0].stopped, true);
  });

  test("a clone that turns into the swapped size later is checked again before it is used", async () => {
    let t = 1000;
    const tr = camTrack();
    const cv = cloneVideo();
    const v = { videoWidth: W, videoHeight: H, frame: frames[0] };
    const b = createDetAnalyzer(v, { makeCanvas, storage: null, glare: false, frames: "clone", track: tr, cloneVideo: cv, now: () => t });
    b.analyze(t);
    await tick();
    cv.frame = small(frames[0]);
    cv.fire();
    t += 100;
    assert.equal(b.analyze(t).timing.path, "clone");
    assert.equal(b.grabInfo().clone.rot, 0);
    // the clone now reports landscape (as after a device-reported orientation flip)
    [cv.videoWidth, cv.videoHeight] = [ws.H, ws.W];
    cv.frame = rotateRgba(small(frames[0]), 90);
    t += 100;
    cv.fire();
    assert.equal(b.analyze(t).timing.path, "main", "checked on the video frame first");
    assert.equal(b.grabInfo().clone.rot, 270);
    t += 100;
    cv.fire();
    assert.equal(b.analyze(t).timing.path, "clone");
  });

  test("cloneRelation: same, swapped (within 1 %) or another view", () => {
    assert.equal(cloneRelation(480, 853, 2160, 3840), "same");
    assert.equal(cloneRelation(853, 480, 2160, 3840), "swapped");
    assert.equal(cloneRelation(640, 480, 2160, 3840), null);
    assert.equal(cloneRelation(0, 0, 2160, 3840), null);
  });

  test("cloneToWork: a clone point turned by 90/270 lands on the video's point (work px / s = 4K px)", () => {
    const VW4 = 2160, VH4 = 3840, w = workSize(VW4, VH4), cw = w.H, ch = w.W; // landscape clone 853x480
    for (const [px, py] of [[100, 200], [2000, 3700], [1080, 1920], [0, 0]]) {
      // the video point in work px, and where it sits in a clone turned the other way
      const wx = px * w.s, wy = py * w.s;
      const in270 = [wy, w.W - wx]; // clone = video turned 270 deg clockwise: (x, y) -> (y, W - x)
      const in90 = [w.H - wy, wx]; // clone = video turned 90 deg clockwise: (x, y) -> (H - y, x)
      for (const [rot, [cx, cy]] of [[90, in270], [270, in90]]) {
        const [x, y] = cloneToWork(rot, cx, cy, cw, ch, w.W, w.H);
        assert.ok(Math.abs(x / w.s - px) < 1e-6 && Math.abs(y / w.s - py) < 1e-6, `${rot}: ${[x / w.s, y / w.s]} vs ${[px, py]}`);
      }
    }
    assert.deepEqual(cloneToWork(0, 10, 20, 480, 853, 480, 853), [10, 20]);
  });

  test("cloneMatches: same orientation and aspect within 1 %", () => {
    assert.equal(cloneMatches(480, 853, 2160, 3840), true);
    assert.equal(cloneMatches(853, 480, 2160, 3840), false);
    assert.equal(cloneMatches(480, 640, 2160, 3840), false);
    assert.equal(cloneMatches(0, 0, 2160, 3840), false);
  });
});

// The rotated clone's check (0.7.0-beta.2): gray thumbnails of the clone and the video frame.
describe("chooseCloneRotation", () => {
  // a 16x28 portrait "scene": smooth blobs + a bright corner patch (not symmetric), seeded noise
  const rand = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const scene = (w, h, seed) => {
    const r = rand(seed), d = new Float32Array(w * h);
    const blobs = Array.from({ length: 5 }, () => [r() * w, r() * h, 2 + r() * 5, 40 + r() * 120]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 60 + (x < w * 0.3 && y < h * 0.25 ? 90 : 0);
      for (const [bx, by, br, bv] of blobs) v += bv * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * br * br));
      d[y * w + x] = v;
    }
    return { w, h, d };
  };
  const noisy = (g, amp, seed) => { const r = rand(seed); return { w: g.w, h: g.h, d: g.d.map((v) => v + (r() - 0.5) * 2 * amp) }; };

  test("finds 90 and 270 for a swapped clone and 0 for a same-size one, with noise and gain", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const video = noisy(scene(16, 28, seed), 8, seed + 100);
      for (const rot of [0, 90, 270]) {
        // the clone shows the video turned the other way, with its own noise and exposure
        const raw = rotateGray(scene(16, 28, seed), (360 - rot) % 360);
        const clone = noisy({ ...raw, d: raw.d.map((v) => v * 0.8 + 15) }, 8, seed + 200 + rot);
        const res = chooseCloneRotation(clone, video);
        assert.equal(res.rot, rot, `seed ${seed} rot ${rot}: ${JSON.stringify(res)}`);
        assert.ok(res.margin >= 0.2 && res.score >= 0.5, JSON.stringify(res));
      }
    }
  });

  test("unclear: flat, symmetric (90 vs 270 alike), unrelated or another size -> rot null", () => {
    const flat = { w: 28, h: 16, d: new Float32Array(28 * 16).fill(100) };
    assert.equal(chooseCloneRotation(flat, scene(16, 28, 3)).why, "flat");
    // point-symmetric scene: turned by 90 or by 270 look the same
    const s = scene(16, 28, 4), sym = { w: 16, h: 28, d: s.d.map((v, i) => v + s.d[s.d.length - 1 - i]) };
    const r1 = chooseCloneRotation(rotateGray(sym, 270), sym);
    assert.equal(r1.rot, null);
    assert.equal(r1.why, "margin");
    // another scene
    const r2 = chooseCloneRotation(rotateGray(noisy(scene(16, 28, 9), 30, 1), 90), scene(16, 28, 5));
    assert.equal(r2.rot, null, JSON.stringify(r2));
    assert.equal(chooseCloneRotation(scene(20, 20, 1), scene(16, 28, 1)).why, "size");
  });

  test("grayThumb area-averages RGBA; rotateGray turns clockwise", () => {
    const img = { w: 4, h: 2, d: new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 0, 0, 0, 255, 0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 0, 0, 0, 255]) };
    const g = grayThumb(img, 2, 1);
    assert.ok(Math.abs(g.d[0] - 50) < 0.01 && Math.abs(g.d[1] - 100) < 0.01, String(g.d));
    const m = { w: 3, h: 2, d: Float32Array.from([1, 2, 3, 4, 5, 6]) };
    assert.deepEqual([...rotateGray(m, 90).d], [4, 1, 5, 2, 6, 3]);
    assert.deepEqual([...rotateGray(m, 270).d], [3, 6, 2, 5, 1, 4]);
    assert.deepEqual([...rotateGray(m, 180).d], [6, 5, 4, 3, 2, 1]);
  });
});

describe("stripSharpness and grabRegions", () => {
  test("stripSharpness: a card's collector strip is sharp, an empty box's isn't, outside the image 0", () => {
    const W = 480, H = 853, q = placeCard(W * 0.5, H * 0.5, W * 0.6, 0, 0);
    const img = background("cloth", W, H, 5);
    drawCard(img, makeCard(5), q);
    const flat = { w: W, h: H, d: new Uint8ClampedArray(W * H * 4).fill(230) };
    assert.ok(stripSharpness(img, q) > 40, String(stripSharpness(img, q)));
    assert.ok(stripSharpness(flat, q) < 1);
    assert.equal(stripSharpness(img, q.map(([x, y]) => [x + 2 * W, y])), 0);
  });

  test("grabRegions reads the source once; the same pixels as one read per region (scale 1 and scaled)", () => {
    const VW2 = 2160, VH2 = 3840, quad = placeCard(VW2 / 2, VH2 / 2, VW2 * 0.7, 2, 0.004);
    const img = background("cloth", VW2, VH2, 3);
    drawCard(img, makeCard(3), quad);
    let reads = 0;
    const src = { frame: img };
    const mk = (w, h) => {
      const c = makeCanvas(w, h), ctx = c.getContext(), draw = ctx.drawImage.bind(ctx);
      ctx.drawImage = (s2, ...a) => { if (s2 === src) reads++; return draw(s2, ...a); };
      return c;
    };
    const still = { w: VW2, h: VH2 };
    const pc = regionPlan(still, quad, null, 1000, 1.3), ps = regionPlan(still, quad, { x0: -0.03, y0: 0.85, x1: 1.03, y1: 1.04 }, 4000, 1);
    assert.ok(pc.k < 1 && ps.k === 1, `${pc.k} ${ps.k}`);
    const [ci, si] = grabRegions(src, [pc, ps], mk);
    assert.equal(reads, 1, "one read of the camera frame");
    const one = (p) => {
      const c = makeCanvas(p.dw, p.dh);
      c.getContext().drawImage({ frame: img }, p.x, p.y, p.w, p.h, 0, 0, p.dw, p.dh);
      return c.getContext().getImageData(0, 0, p.dw, p.dh).data;
    };
    assert.deepEqual([ci.w, ci.h, si.w, si.h], [pc.dw, pc.dh, ps.dw, ps.dh]);
    assert.deepEqual(si.d, one(ps));
    assert.deepEqual(ci.d, one(pc));
    // no plan at scale 1: each region is read on its own (a scaled union would differ)
    reads = 0;
    const p2 = regionPlan(still, quad, null, 500, 1);
    grabRegions(src, [p2, p2], mk);
    assert.equal(reads, 2);
  });
});

describe("captureCard with a frame source (cfg.crop)", () => {
  const video = () => ({ videoWidth: VW, videoHeight: VH, frame: scene });
  const pixelsLog = () => {
    const calls = [];
    return { calls, available: () => true, call: async (op, payload) => { calls.push({ op, payload }); return op === "probe" ? { card: "Q0FSRA==", strip: "U1RSSVA=" } : null; } };
  };
  const readRect = (r) => {
    const c = makeCanvas(r.dw, r.dh);
    c.getContext().drawImage({ frame: scene }, r.x, r.y, r.w, r.h, 0, 0, r.dw, r.dh);
    return { w: r.dw, h: r.dh, d: c.getContext().getImageData(0, 0, r.dw, r.dh).data };
  };

  test("card + strip regions come from crop(): the same pixels and quads as the page's read, nothing read here", async () => {
    const ref = pixelsLog(), viaCrop = pixelsLog();
    await captureCard(video(), null, QUAD, { preferPhoto: false, makeCanvas, pixels: ref });
    let rects = null;
    const shot = await captureCard({ videoWidth: VW, videoHeight: VH }, null, QUAD, {
      preferPhoto: false, makeCanvas, pixels: viaCrop, crop: async (rs) => { rects = rs; return rs.map(readRect); },
    });
    assert.equal(rects.length, 2);
    assert.equal(shot.crop, true);
    assert.equal(shot.ms.grab, 0);
    const p = viaCrop.calls[0].payload, r = ref.calls[0].payload;
    for (const k of ["card", "strip"]) {
      assert.deepEqual([p[k].img.w, p[k].img.h], [r[k].img.w, r[k].img.h], k);
      assert.deepEqual(p[k].q, r[k].q, k);
      assert.deepEqual(p[k].img.d, r[k].img.d, k);
      assert.deepEqual([p[k].outW, p[k].outH], [r[k].outW, r[k].outH], k);
    }
  });

  test("crop() without a frame (null) or failing: the page reads the regions itself", async () => {
    for (const crop of [async () => null, async () => { throw new Error("gone"); }]) {
      const px = pixelsLog();
      const shot = await captureCard(video(), null, QUAD, { preferPhoto: false, makeCanvas, pixels: px, crop });
      assert.equal(shot.crop, false);
      assert.equal(px.calls[0].op, "probe");
      assert.ok(px.calls[0].payload.card.img.w > 600);
    }
  });
});

describe("camera plan (Android 1440p + no clone, else 4K)", () => {
  const PIXEL_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

  test("isAndroid: userAgentData.platform, else the UA string", () => {
    assert.equal(isAndroid({ userAgentData: { platform: "Android" }, userAgent: DESKTOP_UA }), true);
    assert.equal(isAndroid({ userAgentData: { platform: "Windows" }, userAgent: DESKTOP_UA }), false);
    assert.equal(isAndroid({ userAgent: PIXEL_UA }), true);
    assert.equal(isAndroid({ userAgent: IPHONE_UA }), false);
    assert.equal(isAndroid({ userAgent: DESKTOP_UA }), false);
    assert.equal(isAndroid(null), false);
    assert.equal(isAndroid({ get userAgentData() { throw new Error("x"); } }), false);
  });

  test("cameraPlan: Android 1440p + main path, else 4K + auto; params win", () => {
    assert.deepEqual(cameraPlan({ android: true }), { android: true, res: "1440", width: 2560, height: 1440, why: "android", frames: "main", frames_why: "android" });
    assert.deepEqual(cameraPlan({ android: false }), { android: false, res: "4k", width: 3840, height: 2160, why: "default", frames: "auto", frames_why: "default" });
    assert.deepEqual(cameraPlan(), cameraPlan({ android: false }));
    const forced = cameraPlan({ android: true, res: "4k", frames: "clone" });
    assert.equal(forced.res, "4k"); assert.equal(forced.width, 3840); assert.equal(forced.why, "param");
    assert.equal(forced.frames, "clone"); assert.equal(forced.frames_why, "param");
    assert.equal(cameraPlan({ android: false, res: "1080" }).height, 1080);
    assert.equal(cameraPlan({ android: false, res: "1440" }).width, 2560);
    // unknown values fall back to the platform default
    assert.equal(cameraPlan({ android: true, res: "8k", frames: "nope" }).res, "1440");
    assert.equal(cameraPlan({ android: true, res: "toString" }).res, "1440");
    assert.equal(cameraPlan({ android: true, frames: "auto" }).frames, "main");
    assert.equal(cameraPlan({ android: false, frames: "main" }).frames_why, "param");
    assert.deepEqual(Object.keys(CAMERA_RESOLUTIONS).sort(), ["1080", "1440", "4k"]);
  });

  test("openCamera asks for the plan's size first, keeps the fallback chain, reports which try opened", async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const calls = [];
    let failFirst = false;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async (c) => { calls.push(c.video); if (failFirst && calls.length === 1) throw Object.assign(new Error("over"), { name: "OverconstrainedError" }); return { id: calls.length }; } } },
    });
    try {
      const info = {};
      const plan = cameraPlan({ android: true });
      await openCamera({ width: plan.width, height: plan.height, info });
      assert.equal(calls[0].width.ideal, 2560); assert.equal(calls[0].height.ideal, 1440);
      assert.equal(info.try, 0);
      calls.length = 0; failFirst = true;
      const info2 = {};
      await openCamera({ width: 2560, height: 1440, info: info2 });
      assert.equal(info2.try, 1);
      assert.equal(calls[1].width.ideal, 1920);
    } finally {
      if (desc) Object.defineProperty(globalThis, "navigator", desc); else delete globalThis.navigator;
    }
  });

  test("1440p portrait: the probe strip is read 1:1 (never upscaled) and stays ~950 px wide", () => {
    // a card filling ~62 % of the short side of a portrait 1440x2560 frame (the box/free-hand framing)
    const vw = 1440, vh = 2560, w = 0.62 * vw, h = w * 88 / 63, x = (vw - w) / 2, y = (vh - h) / 2;
    const q = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const r = CAPTURE_DEFAULTS.stripRegion;
    const sw = Math.round(Math.max(200, Math.min(CAPTURE_DEFAULTS.stripMaxWidth, (regionQuad(q, r)[1][0] - regionQuad(q, r)[0][0]))));
    assert.ok(sw >= 900 && sw <= 1000, `strip ${sw}`);
    const ps = regionPlan({ w: vw, h: vh }, q, r, sw, 1);
    // k <= 1 always (regionPlan never upscales the read); here ~1: the strip keeps the source's pixels
    assert.ok(ps.k <= 1 && ps.k > 0.99, `k ${ps.k}`);
    assert.ok(Math.abs(ps.dw - ps.w) <= 1);
  });
});
