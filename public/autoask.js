// Auto-ask Claude for hard cards (v0.5.0-beta.5, plan "Later").
//
// Probes never call Claude (they would burn the hourly vision cap on every
// moving frame). A card that no probe recognises (glare, foil, old or rare
// printings: in a recorded free-hand session one hard card took 13
// unidentified probes and 54 s) used to wait for the user to tap the shutter.
// Now, once the same card region got `askAfter` unidentified probe answers and
// lies still, the UI sends ONE normal scan with Claude allowed (the server
// spends it only when the local result is review/failed, under
// SCAN_CLAUDE_PER_HOUR and the CLAUDE_MAX_CONCURRENT gate). The track is built
// from the probe answers, not from frames: free-hand cards lose the quad for
// 0.5-4 s and move by card-thumb MAD 15-35 between probes (that hard card's
// 13 unidentified probes spread over 5 quad losses), so an unidentified answer
// whose probe thumbnail is within `changeMad` of the track's continues it,
// anything else starts a new one; the track ends when a probe stages/finds the
// card or no card was seen for `lostMs`. The ask itself needs a still frame
// whose card is within changeMad of the track's.
// Never twice for one card: the same drift that splits a held card into many
// tracks makes thumbnails useless to recognise it, so after an ask that did
// not stage the card (review / failed / error) auto-asks stay off until a
// probe stages or finds a card, or no card was in view for `quietMs` (the
// next hard card right after a review then needs the shutter once). Cards
// asked about recently (the last `memory` asked thumbnails) are not asked
// again, and at most `maxAsks` asks go out per `budgetMs` whatever happens.
// A card due for an ask (wants()) starts no new probe and the ask waits for
// any probe in flight: a probe answer could otherwise stage the card next to
// the Claude scan. Replay of the recorded box and free-hand sessions through
// the probe loop: 2 asks free hand, 3-4 in the box, no card asked twice,
// probe stages unchanged (proxy model); before, both free-hand asks went out
// while a probe of that card was in flight.
// A "hourly cap reached" answer pauses auto-asks until the cap's reset and
// changes the hint to "Claude limit reached – tap to capture".
//
// Pure ESM (browser + node tests); the UI feeds it frames and answers.

/** Auto-ask policy. */
export const AUTO_ASK_DEFAULTS = Object.freeze({
  askAfter: 4,          // unidentified probe answers on one card before asking Claude
  changeMad: 24,        // card-thumb MAD (0-255 luminance) that makes it another card
  lostMs: 4000,         // no card seen this long: the track ends
  sharpFloor: 60,       // strip sharpness guard for the asked frame (null = not measured = ok)
  memory: 3,            // recently asked cards never asked again
  quietMs: 10000,       // after an ask that staged nothing: no card in view this long re-enables asks
  maxAsks: 4,           // at most this many asks ...
  budgetMs: 300000,     // ... per this window (a runaway backstop, far below the hourly cap)
  busyRetryMs: 5000,    // Claude was busy (concurrency gate): one more try after this long
  capPauseMs: 600000,   // cap reached without a reset time: pause this long
});

export const CLAUDE_LIMIT_HINT = 'Claude limit reached – tap to capture';

// result statuses of a scan that staged the card
const STAGED = new Set(['auto', 'suggest', 'confirmed']);

