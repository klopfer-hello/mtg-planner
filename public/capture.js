// capture.js: when the scanner takes a photo (pure ES module, browser + node, no deps).
//
// Why it exists: the camera loop sees the same card for many seconds, sees
// hands, nudges and glare, and sees new cards slide onto a stack without the
// old one ever leaving. The old AutoCapture (scanlib.js, kept for ?det=v1)
// re-armed on art-hash bits and lost cards silently. This controller follows
// a risk-first rule: motion or a content change starts an evaluation, the
// production 88-byte fingerprint (public/fphash.js) decides, a card is held
// back only when it is almost certainly the same card, and anything uncertain
// is uploaded so the server's duplicate handling decides. A false "same" loses
// a card silently; a false "new" costs a duplicate prompt.
//
// It never touches DOM or canvas. The caller feeds one analysis object per
// frame ({found, weak, accepted, stable, corners, thumb, cardThumb, sharp,
// vw, vh, now, busy?, paused?, priorQuad?, hashCrop?}) and supplies the hash
// crop through `crop(o, quad)` (a rectified card image {width, height,
// channels, data}, ideally a full-res crop area-reduced to 244x340).
//
// Decision, once per settled run (d = min fphash.score over the query
// variants against topRef, the last *decided* settle):
//
//   d                      armed by motion                    not armed
//   <= stillThr            silent, refresh topRef             silent
//   <= sameThr             "+1 same card?" chip, held photo   silent, refresh topRef
//   <= newThr              upload 'uncertain' (no Claude)     upload after 3 agreeing watcher checks
//   >  newThr              upload 'new'                       upload 'new' (no Claude)
//
// topRef (last decided settle) and cap (last upload: ref hash + server scanId)
// are kept apart; a chip only targets cap.scanId when the card matches cap.
// No lock but a card in view (after a change, still for a while): the photo
// is taken anyway on a fallback quad (last weak quad → learned prior quad →
// last accepted quad → centred 63:88) with allowClaude:false, unless the
// scene looks empty (no weak detections and no change against the empty
// reference).

import { hashAt, hashQuery, score, areaResample, QUERY_W, QUERY_H } from './fphash.js';

/**
 * Capture tuning. Provisional values from the scanner research, frozen; field
 * tests override single keys through captureConfig() (?scancfg= or
 * localStorage mtg.scan.capture in the UI).
 */
export const CAPTURE_DEFAULTS = Object.freeze({
  stillThr: 0.035,         // d at or below: the same card lying still (gate G2: nudges reach 0.030-0.034)
  sameThr: 0.10,           // d at or below: the same card re-slid (chip)
  newThr: 0.19,            // d above: certainly a new card
  watchThr: 0.055,         // content watcher and run consistency (G1: still p99 0.034 at 0.25 % jitter + 0.02; < sameThr)
  variants: 27,            // query variants per decision (27 or 9)
  armMad: 6,               // 24x40 frame thumbnail MAD that counts as motion ...
  armMadFrames: 2,         // ... in this many of the last 3 frames
  armMadOnce: 12,          // ... or once above this
  cardMad: 8,              // 12x16 card-region MAD, 2 of the last 3 frames
  lostFrames: 3,           // track lost this many frames in a row
  persistMad: 6,           // thumbnail differs from the last decided settle ...
  persistFrames: 2,        // ... for this many frames
  settleMad: 2,            // frame MAD below this = still
  settleFrames: 3,         // still + stable + accepted + consistent hash for this many frames
  sharpFloor: 60,          // strip sharpness floor (Laplacian variance)
  sharpRel: 0.85,          // ... and >= this x the max of the last sharpWindowMs
  sharpWindowMs: 1500,
  cooldownMs: 600,         // after a capture: no new decision
  watchEvery: 4,           // content watcher: every Nth idle frame
  watchAgree: 3,           // agreeing watcher checks before an unarmed change uploads
  fallbackStillMs: 1500,   // no lock: the scene must be still this long ...
  fallbackNoLockMs: 2500,  // ... and this long since the last change
  emptyWeakMin: 3,         // fallback evidence: weak/accepted detections since the change ...
  emptyMad: 6,             // ... or the thumbnail differs this much from the empty reference
  pendingMaxMs: 5000,      // a pending decision waits this long for the card to settle again
  prevMax: 10,             // silent decision records carried with the next upload
  calibration: false,      // chip on every motion-armed decision with a previous upload; log everything
});

