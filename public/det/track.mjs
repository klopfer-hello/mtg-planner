// det/track.mjs: temporal layer on top of detect.mjs (browser ES module, no deps).
//
// Why it exists: single-frame detections flicker between nested outlines
// (inner frame, card edge, box rim) and jitter by a few pixels, which would
// make captures land on the wrong outline or never settle. This layer turns
// the per-frame results into a steady track and learns where a scan box keeps
// the card, so detect() can be constrained to it. From the scanner research
// (detector "A2"); within a session it behaves like the validated research
// version. New here: the learned box is saved per device and unlearned.
//
//   QuadTracker  per-frame detections -> smoothed corners + `stable`; robust
//                per-corner median over a short window, hysteresis between
//                competing outlines (a different outline must win switchFrames
//                frames in a row), single-frame jumps rejected, corner order
//                (reading orientation) by vote.
//   BoxPrior     learns the scan-box prior from accepted captures: enables box
//                mode ('auto') once the last N captures were centred, near
//                axis-aligned and consistent in angle and position; opts() go
//                into detect(img, opts). toJSON()/restore() keep the learned
//                box per device (localStorage PRIOR_STORAGE_KEY); UNLEARN_AFTER
//                accepted captures in a row outside it forget it again.
//   cardHash     content signature of the card's art window (z-scored 10x8
//                cell grid, plus the 180-degree reading); hashDist = 1 - corr.
//   frameThumb   tiny luma thumbnail for the motion signal (thumbDiff = MAD).

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cardW = (q) => Math.min((dist(q[0], q[1]) + dist(q[2], q[3])) / 2, (dist(q[1], q[2]) + dist(q[3], q[0])) / 2);
const centre = (q) => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
const shiftQ = (q, s) => [0, 1, 2, 3].map((i) => q[(i + s) & 3]);
const maxD = (a, b) => Math.max(dist(a[0], b[0]), dist(a[1], b[1]), dist(a[2], b[2]), dist(a[3], b[3]));
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** Best cyclic shift s so that shiftQ(q, s) matches ref; returns {s, d (max corner distance)}. */
export function align(q, ref) {
  let best = { s: 0, d: Infinity };
  for (let s = 0; s < 4; s++) {
    let d = 0;
    for (let i = 0; i < 4; i++) d = Math.max(d, dist(q[(i + s) & 3], ref[i]));
    if (d < best.d) best = { s, d };
  }
  return best;
}

export class QuadTracker {
  constructor({ window = 5, gate = 0.05, switchFrames = 3, maxMiss = 4, stableFrames = 4, stableJitter = 0.04, stableDrift = 0.015, orientWindow = 9, useWeak = true, noise = 0.012 } = {}) {
    Object.assign(this, { window, gate, switchFrames, maxMiss, stableFrames, stableJitter, stableDrift, orientWindow, useWeak, noise });
    this.reset();
  }

  reset() {
    this.hist = [];     // recent accepted quads, aligned to the track's corner order
    this.cand = [];     // competing outline (hysteresis)
    this.raw = [];      // last raw detections (aligned), for the flicker-vs-motion test
    this.prevOff = null;
    this.miss = 0;
    this.shifts = [];   // per-detection order relative to the track (0 = same reading orientation, 2 = 180)
    this.smoothed = null;
    this.smHist = [];   // recent smoothed outputs (drift check)
    this.age = 0;
    this.jumps = 0;
  }

