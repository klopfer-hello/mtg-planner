// Synthetic test images for the fingerprint tests (fingerprint, fphash,
// matcher-worker): deterministic per seed, no files.

/** A "card art" RGB raster: background + 14 ellipses/rectangles + a shading ramp. */
export function synth(seed, w = 146, h = 204) {
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