/** Controller states (step().state). */
export const STATES = Object.freeze({
  SEARCHING: 'searching', TRACKING: 'tracking', SETTLING: 'settling', CAPTURE: 'capture', PENDING: 'pending',
  COOLDOWN: 'cooldown', IDLE: 'idle', STUCK: 'stuck', FALLBACK: 'fallback', PAUSED: 'paused',
});

/**
 * Merge field-test overrides into CAPTURE_DEFAULTS. Unknown keys and values of
 * the wrong type are ignored and reported (like SCAN_THRESHOLDS on the server).
 * @returns {{cfg: object, ignored: string[]}}
 */
export function captureConfig(over = {}, base = CAPTURE_DEFAULTS) {
  const cfg = { ...base }, ignored = [];
  for (const [k, v] of Object.entries(over || {})) {
    const t = typeof base[k];
    const ok = k in base && typeof v === t && (t !== 'number' || Number.isFinite(v))
      && (k !== 'variants' || v === 27 || v === 9);
    if (ok) cfg[k] = v; else ignored.push(k);
  }
  return { cfg: Object.freeze(cfg), ignored };
}

/** Mean absolute difference of two equal-length thumbnails. */
export function thumbMad(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Minimum fphash.score of any query variant against the reference hash. */
export function minScore(query, ref) {
  let d = Infinity;
  for (const q of query) { const s = score(q, ref); if (s < d) d = s; }
  return d;
}

/** Centred upright 63:88 quad at 80% of what fits a vw x vh frame (the last fallback). */
export function defaultQuad(vw, vh) {
  const w = 0.8 * Math.min(vw, (vh * 63) / 88), h = (w * 88) / 63, x = (vw - w) / 2, y = (vh - h) / 2;
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
// every arm source counts as "armed by motion" in the decision table; the watcher is not an arm
const MOTION = new Set(['start', 'motion', 'card', 'lost', 'persist', 'pending', 'rearm', 'failed']);

/**
 * The capture state machine. Contract with the UI:
 * - step(o) once per analysed frame → {state, capture, pendingCapture, sameChip, held, flush, fallback, hint, rec}.
 *   `flush` (a held photo, upload item) must be queued before `capture` is shot.
 *   `capture` = {id, kind, quad, fallback, allowClaude, hold, rec}: shoot it, then call captured(capture, payload).
 * - captured(c, payload) → upload item {id, payload, capture, allowClaude, dup_of, force} or null when held.
 * - uploaded(id, scanId) once the server staged it (or named the existing row for a duplicate) →
 *   the deferred "+1" increments for that upload ([] when none); uploadLost(id) when it produced no
 *   countable row (review/failed/error) → those "+1"s as forced upload items.
 * - chipAnswer('plus'|'new'), takeHeld(), forgetCapture(scanId?), adopt(capId, scanId), forceCapture(o),
 *   rearm(), reset(), pending().
 */
export class CaptureController {
  /**
   * @param {object} [opts]
   * @param {(o: object, quad: number[][]) => object|null} [opts.crop] hash crop for a quad in frame o
   *   (default: o.hashCrop when quad is o.corners)
   * @param {object} [opts.cfg] overrides (validated by captureConfig)
   * @param {boolean} [opts.calibration]
   */
  constructor({ crop = null, cfg = {}, calibration } = {}) {
    const over = { ...cfg };
    if (calibration !== undefined) over.calibration = Boolean(calibration);
    const { cfg: merged, ignored } = captureConfig(over);
    this.cfg = merged;
    this.ignored = ignored;
    this.cropFn = crop || ((o, quad) => (quad === o.corners ? o.hashCrop || null : null));
    this.centre = this.cfg.variants === 27 ? 13 : 4; // index of the (0,0,1) variant in hashQuery order
    this.nextId = 1;
    this.plus = [];          // "+1" answers waiting for their target row: {capId, payload, capture, event}
    this.forgot = null;      // the last forgotten upload {id, h} (adopt() after a review pick)
    this.reset();
  }

  /** Forget everything (camera restart). */
  reset() {
    this.state = STATES.SEARCHING;
    this.prevThumb = null;
    this.prevCardThumb = null;
    this.madHist = [];
    this.cardHist = [];
    this.lost = 0;
    this.persistN = 0;
    this.stillSince = null;
    this.changeAt = null;
    this.armed = new Set(['start']);
    this.settleN = 0;
    this.runPrev = null;
    this.runDecided = false;
    this.sharpHist = [];
    this.cooldownUntil = 0;
    this.topRef = null;      // {h, thumb, forgotten}
    this.cap = null;         // {id, h, scanId}
    this.held = null;        // {c, payload}
    this.pend = null;        // {c, h, at}
    this.watch = [];         // recent watcher checks {h, d}
    this.watchN = 0;
    this.deferred = false;   // unarmed same<d<=new run waiting for the watcher
    this.weakSince = 0;
    this.lastWeakQuad = null;
    this.lastAcceptedQuad = null;
    this.fallbackDone = false;
    this.emptyRef = null;
    this.prev = [];
    this.lastQuery = null;
  }

  /** Explicit re-arm (the UI's "scan this card again"): the card in view is uploaded at the next settle. */
  rearm() {
    this.forgetCapture();
    this.arm('rearm', null);
    this.runDecided = false;
  }

  /** The decision kept while the UI was busy, or null. */
  pending() { return this.pend ? this.pend.c : null; }

  /** @private */
  arm(src, now) {
    // a scene that keeps differing from topRef re-fires 'persist' every frame; restarting the clock each
    // time would keep the no-lock fallback from ever firing on an undecided new card (gate G2)
    if (src === 'persist' && this.armed.has('persist')) return;
    this.armed.add(src);
    // a real change (not just a lost track) restarts the no-lock fallback and its evidence count
    if (src !== 'lost') { this.changeAt = now; this.fallbackDone = false; this.weakSince = 0; }
  }

  /** @private hash crop → {q (query variants), h (centre)} or null. Cached per frame and quad. */
  hashFor(o, quad, full) {
    const key = this._frameKey;
    if (this._hc && this._hc.key === key && this._hc.quad === quad && (!full || this._hc.q)) return this._hc;
    let img = this.cropFn(o, quad);
    if (!img) return null;
    if (img.width > QUERY_W * 1.25 || img.height > QUERY_H * 1.25) {
      img = { width: QUERY_W, height: QUERY_H, channels: 3, data: areaResample(img, [0, 0, 1, 1], QUERY_W, QUERY_H) };
    }
    const r = { key, quad, img };
    if (full) { r.q = hashQuery(img, { variants: this.cfg.variants }); r.h = r.q[this.centre]; }
    else r.h = hashAt(img);
    this._hc = r;
    return r;
  }

  /** @private upgrade a centre-only hash to the full query (same crop). */
  fullQuery(hc) {
    if (!hc.q) { hc.q = hashQuery(hc.img, { variants: this.cfg.variants }); hc.h = hc.q[this.centre]; }
    return hc;
  }

  /** @private */
  sharpOk(o, now) {
    const c = this.cfg;
    if (!Number.isFinite(o.sharp)) return true;
    const max = this.sharpHist.reduce((m, [t, v]) => (now - t <= c.sharpWindowMs ? Math.max(m, v) : m), 0);
    return o.sharp >= c.sharpFloor && o.sharp >= c.sharpRel * max;
  }

  /**
   * One analysed frame.
   * @returns {{state: string, capture: object|null, pendingCapture: boolean, sameChip: object|null,
   *   held: boolean, flush: object|null, fallback: boolean, hint: string, rec: object|null, armed: string[], mad: number|null}}
   */
  step(o) {
    const c = this.cfg, now = o.now ?? Date.now();
    this._frameKey = (this._frameKey || 0) + 1;
    this._hc = null;
    const out = { state: this.state, capture: null, pendingCapture: false, sameChip: null, held: false, flush: null, fallback: false, hint: '', rec: null, armed: [], mad: null };
    if (this.changeAt === null) this.changeAt = now;

    // --- motion signals and arm sources (also while busy/paused: "arm only")
    const mad = this.prevThumb && o.thumb ? thumbMad(this.prevThumb, o.thumb) : null;
    if (o.thumb) this.prevThumb = o.thumb;
    out.mad = mad;
    const cm = o.found && o.cardThumb && this.prevCardThumb ? thumbMad(this.prevCardThumb, o.cardThumb) : null;
    this.prevCardThumb = o.found ? o.cardThumb || null : null;
    this.madHist.push(mad ?? 0); if (this.madHist.length > 3) this.madHist.shift();
    this.cardHist.push(cm ?? 0); if (this.cardHist.length > 3) this.cardHist.shift();
    const inCooldown = now < this.cooldownUntil;
    if (!inCooldown) {
      if (mad !== null && (mad > c.armMadOnce || this.madHist.filter((m) => m > c.armMad).length >= c.armMadFrames)) this.arm('motion', now);
      if (this.cardHist.filter((m) => m > c.cardMad).length >= 2) this.arm('card', now);
    }
    this.lost = o.found ? 0 : this.lost + 1;
    if (this.lost >= c.lostFrames) this.arm('lost', now);
    const dTop = this.topRef?.thumb && o.thumb ? thumbMad(o.thumb, this.topRef.thumb) : null;
    this.persistN = dTop !== null && dTop > c.persistMad ? this.persistN + 1 : 0;
    if (this.persistN >= c.persistFrames && !inCooldown) this.arm('persist', now);
    const still = mad !== null && mad < c.settleMad;
    if (!still) this.stillSince = null; else if (this.stillSince === null) this.stillSince = now;
    if (Number.isFinite(o.sharp)) {
      this.sharpHist.push([now, o.sharp]);
      while (this.sharpHist.length && now - this.sharpHist[0][0] > c.sharpWindowMs) this.sharpHist.shift();
    }
    if (o.corners && o.found) {
      if (o.accepted) this.lastAcceptedQuad = o.corners;
      else if (o.weak) this.lastWeakQuad = { quad: o.corners, at: now };
    }
    if (o.weakCorners) this.lastWeakQuad = { quad: o.weakCorners, at: now };
    if (o.found && (o.weak || o.accepted)) this.weakSince++;

    const finish = (state, hint) => {
      this.state = state;
      out.state = state;
      out.hint = hint;
      out.armed = [...this.armed];
      out.held = Boolean(this.held);
      out.sameChip = this.held ? { scanId: this.cap?.scanId ?? null, d: this.held.c.rec.d, calibration: c.calibration } : null;
      out.pendingCapture = Boolean(this.pend);
      return out;
    };

    if (o.paused) {
      this.settleN = 0; this.runPrev = null;
      return finish(STATES.PAUSED, 'Paused');
    }

    // --- settle candidate: tracked, stable, accepted, still; the run's centre hashes agree
    const candidate = Boolean(o.found && o.stable && o.accepted && o.corners && still);
    let hc = null;
    if (!candidate) {
      if (this.settleN) this.runDecided = false;
      this.settleN = 0; this.runPrev = null;
    } else if (this.armed.size || !this.runDecided || this.pend) {
      hc = this.hashFor(o, o.corners, false);
      if (hc && this.runPrev && score(hc.h, this.runPrev) > c.watchThr) this.settleN = 1;
      else this.settleN++;
      if (hc) this.runPrev = hc.h;
    } else {
      this.settleN++; // a decided run: the content watcher samples it every watchEvery frames
    }

    // --- a decision kept while busy: shoot it once busy clears and the card is still there
    if (this.pend && !o.busy) {
      const p = this.pend;
      if (candidate && hc) {
        this.pend = null;
        const dp = p.h ? score(hc.h, p.h) : 0; // no hash at decision time: cannot re-check, shoot
        p.c.rec.pending = { waited_ms: Math.round(now - p.at), d_recheck: round(dp) };
        if (dp <= c.sameThr) {
          p.c.quad = o.corners;
          return this.emitCapture(p.c, now, out, finish);
        }
        p.c.rec.pending.dropped = true;
        this.logSilent(p.c.rec);
        this.arm('pending', now);
        this.runDecided = false;
      } else if (now - p.at > c.pendingMaxMs) {
        this.pend = null;
        p.c.rec.pending = { waited_ms: Math.round(now - p.at), dropped: true };
        this.logSilent(p.c.rec);
        this.arm('pending', now);
      } else {
        return finish(STATES.PENDING, 'Next card waiting…');
      }
    }

    if (inCooldown) return finish(STATES.COOLDOWN, 'Done: next card');

    // --- settled run → decide (armed, or not decided yet)
    if (candidate && this.settleN >= c.settleFrames) {
      const sharpOk = this.sharpOk(o, now);
      if ((this.armed.size || !this.runDecided) && sharpOk) {
        return this.decide(o, o.corners, hc, now, out, finish, { fallback: false });
      }
      if (!sharpOk && (this.armed.size || !this.runDecided)) {
        return finish(STATES.SETTLING, o.sharp < c.sharpFloor ? 'Too blurry: more light or move back a little' : 'Focusing…');
      }
      // idle on a decided card: the content watcher
      const w = this.watcher(o, now);
      if (w) return this.decide(o, o.corners, w, now, out, finish, { fallback: false, watch: true });
      return finish(STATES.IDLE, this.held ? 'Same card again?' : 'Done: next card');
    }

    // --- no lock: fallback capture after a change, once the scene is still
    const motionArmed = [...this.armed].some((s) => MOTION.has(s));
    if (motionArmed && !candidate && !this.fallbackDone && this.stillSince !== null
        && now - this.stillSince >= c.fallbackStillMs && now - this.changeAt >= c.fallbackNoLockMs
        && !(o.found && o.accepted && o.stable)) {
      this.fallbackDone = true;
      const ev = this.evidence(o);
      if (!ev.card) {
        if (ev.empty) this.emptyRef = o.thumb;
        return finish(STATES.SEARCHING, 'Place a card in view');
      }
      let quad = null, quadSource = 'default';
      if (this.lastWeakQuad && this.lastWeakQuad.at >= this.changeAt) { quad = this.lastWeakQuad.quad; quadSource = 'weak'; }
      else if (o.priorQuad) { quad = o.priorQuad; quadSource = 'prior'; }
      else if (this.lastAcceptedQuad) { quad = this.lastAcceptedQuad; quadSource = 'accepted'; }
      else quad = defaultQuad(o.vw, o.vh);
      const fh = this.hashFor(o, quad, true);
      return this.decide(o, quad, fh, now, out, finish, { fallback: true, quadSource, evidence: ev });
    }

    if (candidate) return finish(STATES.SETTLING, 'Hold steady');
    if (o.found) return finish(STATES.TRACKING, o.accepted ? 'Hold steady' : 'Adjust the card');
    if (motionArmed && this.stillSince !== null && now - this.stillSince >= 1000 && !this.fallbackDone) return finish(STATES.STUCK, 'Looking for the card…');
    return finish(STATES.SEARCHING, this.held ? 'Same card again?' : 'Place a card in view');
  }

  /** @private is there a card to photograph without a lock? */
  evidence(o) {
    const c = this.cfg;
    const weak = this.weakSince;
    const dEmpty = this.emptyRef && o.thumb ? thumbMad(o.thumb, this.emptyRef) : null;
    const dTop = this.topRef?.thumb && o.thumb ? thumbMad(o.thumb, this.topRef.thumb) : null;
    const changed = dTop === null || dTop > c.persistMad;
    const card = weak >= c.emptyWeakMin || (dEmpty !== null && dEmpty > c.emptyMad && changed);
    // nothing detected at all since the change and no known empty scene that differs: treat as empty
    const empty = !card && weak === 0 && (dEmpty === null || dEmpty <= c.emptyMad);
    return { card, empty, weak, d_empty: round(dEmpty), d_top: round(dTop) };
  }

  /** @private content watcher on an idle, decided card. Returns a full hash when 3 checks agree on new content. */
  watcher(o, now) {
    const c = this.cfg;
    if (!this.topRef || !o.stable || ++this.watchN % c.watchEvery !== 0) return null;
    const hc = this.hashFor(o, o.corners, false);
    if (!hc) return null;
    // the centre distance bounds the variant minimum from above: below watchThr nothing changed
    let d = score(hc.h, this.topRef.h);
    if (d > c.watchThr) { this.fullQuery(hc); d = minScore(hc.q, this.topRef.h); }
    // agreeing checks: all differ from topRef and show the same (settled) content, i.e. each kept check
    // is within watchThr of the current one; a drift still in progress (glare, a slow change) never
    // collects watchAgree mutually close checks
    if (d <= c.watchThr) { this.watch = []; return null; }
    this.watch = this.watch.filter((w) => minScore(hc.q, w.h) <= c.watchThr);
    this.watch.push({ h: hc.h, d });
    if (this.watch.length < c.watchAgree) return null;
    hc.watchChecks = this.watch.map((w) => round(w.d));
    this.watch = [];
    return hc;
  }

  /** @private the decision table. */
  decide(o, quad, hc, now, out, finish, ctx) {
    const c = this.cfg;
    const sources = [...this.armed];
    const motion = sources.some((s) => MOTION.has(s));
    const ref = this.topRef;
    // cheap path: a centre distance <= stillThr bounds the variant minimum, no full query needed
    let d = Infinity, full = false;
    if (hc && ref) {
      const dc = score(hc.h, ref.h);
      if (dc <= c.stillThr && !ref.forgotten && !c.calibration) d = dc;
      else { this.fullQuery(hc); full = true; d = minScore(hc.q, ref.h); }
    } else if (hc) { this.fullQuery(hc); full = true; }
    // distance to the last upload (the chip's target), only where it matters
    let dCap = null;
    const capD = () => (dCap ??= this.cap?.h ? minScore(this.fullQuery(hc).q, this.cap.h) : Infinity);

    let kind, allowClaude = false;
    if (!hc) kind = 'new';                       // no hash: cannot de-duplicate, let the server decide
    else if (motion) {
      if (!ref || ref.forgotten) kind = d > c.newThr ? 'new' : 'retry';
      else if (c.calibration && Number.isFinite(capD())) kind = 'chip';
      else if (d <= c.stillThr) kind = 'silent';
      else if (d <= c.sameThr) kind = capD() <= c.sameThr ? 'chip' : 'uncertain';
      else if (d <= c.newThr) kind = 'uncertain';
      else kind = 'new';
      allowClaude = kind === 'new';
    } else {
      if (d <= c.sameThr) kind = 'silent';
      else if (d <= c.newThr) kind = ctx.watch ? 'uncertain' : 'defer';
      else kind = 'new';
    }
    if (ctx.fallback) allowClaude = false;

    const rec = {
      kind, d: round(d), d_cap: round(dCap), armed: sources, watch: Boolean(ctx.watch), fallback: ctx.fallback,
      quad_source: ctx.quadSource || 'track', mad: round(out.mad), sharp: Number.isFinite(o.sharp) ? Math.round(o.sharp) : null,
      variants: full || hc?.q ? this.cfg.variants : 1, calibration: c.calibration, allow_claude: allowClaude,
    };
    if (hc?.watchChecks) rec.watch_checks = hc.watchChecks;
    if (ctx.evidence) rec.evidence = ctx.evidence;
    out.rec = rec;
    out.fallback = ctx.fallback;
    this.watch = []; this.watchN = 0;

    if (kind === 'defer') {
      // unarmed change in the uncertain band: wait for the watcher, keep topRef
      this.armed.clear(); this.runDecided = true;
      this.logSilent(rec);
      return finish(STATES.IDLE, 'Done: next card');
    }

    // refresh topRef on every decision
    this.topRef = hc ? { h: hc.h, thumb: o.thumb, forgotten: kind === 'silent' && Boolean(ref?.forgotten) } : (ref && { ...ref, thumb: o.thumb });
    this.armed.clear();
    this.runDecided = true;
    this.weakSince = 0;
    this.lastWeakQuad = null;
    this.fallbackDone = true;

    if (kind === 'silent') {
      this.logSilent(rec);
      return finish(STATES.IDLE, this.held ? 'Same card again?' : 'Done: next card');
    }

    const cap = {
      id: this.nextId++, kind, quad, fallback: ctx.fallback, allowClaude, hold: kind === 'chip',
      h: hc?.h ?? null, rec,
    };
    if (o.busy) {
      if (this.pend) { this.pend.c.rec.pending = { replaced: true }; this.logSilent(this.pend.c.rec); }
      this.pend = { c: cap, h: cap.h, at: now };
      return finish(STATES.PENDING, 'Next card waiting…');
    }
    return this.emitCapture(cap, now, out, finish);
  }

  /** @private */
  emitCapture(cap, now, out, finish) {
    // the chip's held photo is uploaded (dup_of) before the next card
    if (this.held) out.flush = this.takeHeld();
    if (!cap.hold) { cap.rec.prev = this.prev; this.prev = []; }
    out.capture = cap;
    out.fallback = cap.fallback;
    this.cooldownUntil = now + this.cfg.cooldownMs;
    return finish(STATES.CAPTURE, cap.fallback ? 'Check the edges' : 'Capturing');
  }

  /** @private */
  logSilent(rec) {
    this.prev.push(rec);
    if (this.prev.length > this.cfg.prevMax) this.prev.shift();
  }

  /**
   * The UI shot the capture (payload = its scan request material). Returns the
   * upload item, or null when the photo is held for the "+1 same card?" chip
   * (or, for a chip photo, the previously held one if it was still there).
   */
  captured(cap, payload) {
    if (cap.hold) {
      // a second chip photo while one is still held (slow shots): the older one is uploaded now, never dropped
      const older = this.takeHeld();
      this.held = { c: cap, payload };
      return older;
    }
    this.cap = { id: cap.id, h: cap.h, scanId: null };
    return { id: cap.id, payload, capture: cap.rec, allowClaude: cap.allowClaude, dup_of: null, force: false };
  }

  /** A shot failed (camera error): the next settle decides again. */
  captureFailed() {
    this.arm('failed', null);
    this.runDecided = false;
  }

  /**
   * The server staged the upload `id` as row scanId (or answered duplicate of row scanId).
   * Returns the "+1" answers given while that upload was still being identified, as
   * increment actions {action:'increment', scanId, payload, capture, event} ([] when none).
   */
  uploaded(id, scanId) {
    if (this.cap && this.cap.id === id) this.cap.scanId = scanId;
    return this.takePlus(id).map((p) => ({ action: 'increment', scanId, payload: p.payload, capture: p.capture, event: p.event }));
  }

  /**
   * The upload `id` produced no row a "+1" can count on (review/failed result, error):
   * its deferred "+1" photos come back as forced upload items (a row of their own, counted).
   */
  uploadLost(id) {
    return this.takePlus(id).map((p) => ({ id: null, payload: p.payload, capture: { ...p.capture, chip: p.event }, allowClaude: false, dup_of: null, force: true }));
  }

  /** @private */
  takePlus(id) {
    const out = this.plus.filter((p) => p.capId === id);
    if (out.length) this.plus = this.plus.filter((p) => p.capId !== id);
    return out;
  }

  /**
   * The user's chip answer. 'plus' → {action:'increment', scanId, payload, event}
   * (the UI uploads payload with dup_of when increment gives 404/409), or
   * {action:'deferred', capId, event} while the target upload has no row id yet:
   * an explicit +1 is never left to the server's duplicate window; uploaded()
   * returns the increment later (uploadLost() a forced upload). 'new' →
   * {action:'upload', item} (forced upload). Null when no chip is showing.
   */
  chipAnswer(answer) {
    const h = this.held;
    if (!h) return null;
    this.held = null;
    const event = { label: answer === 'plus' ? 'same' : 'different', d: h.c.rec.d, d_cap: h.c.rec.d_cap, calibration: this.cfg.calibration };
    if (answer === 'plus' && this.cap?.scanId != null) {
      return { action: 'increment', scanId: this.cap.scanId, payload: h.payload, capture: h.c.rec, event };
    }
    if (answer === 'plus' && this.cap) {
      // the target upload is still being identified: count it once its row id is known
      this.plus.push({ capId: this.cap.id, payload: h.payload, capture: h.c.rec, event });
      return { action: 'deferred', capId: this.cap.id, event };
    }
    if (answer === 'plus') {
      // no target at all: the user said this is a copy, so it is counted (a row of its own)
      return { action: 'upload', item: { id: h.c.id, payload: h.payload, capture: { ...h.c.rec, chip: event }, allowClaude: false, dup_of: null, force: true }, event };
    }
    this.cap = { id: h.c.id, h: h.c.h, scanId: null };
    return { action: 'upload', item: { id: h.c.id, payload: h.payload, capture: { ...h.c.rec, chip: event }, allowClaude: false, dup_of: null, force: true }, event };
  }

  /**
   * Take the held photo (chip ignored: stop, tab change, Commit, or the next
   * card) as an upload item with dup_of = the chip's target row. Null if none.
   */
  takeHeld() {
    const h = this.held;
    if (!h) return null;
    this.held = null;
    return {
      id: h.c.id, payload: h.payload, capture: { ...h.c.rec, chip: { label: 'ignored', d: h.c.rec.d } },
      allowClaude: false, dup_of: this.cap?.scanId ?? null, force: false,
    };
  }

  /**
   * The last upload no longer counts (review/failed result, Rescan, or row
   * `scanId` undone/edited/committed/deleted). The card in view is uploaded
   * again after the next motion. A held photo loses its +1 target and is
   * returned as a plain upload item (the chip falls back to uploading), else null.
   */
  forgetCapture(scanId) {
    if (scanId != null && (!this.cap || this.cap.scanId !== scanId)) return null;
    this.forgot = this.cap ? { id: this.cap.id, h: this.cap.h } : null;
    this.cap = null;
    if (this.topRef) this.topRef.forgotten = true;
    const h = this.held;
    this.held = null;
    if (!h) return null;
    return { id: h.c.id, payload: h.payload, capture: { ...h.c.rec, chip: { label: 'forgotten', d: h.c.rec.d } }, allowClaude: false, dup_of: null, force: false };
  }

  /**
   * The forgotten upload `capId` (a review/failed result) was resolved by the
   * user's pick as row scanId: the card in view counts as decided again, so the
   * next motion over it is silent instead of a re-upload (and a second picker).
   * A no-op (false) once anything else was captured since.
   */
  adopt(capId, scanId) {
    const f = this.forgot;
    if (!f || f.id !== capId || this.cap || !this.topRef?.forgotten) return false;
    this.forgot = null;
    this.cap = { id: f.id, h: f.h, scanId };
    this.topRef.forgotten = false;
    return true;
  }

  /**
   * Manual shutter: a capture for frame o (tracked quad, else the fallback
   * chain). Queue its `flush` (a held chip photo) first, then shoot it and call
   * captured() like any other.
   */
  forceCapture(o = {}) {
    const now = o.now ?? Date.now();
    this._frameKey = (this._frameKey || 0) + 1;
    this._hc = null;
    let quad = o.found && o.corners ? o.corners : null, quadSource = 'track';
    if (!quad && this.lastWeakQuad) { quad = this.lastWeakQuad.quad; quadSource = 'weak'; }
    if (!quad && o.priorQuad) { quad = o.priorQuad; quadSource = 'prior'; }
    if (!quad && this.lastAcceptedQuad) { quad = this.lastAcceptedQuad; quadSource = 'accepted'; }
    if (!quad && o.vw && o.vh) { quad = defaultQuad(o.vw, o.vh); quadSource = 'default'; }
    const hc = quad ? this.hashFor(o, quad, true) : null;
    const rec = { kind: 'manual', d: round(hc && this.topRef ? minScore(hc.q, this.topRef.h) : null), armed: [...this.armed], fallback: quadSource !== 'track', quad_source: quadSource, calibration: this.cfg.calibration, allow_claude: true };
    if (hc) this.topRef = { h: hc.h, thumb: o.thumb || null, forgotten: false };
    this.armed.clear();
    this.runDecided = true;
    this.cooldownUntil = now + this.cfg.cooldownMs;
    rec.prev = this.prev; this.prev = [];
    // flush: a held chip photo, to be queued before this shot
    return { id: this.nextId++, kind: 'manual', quad, fallback: quadSource !== 'track', allowClaude: true, hold: false, h: hc?.h ?? null, rec, flush: this.takeHeld() };
  }
}

/**
 * FIFO upload queue: one request at a time, HTTP 429 retried with backoff,
 * then paused until retry(). send(item) resolves with the server answer or
 * rejects with an error carrying `status`. sleep is injectable for tests.
 */
export class UploadQueue {
  constructor({ send, delays = [1000, 2000, 4000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onResult = () => {}, onError = () => {}, onGiveUp = () => {} } = {}) {
    Object.assign(this, { send, delays, sleep, onResult, onError, onGiveUp });
    this.items = [];
    this.running = null;
    this.stalled = false;
  }

  get length() { return this.items.length; }
  get busy() { return Boolean(this.running); }

  /** Append an item (null is ignored) and start sending. */
  push(item) {
    if (!item) return;
    this.items.push(item);
    this.kick();
  }

  /** Resume after a give-up (the "Retry" toast). */
  retry() { this.stalled = false; this.kick(); }

  /** Resolves when the queue is empty or stalled. */
  async idle() { while (this.running) await this.running; }

  /** @private */
  kick() {
    if (this.running || this.stalled || !this.items.length) return;
    this.running = this.drain().finally(() => { this.running = null; });
  }

  /** @private */
  async drain() {
    while (this.items.length && !this.stalled) {
      const item = this.items[0];
      let attempt = 0;
      for (;;) {
        try {
          const res = await this.send(item);
          this.items.shift();
          this.onResult(item, res);
          break;
        } catch (err) {
          if (err?.status === 429 && attempt < this.delays.length) { await this.sleep(this.delays[attempt++]); continue; }
          if (err?.status === 429) { this.stalled = true; this.onGiveUp(item, err); return; }
          this.items.shift();
          this.onError(item, err);
          break;
        }
      }
    }
  }
}
