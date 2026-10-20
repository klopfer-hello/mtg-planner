// The scanner's server-side state: the card index (its own SQLite file), the
// fingerprint matcher worker, index lookups off the event loop, the background
// index jobs (bulk refresh, fingerprints), the identify slots shared by scans
// and probes, and the scanner part of /healthz. The app keeps working (minus
// scanning) when the index can't be opened.

import {
  fetchBulkInfo, getMeta, indexBrief, openIndex, refreshIndexInWorker, setMeta,
} from "../lib/cardindex.js";
import * as indexModule from "../lib/cardindex.js";
import { visionCap, claudeConfigured } from "../lib/claude.js";
import { MatcherWorker, buildFingerprintsInWorker } from "../lib/fingerprint.js";
import { ocrHelperStatus, ocrTools } from "../lib/ocr.js";
import { ProbeRunner, createScanSlots } from "../lib/scans.js";
import { HttpError } from "./http.js";

export const INDEX_FILE = process.env.INDEX_DB_FILE || "/data/cardindex.db";
const SCAN_MAX_CONCURRENT = Math.max(1, Number(process.env.SCAN_MAX_CONCURRENT) || 2);
// How long a scan waits for the fingerprint matcher's warm-up before it goes
// on without the fingerprint (OCR / Claude only).
const SCAN_MATCHER_WAIT_MS = Number(process.env.SCAN_MATCHER_WAIT_MS) >= 0 && process.env.SCAN_MATCHER_WAIT_MS !== ""
  ? Number(process.env.SCAN_MATCHER_WAIT_MS) : 30000;
const INDEX_LOOKUP_WAIT_MS = 15000;

/** Settles when an index job and its follow-up are finished (not enumerable: job state is sent as JSON). */
export const JOB_DONE = Symbol("job done");

/**
 * Open the index + matcher and return the scanner service. `app` gives
 * shuttingDown and background.scheduleEnglishPrices (after every index job).
 */
