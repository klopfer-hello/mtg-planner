// HTTP side of "store as scanned" and the English-twin price fallback:
// POST /api/scans/manual defaults to settings storageLang "scanned" (the
// detected printing and its language), accepts the fixed languages and
// refuses unknown ones; after a commit the server copies the English twin's
// EUR prices from the card index (matcher worker) into the foreign card row,
// so /api/stats, the binder value and the card detail's owned rows value the
// Italian copy at the English price. Real server on a free port, a small
// local index, no Scryfall (the printings' cards rows are seeded).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, upsertCards } from "../lib/db.js";
import { openIndex, refreshIndex } from "../lib/cardindex.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETS = [{ code: "m15", name: "Magic 2015", set_type: "core", released_at: "2014-07-18", card_count: 284, printed_size: 269 }];
const card = (o) => ({
  object: "card", oracle_id: "o-bolt", lang: "en", games: ["paper"], digital: false, released_at: "2014-07-18", rarity: "common",
  finishes: ["nonfoil", "foil"], promo_types: [], illustration_id: "ill-bolt", frame: "2015", border_color: "black", full_art: false,
  frame_effects: [], layout: "normal", image_status: "highres_scan", type_line: "Instant", mana_cost: "{R}", set: "m15", set_name: "Magic 2015",
  name: "Lightning Bolt", collector_number: "155", ...o,
});
const BOLT_EN = card({ id: "00000000-0000-0000-0000-0000000000e1", prices: { eur: "1.50", eur_foil: "7.25" } });
const BOLT_IT = card({ id: "00000000-0000-0000-0000-0000000000e2", lang: "it", printed_name: "Fulmine", prices: { eur: null } });
const cardRow = (c) => ({
  scryfall_id: c.id, oracle_id: c.oracle_id, name: c.name, set_code: c.set, set_name: c.set_name, collector_number: c.collector_number,
  lang: c.lang, rarity: c.rarity, type_line: c.type_line, mana_cost: c.mana_cost, cmc: 1, colors: "R", color_identity: "R",
  oracle_text: "", keywords: "[]", legalities: "{}", prices: JSON.stringify(c.prices), image_small: null, image_normal: null,
  scryfall_uri: null, fetched_at: "2026-10-14",
});

let dir, proc, base;
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-prices-api-"));
  const bulk = path.join(dir, "all.jsonl.gz");
  writeFileSync(bulk, gzipSync([BOLT_EN, BOLT_IT].map((c) => JSON.stringify(c)).join("\n")));
  const idx = openIndex(path.join(dir, "index.db"));
  await refreshIndex(idx, { source: bulk, setsSource: SETS });
  idx.close();
  const dbFile = path.join(dir, "app.db");
  const db = openDb(dbFile);
  upsertCards(db, [cardRow(BOLT_EN), cardRow(BOLT_IT)]);
  db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
      SCAN_IMAGE_DIR: path.join(dir, "scans"), SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", CLAUDE_CODE_OAUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  if (proc && proc.exitCode == null) await new Promise((r) => { proc.once("exit", r); proc.kill("SIGKILL"); });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function call(method, p, json) {
  const init = { method, headers: {} };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers["Content-Type"] = "application/json"; }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

describe("store as scanned + English twin prices (API)", () => {
  test("manual scans: default 'scanned', fixed languages still work, unknown refused", async () => {
    let r = await call("POST", "/api/scans/manual", { printing_id: BOLT_IT.id, finish: "normal" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.store_printing_id, BOLT_IT.id);
    assert.equal(r.body.store_lang, "it");
    const itScan = r.body.id;
    r = await call("POST", "/api/scans/manual", { printing_id: BOLT_IT.id, finish: "foil", storageLang: "en" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.store_printing_id, BOLT_EN.id);
    const enScan = r.body.id;
    r = await call("POST", "/api/scans/manual", { printing_id: BOLT_IT.id, storageLang: "klingon" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /scanned/);

    r = await call("POST", "/api/scans/commit", { ids: [itScan, enScan], target: { type: "binder", name: "Box", create: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The twin sync runs ~1 s after the commit (debounced, in the background).
    let stats;
    const deadline = Date.now() + 15000;
    do {
      await new Promise((res) => setTimeout(res, 200));
      stats = (await call("GET", "/api/stats")).body;
    } while (stats.value_eur !== 8.75 && Date.now() < deadline);
    assert.equal(stats.value_eur, 8.75, "it normal at the English 1.50 + en foil 7.25");
    assert.equal((await call("GET", "/api/stats?binder=box")).body.value_eur, 8.75);
    const detail = (await call("GET", `/api/cards/${BOLT_IT.id}`)).body;
    assert.equal(detail.card.price.value, 1.5);
    assert.equal(detail.card.price.en, true);
    const rows = detail.owned.map((o) => `${o.language}/${o.finish}=${o.price_eur}`).sort();
    assert.deepEqual(rows, ["en/foil=7.25", "it/normal=1.5"]);
  });
});
