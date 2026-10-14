// det/orientfeat.mjs: features for the 180-degree orientation classifier.
//
// Why it exists: shared by detect.mjs and the (out-of-repo) training script,
// so the weights in orientw.mjs always see the same features. Input: the card
// rectified to 2W x 2H RGB (planar Float32Arrays, short side horizontal).
// Output: 4 z-scored W x H layouts (luma, gradient magnitude, horizontal
// structure |gy|-|gx| = text lines / title bar, saturation), concatenated.
// Every channel is invariant to a 180-degree rotation per cell, so the
// rotated card's features are each channel's cells in reverse order, which
// makes orientScore() antisymmetric.

export const OW = 20, OH = 28, NF = 4 * OW * OH;

/** Feature vector (NF floats) of a rectified card; R, G, B are 2*OW x 2*OH planes. */
export function orientFeatures(R, G, B, out = new Float32Array(NF)) {
  const W2 = 2 * OW, H2 = 2 * OH, n = OW * OH;
  out.fill(0);
  const L = new Float32Array(W2 * H2);
  for (let i = 0; i < L.length; i++) L[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    const i = y * W2 + x, xm = x > 0 ? i - 1 : i, xp = x < W2 - 1 ? i + 1 : i, ym = y > 0 ? i - W2 : i, yp = y < H2 - 1 ? i + W2 : i;
    const j = (y >> 1) * OW + (x >> 1);
    const gx = L[xp] - L[xm], gy = L[yp] - L[ym];
    out[j] += L[i];
    out[n + j] += Math.sqrt(gx * gx + gy * gy);
    out[2 * n + j] += Math.abs(gy) - Math.abs(gx);
    out[3 * n + j] += Math.max(R[i], G[i], B[i]) - Math.min(R[i], G[i], B[i]);
  }
  for (let c = 0; c < 4; c++) {
    let m = 0;
    for (let j = 0; j < n; j++) m += out[c * n + j];
    m /= n;
    let s = 0;
    for (let j = 0; j < n; j++) { const v = out[c * n + j] - m; out[c * n + j] = v; s += v * v; }
    s = Math.sqrt(s / n) || 1;
    for (let j = 0; j < n; j++) out[c * n + j] /= s;
  }
  return out;
}

/** Antisymmetric score: > 0 means upright, < 0 means rotated 180 degrees. */
export function orientScore(f, w) {
  const n = OW * OH;
  let s = 0;
  for (let c = 0; c < 4; c++) { const o = c * n; for (let j = 0; j < n; j++) s += w[o + j] * (f[o + j] - f[o + n - 1 - j]); }
  return s;
}
