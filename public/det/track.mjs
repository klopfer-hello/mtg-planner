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
   *
   * Self-healing (an active box in 'auto' mode, learned or this session's): the box can be wrong while the
   * detector still "finds" a card in it (box mode reuses the learned outline, detect()'s anchor.fromPrior),
   * so nothing gets staged and add() never runs. Three signals put the box to sleep for the session
   * (dormant = free mode) and count as one capture outside (unlearnAfter of those, or of captures outside,
   * in a row forget it):
   *  - noteFree() gets a prior-free detect() the caller runs every few hundred ms:
   *    'reuse': disagreeAfter checks in a row where the box result is the reused outline of a card (not
   *    blank) and the free outline is confident and > freeDiff card widths away from it;
   *    'free': disagreeAfter checks in a row with a confident free outline outside the box (the judge
   *    criteria, either reading orientation) at the same place, which the box result doesn't match;
   *  - noteProbe() 'probes': failAfter unidentified probes in a row cropped from the box's reused outline
   *    while the latest free outline (<= freeFreshMs old) is confident and > freeDiff card widths away from the probe quad.
   * A box result within freeDiff of the free outline never counts: box mode then tracks the card.
   * Recorded box sessions (2026-10-14/15): the reused outline disagreed with a card's free outline > 0.1 in
   * single checks only; the wrong box of the iPhone recording (2026-10-17) in 179 of 186 box frames.
   * A later accepted capture inside the box wakes it again (judge), as for the noteFrame dormancy.
   */
  constructor({ mode = 'auto', need = 3, keep = 6, centreTol = 0.05, angleTol = 4, axisTol = 8, centredTol = 0.2, scaleSlack = [0.9, 1.12], weight = 1,
    unlearnAfter = UNLEARN_AFTER, outsideTol = 0.12, outsideAngle = 10, outsideScale = [0.8, 1.25], probeAfter = 24,
    disagreeAfter = 4, failAfter = 5, freeDiff = 0.1, freeFreshMs = 3000, now = () => Date.now() } = {}) {
    Object.assign(this, { mode, need, keep, centreTol, angleTol, axisTol, centredTol, scaleSlack, weight, unlearnAfter, outsideTol, outsideAngle, outsideScale, probeAfter,
      disagreeAfter, failAfter, freeDiff, freeFreshMs, now });
    this.caps = [];
    this.learned = null;    // {center:[fx,fy], angle, size, quad|null (frame fractions), aspect, confidence, learned_at}
    this.outside = 0;       // accepted captures in a row outside `learned`
    this.confirmed = false; // a capture of this session agreed with `learned`
    this.dormant = false;   // restored box unconfirmed and nothing seen in it for probeAfter frames
    this.misses = 0;
    this.revision = 0;      // bumps whenever `learned` or the strikes change (the caller persists toJSON() then)
    this.free = null;       // latest prior-free outline {at, found, quad, outside, w, h} (noteFree)
    this.disagree = 0;      // free checks in a row with a confident outline outside the box, same place
    this.reuse = 0;         // free checks in a row contradicting the box's reused outline
    this.fails = 0;         // unidentified probes in a row cropped from the box
    this.slept = null;      // why the box went dormant this session: 'empty' | 'reuse' | 'free' | 'probes' | null
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
    else if (++this.misses >= this.probeAfter) { this.dormant = true; this.slept = 'empty'; }
  }

  /** Is the self-healing watching? (an active box in 'auto' mode) */
  get watching() { return this.mode === 'auto' && Boolean(this.learned) && this.active; }

  /**
   * A prior-free detect() result `det` of a w x h frame at time `at` (while watching), with the same
   * frame's box result `box` {quad (w x h px | null), fromPrior (detect's anchor.fromPrior), card (a card,
   * not the blank box)}. Keeps it for noteProbe() and counts the 'reuse' and 'free' signals (see the
   * constructor). Returns true when this call put the box to sleep.
   */
  noteFree(det, w, h, at, box = null) {
    if (!this.watching) { this.disagree = 0; this.reuse = 0; this.free = null; return false; }
    const found = Boolean(det && det.found && det.corners);
    const quad = found ? det.corners : null;
    const outside = found && !this.inside(quad, w, h, true);
    const prev = this.free;
    this.free = { at, found, quad, outside, w, h };
    if (!found) return false;
    // the box result is the same outline: box mode tracks this card well, wherever it lies
    const agrees = Boolean(box && box.card && box.quad && align(quad, box.quad).d <= this.freeDiff * cardW(box.quad));
    if (box && box.card && box.quad) {
      if (box.fromPrior && !agrees) {
        if (++this.reuse >= this.disagreeAfter) { this.sleep('reuse'); return true; }
      } else this.reuse = 0;
    }
    if (!outside || agrees) { this.disagree = 0; return false; }
    const m = Math.min(w, h);
    const same = prev && prev.found && prev.outside && prev.w === w && prev.h === h && dist(centre(prev.quad), centre(quad)) <= this.centreTol * m;
    this.disagree = same ? this.disagree + 1 : 1;
    if (this.disagree >= this.disagreeAfter) { this.sleep('free'); return true; }
    return false;
  }

  /**
   * A probe answer: outcome 'staged' | 'same' | 'unidentified' (others are ignored), quad = the probe's crop
   * in w x h px, at = now on the noteFree clock. Only unidentified probes cropped from the box's reused
   * outline count; staged/same reset the count. Returns true when this call put the box to sleep.
   */
  noteProbe(outcome, quad, w, h, at) {
    if (!this.watching) { this.fails = 0; return false; }
    if (outcome === 'staged' || outcome === 'same') { this.fails = 0; return false; }
    if (outcome !== 'unidentified' || !quad) return false;
    // only crops of the box's own reused outline count (a fresh box-mode outline follows the card)
    const reused = this.opts(w, h).prior?.quad;
    if (!reused || align(quad, reused).d > 0.03 * cardW(reused)) return false;
    if (++this.fails < this.failAfter) return false;
    const F = this.free;
    if (!F || !F.found || F.w !== w || F.h !== h || !(at - F.at <= this.freeFreshMs)) return false;
    if (align(F.quad, quad).d <= this.freeDiff * cardW(quad)) return false; // the crop was the card: it is just hard
    this.sleep('probes');
    return true;
  }

  /** @private dormant for this session; counts as one capture outside the box. */
  sleep(why) {
    this.dormant = true; this.slept = why; this.disagree = 0; this.reuse = 0; this.fails = 0;
    if (++this.outside >= this.unlearnAfter) {
      this.learned = null; this.outside = 0; this.confirmed = false; this.dormant = false; this.slept = null;
    }
    this.revision++;
  }

  /** @private judge()'s inside test: corners (w x h px) within the learned box (anyFlip: either reading orientation). */
  inside(corners, w, h, anyFlip = false) {
    const L = this.learned;
    const m = Math.min(w, h), c = centre(corners), s = cardW(corners) / m, da = angDiff(cardAngle(corners), L.angle);
    return sameAspect(w, h, L.aspect) && dist(c, [L.center[0] * w, L.center[1] * h]) <= this.outsideTol * m
      && (anyFlip ? Math.min(da, 180 - da) : da) <= this.outsideAngle
      && s >= L.size * this.outsideScale[0] && s <= L.size * this.outsideScale[1];
  }

  /** @private */
  push(corners, w, h, boxMode) {
    this.caps.push({ c: centre(corners), a: cardAngle(corners), s: cardW(corners) / Math.min(w, h), w, h, q: corners, box: boxMode });
    if (this.caps.length > this.keep) this.caps.shift();
  }

  /** @private accepted capture vs the learned box: confirm it, or count towards forgetting it. */
  judge(corners, w, h) {
    if (!this.learned) return;
    if (this.inside(corners, w, h)) {
      this.outside = 0;
      this.confirmed = true; this.dormant = false; this.slept = null; this.misses = 0; this.fails = 0; this.disagree = 0; this.reuse = 0;
      this.learned.confidence++;
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
    return (src === 'caps' || src === 'learned') && !this.dormant;
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

  /**
   * Persistable state {v, center, angle, size, quad, aspect, confidence, learned_at, outside}, or null when nothing
   * is learned (outside = the strikes towards forgetting, so a wrong box is forgotten across page loads too).
   */
  toJSON() {
    const L = this.learned;
    if (!L) return null;
    return { v: PRIOR_VERSION, center: [...L.center], angle: L.angle, size: L.size, quad: L.quad ? L.quad.map((p) => [...p]) : null,
      aspect: L.aspect, confidence: L.confidence, learned_at: L.learned_at, outside: this.outside };
  }

  /** Restore toJSON() output (e.g. parsed from localStorage). Invalid input is ignored; returns whether it was used. */
  restore(data) {
    if (!data || typeof data !== 'object' || data.v !== PRIOR_VERSION) return false;
    const { center, angle, size, quad, aspect, confidence, learned_at, outside } = data;
    if (!isPt(center) || center.some((v) => v < 0 || v > 1) || !finite(angle) || !finite(size) || !(size > 0 && size <= 1.5)
      || !finite(aspect) || !(aspect > 0)) return false;
    if (quad != null && !(Array.isArray(quad) && quad.length === 4 && quad.every(isPt))) return false;
    this.learned = { center: [...center], angle, size, quad: quad ? quad.map((p) => [...p]) : null, aspect,
      confidence: finite(confidence) && confidence > 0 ? confidence : this.need, learned_at: typeof learned_at === 'string' ? learned_at : null };
    this.outside = Number.isInteger(outside) && outside > 0 && outside < this.unlearnAfter ? outside : 0;
    this.confirmed = false; this.dormant = false; this.slept = null; this.misses = 0; this.fails = 0; this.disagree = 0; this.reuse = 0; this.free = null;
    return true;
  }

  /** Forget the learned box and this session's captures. */
  forget() {
    this.caps = []; this.learned = null; this.outside = 0; this.confirmed = false; this.dormant = false; this.misses = 0; this.revision++;
    this.free = null; this.disagree = 0; this.reuse = 0; this.fails = 0; this.slept = null;
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


/** 24x40 luma thumbnail for the motion signal (cheap: point samples). */
export function frameThumb(img, TW = 24, TH = 40) {
  const t = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) t[y * TW + x] = sampleLum(img, (x + 0.5) * img.w / TW - 0.5, (y + 0.5) * img.h / TH - 0.5);
  return t;
}

/** Mean absolute difference of two frameThumb()s. */
export const thumbDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