  /** det: detect() result scaled to the caller's coordinates ({found, corners}). Returns the track state. */
  update(det) {
    this.age++;
    // weak outlines (card-ish quad below the confidence bar) are tracked too (UI outline, box-prior learning);
    // `accepted` on the state says whether the current frame's detection reached the bar
    this.accepted = Boolean(det && det.found && det.corners);
    if (!det || !det.corners || !(det.found || (this.useWeak && det.weak))) {
      if (++this.miss > this.maxMiss) this.reset();
      return this.state(false);
    }
    this.miss = 0;
    const q = det.corners;
    if (!this.hist.length) { this.hist = [q]; this.shifts = [0]; this.smoothed = q; return this.state(true); }
    const ref = this.smoothed, cw = cardW(ref);
    const a = align(q, ref), qa = shiftQ(q, a.s);
    this.raw.push(qa); if (this.raw.length > 4) this.raw.shift();
    if (a.d <= this.gate * cw) {
      // within the gate. Small deviations are noise (median). A larger one is either flicker between two
      // outlines (it matches one of the last few raw detections: keep the median) or real motion (it matches
      // none of them: follow at once, so a moving card is not dragged behind)
      const cq = centre(qa), cs = centre(ref), off = [cq[0] - cs[0], cq[1] - cs[1]];
      const big = a.d > this.noise * cw;
      if (big && this.prevOff && this.prevOff[0] * off[0] + this.prevOff[1] * off[1] > 0 && maxD(this.raw[this.raw.length - 2], qa) <= this.gate * cw / 2) {
        // two consecutive detections displaced the same way: motion -> restart the window there
        this.hist = [this.raw[this.raw.length - 2]];
      }
      this.prevOff = big ? off : null;
      this.hist.push(qa); if (this.hist.length > this.window) this.hist.shift();
      this.shifts.push(a.s); if (this.shifts.length > this.orientWindow) this.shifts.shift();
      this.cand = [];
    } else {
      // jump: a different outline. Accept it only after switchFrames consistent frames.
      this.jumps++;
      const last = this.cand[this.cand.length - 1];
      if (last && align(q, last).d <= this.gate * cardW(last)) this.cand.push(shiftQ(q, align(q, last).s));
      else this.cand = [q];
      if (this.cand.length >= this.switchFrames) {
        this.hist = this.cand.slice(-this.window); this.cand = []; this.shifts = [0]; this.smHist = [];
      } else return this.state(true, true);
    }
    // robust smoothing: per-corner, per-coordinate median of the window
    this.smoothed = [0, 1, 2, 3].map((i) => [median(this.hist.map((h) => h[i][0])), median(this.hist.map((h) => h[i][1]))]);
    // reading orientation by vote: if most recent detections say "rotated 180 vs the track", re-base
    const n2 = this.shifts.filter((s) => s === 2).length;
    if (n2 * 2 > this.shifts.length && this.shifts.length >= 3) {
      this.smoothed = shiftQ(this.smoothed, 2);
      this.hist = this.hist.map((h) => shiftQ(h, 2));
      this.shifts = this.shifts.map((s) => (s + 2) & 3);
    }
    this.smHist.push(this.smoothed); if (this.smHist.length > this.stableFrames) this.smHist.shift();
    return this.state(true);
  }

  /**
   * stable: enough consistent frames, every raw detection of the last stableFrames within stableJitter and
   * the smoothed output moved less than stableDrift (fractions of the card width) over those frames.
   */
  state(seen, rejected = false) {
    const q = this.smoothed;
    let stable = false, jitter = Infinity, drift = Infinity;
    // a single rejected (jumped) frame does not destabilise a settled track; two in a row do
    if (q && this.hist.length >= this.stableFrames && this.cand.length <= (rejected ? 1 : 0) && this.miss === 0 && this.smHist.length >= this.stableFrames) {
      const cw = cardW(q);
      jitter = 0; drift = 0;
      for (const h of this.hist.slice(-this.stableFrames)) for (let i = 0; i < 4; i++) jitter = Math.max(jitter, dist(h[i], q[i]) / cw);
      for (const h of this.smHist) { const a = align(h, q); drift = Math.max(drift, a.d / cw); }
      stable = jitter <= this.stableJitter && drift <= this.stableDrift;
    }
    return { corners: q, found: Boolean(q) && this.miss <= this.maxMiss, accepted: Boolean(this.accepted), seen, rejected, stable, jitter, drift, n: this.hist.length };
  }
}

// ---------------------------------------------------------------------------

/** Rotation of the card's up axis vs image up, degrees clockwise (corners TL,TR,BR,BL). */
export function cardAngle(q) {
  const ux = (q[3][0] + q[2][0]) / 2 - (q[0][0] + q[1][0]) / 2, uy = (q[3][1] + q[2][1]) / 2 - (q[0][1] + q[1][1]) / 2; // top -> bottom
  return Math.atan2(-ux, uy) * 180 / Math.PI;
}

/** localStorage key under which the UI keeps BoxPrior.toJSON() per device. */
export const PRIOR_STORAGE_KEY = 'mtg.scan.prior';
/** Accepted captures in a row outside the learned box that make the prior forget it. */
export const UNLEARN_AFTER = 3;
const PRIOR_VERSION = 1;
const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isPt = (p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]);
const sameAspect = (w, h, aspect) => Math.abs(w / h - aspect) <= 0.03 * aspect;