const mad = (a, b) => {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

/**
 * Decides when the probe loop's card gets one Claude scan. Contract:
 * - answer(outcome, thumb, now) for every probe answer (thumb = the probed frame's card region);
 * - step(o) once per analysed frame, o = {found, cardThumb, still, sharp, blocked, now}
 *   (blocked: paused, a sheet open, a scan or probe in flight, a capture running, auto-scan off)
 *   → {ask, hint}; ask true means: shoot the card now and send it as a normal scan with Claude
 *   allowed, then call scanned(result) with the scan's result (scanned(null) on an error), or
 *   cancel() when it could not be shot.
 * - enabled is read from opts.enabled() on every step (the per-device setting).
 */
export class AutoAsk {
  constructor({ cfg = {}, enabled = () => true } = {}) {
    this.cfg = { ...AUTO_ASK_DEFAULTS };
    for (const [k, v] of Object.entries(cfg || {})) if (k in AUTO_ASK_DEFAULTS && Number.isFinite(v) && v >= 0) this.cfg[k] = v;
    this.enabled = enabled;
    this.reset();
  }

  /** Forget the card (camera restart). Keeps the cap pause (the server's) and the ask budget. */
  reset() {
    this.track = null;      // {ref, n, asked, retryAt, retried, since}
    this.seenAt = null;     // last frame (or answer) with a card
    this.recent = [];       // thumbnails of recently asked cards
    this.pending = null;    // {track, thumb}: the ask in flight
    this.hushed = false;    // an ask staged nothing: off until a staged/same answer or quietMs without a card
    this.asks = this.asks ?? []; // times of the asks in the budget window
    this.capUntil = this.capUntil ?? 0;
    this.stats = { asked: this.stats?.asked ?? 0, capped: this.stats?.capped ?? 0 };
  }

  /** Whether auto-asks are paused by the hourly cap. */
  capped(now = Date.now()) { return now < this.capUntil; }

  /** A probe answer for the card region `thumb`. */
  answer(outcome, thumb, now = Date.now()) {
    if (outcome === 'staged' || outcome === 'same') { this.track = null; this.hushed = false; return; }
    if (outcome !== 'unidentified' || !thumb) return;
    this.seenAt = now;
    const t = this.track;
    if (t && mad(thumb, t.ref) <= this.cfg.changeMad) { t.n++; t.ref = thumb; }
    else this.track = { ref: thumb, n: 1, asked: false, retryAt: 0, retried: false, since: now };
  }

  /** One analysed frame → {ask, hint}. hint is CLAUDE_LIMIT_HINT while capped on an unrecognised card, else null. */
  step(o = {}) {
    const c = this.cfg, now = o.now ?? Date.now();
    const thumb = o.found && o.cardThumb ? o.cardThumb : null;
    if (thumb) this.seenAt = now;
    else if (this.seenAt != null) {
      if (this.track && now - this.seenAt > c.lostMs) this.track = null;
      if (this.hushed && now - this.seenAt > c.quietMs) this.hushed = false;
    }
    const t = this.track;
    const out = { ask: false, hint: null };
    if (!t || t.n < c.askAfter) return out;
    if (this.capped(now)) { out.hint = CLAUDE_LIMIT_HINT; return out; }
    if (t.asked && !(t.retryAt && now >= t.retryAt)) return out;
    if (!this.enabled() || this.pending || o.blocked || !thumb || !o.still || mad(thumb, t.ref) > c.changeMad) return out;
    if (Number.isFinite(o.sharp) && o.sharp < c.sharpFloor) return out;
    if (!t.asked && (this.hushed || this.recent.some((r) => mad(thumb, r) <= c.changeMad))) return out;
    while (this.asks.length && now - this.asks[0] >= c.budgetMs) this.asks.shift();
    if (this.asks.length >= c.maxAsks) return out;
    t.asked = true;
    t.retryAt = 0;
    this.pending = { track: t, thumb };
    this.asks.push(now);
    this.stats.asked++;
    out.ask = true;
    return out;
  }

  /**
   * Whether this frame's card is due for an ask (o as for step, before step): the UI then starts no
   * new probe, so the ask goes out on the next still frame instead of racing a probe whose answer
   * could stage the same card next to the Claude scan.
   */
  wants(o = {}) {
    const c = this.cfg, now = o.now ?? Date.now(), t = this.track;
    const thumb = o.found && o.cardThumb ? o.cardThumb : null;
    if (!t || t.n < c.askAfter || t.asked || this.hushed || this.pending || !thumb || this.capped(now) || !this.enabled()) return false;
    if (mad(thumb, t.ref) > c.changeMad || this.recent.some((r) => mad(thumb, r) <= c.changeMad)) return false;
    return this.asks.filter((a) => now - a < c.budgetMs).length < c.maxAsks;
  }

  /** The ask could not be shot (camera busy, capture error): the card may be asked again. */
  cancel() {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    p.track.asked = p.track.retried; // a cancelled retry stays spent
    this.asks.pop();
    this.stats.asked--;
  }

  /**
   * The asked scan's result (the /api/scan answer's `result`, or null on an error). An hourly-cap
   * answer pauses auto-asks until result.claude.resets_at; a busy Claude allows one retry later.
   * Any other answer remembers the card, and one that did not stage it (review / failed / error)
   * turns auto-asks off until a probe stages or finds a card or no card was in view for quietMs.
   * Returns result.claude.skipped (or null).
   */
  scanned(result, now = Date.now()) {
    const p = this.pending;
    this.pending = null;
    const skipped = result?.claude?.skipped ?? null;
    if (skipped === 'hourly cap reached') {
      const at = Date.parse(result.claude.resets_at ?? '');
      this.capUntil = Number.isFinite(at) && at > now ? at : now + this.cfg.capPauseMs;
      this.stats.capped++;
      return skipped;
    }
    if (skipped === 'busy' && p && !p.track.retried) {
      p.track.retried = true;
      p.track.retryAt = now + this.cfg.busyRetryMs;
      return skipped;
    }
    if (p) {
      this.recent.push(p.thumb);
      while (this.recent.length > this.cfg.memory) this.recent.shift();
    }
    if (!STAGED.has(result?.status)) this.hushed = true;
    return skipped;
  }
}
