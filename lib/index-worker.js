// Worker thread for refreshIndexInWorker (lib/cardindex.js): runs the bulk
// refresh on its own SQLite connection so the server's event loop stays free.

import { parentPort, workerData } from "node:worker_threads";
import { openIndex, refreshIndex } from "./cardindex.js";

const controller = new AbortController();
parentPort.on("message", (m) => { if (m === "abort") controller.abort(new Error("aborted")); });

const idx = openIndex(workerData.file);
try {
  const result = await refreshIndex(idx, {
    signal: controller.signal,
    source: workerData.source || undefined,
    setsSource: workerData.setsSource || undefined,
    onProgress: (progress) => parentPort.postMessage({ type: "progress", progress }),
  });
  parentPort.postMessage({ type: "done", result });
} catch (err) {
  parentPort.postMessage({ type: "error", error: err?.message || String(err) });
} finally {
  try { idx.close(); } catch { /* closed */ }
  parentPort.close();
}