export class BoxPrior {
  /**
   * mode: 'auto' (enable after `need` consistent captures), 'box' (always), 'free' (never).
   * Consistency: centres within centreTol * min(w,h) of their median, angles within angleTol of their median,
   * that angle within axisTol of a multiple of 90 deg, card centre within centredTol of the frame centre.
   *
   * Learned box (persisted per device): whenever the session's captures are consistent, their box is kept
   * as `learned` (frame-relative). A new session restores it and uses it until it has `need` captures of
   * its own; from then on the session's captures decide exactly as in the research version. An accepted
   * capture outside the learned box (centre > outsideTol * min(w,h) away, angle > outsideAngle deg off, or
   * size outside outsideScale x the learned size) counts towards forgetting it; unlearnAfter of those in a
   * row clear it (a capture inside resets the count). A restored, not yet confirmed box goes dormant (free
   * mode) after probeAfter frames passed to noteFrame() without any card outline, so cards lying elsewhere
   * (on a table) can be detected at all and then unlearn it.
   */
  constructor({ mode = 'auto', need = 3, keep = 6, centreTol = 0.05, angleTol = 4, axisTol = 8, centredTol = 0.2, scaleSlack = [0.9, 1.12], weight = 1,
    unlearnAfter = UNLEARN_AFTER, outsideTol = 0.12, outsideAngle = 10, outsideScale = [0.8, 1.25], probeAfter = 24, now = () => Date.now() } = {}) {
    Object.assign(this, { mode, need, keep, centreTol, angleTol, axisTol, centredTol, scaleSlack, weight, unlearnAfter, outsideTol, outsideAngle, outsideScale, probeAfter, now });
    this.caps = [];
    this.learned = null;    // {center:[fx,fy], angle, size, quad|null (frame fractions), aspect, confidence, learned_at}
    this.outside = 0;       // accepted captures in a row outside `learned`
    this.confirmed = false; // a capture of this session agreed with `learned`
    this.dormant = false;   // restored box unconfirmed and nothing seen in it for probeAfter frames
    this.misses = 0;
    this.revision = 0;      // bumps whenever `learned` changes (the caller persists toJSON() then)
  }

  setMode(mode) { this.mode = mode; }

  /** Record an accepted capture (corners in work-frame px, frame size w x h). */
  add(corners, w, h, boxMode = false) {
    this.push(corners, w, h, boxMode);
    this.judge(corners, w, h);
    this.learn();
  }

  /** Record a stable outline (accepted or weak) once per stable run; lets 'auto' enable before captures work well. */
  observe(corners, w, h) {
    this.push(corners, w, h, false);
    this.learn();
  }

  /** Per-frame hint (optional): det = the frame's detect() result. Lets an unconfirmed restored box go dormant. */
  noteFrame(det) {
    if (this.source !== 'learned' || this.confirmed) { this.misses = 0; return; }
    if (det && det.corners && (det.found || det.weak)) this.misses = 0;
    else if (++this.misses >= this.probeAfter) this.dormant = true;
  }

  /** @private */
  push(corners, w, h, boxMode) {
    this.caps.push({ c: centre(corners), a: cardAngle(corners), s: cardW(corners) / Math.min(w, h), w, h, q: corners, box: boxMode });
    if (this.caps.length > this.keep) this.caps.shift();
  }

  /** @private accepted capture vs the learned box: confirm it, or count towards forgetting it. */
  judge(corners, w, h) {
    const L = this.learned;
    if (!L) return;
    const m = Math.min(w, h), c = centre(corners), s = cardW(corners) / m;
    const inside = sameAspect(w, h, L.aspect) && dist(c, [L.center[0] * w, L.center[1] * h]) <= this.outsideTol * m
      && angDiff(cardAngle(corners), L.angle) <= this.outsideAngle
      && s >= L.size * this.outsideScale[0] && s <= L.size * this.outsideScale[1];
    if (inside) {
      this.outside = 0;
      this.confirmed = true; this.dormant = false; this.misses = 0;
      L.confidence++;
      return;
    }
    if (++this.outside >= this.unlearnAfter) {
      this.learned = null; this.outside = 0; this.confirmed = false; this.dormant = false; this.revision++;
    }
  }

  /** @private consistent session captures (re)define the learned box. */
  learn() {
    if (!this.consistent()) return;
    const r = this.caps.slice(-this.need), { w, h } = r[r.length - 1];
    const lastBox = [...this.caps].reverse().find((x) => x.box);
    const prev = this.learned;
    this.learned = {
      center: [median(r.map((x) => x.c[0])) / w, median(r.map((x) => x.c[1])) / h],
      angle: median(r.map((x) => x.a)),
      size: Math.max(...r.map((x) => x.s)),
      quad: lastBox && lastBox.w === w && lastBox.h === h ? lastBox.q.map(([x, y]) => [x / w, y / h]) : (prev && prev.quad) || null,
      aspect: w / h,
      confidence: Math.max(this.need, prev ? prev.confidence : 0),
      learned_at: new Date(this.now()).toISOString(),
    };
    this.outside = 0; this.confirmed = true; this.dormant = false;
    this.revision++;
  }