export function createScanner(app) {
  let idx = null;
  let matcher = null;
  const indexJob = { running: null, last: null, controller: null };
  try {
    idx = openIndex(INDEX_FILE);
    // Fingerprint loading/hashing/matching run in a worker thread (started after listen).
    matcher = new MatcherWorker(INDEX_FILE, { waitMs: SCAN_MATCHER_WAIT_MS });
    // The hourly Claude vision cap survives restarts (best effort).
    try { visionCap.restore(JSON.parse(getMeta(idx, "vision_calls") || "[]")); } catch { /* fresh window */ }
    // Skipped while the refresh worker holds the index's write lock (a busy wait would block the event loop).
    visionCap.persistWith((stamps) => { if (indexJob.running?.kind !== "refresh") setMeta(idx, "vision_calls", JSON.stringify(stamps)); });
  } catch (err) {
    console.warn(`[scanner] card index unavailable: ${err.message}`);
  }

  function requireIndex() {
    if (!idx) throw new HttpError(503, "The card index is not available");
    return idx;
  }

  let indexReadyCache = false;
  function indexReady() {
    if (!idx) return false;
    if (indexReadyCache) return true;
    try { indexReadyCache = Boolean(idx.prepare("SELECT 1 FROM printings LIMIT 1").get()); } catch { indexReadyCache = false; }
    return indexReadyCache;
  }

  /**
   * The matcher for a scan. The worker waits for its own warm-up inside
   * hashImage (bounded) and skips hashing without fingerprints.
   */
  function readyMatcher() {
    return matcher && matcher.state !== "closed" ? matcher : null;
  }

  /**
   * A card-index lookup on the matcher worker's connection: a scan makes dozens
   * of them (title search ~70 ms warm, >1 s on a cold cache; collector lookups
   * blocked >1 s in a row cold). Errors of a call (also a timeout) are thrown,
   * never retried on the main thread; while the worker respawns after a crash
   * a lookup waits for it (bounded). In-process only for a worker that is
   * closed or gave up.
   */
  async function indexLookup(fn, ...args) {
    if (matcher?.available) {
      if (!(await matcher.whenRunning(INDEX_LOOKUP_WAIT_MS))) throw new HttpError(503, "The card index is restarting; try again shortly");
      return matcher.indexCall(fn, args);
    }
    return indexModule[fn](idx, ...args);
  }

  // Set codes for the OCR's set matcher (sync API): cached until an index job
  // ends, loaded through the worker before a scan needs them.
  let setCodesCache = null;
  async function loadSetCodes() {
    if (!setCodesCache) setCodesCache = await indexLookup("setCodes");
    return setCodesCache;
  }
  // identify()'s index functions: the lookups run off the event loop.
  const scanIndex = { ...indexModule, setCodes: (i) => (setCodesCache ??= indexModule.setCodes(i)) };
  for (const fn of ["lookupCollector", "lookupLegacyNumber", "getPrinting", "printingsOf", "variantsOf", "storagePrinting", "searchTitle"]) {
    scanIndex[fn] = (_idx, ...args) => indexLookup(fn, ...args);
  }

  /** Background index job ("refresh" | "fingerprints"), one at a time; `then` follows a refresh. */
  function startIndexJob(kind, { then = null } = {}) {
    requireIndex();
    if (indexJob.running) throw new HttpError(409, `The ${indexJob.running.kind} job is already running`);
    const controller = new AbortController();
    const state = { kind, state: "running", running: true, started_at: new Date().toISOString(), progress: null };
    indexJob.running = state;
    indexJob.controller = controller;
    // Progress objects (done/total/phase/...) are flattened for the UI.
    const onProgress = (p) => {
      state.progress = p;
      if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) if (!["kind", "state", "running"].includes(k)) state[k] = v;
    };
    // Both jobs run in a worker thread (the refresh's finalize step and the
    // fingerprint job's whole-table statements are seconds of synchronous SQLite work).
    const source = process.env.INDEX_BULK_SOURCE || undefined;
    const opts = { signal: controller.signal, onProgress };
    const work = kind === "refresh"
      ? refreshIndexInWorker(INDEX_FILE, { ...opts, source })
      : buildFingerprintsInWorker(INDEX_FILE, opts);
    console.log(`[scanner] ${kind} job started`);
    const finished = work.then(
      (result) => {
        indexJob.last = { kind, ok: true, state: "done", finished_at: new Date().toISOString(), result: result ?? null };
        console.log(`[scanner] ${kind} job finished`);
        return indexJob.last;
      },
      (err) => {
        indexJob.last = { kind, ok: false, state: "error", finished_at: new Date().toISOString(), error: err.message };
        console.warn(`[scanner] ${kind} job failed: ${err.message}`);
        return indexJob.last;
      },
    ).finally(() => {
      indexJob.running = null;
      indexJob.controller = null;
      indexReadyCache = false;
      setCodesCache = null;
      app.background.scheduleEnglishPrices();
    });
    // [JOB_DONE] settles when this job and its follow-up (`then`) are finished; it rejects when either fails.
    const done = finished.then((last) => {
      if (!last.ok) throw new Error(`${kind}: ${last.error}`);
      if (kind === "refresh" && then && !app.shuttingDown) {
        let next;
        try { next = startIndexJob(then); } catch (err) { console.warn(`[scanner] could not start ${then}: ${err.message}`); throw err; }
        return next[JOB_DONE];
      }
      return last;
    });
    done.catch(() => { /* reported via indexJob.last */ });
    // A symbol: progress is flattened into `state`, and the fingerprint job's
    // progress has its own `done` count (a "done" key would be overwritten,
    // or, read-only, throw on the first progress message from the worker).
    Object.defineProperty(state, JOB_DONE, { value: done, enumerable: false });
    return state;
  }

  /** Boot: build an empty index, resume an unfinished fingerprint job (off with SCAN_AUTO_INDEX=false). */
  function autoIndex() {
    if (!idx || process.env.SCAN_AUTO_INDEX === "false") return;
    try {
      const st = indexBrief(idx);
      if (!st.printings) startIndexJob("refresh", { then: "fingerprints" });
      // Not finished (interrupted by a restart or redeploy, which leaves it
      // 'paused' or 'running', stopped by errors, or never started): resume.
      // Already-hashed groups are skipped, so this is cheap when little is left.
      else if (st.fingerprint_job?.state !== "done") startIndexJob("fingerprints");
    } catch (err) {
      console.warn(`[scanner] automatic index build not started: ${err.message}`);
    }
  }

  // Identify slots shared by normal scans and recognition probes.
  const scanSlots = createScanSlots(SCAN_MAX_CONCURRENT);
  // Probes answer 'busy' while the fingerprint matcher is still loading: a
  // probe must never sit on a slot for the SCAN_MATCHER_WAIT_MS warm-up.
  const prober = new ProbeRunner({ slots: scanSlots, warming: () => matcher?.state === "loading" });

  /** scanner.matcher for /healthz: loading | ready | error (+ size, load time), never cached. */
  function matcherHealth() {
    return matcher ? matcher.status() : { state: "unavailable" };
  }

  // Index counts for /healthz, stale-while-revalidate: the COUNT(*)s run on the
  // matcher worker (cold cache: >100 ms, and they queue behind a scan's
  // matching there), so a request never waits for them beyond the first
  // 100 ms after a start; later requests get the previous counts while one
  // refresh runs in the background.
  let healthCache = null;
  let healthRefresh = null;
  function refreshHealth() {
    healthRefresh ??= (async () => {
      const tools = await ocrTools().catch(() => ({ tesseract: false, djpeg: false }));
      let st = null;
      try {
        st = idx ? await indexLookup("indexStatus") : null;
      } catch {
        // Worker restarting: keep the last counts rather than count on the main thread.
        if (healthCache) return (healthCache = { at: Date.now(), value: { ...healthCache.value, tesseract: tools.tesseract, djpeg: tools.djpeg } }).value;
      }
      const value = { index_ready: Boolean(st?.printings), fingerprints: st?.fingerprints ?? 0, tesseract: tools.tesseract, djpeg: tools.djpeg };
      healthCache = { at: Date.now(), value };
      return value;
    })().finally(() => { healthRefresh = null; });
    return healthRefresh;
  }

  /** /healthz scanner: index counts, tools, OCR helper, matcher, probe stats, Claude vision cap. */
  async function health() {
    if (!healthCache || Date.now() - healthCache.at >= 30000) {
      const pending = refreshHealth();
      if (!healthCache) {
        let timer;
        const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 100); });
        await Promise.race([pending, slow]).finally(() => clearTimeout(timer));
      }
    }
    const value = healthCache?.value ?? { index_ready: indexReadyCache || null, fingerprints: null, tesseract: null, djpeg: null, pending: true };
    return {
      ...value, ocr_helper: ocrHelperStatus(), matcher: matcherHealth(), probes: prober.stats(),
      // the UI's auto-ask for hard cards is off when the cap is 0 or Claude is not configured
      vision: { configured: claudeConfigured(), per_hour: visionCap.limit, remaining: visionCap.remaining(), resets_at: visionCap.resetsAt() },
    };
  }

  /** For lib/scheduler.js: the index facts that decide a nightly refresh. */
  function indexInfo() {
    if (!idx) return null;
    const st = indexBrief(idx);
    return { printings: st.printings, last_refresh: st.last_refresh, bulk_updated_at: st.bulk_updated_at };
  }

  /** After listen: preload the fingerprints so the first scan doesn't pay for it; `onReady` after the warm-up. */
  function start(onReady) {
    if (!matcher) return false;
    matcher.start();
    matcher.whenReady(10 * 60 * 1000).then((ok) => {
      const st = matcher.status();
      if (ok) console.log(`[scanner] matcher ready: ${st.size} fingerprints, load ${st.load_ms} ms, ready after ${st.ready_ms} ms${st.backfill ? ` (backfilled ${st.backfill.updated} in ${st.backfill.ms} ms)` : ""}`);
      onReady();
    });
    return true;
  }

  /** Shutdown: abort the index job, stop the worker (the index connection closes in close()). */
  function stop() {
    indexJob.controller?.abort();
    matcher?.close().catch(() => {});
  }

  return {
    get idx() { return idx; },
    get matcher() { return matcher; },
    indexJob, scanIndex, scanSlots, prober,
    requireIndex, indexReady, readyMatcher, indexLookup, loadSetCodes, startIndexJob, autoIndex, health, indexInfo,
    /** Card index lookup for lib/edits.js (printing facts: oracle, language, finishes), or null without an index. */
    printingLookup: () => (idx ? (id) => indexLookup("getPrinting", id) : null),
    /** indexPrices option of lib/prices.js / priceScans: batched index EUR prices, null without an index. */
    indexPrices: () => (idx ? (items) => indexLookup("printingPricesEur", items) : null),
    remoteBulkUpdatedAt: async () => (await fetchBulkInfo()).updated_at,
    start, stop,
    close: () => { try { idx?.close(); } catch { /* ignore */ } },
  };
}
