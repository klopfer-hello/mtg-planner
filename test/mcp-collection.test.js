// End-to-end check of the "collection" MCP server over stdio (JSON-RPC 2.0,
// newline-delimited) against a seeded temp database. No network: save_deck uses
// owned cards, which resolve locally; the edit_copies server gets a small card
// index next to its DB and a fetch that always fails (preloaded), so a printing
// missing from the cards table comes from the index (offline fallback).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { openIndex, refreshIndex } from "../lib/cardindex.js";
import { listEdits, undoEdit } from "../lib/edits.js";
import { setSpellbookSettings } from "../lib/spellbook.js";
import { setBinderProps } from "../lib/binders.js";
import { saveDeckRows } from "../lib/decks.js";
import { ID, seedCards, seedCollection, tempDb } from "./fixtures.js";

const SERVER = fileURLToPath(new URL("../mcp-collection.js", import.meta.url));

// Preloaded into the edit server: Scryfall is unreachable.
const OFFLINE = `--import=data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("offline (test)"); };')}`;

function startServer(dbFile, { nodeArgs = [], env = {} } = {}) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...nodeArgs, SERVER], {
    env: { ...process.env, DB_FILE: dbFile, ...env },
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
    assert.deepEqual(names, ["add_to_wishlist", "check_owned", "collection_overview", "edit_copies", "evaluate_deck", "get_card", "get_deck", "get_deck_history", "list_binders", "list_decks", "list_wishlist", "save_deck", "search_collection", "shopping_list", "update_deck_notes"]);
    for (const t of result.tools) {
      assert.equal(typeof t.description, "string");
      assert.equal(t.inputSchema?.type, "object", `${t.name} needs an object inputSchema`);
    }
  });

  test("has no backup/restore tools (backups are UI-only)", async () => {
    const { result } = await mcp.request("tools/list", {});
    const hits = result.tools.filter((t) => /backup|restore|snapshot|dump/i.test(`${t.name} ${t.description}`)).map((t) => t.name);
    assert.deepEqual(hits, []);
    for (const name of ["create_backup", "list_backups", "restore_backup", "delete_backup"]) {
      assert.ok((await mcp.request("tools/call", { name, arguments: {} })).error, `${name} must not exist`);
    }
  });

  test("no deleting tool: edit_copies is the only collection write and is not destructive", async () => {
    const { result } = await mcp.request("tools/list", {});
    assert.deepEqual(result.tools.filter((t) => /delete|remove|discard|erase|destroy/i.test(t.name)).map((t) => t.name), []);
    const edit = result.tools.find((t) => t.name === "edit_copies");
    assert.equal(edit.annotations.destructiveHint, false);
    assert.match(edit.description, /BEFORE calling it, tell the user the exact change/);
    assert.match(edit.description, /Never guess/);
    assert.match(edit.description, /deleting is only possible in the app/);
    assert.deepEqual(Object.keys(edit.inputSchema.properties.set.properties).sort(), ["condition", "finish", "language", "printing"]);
    for (const name of ["delete_copies", "delete_card", "remove_copies"]) {
      assert.ok((await mcp.request("tools/call", { name, arguments: {} })).error, `${name} must not exist`);
    }
  });

  test("card names are matched literally: % and _ are no wildcards", async () => {
    for (const card of ["%", "Delver of Secret_", "D%"]) {
      const r = await mcp.call("edit_copies", { card, set: { condition: "played" } });
      assert.equal(r.isError, true);
      assert.match(r.text, /owns no/, card);
    }
    const owned = await mcp.call("check_owned", { names: ["Delver of Secret_"] });
    assert.match(owned.text, /Delver of Secret_: NOT OWNED/);
    const front = await mcp.call("check_owned", { names: ["Delver of Secrets"] });
    assert.match(front.text, /Insectile Aberration\): 1 owned/);
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

  test("update_deck_notes replaces only the notes, get_deck shows them, unknown deck is an error", async () => {
    const NOTES = "## Plan\n- **ramp** early";
    const saved = await mcp.call("save_deck", { name: "Notes deck", cards: [{ name: "Sol Ring", quantity: 1 }] });
    const id = Number(/deck #(\d+)/.exec(saved.text)[1]);
    const res = await mcp.call("update_deck_notes", { deck: id, notes: NOTES });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /Updated the notes of deck #\d+ "Notes deck"/);
    const shown = await mcp.call("get_deck", { deck: id });
    assert.ok(shown.text.includes(NOTES), shown.text);
    assert.match(shown.text, /Deck guide: none yet\. The user can make one in the app/);
    const v = ctx.db.prepare("SELECT MAX(id) AS v FROM deck_versions WHERE deck_id = ?").get(id).v;
    ctx.db.prepare("INSERT INTO deck_guides (deck_id, created_at, deck_version_id, kind, data) VALUES (?, '2026-10-20T10:00:00Z', ?, 'facts', '{}')").run(id, v);
    assert.match((await mcp.call("get_deck", { deck: id })).text, /Deck guide: written 2026-10-20 \(facts only, no strategy part\)\. The user opens it/);
    assert.match(shown.text, /Sol Ring/);
    assert.match((await mcp.call("update_deck_notes", { deck: id, notes: NOTES })).text, /unchanged/);
    assert.match((await mcp.call("update_deck_notes", { deck: id, notes: "" })).text, /Cleared the notes/);
    const history = await mcp.call("get_deck_history", { deck: id });
    assert.match(history.text, /claude/);
    const missing = await mcp.call("update_deck_notes", { deck: "no such deck at all", notes: "x" });
    assert.equal(missing.isError, true);
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

  test("wishlist: add (source claude, merge), list, shown in shopping_list; no removal tool", async () => {
    assert.equal((await mcp.call("list_wishlist")).text, "The wishlist is empty.");
    const add = await mcp.call("add_to_wishlist", { card: "Serra Angel", quantity: 2, max_price_eur: 1, note: "flyers" });
    assert.equal(add.isError, false, add.text);
    assert.match(add.text, /^Added wishlist item:\n  #\d+ 2x Serra Angel \(any printing\) \| owned 0 \| to buy 2, €0\.10 each \| max €1\.00 \(price is below max\) \| note: flyers/);
    const again = await mcp.call("add_to_wishlist", { card: "Serra Angel" });
    assert.match(again.text, /^Updated wishlist item:\n  #\d+ 3x Serra Angel/);
    assert.match((await mcp.call("add_to_wishlist", { card: "Sol Ring" })).text, /GOT IT/);
    const list = await mcp.call("list_wishlist");
    assert.match(list.text, /^Wishlist: 2 items, 3 copies to buy for €0\.30; 1 already owned \(got it\):/);
    assert.match((await mcp.call("shopping_list")).text, /Wishlist \(not for a deck\): 1 cards, €0\.30[^\n]*\n  3x Serra Angel \| €0\.10 each \(below the user's max price\)/);
    assert.equal(ctx.db.prepare("SELECT source FROM wishlist WHERE name = 'Serra Angel'").get().source, "claude");
    const bad = await mcp.call("add_to_wishlist", { card: "Serra Angel", collector_number: "33" });
    assert.equal(bad.isError, true);
  });
});

// A tiny card index (same Scryfall ids as the fixtures, plus a German 7ED Counterspell).
const SETS = ["mh2", "7ed", "m10", "c21"].map((code) => ({ code, name: code, set_type: "expansion", released_at: "2001-01-01", card_count: 300, printed_size: 300 }));
const indexCard = (o) => ({
  object: "card", lang: "en", games: ["paper"], digital: false, released_at: "2001-01-01", rarity: "common", finishes: ["nonfoil"],
  promo_types: [], illustration_id: `ill-${o.id}`, frame: "2015", border_color: "black", full_art: false, frame_effects: [],
  layout: "normal", image_status: "highres_scan", type_line: "Instant", mana_cost: "{U}{U}", prices: {}, ...o,
});
const COUNTER_DE = "00000000-0000-0000-0000-0000000000a6";
const INDEX_CARDS = [
  indexCard({ id: ID.counterspell, oracle_id: "o-counter", name: "Counterspell", set: "mh2", collector_number: "267", finishes: ["nonfoil", "foil"] }),
  indexCard({ id: ID.counterspell7ed, oracle_id: "o-counter", name: "Counterspell", set: "7ed", collector_number: "67" }),
  indexCard({ id: COUNTER_DE, oracle_id: "o-counter", name: "Counterspell", printed_name: "Gegenzauber", lang: "de", set: "7ed", collector_number: "67" }),
  indexCard({ id: ID.lightning, oracle_id: "o-bolt", name: "Lightning Bolt", set: "m10", collector_number: "146", finishes: ["nonfoil", "foil"], mana_cost: "{R}" }),
  indexCard({ id: ID.sol, oracle_id: "o-solring", name: "Sol Ring", set: "c21", collector_number: "263", type_line: "Artifact", mana_cost: "{1}" }),
];

describe("mcp-collection.js edit_copies", () => {
  let ctx;
  let mcp;
  const editCount = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM collection_edits").get().n;
  const rowsOf = (id) => ctx.db.prepare("SELECT finish, language, condition, binder, source, quantity FROM collection WHERE scryfall_id = ? ORDER BY id")
    .all(id).map((r) => ({ ...r }));
  before(async () => {
    ctx = tempDb();
    const dir = path.dirname(ctx.file);
    const bulk = path.join(dir, "all.jsonl.gz");
    writeFileSync(bulk, gzipSync(INDEX_CARDS.map((c) => JSON.stringify(c)).join("\n")));
    const idx = openIndex(path.join(dir, "cardindex.db"));
    await refreshIndex(idx, { source: bulk, setsSource: SETS });
    idx.close();
    seedCards(ctx.db);
    seedCollection(ctx.db, [
      [ID.sol, 2],
      [ID.lightning, 3],
      [ID.lightning, 1, { finish: "foil" }],
      [ID.counterspell, 1, { binder: "Blue" }],
      [ID.counterspell7ed, 2, { binder: "Blue" }],
    ]);
    mcp = startServer(ctx.file, { nodeArgs: [OFFLINE] });
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  });
  after(async () => {
    await mcp?.stop();
    ctx?.cleanup();
  });

  test("full JSON-RPC round trip: tools/call result shape", async () => {
    const msg = await mcp.request("tools/call", { name: "edit_copies", arguments: { card: "Serra Angel", set: { condition: "played" } } });
    assert.equal(msg.jsonrpc, "2.0");
    assert.equal(msg.error, undefined);
    assert.equal(msg.result.isError, true);
    assert.equal(msg.result.content[0].type, "text");
    assert.match(msg.result.content[0].text, /owns no "Serra Angel"/);
  });

  test("ambiguous requests are refused with the matching copies listed (nothing changes)", async () => {
    const many = await mcp.call("edit_copies", { card: "Counterspell", set: { condition: "played" } });
    assert.equal(many.isError, true);
    assert.match(many.text, /3 copies of Counterspell match/);
    assert.match(many.text, /1x MH2 #267 normal en near_mint \[binder: Blue\]/);
    assert.match(many.text, /2x 7ED #67 normal en near_mint \[binder: Blue\]/);
    assert.match(many.text, /Ask the user/);
    const partial = await mcp.call("edit_copies", { card: "Counterspell", set: { condition: "played" }, quantity: 2 });
    assert.equal(partial.isError, true);
    assert.match(partial.text, /2 of 3 copies is ambiguous/);
    const tooMany = await mcp.call("edit_copies", { card: "Sol Ring", set: { condition: "played" }, quantity: 5 });
    assert.match(tooMany.text, /Only 2 matching copies/);
    const none = await mcp.call("edit_copies", { card: "Counterspell", match: { language: "ja" }, set: { condition: "played" } });
    assert.match(none.text, /No owned copies of Counterspell match/);
    const unknown = await mcp.call("edit_copies", { card: "Sol Ring", set: { binder: "x" }, quantity: 2 });
    assert.match(unknown.text, /Unknown field\(s\): binder/);
    const empty = await mcp.call("edit_copies", { card: "Sol Ring", set: {}, quantity: 2 });
    assert.match(empty.text, /at least one of/);
    assert.equal(editCount(), 0);
  });

  test("ManaBox copies need the user's OK first (confirm_master), then the edit is logged as claude", async () => {
    const ask = await mcp.call("edit_copies", { card: "Counterspell", match: { set: "mh2" }, set: { finish: "foil" } });
    assert.equal(ask.isError, true);
    assert.match(ask.text, /imported from ManaBox/);
    const token = /confirm_master: "([0-9a-f]+)"/.exec(ask.text)?.[1];
    assert.ok(token, ask.text);
    assert.deepEqual(rowsOf(ID.counterspell).map((r) => r.finish), ["normal"]);
    assert.equal(editCount(), 0);

    // The model can't confirm on its own: true, a wrong token, or the right token in the same
    // turn (same server process) are refused.
    const args = { card: "Counterspell", match: { set: "mh2" }, set: { finish: "foil" } };
    const bare = await mcp.call("edit_copies", { ...args, confirm_master: true });
    assert.equal(bare.isError, true);
    assert.match(bare.text, /must be the token/);
    const sameTurn = await mcp.call("edit_copies", { ...args, confirm_master: token });
    assert.equal(sameTurn.isError, true);
    assert.match(sameTurn.text, /has not answered yet/);
    assert.equal(editCount(), 0);
    assert.equal(ctx.db.prepare("SELECT value FROM meta WHERE key = 'collection_master'").get()?.value ?? null, null);

    // The next chat turn spawns a new server: the token works there, once.
    const next = startServer(ctx.file, { nodeArgs: [OFFLINE] });
    let done;
    try {
      await next.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      // A refused edit keeps the token (the user already agreed): a retry with the right finish works.
      const etched = await next.call("edit_copies", { ...args, set: { finish: "etched" }, confirm_master: token });
      assert.match(etched.text, /has no etched finish/);
      // The token covers these copies only, not another edit.
      const other = await next.call("edit_copies", { card: "Counterspell", match: { set: "7ed" }, set: { finish: "foil" }, quantity: 2, confirm_master: token });
      assert.match(other.text, /issued for other copies/);
      done = await next.call("edit_copies", { ...args, confirm_master: token });
      const again = await next.call("edit_copies", { card: "Counterspell", match: { set: "7ed" }, set: { finish: "foil" }, quantity: 2, confirm_master: token });
      assert.match(again.text, /must be the token/);
    } finally {
      await next.stop();
    }
    assert.equal(done.isError, false, done.text);
    assert.match(done.text, /^Edit #\d+: Edited 1 copy of Counterspell: finish normal → foil\./);
    assert.match(done.text, /undo it in the app/);
    assert.match(done.text, /1x Counterspell MH2 #267 foil en near_mint \[binder: Blue\] \(kept by the app\)/);
    assert.match(done.text, /mtg-planner is the collection master/);
    assert.deepEqual(rowsOf(ID.counterspell), [{ finish: "foil", language: "en", condition: "near_mint", binder: "Blue", source: "app", quantity: 1 }]);
    const [entry] = listEdits(ctx.db);
    assert.equal(entry.actor, "claude");
    assert.equal(entry.kind, "edit");
    assert.equal(entry.undoable, true);
  });

  test("printing + language: picks the German printing from the index (Scryfall offline)", async () => {
    const res = await mcp.call("edit_copies", {
      card: "Counterspell", match: { set: "7ed" }, set: { printing: { set: "7ED", collector_number: "67" }, language: "de" }, quantity: 2,
    });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /2 copies of Counterspell/);
    assert.deepEqual(rowsOf(ID.counterspell7ed), []);
    assert.deepEqual(rowsOf(COUNTER_DE), [{ finish: "normal", language: "de", condition: "near_mint", binder: "Blue", source: "app", quantity: 2 }]);
    const card = ctx.db.prepare("SELECT name, lang, fetched_at FROM cards WHERE scryfall_id = ?").get(COUNTER_DE);
    assert.deepEqual({ ...card }, { name: "Counterspell", lang: "de", fetched_at: "" });
  });

  test("finish and printing are checked against the card", async () => {
    const foil = await mcp.call("edit_copies", { card: "sol ring", set: { finish: "foil" }, quantity: 2 });
    assert.equal(foil.isError, true);
    assert.match(foil.text, /has no foil finish/);
    const other = await mcp.call("edit_copies", { card: "Lightning Bolt", match: { finish: "normal" }, set: { printing: { set: "mh2", collector_number: "267" } }, quantity: 1 });
    assert.equal(other.isError, true);
    assert.match(other.text, /is Counterspell, not Lightning Bolt/);
    const missing = await mcp.call("edit_copies", { card: "Lightning Bolt", match: { finish: "normal" }, set: { printing: { set: "zzz", collector_number: "1" } }, quantity: 1 });
    assert.match(missing.text, /No printing ZZZ #1 found/);
    assert.deepEqual(rowsOf(ID.sol).map((r) => r.finish), ["normal"]);
  });

  test("partial quantity splits a row; same values = nothing changed; undo restores exactly", async () => {
    const before = rowsOf(ID.lightning);
    const res = await mcp.call("edit_copies", { card: "Lightning Bolt", match: { finish: "normal" }, set: { condition: "Light Played" }, quantity: 1 });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /condition near_mint → light_played/);
    assert.deepEqual(rowsOf(ID.lightning).map((r) => [r.finish, r.condition, r.source, r.quantity]), [
      ["normal", "near_mint", "manabox", 2], ["foil", "near_mint", "manabox", 1], ["normal", "light_played", "app", 1],
    ]);
    const same = await mcp.call("edit_copies", { card: "Lightning Bolt", match: { finish: "foil" }, set: { finish: "foil" } });
    assert.match(same.text, /^Nothing changed/);
    const id = Number(res.text.match(/^Edit #(\d+)/)[1]);
    undoEdit(ctx.db, id);
    assert.deepEqual(rowsOf(ID.lightning), before);
  });
});

// Deck power over MCP: evaluate_deck (dry run), save_deck/get_deck target_bracket verdicts, the
// bracket/score in list_decks. Commander Spellbook is a local stub (its URL in the shared meta
// settings, like the server's Settings tab writes it); the opt-out in meta or in the env
// (SPELLBOOK_ENABLED=false from lib/claude.js) means no call from this process.
describe("mcp-collection.js deck power", () => {
  let ctx;
  let mcp;
  let stub;
  const calls = [];
  const LIST = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Counterspell\n1 Serra Angel\n20 Forest\n";
  before(async () => {
    stub = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => { data += c; });
      req.on("end", () => {
        const body = JSON.parse(data || "{}");
        calls.push({ body, headers: req.headers });
        const names = [...body.commanders, ...body.main].map((e) => e.card);
        const card = (name) => ({ id: 1, name, typeLine: "Card" });
        const combos = names.includes("Sol Ring") && names.includes("Counterspell") ? [{
          combo: { id: "1-2", uses: [{ card: card("Sol Ring") }, { card: card("Counterspell") }], produces: [{ feature: { name: "Infinite mana" } }], manaValueNeeded: 3 },
          relevant: true, definitelyTwoCard: true, arguablyTwoCard: true, speed: 3,
        }] : [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ bracketTag: "R", cards: names.map((n) => ({ card: card(n), quantity: 1 })), combos }));
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    ctx = tempDb();
    seedCards(ctx.db);
    seedCollection(ctx.db, [[ID.sol, 1], [ID.atraxa, 1], [ID.counterspell, 1], [ID.serra, 1], [ID.forest, 30], [ID.lightning, 4]]);
    setSpellbookSettings(ctx.db, { url: `http://127.0.0.1:${stub.address().port}/estimate-bracket` });
    mcp = startServer(ctx.file, { env: { SPELLBOOK_ENABLED: "", APP_VERSION: "0.0.0-mcp" } });
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  });
  after(async () => {
    await mcp?.stop();
    await new Promise((r) => stub?.close(r));
    ctx?.cleanup();
  });

  test("evaluate_deck: stats, bracket, score and an OVER verdict; only names leave the process; nothing saved", async () => {
    const r = await mcp.call("evaluate_deck", { decklist: LIST, target_bracket: 3 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^Draft \(not saved\): commander 1, main 23/);
    assert.match(r.text, /\nStats: 24 cards · lands 20 · avg MV [\d.]+ · curve 0:0 1:1 2:1 3:0 4:0 5:1 6:0 7\+:0 · pips /);
    assert.match(r.text, /\nBracket: 4 Optimized \(auto; combos checked \d{4}-\d\d-\d\d\) - 2-card combo Sol Ring \+ Counterspell, ≤4 mana \(3 mana\): can end games before turn 6 \(heuristic\)/);
    assert.match(r.text, /\nScore [\d.]+\/10: speed [\d.]+\/1 · fast mana [\d.]+\/1\.75 · tutors 0\/1 · combos 1\.5\/2 · interaction/);
    assert.match(r.text, /\nNot Commander-legal: .*not 100/);
    assert.match(r.text, /\nCombos \(Commander Spellbook\): Sol Ring \+ Counterspell \(3 mana\)/);
    assert.match(r.text, /\nTokens & extras: also Proliferate\.\n/, "tokens & extras of the draft (Atraxa proliferates)");
    assert.match(r.text, /\nTarget bracket 3: OVER - 2-card combo Sol Ring \+ Counterspell/);
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["commanders", "main"]);
    assert.deepEqual(calls[0].body.commanders, [{ card: "Atraxa, Praetors' Voice", quantity: 1 }]);
    assert.match(calls[0].headers["user-agent"], /^mtg-planner\/0\.0\.0-mcp /);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM decks").get().n, 0);

    const ok = await mcp.call("evaluate_deck", { decklist: LIST, target_bracket: 4 });
    assert.match(ok.text, /\nTarget bracket 4: OK$/);
    assert.equal(calls.length, 1, "same list: cache hit");
    const cards = await mcp.call("evaluate_deck", {
      cards: [{ name: "Sol Ring" }, { name: "Serra Angel" }], commander: "Atraxa, Praetors' Voice", target_bracket: 2,
    });
    assert.match(cards.text, /Target bracket 2: OK/);
    const modern = await mcp.call("evaluate_deck", { decklist: "4 Lightning Bolt", format: "modern", target_bracket: 3 });
    assert.match(modern.text, /Not a Commander deck: stats only/);
    assert.doesNotMatch(modern.text, /\nBracket:/);
    assert.match(modern.text, /Target bracket 3: not a Commander deck/);
    assert.equal((await mcp.call("evaluate_deck", { decklist: LIST, target_bracket: 7 })).isError, true);
    assert.equal((await mcp.call("evaluate_deck", {})).isError, true);
  });

  test("save_deck target_bracket → verdict (cache hit); list_decks and get_deck show bracket and score", async () => {
    const before = calls.length;
    const saved = await mcp.call("save_deck", {
      name: "Atraxa Combo", format: "commander", target_bracket: 3,
      cards: [
        { name: "Atraxa, Praetors' Voice", board: "commander" }, { name: "Sol Ring" }, { name: "Counterspell" }, { name: "Serra Angel" },
        { name: "Forest", quantity: 20 }, { name: "Lightning Bolt", companion: true },
      ],
    });
    assert.equal(saved.isError, false, saved.text);
    assert.match(saved.text, /\nBracket: 4 Optimized \(auto; combos checked/);
    assert.match(saved.text, /\nTarget bracket 3: OVER - 2-card combo Sol Ring \+ Counterspell/);
    assert.match(saved.text, /companion Lightning Bolt/);
    assert.equal(calls.length, before, "the companion is not sent: same request as the draft, cache hit");
    const row = ctx.db.prepare("SELECT board, companion FROM deck_cards WHERE name = 'Lightning Bolt'").get();
    assert.deepEqual({ ...row }, { board: "side", companion: 1 });

    const list = await mcp.call("list_decks");
    assert.match(list.text, /Atraxa Combo \[commander\] .* · B4 · [\d.]+\/10 · not Commander-legal$/m);
    const got = await mcp.call("get_deck", { deck: "Atraxa Combo", target_bracket: 4 });
    assert.match(got.text, /\nStats: 24 cards/);
    assert.match(got.text, /\nScore [\d.]+\/10/);
    assert.match(got.text, /\n\nTarget bracket 4: OK$/);
  });

  test("opt-out: disabled in meta or by SPELLBOOK_ENABLED=false means no call", async () => {
    const before = calls.length;
    const fresh = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Counterspell\n";
    const offEnv = startServer(ctx.file, { env: { SPELLBOOK_ENABLED: "false" } });
    try {
      await offEnv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      const r = await offEnv.call("evaluate_deck", { decklist: fresh, target_bracket: 3 });
      assert.match(r.text, /\nBracket: ≥2 Core \(auto; combos not checked \(combo check is off\)\)/);
      assert.match(r.text, /Target bracket 3: (OK|UNDER).*combos not checked yet/);
    } finally {
      await offEnv.stop();
    }
    setSpellbookSettings(ctx.db, { enabled: false });
    const r2 = await mcp.call("evaluate_deck", { decklist: fresh });
    assert.match(r2.text, /combos not checked \(combo check is off\)/);
    assert.equal(calls.length, before, "no Spellbook call while disabled");
    setSpellbookSettings(ctx.db, { enabled: true });
  });
});

describe("collection MCP server: locked binders", () => {
  let ctx;
  let mcp;
  before(async () => {
    ctx = tempDb();
    seedCards(ctx.db);
    seedCollection(ctx.db, [[ID.sol, 2, { binder: "Commander Deck: Rin and Seri" }], [ID.sol, 1], [ID.lightning, 1]]);
    mcp = startServer(ctx.file);
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  });
  after(async () => {
    await mcp?.stop();
    ctx?.cleanup();
  });

  test("check_owned, search_collection, get_card and list_binders name the locked binder", async () => {
    const owned = await mcp.call("check_owned", { names: ["Sol Ring", "Lightning Bolt"] });
    assert.match(owned.text, /Sol Ring: 3 owned, 1 free — .*in locked binder Commander Deck: Rin and Seri \(no deck\) 2x/);
    assert.match(owned.text, /Lightning Bolt: 1 owned, 1 free/);
    const search = await mcp.call("search_collection", { query: "avail>=1" });
    assert.match(search.text, /Sol Ring .*\| free 1 \(2 in locked binders\)/);
    assert.equal((await mcp.call("search_collection", { query: "avail>=2" })).text.split("\n")[0], "0 matches");
    assert.match((await mcp.call("get_card", { name: "Sol Ring" })).text, /in locked binder Commander Deck: Rin and Seri \(no deck\) 2x; free: 1/);
    assert.match((await mcp.call("list_binders")).text, /Commander Deck: Rin and Seri \[deck box, locked\].*locked for every deck/);
  });

  test("a binder the user locked: list_binders [locked], get_deck IN USE in locked binder", async () => {
    ctx.db.prepare("UPDATE collection SET binder = 'Foundation' WHERE scryfall_id = ? AND binder = ''").run(ID.lightning);
    setBinderProps(ctx.db, "Foundation", { locked: true });
    const id = saveDeckRows(ctx.db, { name: "Plan", status: "idea", rows: [{ name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 1, board: "main" }] });
    assert.match((await mcp.call("list_binders")).text, /Foundation \[binder, locked\]/);
    assert.match((await mcp.call("get_deck", { deck: id })).text, /IN USE 1 in locked binder Foundation \(can be moved\)/);
    assert.match((await mcp.call("check_owned", { names: ["Lightning Bolt"] })).text, /Lightning Bolt: 1 owned, 0 free .*in locked binder Foundation \(no deck\) 1x/);
    setBinderProps(ctx.db, "Foundation", { locked: false });
    assert.match((await mcp.call("list_binders")).text, /Foundation \[binder\]/);
  });
});
