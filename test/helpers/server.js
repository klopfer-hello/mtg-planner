// Start the real server (server.js) for HTTP-level tests: a free port, a temp
// data dir, no scheduler / auto index / Claude token unless asked, and a
// `call` helper that parses JSON answers. With `scryfall: true` the child
// process answers Scryfall's /cards/collection from the fixture card pool
// (test/fixtures.js stubScryfall), with `offline: true` every fetch fails.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = pathToFileURL(path.join(ROOT, "test/fixtures.js")).href;

/** A TCP port that was free a moment ago. */
export const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

const preload = (code) => `--import=data:text/javascript,${encodeURIComponent(code)}`;
/** Node flag: the child's fetch answers /cards/collection from the fixture pool. */
export const SCRYFALL_STUB = preload(`const { stubScryfall } = await import(${JSON.stringify(FIXTURES)}); stubScryfall();`);
/** Node flag: every fetch in the child fails (no network). */
export const OFFLINE = preload('globalThis.fetch = async () => { throw new Error("offline (test)"); };');

/**
 * Start server.js. `seed(dbFile, dir)` runs before the start (open the DB, insert rows, close it).
 * Returns {base, dir, dbFile, call(method, path, json?, headers?) → {status, headers, body}, log(), stop()}.
 */
export async function startServer({ name = "server", env = {}, seed = null, scryfall = false, offline = false, nodeArgs = [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `mtg-planner-test-${name}-`));
  const dbFile = path.join(dir, "app.db");
  if (seed) await seed(dbFile, dir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = ["--disable-warning=ExperimentalWarning", ...(scryfall ? [SCRYFALL_STUB] : []), ...(offline ? [OFFLINE] : []), ...nodeArgs, "server.js"];
  const proc = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
      SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", CLAUDE_CODE_OAUTH_TOKEN: "", SPELLBOOK_ENABLED: "false",
      DEBUG_SESSIONS_DIR: path.join(dir, "debug-sessions"), DEBUG_PERF_FILE: path.join(dir, "debug-perf.jsonl"),
      BACKUP_DIR: path.join(dir, "backups"), SCAN_IMAGE_DIR: path.join(dir, "scans"), ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    if (proc.exitCode != null || Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  async function call(method, p, json, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (json !== undefined) {
      init.body = typeof json === "string" || json instanceof Uint8Array ? json : JSON.stringify(json);
      init.headers["Content-Type"] ??= "application/json";
    }
    const res = await fetch(base + p, init);
    const type = res.headers.get("content-type") || "";
    const raw = Buffer.from(await res.arrayBuffer());
    let body = raw;
    if (/json|text/.test(type) || !type) {
      body = raw.toString("utf8");
      try { body = JSON.parse(body); } catch { /* plain text */ }
    }
    return { status: res.status, headers: res.headers, body };
  }

  async function stop() {
    // Wait for the exit: on Windows the server's open DB files block the cleanup until then.
    if (proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once("exit", r); proc.kill("SIGKILL"); });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  return { base, dir, dbFile, proc, call, stop, log: () => log };
}
