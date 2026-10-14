// public/fphash.js: the browser/server shared hash must stay byte-identical to
// the implementation that lib/fingerprint.js had before the move (frozen copy
// below), because every stored reference fingerprint was built with it.
// Procedural cards only.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fph from "../public/fphash.js";
import { FP_BYTES, areaResample, hashCard, hashQuery, score } from "../lib/fingerprint.js";

// --- frozen pre-move implementation (lib/fingerprint.js, v0.4) ---------------
const L = (() => {
  const WORDS = 22;
  const BOX = { full: [0.03, 0.03, 0.97, 0.97], art: [0.12, 0.13, 0.88, 0.52] };
  const SHIFTS = [-0.02, 0, 0.02], SCALES = [0.97, 1, 1.03], QUERY_W = 488, QUERY_H = 680;
  function areaResample(img, [x0, y0, x1, y1], ow, oh) {
    const { width: w, height: h, channels: ch, data: d } = img;
    const out = new Float32Array(ow * oh * 3);
    const X0 = x0 * w, Y0 = y0 * h, sx = ((x1 - x0) * w) / ow, sy = ((y1 - y0) * h) / oh;
    const g = ch === 1 ? 0 : 1, b = ch === 1 ? 0 : 2;
    for (let oy = 0; oy < oh; oy++) {
      const ya = Y0 + oy * sy, yb = ya + sy;
      for (let ox = 0; ox < ow; ox++) {
        const xa = X0 + ox * sx, xb = xa + sx;
        let r = 0, gg = 0, bb = 0, wt = 0;
        for (let y = Math.floor(ya); y < Math.ceil(yb); y++) {
          const fy = Math.min(yb, y + 1) - Math.max(ya, y);
          const yy = Math.min(h - 1, Math.max(0, y));
          for (let x = Math.floor(xa); x < Math.ceil(xb); x++) {
            const fx = Math.min(xb, x + 1) - Math.max(xa, x);
            const xx = Math.min(w - 1, Math.max(0, x));
            const f = fx * fy, i = (yy * w + xx) * ch;
            r += d[i] * f; gg += d[i + g] * f; bb += d[i + b] * f; wt += f;
          }
        }
        const o = (oy * ow + ox) * 3;
        out[o] = r / wt; out[o + 1] = gg / wt; out[o + 2] = bb / wt;
      }
    }
    return out;
  }
  const toGray = (p) => {
    const o = new Float32Array(p.length / 3);
    for (let i = 0; i < o.length; i++) o[i] = 0.299 * p[i * 3] + 0.587 * p[i * 3 + 1] + 0.114 * p[i * 3 + 2];
    return o;
  };
  function dhashInto(u, bit, px, w, h, stride = 1, off = 0) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++, bit++) {
        if (px[(y * w + x) * stride + off] < px[(y * w + x + 1) * stride + off]) u[bit >> 5] |= 1 << (bit & 31);
      }
    }
    return bit;
  }
  const variantBox = (b, dx, dy, sc) => {
    const cx = (b[0] + b[2]) / 2 + dx, cy = (b[1] + b[3]) / 2 + dy;
    const hw = ((b[2] - b[0]) / 2) * sc, hh = ((b[3] - b[1]) / 2) * sc;
    return [cx - hw, cy - hh, cx + hw, cy + hh];
  };
  function hashAt(img, dx = 0, dy = 0, sc = 1) {
    const u = new Uint32Array(WORDS);
    const full = variantBox(BOX.full, dx, dy, sc);
    dhashInto(u, 0, toGray(areaResample(img, full, 17, 16)), 17, 16);
    dhashInto(u, 256, toGray(areaResample(img, variantBox(BOX.art, dx, dy, sc), 17, 16)), 17, 16);
    const c = areaResample(img, full, 9, 8);
    let bit = 512;
    for (let ch = 0; ch < 3; ch++) bit = dhashInto(u, bit, c, 9, 8, 3, ch);
    return Buffer.from(u.buffer, u.byteOffset, 88);
  }
  function hashQuery(pixels) {
    let img = pixels;
    if (img.width > QUERY_W * 1.25 || img.height > QUERY_H * 1.25) {
      img = { width: QUERY_W, height: QUERY_H, channels: 3, data: areaResample(img, [0, 0, 1, 1], QUERY_W, QUERY_H) };
    }
    const out = [];
    for (const dx of SHIFTS) for (const dy of SHIFTS) for (const sc of SCALES) out.push(hashAt(img, dx, dy, sc));
    return out;
  }
  const pc = (x) => {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
  };
  const asWords = (h) => (h instanceof Uint32Array ? h : new Uint32Array(Uint8Array.from(h).buffer));
  function score(a, b) {
    const A = asWords(a), B = asWords(b);
    let f = 0, r = 0, c = 0;
    for (let k = 0; k < 8; k++) f += pc((A[k] ^ B[k]) >>> 0);
    for (let k = 8; k < 16; k++) r += pc((A[k] ^ B[k]) >>> 0);
    for (let k = 16; k < 22; k++) c += pc((A[k] ^ B[k]) >>> 0);
    return (3 * f + 3 * r + 4 * c) / 2304;
  }
  return { areaResample, hashAt, hashQuery, score };
})();

// --- procedural inputs (same generator as test/fingerprint.test.js) -----------
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

