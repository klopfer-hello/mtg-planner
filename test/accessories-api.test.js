// HTTP layer of tokens & extras and the deck cover (server.js): deck detail adds
// `accessories` and `cover`, list rows add `cover`, the build list ends with the
// tokens group. With the scheduler off nothing is fetched in the background: missing
// token data reads "unavailable" and falls back to the card text. Real server, temp DB.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, upsertCards } from "../lib/db.js";
import { normalizeCard } from "../lib/scryfall.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let dir, proc, base;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});
const img = (id) => ({ small: `https://cards.scryfall.io/small/front/0/0/${id}.jpg?1`, normal: `https://cards.scryfall.io/normal/front/0/0/${id}.jpg?1` });
const card = (id, name, extra = {}) => normalizeCard({
  id, oracle_id: `o-${id}`, name, set: "tst", set_name: "Test", collector_number: "1", lang: "en", rarity: "common", type_line: "Sorcery",
  cmc: 1, colors: ["W"], color_identity: ["W"], keywords: [], legalities: {}, prices: { eur: "0.50" }, image_uris: img(id), layout: "normal", ...extra,
});
const BIRD = "t1000000-0000-0000-0000-000000000001";
const SCREECH = "c1000000-0000-0000-0000-000000000001";
const SPIRITS = "c1000000-0000-0000-0000-000000000002";

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-accessories-"));
  const dbFile = path.join(dir, "app.db");
  const db = openDb(dbFile);
  upsertCards(db, [
    card(BIRD, "Bird", { layout: "token", type_line: "Token Creature — Bird", power: "1", toughness: "1", oracle_text: "Flying", prices: {} }),
    card(SCREECH, "Battle Screech", {
      oracle_text: "Create two 1/1 white Bird creature tokens with flying.\nFlashback—Tap three untapped white creatures you control.", keywords: ["Flashback"],
      all_parts: [{ id: BIRD, component: "token", name: "Bird", type_line: "Token Creature — Bird" }], prices: { eur: "0.80" },
    }),
    { ...card(SPIRITS, "Spectral Procession", { oracle_text: "Create three 1/1 white Spirit creature tokens with flying.", prices: { eur: "3.00" } }), all_parts: null },
    card("c1000000-0000-0000-0000-000000000003", "Plains", { type_line: "Basic Land — Plains", prices: { eur: "20" } }),
  ]);
  db.prepare("INSERT INTO collection (scryfall_id, binder, quantity, source) VALUES (?, 'Tokens', 6, 'app')").run(BIRD);
  db.prepare("INSERT INTO decks (name, format) VALUES ('Skies', 'pauper')").run();
  const add = db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'main', ?, ?, ?)");
  add.run("Battle Screech", SCREECH, 4);
  add.run("Spectral Procession", SPIRITS, 2);
  add.run("Plains", "c1000000-0000-0000-0000-000000000003", 16);
  db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
      SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", SPELLBOOK_ENABLED: "false", CLAUDE_CODE_OAUTH_TOKEN: "",
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

after(() => {
  proc?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};

describe("tokens & extras API", () => {
  test("GET /api/decks/:id adds accessories (cached tokens + text fallback) and the cover", async () => {
    const { status, body } = await get("/api/decks/1");
    assert.equal(status, 200);
    const a = body.accessories;
    assert.equal(a.status, "unavailable", "Spectral Procession has no all_parts and the scheduler is off");
    const bird = a.tokens.find((t) => t.name === "Bird");
    assert.deepEqual([bird.pt, bird.estimate, bird.source, bird.owned.quantity, bird.owned.binders[0].binder], ["1/1", 16, "scryfall", 6, "Tokens"]);
    assert.equal(bird.image_small, img(BIRD).small);
    const spirit = a.tokens.find((t) => t.name === "Spirit");
    assert.deepEqual([spirit.pt, spirit.estimate, spirit.source], ["1/1", 6, "text"]);
    assert.ok(!("fetch_ids" in a));
    assert.equal(body.cover.name, "Spectral Procession", "most expensive non-basic");
    assert.equal(body.cover.source, "top");
    assert.ok(body.cover.image_art.includes("/art_crop/"));
  });

  test("GET /api/decks rows add the cover; the build list ends with Tokens & extras", async () => {
    const list = await get("/api/decks");
    assert.equal(list.body[0].cover.name, "Spectral Procession");
    const build = await get("/api/decks/1/build");
    const g = build.body.groups.at(-1);
    assert.equal(g.kind, "tokens");
    assert.deepEqual(g.lines.filter((l) => l.token).map((l) => [l.name, l.source, l.quantity]),
      [["Bird", "t:tokens", 6], ["Bird", "tneed", 10], ["Spirit", "tneed", 6]]);
    assert.equal(build.body.total, 22, "tokens not in the total (4 + 2 + 16 cards)");
  });
});
