// HTTP layer of lib/edits.js (server.js): POST /api/collection/edit|delete,
// GET /api/collection/edits, POST /api/collection/edits/:id/undo and
// POST /api/maintenance/relanguage-scans: status codes, error codes
// (confirm_master, manabox_rows, conflict, undone) and the CSRF / content-type
// guards. Starts the real server on a free port against a seeded temp DB; no
// request needs Scryfall (every printing used is in the cards table).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb, upsertCards } from "../lib/db.js";
import { normalizeCard } from "../lib/scryfall.js";
import { ID, SCRYFALL_CARDS, seedCards } from "./fixtures.js";
import { startServer } from "./helpers/server.js";

const BOLT_IT = { ...SCRYFALL_CARDS.find((c) => c.id === ID.lightning), id: "00000000-0000-0000-0000-0000000000a1", lang: "it", prices: {} };
let srv, call;

before(async () => {
  srv = await startServer({
    name: "edits-api",
    seed: (dbFile) => {
      const db = openDb(dbFile);
      seedCards(db);
      upsertCards(db, [normalizeCard(BOLT_IT)]);
      const ins = db.prepare("INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source) VALUES (?, 'normal', 'en', 'near_mint', ?, ?, ?)");
      ins.run(ID.sol, "Box", 3, "manabox");
      ins.run(ID.lightning, "Scans", 2, "scan");
      ins.run(ID.counterspell, "", 1, "scan");
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO scans (id, created_at, updated_at, status, printing_id, store_printing_id, oracle_id, name, finish, condition, quantity,
                            lang_detected, store_lang, committed_at, committed_to)
         VALUES (7, ?, ?, 'committed', ?, ?, 'o-bolt', 'Lightning Bolt', 'normal', 'near_mint', 1, 'it', 'en', ?, ?)`,
      ).run(now, now, BOLT_IT.id, ID.lightning, now, JSON.stringify({ type: "binder", name: "Scans" }));
      db.close();
    },
  });
  call = srv.call;
});

after(() => srv?.stop());

const item = (id, quantity, o = {}) => ({ scryfall_id: id, finish: "normal", language: "en", condition: "near_mint", binder: "", ...o, quantity });
const owned = async (id) => (await call("GET", `/api/cards/${id}`)).body.owned.map((r) => `${r.language}/${r.condition}/${r.binder}/${r.source}=${r.quantity}`).sort();

describe("edit / delete / undo API", () => {
  test("POST /api/collection/edit: validation, confirm_master flow, split, log entry", async () => {
    const sol = [item(ID.sol, 1, { binder: "Box" })];
    assert.equal((await call("POST", "/api/collection/edit", { items: sol })).status, 400, "set missing");
    assert.equal((await call("POST", "/api/collection/edit", { items: sol, set: { language: "de" }, actor: "claude" })).status, 400, "actor is app only");
    assert.equal((await call("POST", "/api/collection/edit", { items: sol, set: { printing_id: ID.lightning } })).status, 400, "other card");
    assert.equal((await call("POST", "/api/collection/edit", { items: [item(ID.sol, 9, { binder: "Box" })], set: { language: "de" } })).status, 409);
    assert.equal((await call("POST", "/api/collection/edit", { items: sol, set: { language: "de" } }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await call("POST", "/api/collection/edit", { items: sol, set: { language: "de" } }, { Origin: "http://evil.example" })).status, 403);
    let r = await call("POST", "/api/collection/edit", { items: sol, set: { language: "de" } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "confirm_master");
    assert.equal(r.body.manabox_copies, 1);
    r = await call("POST", "/api/collection/edit", { items: sol, set: { language: "de" }, confirm_master: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.edit_id);
    assert.equal(r.body.edited_copies, 1);
    assert.equal(r.body.converted_copies, 1);
    assert.deepEqual(r.body.rows, [{ scryfall_id: ID.sol, finish: "normal", language: "de", condition: "near_mint", binder: "Box", source: "app", quantity: 1 }]);
    assert.deepEqual(await owned(ID.sol), ["de/near_mint/Box/app=1", "en/near_mint/Box/manabox=2"]);
    assert.equal((await call("GET", "/api/settings")).body.collection_master, "app");
    const { body } = await call("GET", "/api/collection/edits");
    assert.equal(body.edits[0].id, r.body.edit_id);
    assert.deepEqual(Object.keys(body.edits[0]).sort(), ["actor", "at", "copies", "id", "kind", "reason", "summary", "undoable", "undone_at"]);
    assert.equal(body.edits[0].undoable, true);
    // Undo: restores the ManaBox row exactly; a second undo is 409 undone.
    const u = await call("POST", `/api/collection/edits/${r.body.edit_id}/undo`);
    assert.equal(u.status, 200);
    assert.equal(u.body.undone, true);
    assert.deepEqual(await owned(ID.sol), ["en/near_mint/Box/manabox=3"]);
    assert.equal((await call("POST", `/api/collection/edits/${r.body.edit_id}/undo`)).body.code, "undone");
    assert.equal((await call("POST", "/api/collection/edits/99999/undo")).status, 404);
    assert.equal((await call("GET", `/api/collection/edits/${r.body.edit_id}/undo`)).status, 405);
  });

  test("POST /api/collection/delete: confirm, manabox_rows, undo conflict after a move", async () => {
    // Back to a ManaBox master for this test (the previous one flipped it).
    assert.equal((await call("PATCH", "/api/settings", { collection_master: "manabox" })).status, 200);
    const sol = [item(ID.sol, 1, { binder: "Box" })];
    assert.equal((await call("POST", "/api/collection/delete", { items: sol })).status, 400, "confirm missing");
    let r = await call("POST", "/api/collection/delete", { items: sol, confirm: true, expected_copies: 2 });
    assert.equal(r.status, 409);
    assert.deepEqual([r.body.code, r.body.copies], ["changed", 1], "the typed count must match");
    r = await call("POST", "/api/collection/delete", { items: sol, confirm: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "manabox_rows");
    assert.deepEqual(await owned(ID.sol), ["en/near_mint/Box/manabox=3"]);
    r = await call("POST", "/api/collection/delete", { items: sol, confirm: true, confirm_master: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted_copies, 1);
    assert.equal(r.body.collection_master, "app");
    const del = r.body.edit_id;

    // Scanned copies: delete 1 of 2, then move the other away -> the delete's undo conflicts.
    const bolt = [item(ID.lightning, 1, { binder: "Scans" })];
    r = await call("POST", "/api/collection/delete", { items: bolt, confirm: true });
    assert.equal(r.status, 200);
    const boltDel = r.body.edit_id;
    assert.equal((await call("POST", "/api/collection/move", { items: bolt, to_binder: "Elsewhere", create: true })).status, 200);
    let list = (await call("GET", "/api/collection/edits?limit=2")).body.edits;
    assert.deepEqual(list.map((e) => [e.id, e.kind, e.undoable]), [[boltDel, "delete", false], [del, "delete", true]]);
    r = await call("POST", `/api/collection/edits/${boltDel}/undo`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "conflict");
    // Move it back: undo works again.
    assert.equal((await call("POST", "/api/collection/move", { items: [item(ID.lightning, 1, { binder: "Elsewhere" })], to_binder: "Scans" })).status, 200);
    assert.equal((await call("POST", `/api/collection/edits/${boltDel}/undo`)).status, 200);
    assert.equal((await call("POST", `/api/collection/edits/${del}/undo`)).status, 200);
    assert.deepEqual(await owned(ID.sol), ["en/near_mint/Box/manabox=3"]);
    assert.deepEqual(await owned(ID.lightning), ["en/near_mint/Scans/scan=2"]);
    list = (await call("GET", "/api/collection/edits")).body.edits;
    assert.ok(list.every((e) => e.undone_at && !e.undoable));
  });

  test("POST /api/maintenance/relanguage-scans: dry run by default, apply, undo", async () => {
    assert.equal((await call("POST", "/api/maintenance/relanguage-scans", {})).status, 400);
    let r = await call("POST", "/api/maintenance/relanguage-scans", { scan_ids: [7] });
    assert.equal(r.status, 200);
    assert.equal(r.body.applied, false);
    assert.deepEqual(r.body.changes, [{
      scan_id: 7, name: "Lightning Bolt", from: { scryfall_id: ID.lightning, language: "en" }, to: { scryfall_id: BOLT_IT.id, language: "it" },
      copies: 1, binder: "Scans",
    }]);
    assert.deepEqual(await owned(ID.lightning), ["en/near_mint/Scans/scan=2"]);
    r = await call("POST", "/api/maintenance/relanguage-scans", { scan_ids: [7], dry_run: false });
    assert.equal(r.body.applied, true);
    assert.deepEqual(await owned(ID.lightning), ["en/near_mint/Scans/scan=1", "it/near_mint/Scans/scan=1"]);
    const [entry] = (await call("GET", "/api/collection/edits?limit=1")).body.edits;
    assert.deepEqual([entry.id, entry.kind, entry.actor, entry.undoable], [r.body.edit_id, "relanguage", "maintenance", true]);
    assert.equal((await call("POST", `/api/collection/edits/${r.body.edit_id}/undo`)).status, 200);
    assert.deepEqual(await owned(ID.lightning), ["en/near_mint/Scans/scan=2"]);
  });

  test("GET /api/collection/edits: limit, newest first", async () => {
    const all = (await call("GET", "/api/collection/edits?limit=500")).body.edits;
    assert.equal(all.length, 4);
    assert.deepEqual(all.map((e) => e.id), [...all.map((e) => e.id)].sort((a, b) => b - a));
    assert.equal((await call("GET", "/api/collection/edits?limit=1")).body.edits.length, 1);
    assert.equal((await call("GET", "/api/collection/edits?limit=nope")).body.edits.length, 4);
  });
});
