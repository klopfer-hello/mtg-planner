// Worker thread for the background index jobs: refreshIndexInWorker
// (lib/cardindex.js, workerData.task 'refresh' or unset) and
// buildFingerprintsInWorker (lib/fingerprint.js, task 'fingerprints'). Each
// runs on its own SQLite connection so the server's event loop stays free:
// the refresh's finalize step and the fingerprint job's whole-table
// statements (plan scan+sort, non-card cleanup join, key set, stale-key
// DELETE) are seconds of synchronous SQLite work on a cold cache.

import { parentPort, workerData } from "node:worker_threads";
import { openIndex, refreshIndex } from "./cardindex.js";

const controller = new AbortController();
parentPort.on("message", (m) => { if (m === "abort") controller.abort(new Error("aborted")); });

const idx = openIndex(workerData.file);
const onProgress = (progress) => parentPort.postMessage({ type: "progress", progress });
try {
  let result;
  if (workerData.task === "fingerprints") {
    const { buildFingerprints } = await import("./fingerprint.js");
    result = await buildFingerprints(idx, { ...(workerData.options || {}), signal: controller.signal, onProgress });
  } else {
    result = await refreshIndex(idx, {
      signal: controller.signal,
      source: workerData.source || undefined,
      setsSource: workerData.setsSource || undefined,
      onProgress,
    });
  }
  parentPort.postMessage({ type: "done", result });
} catch (err) {
  parentPort.postMessage({ type: "error", error: err?.message || String(err) });
} finally {
  try { idx.close(); } catch { /* closed */ }
  parentPort.close();
}