// Same pixels as RGBA (canvas ImageData layout, alpha varied: it must be ignored).
function toRgba(img) {
  const n = img.width * img.height, data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = img.data[i * 3]; data[i * 4 + 1] = img.data[i * 3 + 1]; data[i * 4 + 2] = img.data[i * 3 + 2];
    data[i * 4 + 3] = (i * 37) & 255;
  }
  return { width: img.width, height: img.height, channels: 4, data };
}

const toGray = (img) => {
  const n = img.width * img.height, data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = (img.data[i * 3] * 3 + img.data[i * 3 + 1] * 5 + img.data[i * 3 + 2] * 2) / 10;
  return { width: img.width, height: img.height, channels: 1, data };
};

const bytes = (u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
// Small cards, the query size, and an oversize one that takes the downscale path.
const SIZES = [[146, 204], [244, 340], [488, 680], [700, 980]];

describe("fphash parity with the pre-move implementation", () => {
  test("constants", () => {
    assert.equal(fph.FP_BYTES, 88);
    assert.equal(FP_BYTES, fph.FP_BYTES);
    assert.equal(fph.WORDS, 22);
    assert.deepEqual([fph.QUERY_W, fph.QUERY_H], [488, 680]);
  });

  test("hashCard: RGB, RGBA and gray are byte-identical, Buffer type kept", () => {
    for (const [w, h] of SIZES) {
      for (let seed = 1; seed <= 4; seed++) {
        const rgb = synth(seed * 11 + w, w, h);
        for (const img of [rgb, toRgba(rgb), toGray(rgb)]) {
          const want = L.hashAt(img);
          const got = hashCard(img);
          assert.ok(Buffer.isBuffer(got));
          assert.equal(got.length, FP_BYTES);
          assert.ok(got.equals(want), `hashCard ${w}x${h} seed ${seed} ch ${img.channels}`);
          const raw = fph.hashAt(img);
          assert.ok(raw instanceof Uint32Array && raw.length === 22);
          assert.ok(bytes(raw).equals(want), `fphash.hashAt ${w}x${h} ch ${img.channels}`);
        }
        // RGBA must hash exactly like the same RGB pixels.
        assert.ok(hashCard(toRgba(rgb)).equals(hashCard(rgb)));
      }
    }
  });

  test("hashQuery: 27 variants in the same order, byte-identical (RGB and RGBA)", () => {
    for (const [w, h] of SIZES) {
      const rgb = synth(w + h, w, h);
      for (const img of [rgb, toRgba(rgb)]) {
        const want = L.hashQuery(img);
        const got = hashQuery(img);
        assert.equal(got.length, 27);
        got.forEach((b, i) => {
          assert.ok(Buffer.isBuffer(b));
          assert.ok(b.equals(want[i]), `variant ${i} ${w}x${h} ch ${img.channels}`);
        });
        const raw = fph.hashQuery(img);
        assert.equal(raw.length, 27);
        raw.forEach((u, i) => assert.ok(bytes(u).equals(want[i])));
      }
    }
  });

  test("hashQuery variants option: 27 default, 9 = shift grid at scale 1, others refused", () => {
    const img = synth(5);
    const all = fph.hashQuery(img);
    assert.equal(fph.hashQuery(img, { variants: 27 }).length, 27);
    const nine = fph.hashQuery(img, { variants: 9 });
    assert.equal(nine.length, 9);
    // In the 27 order (dx, dy, scale) the scale-1 entries are every third, starting at 1.
    nine.forEach((u, i) => assert.deepEqual([...u], [...all[i * 3 + 1]]));
    assert.deepEqual([...nine[4]], [...fph.hashAt(img)], "centre of the grid is the reference hash");
    assert.equal(hashQuery(img, { variants: 9 }).length, 9);
    assert.throws(() => fph.hashQuery(img, { variants: 3 }), /variants/);
  });

  test("areaResample is unchanged", () => {
    const img = synth(9, 300, 420);
    for (const box of [[0, 0, 1, 1], [0.03, 0.03, 0.97, 0.97], [-0.05, 0.1, 0.9, 1.04]]) {
      for (const [ow, oh] of [[17, 16], [9, 8], [244, 340]]) {
        assert.deepEqual(areaResample(img, box, ow, oh), L.areaResample(img, box, ow, oh));
        assert.deepEqual(fph.areaResample(toRgba(img), box, ow, oh), L.areaResample(img, box, ow, oh));
      }
    }
  });

  test("score matches for Buffer, Uint8Array and Uint32Array inputs", () => {
    const hs = [1, 2, 3, 4, 5, 6].map((s) => L.hashAt(synth(s)));
    hs.push(...L.hashQuery(synth(7)).slice(0, 6));
    for (const a of hs) {
      for (const b of hs) {
        const want = L.score(a, b);
        assert.equal(score(a, b), want);
        assert.equal(fph.score(new Uint8Array(a), b), want);
        assert.equal(fph.score(fph.asWords(a), fph.asWords(b)), want);
      }
    }
    assert.equal(score(hs[0], hs[0]), 0);
  });

  test("popcount", () => {
    for (const x of [0, 1, 0xffffffff, 0x80000000, 0x55555555, 0x12345678]) {
      assert.equal(fph.pc(x >>> 0), (x >>> 0).toString(2).replace(/0/g, "").length);
    }
  });
});
