// End-to-end check of the "collection" MCP server over stdio (JSON-RPC 2.0,
// newline-delimited) against a seeded temp database. No network: the only
// write exercised (save_deck) uses owned cards, which resolve locally.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ID, seedCards, seedCollection, tempDb } from "./fixtures.js";

const SERVER = fileURLToPath(new URL("../mcp-collection.js", import.meta.url));

function startServer(dbFile) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SERVER], {
    env: { ...process.env, DB_FILE: dbFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  let nextId = 1;
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line); // anything that is not JSON-RPC on stdout fails the test
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr:\n${stderr}`)), 10000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args = {}) => {
    const msg = await request("tools/call", { name, arguments: args });
    assert.equal(msg.error, undefined, `tools/call ${name} failed: ${JSON.stringify(msg.error)}`);
    return { text: msg.result.content.map((c) => c.text).join("\n"), isError: Boolean(msg.result.isError) };
  };
  const stop = () => new Promise((resolve) => {
    child.once("exit", resolve);
    child.stdin.end();
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
  return { request, call, stop };
}

describe("mcp-collection.js", () => {
  let ctx;
  let mcp;
  before(async () => {
    ctx = tempDb();
    seedCards(ctx.db);
    seedCollection(ctx.db, [
      [ID.sol, 2],
      [ID.lightning, 3],
      [ID.lightning, 1, { finish: "foil" }],
      [ID.counterspell, 1],
      [ID.counterspell7ed, 2, { language: "de" }],
      [ID.delver, 1],
      [ID.atraxa, 1],
    ]);
    mcp = startServer(ctx.file);
    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.capabilities.tools);
  });
  after(async () => {
    await mcp?.stop();
    ctx?.cleanup();
  });

  test("lists exactly the documented, non-destructive tools", async () => {
    const { result } = await mcp.request("tools/list", {});
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["check_owned", "collection_overview", "get_card", "get_deck", "list_binders", "list_decks", "save_deck", "search_collection", "shopping_list"]);
    for (const t of result.tools) {
      assert.equal(typeof t.description, "string");
      assert.equal(t.inputSchema?.type, "object", `${t.name} needs an object inputSchema`);
    }
  });

  test("unknown method and unknown tool are JSON-RPC errors", async () => {
    assert.equal((await mcp.request("nope/nothing", {})).error.code, -32601);
    assert.ok((await mcp.request("tools/call", { name: "delete_everything", arguments: {} })).error);
  });

  test("collection_overview", async () => {
    const { text, isError } = await mcp.call("collection_overview");
    assert.equal(isError, false);
    assert.match(text, /Atraxa/);
    assert.match(text, /11/, "total copies");
  });

  test("search_collection", async () => {
    const { text } = await mcp.call("search_collection", { query: "t:instant", sort: "name" });
    assert.match(text, /^2 matches/m);
    assert.match(text, /3x Counterspell/);
    assert.match(text, /4x Lightning Bolt/);
    const withText = await mcp.call("search_collection", { query: "bolt", include_text: true });
    assert.match(withText.text, /3 damage to any target/);
    const bad = await mcp.call("search_collection", { query: "foo:bar" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Unknown search key/);
  });

  test("list_binders and binder/source details", async () => {
    const { text, isError } = await mcp.call("list_binders");
    assert.equal(isError, false);
    assert.match(text, /source manabox/);
    const overview = await mcp.call("collection_overview");
    assert.match(overview.text, /Binders \(/);
    const search = await mcp.call("search_collection", { query: "bolt" });
    assert.match(search.text, /source: manabox/);
  });

  test("check_owned: case-insensitive, DFC front faces, not owned", async () => {
    const { text } = await mcp.call("check_owned", { names: ["sol ring", "Delver of Secrets", "Serra Angel"] });
    const lines = text.split("\n");
    assert.ok(lines.some((l) => /sol ring/i.test(l) && /2/.test(l)), text);
    assert.ok(lines.some((l) => /Delver of Secrets/.test(l) && !/NOT OWNED/.test(l)), text);
    assert.ok(lines.some((l) => /Serra Angel/.test(l) && /NOT OWNED/.test(l)), text);
  });

  test("get_card", async () => {
    const { text } = await mcp.call("get_card", { name: "Counterspell" });
    assert.match(text, /Counter target spell/);
    assert.match(text, /mh2|MH2/);
    assert.match(text, /7ed|7ED/);
  });

  test("save_deck → list_decks → get_deck", async () => {
    const saved = await mcp.call("save_deck", {
      name: "Izzet Test", format: "modern",
      cards: [
        { name: "Lightning Bolt", quantity: 4 },
        { name: "Counterspell", quantity: 4 },
        { name: "Delver of Secrets", quantity: 4, board: "main" },
        { name: "Sol Ring", quantity: 1, board: "side" },
      ],
    });
    assert.equal(saved.isError, false, saved.text);
    assert.match(saved.text, /Izzet Test/);
    const id = Number(saved.text.match(/#(\d+)/)?.[1]);
    assert.ok(id > 0, saved.text);

    const deck = ctx.db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
    assert.equal(deck.source, "claude");
    assert.equal(deck.format, "modern");

    const list = await mcp.call("list_decks");
    assert.match(list.text, /Izzet Test/);
    assert.match(list.text, /value €\d+\.\d\d/);
    const got = await mcp.call("get_deck", { deck: "izzet test" });
    assert.match(got.text, /Value: €\d+\.\d\d \(owned €\d+\.\d\d, to buy €\d+\.\d\d/);
    assert.match(got.text, /4x Counterspell .*TO BUY 1, owned 3/);
    const byId = await mcp.call("get_deck", { deck: id });
    assert.match(byId.text, /Izzet Test/);
  });

  test("built decks: free copies in check_owned/search, shopping_list, status in save/list/get", async () => {
    const saved = await mcp.call("save_deck", {
      name: "Built Burn", status: "built", cards: [{ name: "Lightning Bolt", quantity: 4 }, { name: "Sol Ring", quantity: 3 }],
    });
    assert.equal(saved.isError, false, saved.text);
    assert.match(saved.text, /status: BUILT/);
    assert.equal(ctx.db.prepare("SELECT status FROM decks WHERE name = 'Izzet Test'").get().status, "idea", "default idea");
    const bad = await mcp.call("save_deck", { name: "X", status: "done", cards: [{ name: "Sol Ring" }] });
    assert.equal(bad.isError, true);

    const owned = await mcp.call("check_owned", { names: ["Lightning Bolt", "Sol Ring", "Serra Angel"] });
    assert.match(owned.text, /Lightning Bolt: 4 owned, 0 free .*used in built decks: #\d+ Built Burn 4x \(can be moved\)/);
    assert.match(owned.text, /only NOT OWNED cards are to buy/);
    assert.match(owned.text, /Sol Ring: 2 owned, -1 free \(SHORT\)/);
    const search = await mcp.call("search_collection", { query: "avail>=1" });
    assert.doesNotMatch(search.text, /Lightning Bolt|Sol Ring/);
    assert.match(search.text, /Counterspell/);
    const used = await mcp.call("search_collection", { query: "used>=1" });
    assert.match(used.text, /Lightning Bolt .*\| free 0/);
    const shop = await mcp.call("shopping_list");
    assert.match(shop.text, /short of 1 cards/);
    assert.match(shop.text, /1x Sol Ring \| €1\.50 each \| #\d+ Built Burn 3x/);
    assert.match(shop.text, /Izzet Test \[idea\]: \d+ to buy, €\d+\.\d\d; \d+ in other decks \(buying instead €\d+\.\d\d\)/);
    const list = await mcp.call("list_decks");
    assert.match(list.text, /Built Burn — built/);
    assert.match(list.text, /Izzet Test .*, \d+ in other built decks \(can be moved\)/);
    const izzet = await mcp.call("get_deck", { deck: "Izzet Test" });
    assert.match(izzet.text, /4x Lightning Bolt .*IN USE 4 in other deck\(s\): Built Burn \(can be moved\)/);
    assert.match(izzet.text, /In other built decks: \d+ cards \(owned, can be moved over/);
    const card = await mcp.call("get_card", { name: "Sol Ring" });
    assert.match(card.text, /Built decks claim 3; free: -1 \(SHORT\)/);

    // Built deck: contested copies are shared (conflict), never "can be moved".
    ctx.db.prepare("UPDATE decks SET status = 'built' WHERE name = 'Izzet Test'").run();
    const izzetBuilt = await mcp.call("get_deck", { deck: "Izzet Test" });
    assert.match(izzetBuilt.text, /4x Lightning Bolt .*SHARED 4 with Built Burn \(CONFLICT/);
    assert.match(izzetBuilt.text, /Shared with other built decks: \d+ cards/);
    assert.doesNotMatch(izzetBuilt.text, /can be moved/);
    const list2 = await mcp.call("list_decks");
    assert.match(list2.text, /Izzet Test .*, \d+ shared with other built decks \(buy extra to play both\)/);
    const shop2 = await mcp.call("shopping_list");
    assert.match(shop2.text, /Izzet Test \[built\]: \d+ to buy, €\d+\.\d\d; \d+ shared with other built decks/);
  });
});
