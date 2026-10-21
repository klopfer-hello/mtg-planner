// A client that leaves cancels its scan (server/routes/scans.js): nothing is staged and the scan slot
// is free again. The OCR helper is a fake that never answers, so identify() is still busy (until
// OCR_TIMEOUT_MS) when the client closes the connection. Needs djpeg + cjpeg (a real JPEG must decode
// for OCR to start): runs in the image (CI, deploy), skipped in node:24-slim.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { openDb } from "../lib/db.js";
import { openIndex, refreshIndex } from "../lib/cardindex.js";
import { encodeJpeg } from "../lib/fingerprint.js";
import { hasBinary } from "../lib/ocr.js";
import { seedCards } from "./fixtures.js";
import { synth } from "./helpers/images.js";
import { startServer } from "./helpers/server.js";

const OCR_TIMEOUT = 1000;
const usable = process.platform !== "win32" && (await hasBinary("djpeg")) && (await hasBinary("cjpeg"));

describe("scan cancelled by the client", { skip: !usable && "djpeg/cjpeg not installed (runs in the image)" }, () => {
  let srv, card;

  before(async () => {
    card = (await encodeJpeg(synth(3, 488, 680))).toString("base64");
    // OCR_HELPER is added by seed (the temp dir exists only then); startServer spreads env at spawn time.
    const env = { SCAN_MATCHER_WAIT_MS: "0", SCAN_CLAUDE_PER_HOUR: "0", SCAN_MAX_CONCURRENT: "1", OCR_TIMEOUT_MS: String(OCR_TIMEOUT) };
    srv = await startServer({
      name: "scan-cancel",
      env,
      seed: async (dbFile, dir) => {
        const db = openDb(dbFile);
        seedCards(db);
        db.close();
        // A helper that reads requests and never answers: every OCR call waits for OCR_TIMEOUT_MS.
        const helper = path.join(dir, "mtg-ocr-hang");
        writeFileSync(helper, "#!/usr/bin/env node\nprocess.stdin.resume();\n");
        chmodSync(helper, 0o755);
        env.OCR_HELPER = helper;
        // A one-printing index, so /api/scan gets past "index still being built".
        const bulk = path.join(dir, "all.jsonl.gz");
        writeFileSync(bulk, gzipSync(JSON.stringify({
          object: "card", id: "idx-1", oracle_id: "o-1", name: "Index Card", lang: "en", set: "m15", collector_number: "1", games: ["paper"], finishes: ["nonfoil"],
        })));
        const idx = openIndex(path.join(dir, "index.db"));
        await refreshIndex(idx, { source: bulk, setsSource: [{ code: "m15", name: "Magic 2015" }] });
        idx.close();
      },
    });
  });

  after(() => srv?.stop());

  test("closing the request mid-identify stages nothing and frees the slot", async () => {
    // Calibration mode stages even a failed identification: the control scan below must be staged,
    // so "nothing staged" for the cancelled one is a real check.
    const scans = async () => (await srv.call("GET", "/api/scans")).body.scans.length;
    const before = await scans();
    const body = JSON.stringify({ card, allowClaude: false, calibration: true });
    const req = http.request(`${srv.base}/api/scan`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } });
    req.on("error", () => {});
    req.end(body);
    await new Promise((r) => setTimeout(r, 600)); // identify is waiting for the hanging OCR helper
    // A restore waits while a scan is identified.
    const backup = (await srv.call("POST", "/api/backups")).body;
    const restore = await srv.call("POST", `/api/backups/${backup.name}/restore`, { confirm: true });
    assert.equal(restore.status, 409);
    assert.match(restore.body.error, /scan is being identified/);
    req.destroy();
    // SCAN_MAX_CONCURRENT 1: 429 while the cancelled scan still runs, then the control scan gets the slot.
    let control;
    const deadline = Date.now() + 60_000;
    do {
      control = await srv.call("POST", "/api/scan", { card, allowClaude: false, calibration: true });
      if (control.status === 429) await new Promise((r) => setTimeout(r, 300));
    } while (control.status === 429 && Date.now() < deadline);
    assert.equal(control.status, 200, JSON.stringify(control.body));
    assert.equal(await scans(), before + 1, "only the control scan was staged, the cancelled one not");
  });
});
