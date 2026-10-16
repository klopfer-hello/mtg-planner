// capture.js: when the scanner sends a card (pure ES module, browser + node, no deps).
//
// The UI's scanner runs ProbeController ("recognition-driven capture", below):
// while a card is tracked and lies still the client sends the crop as a probe
// and the server decides (identified and not the last card → staged).
// UploadQueue carries the shutter scans and resends. The beta.1
// CaptureController (client-side fingerprint decisions) was removed with the
// classic scanner in v0.5.0.
//
// It never touches DOM or canvas: the caller feeds one analysis object per
// frame (scanlib.js createDetAnalyzer) and does the cropping and requests.

/**
 * Merge field-test overrides into `base`. Unknown keys and values of the wrong
 * type are ignored and reported (like SCAN_THRESHOLDS on the server).
 * @returns {{cfg: object, ignored: string[]}}
 */
function mergeConfig(over, base) {
  const cfg = { ...base }, ignored = [];
  for (const [k, v] of Object.entries(over || {})) {
    const t = typeof base[k];
    const ok = k in base && typeof v === t && (t !== 'number' || Number.isFinite(v));
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

const round = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

// ---------------------------------------------------------------------------
// Recognition-driven capture (beta.2, decision 18)
//
// Beta.1 decided on the client when a photo was a new card: it waited for an
// *accepted* quad and a still whole frame (hand-held never settled: frame MAD
// 7-30 vs settleMad 2), fell back to weak quads of an empty box floor, and
// asked "Same card?" on every re-slide. Now the client only asks "is a card
// lying still here?" and the server answers what it is: a probe (local
// OCR + fingerprint, never Claude) is staged when it is identified and is not
// the session's last card; the same card again is ignored; an unidentified
// probe stores nothing. Values from the offline replay of the 3 recorded
// beta.1 sessions (25/25 cards staged once in the full-res
// proxy, 19/25 on the 480-px floor, 0 false/wrong/duplicate stages):
// - probe only on a tracked quad (accepted or weak): no-quad crops never
//   identified anything (0 of ~690), so an empty box sends no requests;
// - card-relative stillness: the 12x16 card thumbnail vs a frame >= 400 ms
//   older, MAD <= 14 (beta.5 sweep: was 8; the recorded free-hand session's
//   card MAD p50 was 10.2, so 'Hold steady' blocked still-enough cards. 14 kept
//   0 false/extra stages in the box and free hand, 12-17 all passed, 18 is
//   the first failure (a printing flip on moving frames); box time-to-stage
//   p50 1.57 → 1.27 s, free hand mean 5.0 → 3.9 s, 'Hold steady' frames
//   -34 %. One value for box and free hand: a prior-keyed pair gained nothing
//   and the prior flips during free hand);
// - one probe in flight, at most one per second;
// - only on a fresh quad (0.7.0-beta.5): never on a frame whose detection
//   the tracker rejected as a jump (it then still reports the old corners);
//   the free-hand recordings probed such stale quads 0.9-2.4 s old, and the
//   card-region stillness passed on the frozen region;
// - after 'staged' or 'same' hold until the card region changes (MAD > 10),
//   the quad is lost or 8 s pass (halves the load, changes no result);
// - N=1: a second agreeing answer never prevented a wrong card and cost
//   misses; the sharpness gate had no effect (kept as a floor guard only);
// - glare (beta.5): the UI measures the probe crop's glare and passes it to
//   answer(); an unidentified answer with a reflection shows the reflection
//   hint until a probe comes back clean (free hand: glare on 23 of 35 non-auto
//   probes vs 2 of 26 auto ones; the stable-track hint fired on only 43 of 367
//   found frames). Tied to failed answers: the region limits also fire on 29
//   of 101 auto box probes. The hint belongs to that card: it ends when the
//   card leaves or changes (a staged card is done, so no hint for it).

/** Probe policy (tests/field overrides through probeConfig()). */
export const PROBE_DEFAULTS = Object.freeze({
  stillMad: 14,            // card-thumb MAD vs a frame >= stillAgeMs older: the card lies still
  stillAgeMs: 400,
  historyMs: 2000,         // card thumbnails kept for the stillness check
  sharpFloor: 60,          // strip sharpness guard (Laplacian variance; null = not measured = ok)
  intervalMs: 1000,        // probe start to probe start
  holdMad: 10,             // after staged/same: card region change that releases the hold
  holdMs: 8000,            // ... or this long
  lostFrames: 3,           // ... or the quad lost this many frames in a row
  slowAfter: 3,            // unidentified answers on an unchanged card before backing off
  slowMs: 3000,            // ... to this interval
  hintAfterMs: 3000,       // unidentified for this long on a still card: "Not recognised – tap to capture"
  errorMs: 3000,           // after a network/server error
  warmingMs: 2500,         // after 'busy' with reason warming_up
  glareHintMs: 20000,      // a reflection hint from a failed probe is shown at most this long without a new probe
  glareMad: 24,            // card-thumb MAD vs the failed probe's card that ends its reflection hint (another card;
                           // free-hand drift of the same card is 15-35 between probes, so not holdMad)
});

/** Probe controller states (step().state). */
export const PROBE_STATES = Object.freeze({
  SEARCHING: 'searching', TRACKING: 'tracking', PROBING: 'probing', WAITING: 'waiting', HOLD: 'hold',
  UNRECOGNISED: 'unrecognised', PAUSED: 'paused',
});

/** probeConfig(over) → {cfg, ignored}: PROBE_DEFAULTS with validated overrides. */
export const probeConfig = (over = {}) => mergeConfig(over, PROBE_DEFAULTS);

/**
 * The probe loop's decision state. Contract with the UI:
 * - step(o) once per analysed frame (o: {found, weak, accepted, stable, fresh?, corners, cardThumb, sharp, now,
 *   paused?, busy?, plusOne?}) → {state, hint, probe, still, cmad, hold}. fresh false (the tracker kept
 *   the old corners on a jump frame): no probe this frame. `probe` = {id, quad, rec} means:
 *   crop `quad` now, POST it as mode 'probe', then answer(probe.id, response) or failed(probe.id).
 *   paused (a sheet is open, auto-scan off) or busy (a shutter scan is being identified): no probes.
 *   plusOne false (the UI has no staged row to +1, e.g. right after a commit): a 'same' hold says to
 *   use the shutter for another copy instead of "+1".
 * - answer(id, res, now?, {glare?}) with the server's {outcome, reason?, scan?, result?} and the probe
 *   crop's glare {code, advice} (null = not measured); failed(id) on a crop or network error; manual(o)
 *   after a shutter scan of the card in view (holds like 'staged'); reset().
 * - glare: an 'unidentified' answer whose crop had a reflection (code not 'ok') sets `glareHint`
 *   (the advice text); it replaces 'Hold steady'/waiting hints (and prefixes the 'Not recognised'
 *   one) until an answer with a clean crop, a staged/same answer, glareHintMs, or the card leaves
 *   (lostFrames) or changes (card thumb MAD > glareMad vs the probed one).
 * - rearm({rescan:true}) (the UI's Rescan of a review row) also starts a rescan track: `rescan` =
 *   {id, thumb} follows the card in view and ends when the quad is lost for lostFrames, the card region
 *   changes by more than holdMad, a probe answers 'staged'/'same', or endRescan()/reset(). Probes carry
 *   `probe.rescan` (the id or null); the UI replaces the review row only when that id is still current,
 *   so a probe of the next card never deletes it.
 */
export class ProbeController {
  /** @param {{cfg?: object}} [opts] overrides (validated by probeConfig) */
  constructor({ cfg = {} } = {}) {
    const { cfg: merged, ignored } = probeConfig(cfg);
    this.cfg = merged;
    this.ignored = ignored;
    this.nextId = 1;
    this.nextRescan = 1;
    this.reset();
  }

  /** Forget everything (camera restart). */
  reset() {
    this.hist = [];          // [{t, thumb}] card thumbnails of the current track
    this.lost = 0;
    this.flight = null;      // {id, at, thumb}
    this.lastAt = -Infinity; // last probe start
    this.notBefore = 0;      // backoff (error, warming up)
    this.hold = null;        // {thumb, at, outcome}
    this.unk = null;         // {n, thumb, since}: unidentified answers on an unchanged card
    this.last = null;        // last answer {outcome, reason, at, ms}
    this.warming = false;
    this.cmad = null;
    this.rescan = null;      // {id, thumb}: the card a Rescan was asked for (see the class comment)
    this.glare = null;       // {advice, at, thumb}: reflection hint from a failed probe of the card `thumb`
    this.stats = { sent: 0, staged: 0, same: 0, unidentified: 0, busy: 0, error: 0 };
  }

  /**
   * One analysed frame.
   * @returns {{state: string, hint: string, probe: object|null, still: boolean, cmad: number|null, hold: boolean}}
   */
  step(o) {
    const c = this.cfg, now = o.now ?? Date.now();
    const thumb = o.found && o.corners ? o.cardThumb || null : null;
    // --- card-relative stillness: this frame's card region vs the newest one >= stillAgeMs older
    if (thumb) {
      this.lost = 0;
      this.hist.push({ t: now, thumb });
    } else {
      this.lost++;
      this.hist = [];
    }
    while (this.hist.length && now - this.hist[0].t > c.historyMs) this.hist.shift();
    let ref = null; // the newest thumbnail at least stillAgeMs old
    for (const h of this.hist) if (now - h.t >= c.stillAgeMs) ref = h;
    const cmad = thumb && ref && ref.thumb.length === thumb.length ? thumbMad(thumb, ref.thumb) : null;
    this.cmad = cmad;
    const still = cmad !== null && cmad <= c.stillMad;
    const sharpOk = !Number.isFinite(o.sharp) || o.sharp >= c.sharpFloor;

    // --- hold after staged/same: released by a changed card region, a lost quad or time
    if (this.hold) {
      const changed = thumb && this.hold.thumb && thumbMad(thumb, this.hold.thumb) > c.holdMad;
      if (changed || this.lost >= c.lostFrames || now - this.hold.at >= c.holdMs) this.hold = null;
    }
    // unidentified streak: forgotten when the card leaves or changes
    if (this.unk && (this.lost >= c.lostFrames || (thumb && thumbMad(thumb, this.unk.thumb) > c.holdMad))) this.unk = null;
    // reflection hint: that card's; another card (or none) has its own glare
    if (this.glare && (this.lost >= c.lostFrames || (thumb && this.glare.thumb && thumbMad(thumb, this.glare.thumb) > c.glareMad))) this.glare = null;
    // rescan track: the card in view at Rescan (or the first one after it); gone when it leaves or changes
    if (this.rescan) {
      if (this.lost >= c.lostFrames) this.rescan = null;
      else if (thumb && !this.rescan.thumb) this.rescan.thumb = thumb;
      else if (thumb && thumbMad(thumb, this.rescan.thumb) > c.holdMad) this.rescan = null;
    }

    const out = { state: PROBE_STATES.SEARCHING, hint: '', probe: null, still, cmad, hold: Boolean(this.hold) };
    const done = (state, hint) => Object.assign(out, { state, hint });

    if (o.paused) return done(PROBE_STATES.PAUSED, 'Paused');
    if (this.flight) return done(PROBE_STATES.PROBING, thumb ? 'Identifying…' : 'Place a card in view');
    if (!thumb) return done(PROBE_STATES.SEARCHING, 'Place a card in view');
    if (this.hold) {
      const same = o.plusOne === false ? 'Same card as before: tap the shutter for another copy' : 'Same card: tap +1 for another copy';
      return done(PROBE_STATES.HOLD, this.hold.outcome === 'same' ? same : 'Done: next card');
    }
    if (o.busy) return done(PROBE_STATES.WAITING, 'Identifying…');
    const unrecognised = this.unk && now - this.unk.since >= c.hintAfterMs;
    if (this.glare && now - this.glare.at > c.glareHintMs) this.glare = null;
    const glareHint = this.glare ? this.glare.advice : null;
    const unrecHint = glareHint ? `${glareHint} – or tap to capture` : 'Not recognised – tap to capture';
    if (!still || !sharpOk || o.fresh === false) {
      if (unrecognised) return done(PROBE_STATES.UNRECOGNISED, unrecHint);
      return done(PROBE_STATES.TRACKING, !still || o.fresh === false ? glareHint || 'Hold steady' : 'Too blurry: more light or move back a little');
    }
    const gap = this.unk && this.unk.n >= c.slowAfter ? c.slowMs : c.intervalMs;
    if (now - this.lastAt < gap || now < this.notBefore) {
      if (unrecognised) return done(PROBE_STATES.UNRECOGNISED, unrecHint);
      return done(PROBE_STATES.WAITING, this.warming ? 'Warming up the scanner…' : glareHint || 'Hold steady');
    }
    const id = this.nextId++;
    this.flight = { id, at: now, thumb };
    this.lastAt = now;
    this.stats.sent++;
    out.probe = {
      id, quad: o.corners, rescan: this.rescan ? this.rescan.id : null,
      rec: {
        kind: 'probe', id, state: 'probe', quad_source: o.accepted ? 'track' : 'weak', mad: round(cmad),
        sharp: Number.isFinite(o.sharp) ? Math.round(o.sharp) : null, t: Math.round(now),
      },
    };
    return done(PROBE_STATES.PROBING, unrecognised ? unrecHint : 'Identifying…');
  }

  /**
   * The server's answer to probe `id` ({outcome, reason?}). Unknown ids (a
   * reset in between) are ignored. Returns the outcome, or null.
   */
  answer(id, res, now = Date.now(), { glare = null } = {}) {
    const f = this.flight;
    if (!f || f.id !== id) return null;
    this.flight = null;
    const outcome = res?.outcome;
    this.noteGlare(outcome, glare, now, f.thumb);
    this.last = { outcome: outcome ?? null, reason: res?.reason ?? null, at: now, ms: Math.round(now - f.at) };
    this.warming = false;
    if (outcome === 'staged' || outcome === 'same') {
      this.stats[outcome]++;
      this.hold = { thumb: f.thumb, at: now, outcome };
      this.unk = null;
      this.rescan = null; // the rescanned card was answered (the UI checked the id before this call)
    } else if (outcome === 'unidentified') {
      this.stats.unidentified++;
      if (this.unk && thumbMad(f.thumb, this.unk.thumb) <= this.cfg.holdMad) this.unk.n++;
      else this.unk = { n: 1, thumb: f.thumb, since: f.at };
    } else if (outcome === 'busy') {
      this.stats.busy++;
      // warming up: a little longer; slots/session: simply the next interval
      if (res?.reason === 'warming_up') { this.warming = true; this.notBefore = now + this.cfg.warmingMs; }
    } else {
      this.stats.error++;
      this.notBefore = now + this.cfg.errorMs;
    }
    return outcome ?? null;
  }

  /**
   * @private glare of an answered probe of the card `thumb`: an unidentified answer with a
   * reflection sets the hint, a clean or identified answer clears it (a staged card is done: the
   * hold follows, and the hint would only land on the next card).
   */
  noteGlare(outcome, glare, now, thumb) {
    if (outcome !== 'staged' && outcome !== 'same' && outcome !== 'unidentified') return; // busy/error: no information
    const failed = outcome === 'unidentified';
    const reflect = glare && glare.code && glare.code !== 'ok' && glare.code !== 'too-blurry' && glare.advice;
    if (failed && reflect) this.glare = { advice: glare.advice, at: now, thumb: thumb || null };
    else if (!failed || (glare && glare.code === 'ok')) this.glare = null;
  }

  /** Probe `id` could not be cropped or sent (or the server failed): back off a little. */
  failed(id, now = Date.now()) {
    if (!this.flight || this.flight.id !== id) return;
    this.flight = null;
    this.stats.error++;
    this.last = { outcome: 'error', reason: null, at: now, ms: null };
    this.notBefore = now + this.cfg.errorMs;
  }

  /** A shutter scan of the card in view (o = the frame it was taken on): no probe of it until it changes. */
  manual(o = {}, now = o.now ?? Date.now()) {
    const thumb = o.found && o.cardThumb ? o.cardThumb : null;
    this.unk = null;
    this.hold = thumb ? { thumb, at: now, outcome: 'manual' } : null;
  }

  /**
   * Forget the hold (the UI's "scan this card again"): the card in view is probed at the next still frame.
   * rescan: true starts a rescan track of that card (a review row waits to be replaced), else none.
   */
  rearm({ rescan = false } = {}) {
    this.hold = null;
    this.unk = null;
    this.notBefore = 0;
    this.lastAt = -Infinity;
    this.rescan = rescan ? { id: this.nextRescan++, thumb: this.hist.length ? this.hist[this.hist.length - 1].thumb : null } : null;
  }

  /** End the rescan track (its review row was replaced, discarded, or a shutter scan took it). */
  endRescan() { this.rescan = null; }
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
