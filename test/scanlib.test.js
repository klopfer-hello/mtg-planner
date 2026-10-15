// Browser capture module (public/scanlib.js): the auto-capture state machine
// is pure, so it runs under node:test without a DOM. The v2 (detector A2)
// analyzer runs on a tiny canvas shim over procedural frames (no photos).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AutoCapture, CAPTURE_DEFAULTS, DET_BLANK_SHARP, DET_STORAGE_KEY, SOUND_DEFAULTS, captureAdvice, chooseScanSound, createDetAnalyzer,
  createScanSounds, glareMap, mapToPhoto, photoMapping, quadSize, scanDetVersion, warpQuad, workSize,
} from "../public/scanlib.js";
import { CaptureController, ProbeController } from "../public/capture.js";
import { hashAt, score } from "../public/fphash.js";
import { PRIOR_STORAGE_KEY } from "../public/det/track.mjs";
import { addNoise, background, drawCard, makeCard, placeCard } from "./helpers/detscenes.js";

const thumb = (v) => ({ w: 64, h: 64, d: new Uint8Array(64 * 64).fill(v) });
const corners = [[100, 100], [400, 100], [400, 520], [100, 520]];
const art = (bit) => Uint8Array.from({ length: 64 }, (_, i) => (i % 2 === bit ? 1 : 0));

function feed(ac, frames, start = 0) {
  const caps = [];
  frames.forEach((f, i) => {
    const r = ac.step({ now: start + i * 125, guideW: 300, sharp: 200, corners: f.found ? corners : null, ...f });
    if (r.capture) caps.push(i);
  });
  return caps;
}

test("a brief detection dropout (weak quad) never re-captures the same card", () => {
  const ac = new AutoCapture();
  const card = { found: true, thumb: thumb(120), artHash: art(0) };
  const caps = feed(ac, [
    ...Array(8).fill(card),
    ...Array(3).fill({ found: false, weak: true, thumb: thumb(118) }),
    ...Array(4).fill({ found: false, weak: false, thumb: thumb(121) }), // card not detected, scene unchanged
    ...Array(8).fill(card),
  ]);
  assert.equal(caps.length, 1);
  assert.equal(ac.state, "cooldown");
});

test("the card leaving the frame (or another card swapped in) re-arms", () => {
  const ac = new AutoCapture();
  const card = { found: true, thumb: thumb(120), artHash: art(0) };
  const empty = { found: false, weak: false, thumb: thumb(30) };
  const next = { found: true, thumb: thumb(160), artHash: art(1) };
  assert.equal(feed(ac, [...Array(8).fill(card), ...Array(8).fill(empty), ...Array(8).fill(card)]).length, 2);
  const swap = new AutoCapture();
  assert.equal(feed(swap, [...Array(8).fill(card), ...Array(8).fill(next)]).length, 2);
});

// ---------------------------------------------------------------------------
// v2 helpers

/** Map-backed Storage stand-in; `fail` makes every call throw (blocked storage). */
function memStorage(init = {}, fail = false) {
  const m = new Map(Object.entries(init));
  const guard = () => { if (fail) throw new Error("SecurityError"); };
  return {
    m,
    getItem: (k) => { guard(); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { guard(); m.set(k, String(v)); },
    removeItem: (k) => { guard(); m.delete(k); },
  };
}

// Bilinear point sampling at output pixel centres (what drawImage does when scaling).
function resample(src, sx, sy, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4), { w, h, d } = src, kx = sw / dw, ky = sh / dh;
  for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
    let x = sx + (i + 0.5) * kx - 0.5, y = sy + (j + 0.5) * ky - 0.5;
    x = Math.min(w - 1.001, Math.max(0, x)); y = Math.min(h - 1.001, Math.max(0, y));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, a = (y0 * w + x0) * 4, b = a + w * 4, o = (j * dw + i) * 4;
    for (let c = 0; c < 3; c++) {
      out[o + c] = (d[a + c] * (1 - fx) + d[a + 4 + c] * fx) * (1 - fy) + (d[b + c] * (1 - fx) + d[b + 4 + c] * fx) * fy;
    }
    out[o + 3] = 255;
  }
  return out;
}

