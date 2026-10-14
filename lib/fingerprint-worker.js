// Worker thread behind MatcherWorker (lib/fingerprint.js): the scanner's
// fingerprint work, off the server's event loop. Loading ~78k reference
// hashes, hashing a query (27 variants, ~300 ms) and the linear scan
// (~160 ms idle, seconds under load) are all synchronous; on the main thread
// they froze every request (first scan after a start: 166 s). Here they only
// delay the scan that asked for them.
//
// Startup: open a read-only connection, copy missing oracle_id/name into the
// fingerprints (one-off after the schema upgrade, in a nested 'backfill'
// worker with its own write connection, so index lookups keep being served),
// load the matcher and report {type:'ready'}. The matcher reloads
// when meta.fp_generation changes (polled, and checked on every match).
// Requests: {id, op: 'hash'|'match'|'scorePrintings'|'index', ...} →
// {id, result} | {id, error}. 'hash' takes rotate: 180 (the scanner's
// upside-down retry turns the decoded pixels before hashing) and variants: 9
// (a precise capture; default 27). 'index' runs one of the scanner's card-index
// lookups (INDEX_OPS) on this connection: a scan makes dozens of them, and on
// a cold cache they blocked the main thread for >1 s in a row (searchTitle
// alone: 70 ms warm, >1 s cold). They are served from the start, also during
// the warm-up.
// With workerData.task = 'warm' | 'backfill' the same file instead runs
// warmIndex (page-cache warm-up) or syncFingerprintMeta once and exits.

import { Worker, parentPort, workerData } from "node:worker_threads";
import * as cardindex from "./cardindex.js";
import { fingerprintMetaPending, openIndex, syncFingerprintMeta, warmIndex } from "./cardindex.js";
import { Matcher, decodeJpeg, hashQuery, rotate180 } from "./fingerprint.js";

const { file, pollMs = 10000, startDelayMs = 0, task = "matcher" } = workerData;
const post = (m) => parentPort.postMessage(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idx = null;
let matcher = null;
/** cardindex functions the server may run here (all take the index as their first argument). */
const INDEX_OPS = new Set([
  "lookupCollector", "lookupLegacyNumber", "getPrinting", "printingsOf", "variantsOf", "storagePrinting", "searchTitle", "setCodes",
  "indexStatus",
]);
const loadInfo = () => ({ size: matcher.size, load_ms: matcher.loadMs ?? null });

async function start() {
  idx = openIndex(file, { readOnly: true });
  if (startDelayMs) await sleep(startDelayMs); // test hook: a slow warm-up
  if (fingerprintMetaPending(idx)) {
    post({ type: "phase", phase: "backfill" });
    // On failure load anyway: rows without a name only weaken the name gap.
    try { post({ type: "backfill", ...(await runTask("backfill")) }); } catch (err) { post({ type: "warn", error: `backfill failed: ${err.message}` }); }
  }
  post({ type: "phase", phase: "load" });
  matcher = new Matcher(idx);
  matcher.load();
  post({ type: "ready", ...loadInfo() });
  // Pick up hashes added by the fingerprint job (or a refresh) between scans.
  setInterval(() => {
    try { if (matcher.ensureLoaded()) post({ type: "loaded", ...loadInfo() }); } catch (err) { post({ type: "warn", error: err.message }); }
  }, pollMs).unref();
}

// One-shot task in a nested worker; resolves with its result message.
function runTask(name) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { file, task: name } });
    w.once("message", (m) => (m?.error ? reject(new Error(m.error)) : resolve(m)));
    w.once("error", reject);
    w.once("exit", (code) => reject(new Error(`${name} worker exited with code ${code}`)));
  });
}

const toBuffers = (hashes) => hashes.map((h) => Buffer.from(h.buffer, h.byteOffset, h.byteLength));

async function handle(m) {
  if (m.op === "hash") {
    const px = await decodeJpeg(Buffer.from(m.jpeg.buffer, m.jpeg.byteOffset, m.jpeg.byteLength));
    const hashes = hashQuery(m.rotate === 180 ? rotate180(px) : px, m.variants === 9 ? { variants: 9 } : undefined);
    return hashes.map((h) => new Uint8Array(h));
  }
  if (m.op === "index") {
    if (!INDEX_OPS.has(m.fn)) throw new Error(`index function ${m.fn} not allowed`);
    if (!idx) throw new Error("index not open");
    return cardindex[m.fn](idx, ...(m.args || []));
  }
  if (!matcher) throw new Error("matcher not loaded");
  if (m.op === "match") {
    const reloaded = matcher.ensureLoaded();
    const results = matcher.match(toBuffers(m.hashes), { topK: m.topK ?? 20 });
    return { results: [...results], bestOther: results.bestOther, reloaded, ...loadInfo() };
  }
  if (m.op === "scorePrintings") return [...matcher.scorePrintings(toBuffers(m.hashes), m.ids)];
  throw new Error(`unknown op ${m.op}`);
}

if (task === "warm" || task === "backfill") {
  const conn = task === "backfill" ? openIndex(file) : null;
  try {
    post({ type: task, ...(await (task === "warm" ? warmIndex(file) : syncFingerprintMeta(conn))) });
  } catch (err) {
    post({ type: task, error: err?.message || String(err) });
  } finally {
    conn?.close();
    parentPort.close();
  }
} else {
  parentPort.on("message", (m) => {
    if (!m || m.id == null) return;
    handle(m).then(
      (result) => post({ id: m.id, result }),
      (err) => post({ id: m.id, error: err?.message || String(err) }),
    );
  });

  start().catch((err) => post({ type: "error", error: err?.message || String(err) }));
}