  consistent() {
    const r = this.caps.slice(-this.need);
    if (r.length < this.need) return false;
    const { w, h } = r[r.length - 1], m = Math.min(w, h);
    const mc = [median(r.map((x) => x.c[0])), median(r.map((x) => x.c[1]))];
    const ma = median(r.map((x) => x.a));
    const axis = Math.abs(((ma % 90) + 135) % 90 - 45);
    return r.every((x) => dist(x.c, mc) <= this.centreTol * m && Math.abs(x.a - ma) <= this.angleTol)
      && axis <= this.axisTol && dist(mc, [w / 2, h / 2]) <= this.centredTol * m;
  }

  /**
   * Where the box comes from: 'caps' (this session's captures, as in the research version), 'learned' (a
   * restored box while the session has fewer than `need` captures of its own), or null.
   */
  get source() {
    if (this.consistent()) return 'caps';
    if (this.learned && this.caps.length < this.need) return 'learned';
    return null;
  }

  get active() {
    if (this.mode === 'box') return true;
    if (this.mode !== 'auto') return false;
    const src = this.source;
    return src === 'caps' || (src === 'learned' && !this.dormant);
  }

  /** detect() options for the next frame: {mode:'box', prior} when active, else {} (free mode). */
  opts(w, h) {
    if (!this.active) return {};
    if (this.mode === 'auto' && this.source === 'learned') return this.learnedOpts(w, h);
    const r = this.caps.slice(-this.need);
    if (!r.length) return { mode: 'box' }; // manual toggle, nothing learned yet: detect's default box prior
    const center = [median(r.map((x) => x.c[0])), median(r.map((x) => x.c[1]))];
    // snap the learned angle to the nearest axis when it is close (a box guides the card)
    const a = median(r.map((x) => x.a)), ax = Math.round(a / 90) * 90;
    const angle = Math.abs(a - ax) <= 3 ? ax : a;
    // the stack grows: the card gets larger; allow some shrink (re-seated card) and generous growth
    const s = Math.max(...r.map((x) => x.s));
    // fallback outline for dark-frame cards: only a capture made in box mode (frame-anchored) qualifies
    const lastBox = [...this.caps].reverse().find((x) => x.box);
    return { mode: 'box', prior: { center, angle, scaleRange: [s * this.scaleSlack[0], Math.min(1.05, s * this.scaleSlack[1])], weight: this.weight, quad: lastBox ? lastBox.q : null } };
  }

  /** @private the restored box in this frame's px ({} = free when the frame's aspect differs, e.g. rotated). */
  learnedOpts(w, h) {
    const L = this.learned;
    if (!sameAspect(w, h, L.aspect)) return {};
    const a = L.angle, ax = Math.round(a / 90) * 90;
    const angle = Math.abs(a - ax) <= 3 ? ax : a, s = L.size;
    return { mode: 'box', prior: { center: [L.center[0] * w, L.center[1] * h], angle, scaleRange: [s * this.scaleSlack[0], Math.min(1.05, s * this.scaleSlack[1])],
      weight: this.weight, quad: this.learnedQuad(w, h) } };
  }

  /** The learned box's card outline in w x h frame px (a fallback capture quad), or null. */
  learnedQuad(w, h) {
    const L = this.learned;
    if (!L || !L.quad || !sameAspect(w, h, L.aspect)) return null;
    return L.quad.map(([x, y]) => [x * w, y * h]);
  }

  /** Persistable state {v, center, angle, size, quad, aspect, confidence, learned_at}, or null when nothing is learned. */
  toJSON() {
    const L = this.learned;
    if (!L) return null;
    return { v: PRIOR_VERSION, center: [...L.center], angle: L.angle, size: L.size, quad: L.quad ? L.quad.map((p) => [...p]) : null,
      aspect: L.aspect, confidence: L.confidence, learned_at: L.learned_at };
  }

