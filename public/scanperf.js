// scanperf.js: scanner frame pacing and the perf beacon (pure ESM, no imports).
//
// Why it exists: the scanner analyses camera frames on the page's main thread
// (the detector runs in a worker where it can). On a slow phone a fixed 8 fps
// loop kept the main thread 90-99 % busy (headless Chromium at 4x CPU
// throttling: 3.5 fps actually reached, single stalls up to 0.75 s), so the
// page froze. FramePacer spaces the analyses so that their main-thread time
// stays under a budget share; a fast phone keeps the full rate. PerfMonitor
// collects what the camera loop measures and turns it into the ~5 s beacon
// for POST /api/debug/perf (lib/debugperf.js), so a slow phone leaves numbers
// on the server without a recording.

/** Frame pacing defaults. */
export const PACER_DEFAULTS = Object.freeze({
  minGapMs: 125,  // 8 Hz at most (the detector and the tracker were tuned at ~8 fps)
  maxGapMs: 500,  // never slower than 2 Hz (the tracker's stable window counts frames)
  budget: 0.45,   // share of the main thread the analysis may use
  alpha: 0.25,    // EWMA weight of a new sample
});

/** q-quantile (0..1) of numbers (nearest rank), null for none. */
export function percentile(values, q) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
}

/** {n, p50, p90, max} of numbers rounded to 0.1 (p50/p90/max null when empty). */
export function summarize(values) {
  const r = (v) => (v === null ? null : Math.round(v * 10) / 10);
  const a = values.filter((v) => Number.isFinite(v));
  return { n: a.length, p50: r(percentile(a, 0.5)), p90: r(percentile(a, 0.9)), max: r(a.length ? Math.max(...a) : null) };
}

/**
 * Adaptive spacing of the frame analyses. note(mainMs) after each analysis
 * with its main-thread time (worker time excluded); gap() is the wait before
 * the next one: mainMs / budget, clamped to [minGapMs, maxGapMs]. A single
 * slow frame (GC, a probe crop) moves it by alpha only.
 */
export class FramePacer {
  constructor(cfg = {}) {
    this.cfg = { ...PACER_DEFAULTS, ...cfg };
    this.ewma = null;
  }

  note(mainMs) {
    if (!Number.isFinite(mainMs) || mainMs < 0) return;
    const a = this.cfg.alpha;
    this.ewma = this.ewma === null ? mainMs : this.ewma * (1 - a) + mainMs * a;
  }

  gap() {
    const { minGapMs, maxGapMs, budget } = this.cfg;
    if (this.ewma === null) return minGapMs;
    return Math.round(Math.min(maxGapMs, Math.max(minGapMs, this.ewma / budget)));
  }

  /** true when an analysis started at `last` may run again at `now`. */
  due(now, last) {
    return now - last >= this.gap();
  }
}

const CAP = 600; // samples per series per window (a 5 s window at 60 Hz rAF is 300)

/**
 * Collects scanner timings for one beacon window. The camera loop calls
 * frame({total, main, grab, detect, sharp, wgrab, wsharp}) per analysis (grab: the page's
 * frame read; sharp: the strip sharpness; wgrab/wsharp: the worker's frame read / strip round
 * trip on the experimental worker paths), interval(ms) between analysis starts, raf(ms) per
 * animation frame, longTask(ms), probe {rtt, capture, crop, read (the page's card+strip read),
 * job (worker warps + JPEGs)} per probe; snapshot(now, extra) returns the beacon body and
 * starts the next window.
 */
export class PerfMonitor {
  constructor({ now = Date.now() } = {}) {
    this.start = now;
    this.reset(now);
  }

  /** @private */
  reset(now) {
    this.windowStart = now;
    this.s = { analyze: [], main: [], grab: [], detect: [], sharp: [], wgrab: [], wsharp: [], interval: [], raf: [], rtt: [], capture: [], crop: [], read: [], job: [] };
    this.longTasks = 0;
    this.longTaskMs = 0;
    this.probes = 0;
    this.errors = 0;
  }

  /** @private */
  push(key, v) {
    const a = this.s[key];
    if (!Number.isFinite(v)) return;
    if (a.length >= CAP) a.shift();
    a.push(v);
  }

  frame({ total, main, grab, detect, sharp, wgrab, wsharp } = {}) {
    this.push("analyze", total); this.push("main", main); this.push("grab", grab);
    this.push("detect", detect); this.push("sharp", sharp); this.push("wgrab", wgrab); this.push("wsharp", wsharp);
  }

  interval(ms) { this.push("interval", ms); }

  raf(ms) { this.push("raf", ms); }

  longTask(ms) {
    if (!Number.isFinite(ms)) return;
    this.longTasks++;
    this.longTaskMs += ms;
  }

  probe({ rtt, capture, crop, read, job, error = false } = {}) {
    this.probes++;
    if (error) this.errors++;
    this.push("rtt", rtt);
    this.push("capture", capture);
    this.push("crop", crop);
    this.push("read", read);
    this.push("job", job);
  }

  /** Frames analysed in this window. */
  get frames() { return this.s.analyze.length; }

  /**
   * The beacon body for this window ({window_ms, analyze, main, grab, detect,
   * sharp: summarize(), interval/raf {n, p50, p95, max}, long_tasks, ...}
   * merged with `extra`), then a fresh window.
   */
  snapshot(now = Date.now(), extra = {}) {
    const s = this.s;
    const iv = (a) => {
      const x = summarize(a);
      const p95 = percentile(a, 0.95);
      return { n: x.n, p50: x.p50, p95: p95 === null ? null : Math.round(p95 * 10) / 10, max: x.max };
    };
    const body = {
      v: 1,
      window_ms: Math.round(now - this.windowStart),
      analyze: summarize(s.analyze), main: summarize(s.main), grab: summarize(s.grab), detect: summarize(s.detect), sharp: summarize(s.sharp),
      wgrab: summarize(s.wgrab), wsharp: summarize(s.wsharp),
      interval: iv(s.interval), raf: iv(s.raf),
      long_tasks: this.longTasks, long_task_ms: Math.round(this.longTaskMs),
      probes: this.probes, probe_rtt: summarize(s.rtt), probe_capture: summarize(s.capture), probe_crop: summarize(s.crop),
      probe_read: summarize(s.read), probe_job: summarize(s.job), errors: this.errors,
      ...extra,
    };
    this.reset(now);
    return body;
  }
}