/** Minimal 2D canvas: drawImage (5- and 9-argument forms) + getImageData. drawMs sums the shim's own time. */
function shim() {
  const stats = { drawMs: 0, draws: 0 };
  const srcOf = (s) => (s.frame ? s.frame : { w: s.width, h: s.height, d: s.buf });
  const mk = (w, h) => {
    const c = { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
    c.buf = new Uint8ClampedArray(c.width * c.height * 4);
    const ctx = {
      drawImage(src, ...a) {
        const t0 = performance.now(), S = srcOf(src);
        let sx = 0, sy = 0, sw = S.w, sh = S.h, dw, dh;
        if (a.length === 4) [, , dw, dh] = a; else [sx, sy, sw, sh, , , dw, dh] = a;
        dw = Math.round(dw); dh = Math.round(dh);
        const px = resample(S, sx, sy, sw, sh, dw, dh);
        for (let y = 0; y < Math.min(dh, c.height); y++) c.buf.set(px.subarray(y * dw * 4, (y * dw + Math.min(dw, c.width)) * 4), y * c.width * 4);
        stats.drawMs += performance.now() - t0; stats.draws++;
      },
      getImageData(x, y, w2, h2) {
        const data = new Uint8ClampedArray(w2 * h2 * 4);
        for (let r = 0; r < h2; r++) data.set(c.buf.subarray(((y + r) * c.width + x) * 4, ((y + r) * c.width + x + w2) * 4), r * w2 * 4);
        return { width: w2, height: h2, data };
      },
    };
    c.getContext = () => ctx;
    return c;
  };
  return { mk, stats };
}

const cardW = (q) => Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
const maxErr = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

const sceneCache = new Map();
/** A video-sized RGBA frame: `kind` box|cloth background with a card (or none). */
function frame(key, w, h, kind, cardSeed, quad, noiseSeed = 1) {
  const k = `${key}|${noiseSeed}`;
  if (!sceneCache.has(k)) {
    const img = background(kind, w, h, cardSeed || 5);
    if (quad) drawCard(img, makeCard(cardSeed), quad);
    sceneCache.set(k, addNoise(img, noiseSeed, 4));
  }
  return sceneCache.get(k);
}

describe("scanDetVersion", () => {
  test("URL beats storage and is remembered; storage beats the default; v2 by default", () => {
    const st = memStorage();
    assert.equal(scanDetVersion({ search: "", storage: st }), "v2");
    assert.equal(scanDetVersion({ search: "?det=v1", storage: st }), "v1");
    assert.equal(st.m.get(DET_STORAGE_KEY), "v1");
    assert.equal(scanDetVersion({ search: "?tab=scan", storage: st }), "v1", "a PWA start without the query keeps v1");
    assert.equal(scanDetVersion({ search: "?det=v2&x=1", storage: st }), "v2");
    assert.equal(scanDetVersion({ search: "", storage: st }), "v2");
    assert.equal(scanDetVersion({ search: "", storage: memStorage({ [DET_STORAGE_KEY]: "v1" }) }), "v1");
  });

  test("junk values, blocked or missing storage fall back safely", () => {
    assert.equal(scanDetVersion({ search: "?det=v9", storage: memStorage({ [DET_STORAGE_KEY]: "garbage" }) }), "v2");
    assert.equal(scanDetVersion({ search: "?det=v1", storage: memStorage({}, true) }), "v1");
    assert.equal(scanDetVersion({ search: "", storage: memStorage({}, true) }), "v2");
    assert.equal(scanDetVersion({ search: "", storage: null }), "v2");
    assert.equal(scanDetVersion({ storage: null }), "v2", "no location in node");
  });
});

describe("chooseScanSound", () => {
  const scan = (match_status, price) => ({ scan: { id: 1, match_status, status: "staged" }, duplicate: false, result: { status: match_status, price_eur: price } });
  const cases = [
    ["auto, no price", scan("auto", null), {}, "success"],
    ["auto, cheap", scan("auto", 0.25), {}, "success"],
    ["auto, exactly the default threshold", scan("auto", 5), {}, "cash"],
    ["suggest, valuable", scan("suggest", 12.5), {}, "cash"],
    ["confirmed, just below", scan("confirmed", 4.99), {}, "success"],
    ["review", scan("review", 50), {}, null],
    ["failed (staged in calibration)", scan("failed", 50), {}, null],
    ["manual is not a scan result", scan("manual", 50), {}, null],
    ["duplicate prompt", { ...scan("auto", 50), duplicate: true }, {}, null],
    ["nothing staged", { scan: null, duplicate: false, result: { status: "failed" } }, {}, null],
    ["custom threshold", scan("auto", 3), { threshold: 2 }, "cash"],
    ["threshold as a string (number input)", scan("auto", 3), { threshold: "2.5" }, "cash"],
    ["empty threshold = default", scan("auto", 3), { threshold: "" }, "success"],
    ["junk threshold = default", scan("auto", 6), { threshold: "abc" }, "cash"],
    ["zero threshold: every priced card", scan("auto", 0.01), { threshold: 0 }, "cash"],
    ["sounds off", scan("auto", 50), { enabled: false }, null],
    ["+1 (flag)", { increment: true, price_eur: 7 }, {}, "cash"],
    ["+1 (scan row), no price", { id: 3, match_status: "review", last_action: "increment" }, {}, "success"],
    ["+1 while off", { increment: true, price_eur: 7 }, { enabled: false }, null],
    ["garbage", null, {}, null],
  ];
  for (const [name, res, settings, want] of cases) {
    test(name, () => assert.equal(chooseScanSound(res, settings), want));
  }
  test("defaults are on with €5", () => assert.deepEqual({ ...SOUND_DEFAULTS }, { enabled: true, threshold: 5 }));
});

describe("createScanSounds", () => {
  test("no AudioContext: unlock and play are silent no-ops", async () => {
    const s = createScanSounds({ AudioContext: undefined });
    await s.unlock();
    s.play("success"); s.play("cash"); s.play("nope");
  });

  test("a throwing AudioContext never breaks the caller", async () => {
    const s = createScanSounds({ AudioContext: function Boom() { throw new Error("no audio"); } });
    await s.unlock();
    s.play("cash");
  });

  test("success = two oscillators; cash = noise bursts + bell partials; resumes a suspended context", async () => {
    const log = [];
    const param = () => ({ setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    const node = (kind) => ({ kind, connect() {}, start(t) { log.push([kind, "start", t]); }, stop() {}, frequency: param(), gain: param(), type: "" });
    class FakeAC {
      constructor() { this.state = "suspended"; this.currentTime = 1; this.sampleRate = 8000; this.destination = {}; }
      async resume() { this.state = "running"; log.push(["resume"]); }
      createOscillator() { return node("osc"); }
      createGain() { return node("gain"); }
      createBiquadFilter() { return node("filter"); }
      createBufferSource() { return node("src"); }
      createBuffer(ch, n) { const d = new Float32Array(n); return { getChannelData: () => d }; }
    }
    const s = createScanSounds({ AudioContext: FakeAC });
    await s.unlock();
    assert.ok(log.some((e) => e[0] === "resume"));
    log.length = 0;
    s.play("success");
    assert.equal(log.filter((e) => e[0] === "osc").length, 2);
    assert.equal(log.filter((e) => e[0] === "src").length, 0);
    log.length = 0;
    s.play("cash");
    assert.ok(log.filter((e) => e[0] === "osc").length >= 3, "bell partials");
    assert.equal(log.filter((e) => e[0] === "src").length, 2, "noise bursts");
  });
});

// ---------------------------------------------------------------------------
// mapToPhoto: still photo (Android takePhoto) with another aspect/FOV than the preview

describe("mapToPhoto", () => {
  // 9:16 preview, 3:4 photo: the photo sees more to the left and right
  const VW = 540, VH = 960, PW = 1512, PH = 2016;
  const m = photoMapping(PW, PH, VW, VH);
  const photoQuad = placeCard(PW * 0.5 + 40, PH * 0.52, PW * 0.5, 6, 0.01);
  let grabK = [];
  const photo = { width: PW, height: PH };
  const grab = (bmp, rect, k) => {
    grabK.push(k);
    const src = frame("photo", PW, PH, "cloth", 11, photoQuad), w = Math.round(rect.w * k), h = Math.round(rect.h * k);
    return { w, h, d: resample(src, rect.x, rect.y, rect.w, rect.h, w, h) };
  };
  const toVideo = (q, dx = 0, dy = 0) => q.map(([x, y]) => [(x - m.ox) / m.s + dx, (y - m.oy) / m.s + dy]);

  test("photoMapping: 4:3 photo from a 16:9 preview, same orientation required", () => {
    assert.deepEqual(m, { s: PH / VH, ox: (PW - VW * (PH / VH)) / 2, oy: 0 });
    const wide = photoMapping(1000, 2000, 540, 960); // narrower photo: crops top/bottom
    assert.ok(Math.abs(wide.s - 1000 / 540) < 1e-12 && wide.ox === 0 && wide.oy > 0);
    assert.equal(photoMapping(2016, 1512, VW, VH), null);
    assert.equal(photoMapping(0, 10, VW, VH), null);
  });

  test("v2 re-detects on a 1440 px copy and lands on the card (corners from a 2 % off video quad)", () => {
    grabK = [];
    const info = {};
    const q = mapToPhoto(photo, VW, VH, toVideo(photoQuad, 4, -3), { det: "v2", grab, info });
    assert.ok(q, `rejected: ${info.reason}`);
    assert.equal(grabK.length, 1);
    assert.ok(Math.abs(grabK[0] - 1440 / PH) < 1e-12, `k ${grabK[0]}`);
    const e = maxErr(q, photoQuad) / cardW(photoQuad);
    assert.ok(e < 0.015, `corner error ${(100 * e).toFixed(2)} % of the card width`);
    assert.ok(info.drift > 0 && info.drift < 0.08);
  });

  test("v2 keeps the caller's corner order (a card the tracker reads upside down)", () => {
    const rot = [2, 3, 0, 1].map((i) => photoQuad[i]);
    const q = mapToPhoto(photo, VW, VH, toVideo(rot), { det: "v2", grab });
    assert.ok(q);
    assert.ok(maxErr(q, rot) / cardW(photoQuad) < 0.015);
  });

  test("a photo no longer than 1440 px is not downscaled", () => {
    const small = { width: 1080, height: 1440 };
    const ks = [];
    const sq = placeCard(540, 760, 520, -4);
    const g = (bmp, rect, k) => {
      ks.push(k);
      const src = frame("photo-small", 1080, 1440, "cloth", 12, sq), w = Math.round(rect.w * k), h = Math.round(rect.h * k);
      return { w, h, d: resample(src, rect.x, rect.y, rect.w, rect.h, w, h) };
    };
    const mm = photoMapping(1080, 1440, VW, VH);
    const q = mapToPhoto(small, VW, VH, sq.map(([x, y]) => [(x - mm.ox) / mm.s, (y - mm.oy) / mm.s]), { det: "v2", grab: g });
    assert.deepEqual(ks, [1]);
    assert.ok(q && maxErr(q, sq) / cardW(sq) < 0.015);
  });

  test("a different FOV/scale than assumed (drift > 8 %) is rejected: the video frame is used", () => {
    // the preview really is a 1.25x zoomed crop: the mapped quad misses the card by far more than 8 %
    const info = {};
    const zoomed = photoQuad.map(([x, y]) => [(x - PW / 2) / 1.25 + PW / 2, (y - PH / 2) / 1.25 + PH / 2]);
    const q = mapToPhoto(photo, VW, VH, toVideo(zoomed), { det: "v2", grab, info });
    assert.equal(q, null);
    assert.equal(info.reason, "drift");
    assert.ok(info.drift > 0.08, `drift ${info.drift}`);
  });

  test("orientation mismatch is rejected before any re-detect", () => {
    grabK = [];
    const info = {};
    assert.equal(mapToPhoto({ width: PH, height: PW }, VW, VH, toVideo(photoQuad), { det: "v2", grab, info }), null);
    assert.equal(info.reason, "orientation");
    assert.equal(grabK.length, 0);
  });

  test("v1 keeps the findCard re-detect at 720 px wide", () => {
    grabK = [];
    const q = mapToPhoto(photo, VW, VH, toVideo(photoQuad, 3, 2), { det: "v1", grab });
    assert.ok(Math.abs(grabK[0] - 720 / PW) < 1e-12);
    if (q) assert.ok(maxErr(q, photoQuad) / cardW(photoQuad) < 0.03);
  });
});

// ---------------------------------------------------------------------------
// createDetAnalyzer on a fake video + canvas shim

describe("createDetAnalyzer", () => {
  const VW = 720, VH = 1280;
  const boxQ = placeCard(VW / 2 + 6, VH / 2 - 10, VW * 0.62, 0.8, 0.005);
  const clothQ = placeCard(VW * 0.42, VH * 0.55, VW * 0.5, 17, 0.02);
  const empty = () => frame("empty", VW, VH, "box", 0, null);
  const boxCard = (seed, n = 1) => frame(`box${seed}`, VW, VH, "box", seed, boxQ, n);

  function rig(opts = {}) {
    const { mk, stats } = shim();
    const video = { videoWidth: VW, videoHeight: VH, frame: empty() };
    let t = 0;
    const an = createDetAnalyzer(video, { makeCanvas: mk, storage: opts.storage ?? memStorage(), ...opts });
    const step = (img) => { video.frame = img; t += 125; return an.analyze(t); };
    return { an, video, step, stats };
  }

  test("work frame is 480 px on the short side", () => {
    assert.deepEqual(workSize(720, 1280), { W: 480, H: 853, s: 480 / 720 });
    assert.deepEqual(workSize(1920, 1080), { W: 853, H: 480, s: 480 / 1080 });
    assert.deepEqual(workSize(320, 240), { W: 320, H: 240, s: 1 });
  });

  test("returns null without video dimensions; a card on cloth is found, tracked and stable", () => {
    const { an, video, step } = rig();
    video.videoWidth = 0;
    assert.equal(an.analyze(0), null);
    video.videoWidth = VW;
    const img = frame("cloth", VW, VH, "cloth", 21, clothQ);
    let o = null;
    for (let i = 0; i < 8; i++) o = step(i % 2 ? img : frame("cloth", VW, VH, "cloth", 21, clothQ, 2));
    assert.ok(o.found && o.accepted && o.stable, JSON.stringify({ found: o.found, accepted: o.accepted, stable: o.stable }));
    assert.equal(o.weak, false);
    assert.ok(maxErr(o.corners, clothQ) / cardW(clothQ) < 0.03, "corners in full-res video px");
    assert.equal(o.vw, VW); assert.equal(o.vh, VH);
    assert.equal(o.thumb.length, 24 * 40);
    assert.equal(o.cardThumb.length, 12 * 16);
    assert.ok(o.sharp > 0);
    assert.ok(o.rawCorners && o.rawCorners.length === 4);
    assert.ok(o.jitter !== null && o.jitter < 0.04);
    assert.equal(o.priorLearned, false);
    assert.equal(o.priorQuad, null);
    assert.deepEqual(Object.keys(o.glare).sort(), ["advice", "code", "regions"]);
    assert.equal(o.glare.advice, null);
    assert.ok(Number.isFinite(o.ms));
    assert.deepEqual(an.captureOpts(), { det: "v2", preferPhoto: true });
  });

  test("an empty box: nothing found, no card thumbnail, no sharpness", () => {
    const { step } = rig();
    let o;
    for (let i = 0; i < 6; i++) o = step(empty());
    assert.equal(o.found, false);
    assert.equal(o.corners, null);
    assert.equal(o.cardThumb, null);
    assert.equal(o.sharp, null);
  });

  test("a tracked outline with a blank strip (the empty scan box) is no card; a card in the same outline is", () => {
    // a tracker that keeps reporting the box outline, as box mode does with a learned prior
    const tracker = { update: () => ({ corners: boxQ.map(([x, y]) => [x * (480 / VW), y * (480 / VW)]), seen: true, found: true, accepted: true, stable: true, jitter: 0, drift: 0 }), reset() {} };
    const { step } = rig({ tracker, glare: false });
    const o = step(empty());
    assert.ok(Number.isFinite(o.sharp) && o.sharp > 0 && o.sharp < DET_BLANK_SHARP, `empty box strip ${o.sharp}`);
    assert.equal(o.blank, true);
    assert.equal(o.found, false); assert.equal(o.accepted, false); assert.equal(o.stable, false);
    assert.equal(o.corners, null); assert.equal(o.cardThumb, null);
    assert.ok(o.rawCorners === null || o.rawCorners.length === 4);
    const c = step(boxCard(70));
    assert.ok(c.sharp >= DET_BLANK_SHARP, `card strip ${c.sharp}`);
    assert.equal(c.blank, false);
    assert.equal(c.found, true); assert.ok(c.corners && c.cardThumb);
  });

  test("hashCrop: 244x340 RGB from the full-res frame; same card ≈ 0, another card far", () => {
    const { an, step } = rig();
    step(boxCard(31));
    const a = an.hashCrop(boxQ);
    assert.equal(a.width, 244); assert.equal(a.height, 340); assert.equal(a.channels, 3);
    assert.equal(a.data.length, 244 * 340 * 3);
    const jit = boxQ.map(([x, y], i) => [x + (i % 2 ? 1.5 : -1), y + (i > 1 ? 1 : -1.5)]);
    step(boxCard(31, 2));
    const b = an.hashCrop(jit);
    step(boxCard(32));
    const c = an.hashCrop(boxQ);
    const dSame = score(hashAt(a), hashAt(b)), dOther = score(hashAt(a), hashAt(c));
    // the flat synthetic card flips dHash bits on sensor noise (real cards: ~0.015); the gap is what matters
    assert.ok(dSame < 0.1, `same ${dSame}`);
    assert.ok(dOther > 0.25 && dOther > 3 * dSame, `other ${dOther} vs same ${dSame}`);
    assert.equal(an.hashCrop(null), null);
    assert.equal(an.hashCrop([[-50, -50], [-10, -50], [-10, -10], [-50, -10]]), null, "outside the frame");
  });

  test("the box prior learns from captures, persists, restores in a new session and becomes the video source", () => {
    const storage = memStorage();
    const { an, step } = rig({ storage });
    let adds = 0;
    const add = an.prior.add.bind(an.prior);
    an.prior.add = (...a) => { adds++; return add(...a); };
    // three captures of cards in the box, each its own stable run (empty box in between)
    for (let c = 0; c < 3; c++) {
      let o;
      for (let i = 0; i < 6; i++) o = step(empty());
      for (let i = 0; i < 8; i++) o = step(boxCard(40 + c, 1 + (i & 1)));
      assert.ok(o.stable && o.accepted, `card ${c} stable`);
      an.savePrior(c === 0 ? o.corners : undefined);
      an.savePrior(); // a second call in the same run adds nothing
    }
    assert.ok(an.prior.learned, "learned after 3 consistent captures");
    assert.equal(adds, 3, "savePrior adds once per stable run");
    const saved = JSON.parse(storage.m.get(PRIOR_STORAGE_KEY));
    assert.equal(saved.v, 1);
    assert.ok(Math.abs(saved.center[0] - 0.5) < 0.05);

    const next = rig({ storage });
    assert.ok(next.an.prior.learned, "restored on create");
    const o = next.step(boxCard(50));
    assert.equal(o.priorLearned, true);
    assert.equal(o.mode, "box");
    assert.deepEqual(next.an.captureOpts(), { det: "v2", preferPhoto: false });
    next.an.forgetPrior();
    assert.equal(storage.m.has(PRIOR_STORAGE_KEY), false);
  });

  test("blocked storage never breaks the analyzer", () => {
    const { an, step } = rig({ storage: memStorage({}, true) });
    const o = step(boxCard(60));
    assert.ok(o);
    an.savePrior(); an.reset();
    assert.equal(an.loadPrior(), false);
  });

  test("glare: a specular highlight on the collector line is reported; the clean card is not", () => {
    const card = warpQuad(frame("box70", VW, VH, "box", 70, boxQ), boxQ, 500, 700);
    assert.equal(captureAdvice(glareMap(card), null), "ok");
    const d = new Uint8ClampedArray(card.d);
    // a clipped, soft-edged highlight across the bottom line (cx .5, cy .955)
    for (let y = 0; y < 700; y++) for (let x = 0; x < 500; x++) {
      const e = ((x - 250) / 60) ** 2 + ((y - 668) / 14) ** 2;
      if (e < 1) { const i = (y * 500 + x) * 4, v = e < 0.6 ? 255 : 250; d[i] = d[i + 1] = d[i + 2] = v; }
    }
    const g = glareMap({ w: 500, h: 700, d });
    assert.equal(captureAdvice(g, null), "glare-collector", JSON.stringify(g.regions));
  });

  test("the analyzer reports glare advice only after the card sat still for glareDelayMs", () => {
    const base = boxCard(71);
    const img = { w: base.w, h: base.h, d: new Uint8ClampedArray(base.d) };
    const at = (u, v) => [0, 1].map((k) => (1 - v) * ((1 - u) * boxQ[0][k] + u * boxQ[1][k]) + v * ((1 - u) * boxQ[3][k] + u * boxQ[2][k]));
    for (let v = 0.94; v <= 0.97; v += 0.0005) for (let u = 0.38; u <= 0.62; u += 0.0005) {
      if (((u - 0.5) / 0.12) ** 2 + ((v - 0.955) / 0.015) ** 2 >= 1) continue;
      const [x, y] = at(u, v), i = ((y | 0) * img.w + (x | 0)) * 4;
      img.d[i] = img.d[i + 1] = img.d[i + 2] = 255;
    }
    const { step } = rig();
    const seen = [];
    for (let i = 0; i < 16; i++) { const o = step(img); seen.push([o.stable, o.glare.code]); }
    const firstStable = seen.findIndex(([s]) => s), firstGlare = seen.findIndex(([, c]) => c !== "ok");
    assert.ok(firstStable >= 0 && firstGlare > firstStable, JSON.stringify(seen));
    assert.ok((firstGlare - firstStable) * 125 >= 800, "not before glareDelayMs");
    assert.equal(seen[seen.length - 1][1], "glare-collector");
  });

  test("glare: the type line counts for probes (limit 0.1), not for the stable-track hint", () => {
    const regions = { collector: 0, title: 0, art: 0.01, typeLine: 0.2, textBox: 0 };
    assert.equal(captureAdvice({ regions }, null), "glare-type");
    assert.equal(captureAdvice({ regions: { ...regions, typeLine: 0.09 } }, null), "ok");
    assert.equal(captureAdvice({ regions }, null, { typeLine: Infinity }), "ok");
    assert.equal(captureAdvice({ regions: { ...regions, art: 0.06 } }, null), "glare-art", "art first");
  });

  test("glareOf(quad) measures a probe crop at once (no stability wait); null without a quad", () => {
    const base = boxCard(72);
    const img = { w: base.w, h: base.h, d: new Uint8ClampedArray(base.d) };
    const at = (u, v) => [0, 1].map((k) => (1 - v) * ((1 - u) * boxQ[0][k] + u * boxQ[1][k]) + v * ((1 - u) * boxQ[3][k] + u * boxQ[2][k]));
    for (let v = 0.94; v <= 0.97; v += 0.0005) for (let u = 0.38; u <= 0.62; u += 0.0005) {
      if (((u - 0.5) / 0.12) ** 2 + ((v - 0.955) / 0.015) ** 2 >= 1) continue;
      const [x, y] = at(u, v), i = ((y | 0) * img.w + (x | 0)) * 4;
      img.d[i] = img.d[i + 1] = img.d[i + 2] = 255;
    }
    const { an, step } = rig();
    step(img);
    const g = an.glareOf(boxQ);
    assert.equal(g.code, "glare-collector", JSON.stringify(g));
    assert.match(g.advice, /Reflection on the bottom line/);
    assert.ok(g.regions.collector > 0.004 && Number.isFinite(g.fraction));
    step(boxCard(72));
    const clean = an.glareOf(boxQ);
    assert.equal(clean.code, "ok");
    assert.equal(clean.advice, null);
    assert.equal(an.glareOf(null), null);
  });

  test("end to end with CaptureController: an empty box, then two different cards = two uploads", () => {
    const { an, step } = rig();
    const ctl = new CaptureController({ crop: (o, quad) => an.hashCrop(quad) });
    const caps = [];
    const run = (img, n) => {
      for (let i = 0; i < n; i++) {
        const o = step(img);
        const out = ctl.step(o);
        if (out.capture) {
          caps.push(out.capture);
          const item = ctl.captured(out.capture, { n: caps.length });
          if (item) ctl.uploaded(item.id, 100 + caps.length);
          an.savePrior();
        }
      }
    };
    run(empty(), 6);
    run(boxCard(80), 14);
    run(empty(), 6);
    run(boxCard(81), 14);
    assert.equal(caps.length, 2, JSON.stringify(caps.map((c) => [c.kind, c.rec && c.rec.d])));
    assert.ok(caps.every((c) => !c.fallback));
    assert.ok(caps.every((c) => maxErr(c.quad, boxQ) / cardW(boxQ) < 0.03));
    assert.ok(quadSize(caps[0].quad).w > 0);
    assert.equal(CAPTURE_DEFAULTS.workShort, 480);
  });

  test("end to end with ProbeController: an empty box sends no probes; each card still in the box is probed and staged once", () => {
    const { an, step } = rig();
    const pc = new ProbeController();
    const probes = [], staged = [];
    let lastKey = null, pending = null;
    const run = (img, key, n) => {
      for (let i = 0; i < n; i++) {
        const o = step(img);
        // the server answers one frame later (key null = nothing identifiable in the crop)
        if (pending) {
          const res = pending.key == null ? { outcome: "unidentified" } : pending.key === lastKey ? { outcome: "same" } : { outcome: "staged" };
          if (res.outcome === "staged") { lastKey = pending.key; staged.push(pending.key); an.savePrior(pending.quad); }
          pc.answer(pending.id, res, o.now);
          pending = null;
        }
        const r = pc.step(o);
        if (r.probe) { probes.push({ key, quad: r.probe.quad }); pending = { id: r.probe.id, key, quad: r.probe.quad }; }
      }
    };
    run(empty(), null, 16);
    assert.equal(probes.length, 0, "empty box: no requests");
    run(boxCard(80), 80, 20);
    run(empty(), null, 10);
    run(boxCard(81), 81, 20);
    assert.deepEqual(staged, [80, 81]);
    assert.ok(probes.every((p) => p.key !== null), "never an empty-box probe");
    assert.ok(probes.every((p) => maxErr(p.quad, boxQ) / cardW(boxQ) < 0.03));
  });
});