  /** Restore toJSON() output (e.g. parsed from localStorage). Invalid input is ignored; returns whether it was used. */
  restore(data) {
    if (!data || typeof data !== 'object' || data.v !== PRIOR_VERSION) return false;
    const { center, angle, size, quad, aspect, confidence, learned_at } = data;
    if (!isPt(center) || center.some((v) => v < 0 || v > 1) || !finite(angle) || !finite(size) || !(size > 0 && size <= 1.5)
      || !finite(aspect) || !(aspect > 0)) return false;
    if (quad != null && !(Array.isArray(quad) && quad.length === 4 && quad.every(isPt))) return false;
    this.learned = { center: [...center], angle, size, quad: quad ? quad.map((p) => [...p]) : null, aspect,
      confidence: finite(confidence) && confidence > 0 ? confidence : this.need, learned_at: typeof learned_at === 'string' ? learned_at : null };
    this.outside = 0; this.confirmed = false; this.dormant = false; this.misses = 0;
    return true;
  }

  /** Forget the learned box and this session's captures. */
  forget() {
    this.caps = []; this.learned = null; this.outside = 0; this.confirmed = false; this.dormant = false; this.misses = 0; this.revision++;
  }
}

// ---------------------------------------------------------------------------

function sampleLum(img, x, y) {
  const { w, h, d } = img;
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = (y0 * w + x0) * 4, j = i + w * 4;
  const L = (o) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  return (L(i) * (1 - fx) + L(i + 4) * fx) * (1 - fy) + (L(j) * (1 - fx) + L(j + 4) * fx) * fy;
}

function bilerpQ(q, u, v) {
  // bilinear interpolation inside the quad (enough for a hash; the card is nearly fronto-parallel)
  const x = (1 - v) * ((1 - u) * q[0][0] + u * q[1][0]) + v * ((1 - u) * q[3][0] + u * q[2][0]);
  const y = (1 - v) * ((1 - u) * q[0][1] + u * q[1][1]) + v * ((1 - u) * q[3][1] + u * q[2][1]);
  return [x, y];
}

/**
 * Content signature of the card's art window: a 10x8 grid of cell means (3x3 samples each), z-scored,
 * plus the same for the card rotated 180 degrees. Compared by correlation (sigDist = 1 - max corr over
 * 0 / 180 degrees, 0 = identical, ~1 = unrelated): far more tolerant of 1-3 % corner jitter than a dHash,
 * whose bits flip wherever two neighbouring cells are nearly equal. corners: TL,TR,BR,BL in img px.
 */
export function cardHash(img, corners, GX = 10, GY = 8, region = [0.1, 0.12, 0.9, 0.55]) {
  // art window of a normal frame (the frame/text layout is shared by all cards and would dominate the
  // correlation); `r` = the same signature as if the card's corner order were rotated 180 degrees
  const grid = (rot) => {
    const S = 3, v = new Float32Array(GX * GY), [u0, v0, u1, v1] = region;
    for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
      let s = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        let u = u0 + (u1 - u0) * (gx + (sx + 0.5) / S) / GX, w = v0 + (v1 - v0) * (gy + (sy + 0.5) / S) / GY;
        if (rot) { u = 1 - u; w = 1 - w; }
        const p = bilerpQ(corners, u, w);
        s += sampleLum(img, p[0], p[1]);
      }
      v[gy * GX + gx] = s;
    }
    let m = 0; for (let i = 0; i < v.length; i++) m += v[i]; m /= v.length;
    let sd = 0; for (let i = 0; i < v.length; i++) { v[i] -= m; sd += v[i] * v[i]; }
    sd = Math.sqrt(sd / v.length) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= sd;
    return v;
  };
  return { h: grid(false), r: grid(true) };
}

/**
 * Signature distance (0 identical .. ~1 unrelated .. 2 inverted). rot180: also accept the card read rotated
 * by 180 degrees (only needed when the corner order may flip between captures; it doubles the chance that
 * two different arts look alike, so the capture trigger leaves it off - the tracker keeps the order stable).
 */
export function hashDist(a, b, rot180 = false) {
  let c0 = 0, c1 = 0;
  for (let i = 0; i < a.h.length; i++) { c0 += a.h[i] * b.h[i]; c1 += a.h[i] * b.r[i]; }
  return 1 - (rot180 ? Math.max(c0, c1) : c0) / a.h.length;
}

/** 24x40 luma thumbnail for the motion signal (cheap: point samples). */
export function frameThumb(img, TW = 24, TH = 40) {
  const t = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) t[y * TW + x] = sampleLum(img, (x + 0.5) * img.w / TW - 0.5, (y + 0.5) * img.h / TH - 0.5);
  return t;
}

/** Mean absolute difference of two frameThumb()s. */
export const thumbDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
