// Scanner work off the main thread: the worker client (scanlib createScanWorker)
// on a fake Worker, the worker module's ops (public/scanworker.js, loaded with a
// stand-in `self`; node has no OffscreenCanvas, so its raw-RGBA path runs),
// captureCard through a worker and inline, analyzeAsync vs analyze, and the
// small pure helpers. Procedural frames only.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  bytesToBase64, captureCard, createDetAnalyzer, createScanWorker, glareMap, glareSummary, warpQuad,
} from "../public/scanlib.js";
import { detect } from "../public/det/detect.mjs";
import { addNoise, background, drawCard, makeCard, placeCard } from "./helpers/detscenes.js";

// ---------------------------------------------------------------------------
// helpers

/** Canvas stand-in: drawImage (5/9 args, nearest sample), get/putImageData, toBlob (fake bytes), toDataURL. */
function makeCanvas(w, h) {
  const c = { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), blobs: 0 };
  c.buf = new Uint8ClampedArray(c.width * c.height * 4);
  const ctx = {
    drawImage(src, ...a) {
      const S = src.frame ? src.frame : { w: src.width, h: src.height, d: src.buf };
      let sx = 0, sy = 0, sw = S.w, sh = S.h, dw, dh;
      if (a.length === 4) [, , dw, dh] = a; else [sx, sy, sw, sh, , , dw, dh] = a;
      dw = Math.round(dw); dh = Math.round(dh);
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
    const b = createDetAnalyzer(vB, { makeCanvas, storage: null, glare: false, detectWorker: dw, frames: "auto", track: camTrack() });
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
      assert.ok(Number.isFinite(ob.timing.wgrab) && Number.isFinite(ob.timing.wsharp));
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
