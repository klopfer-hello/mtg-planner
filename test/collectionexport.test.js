// Collection export: ManaBox layout (round trip through importManaBoxCsv), plain CSV, binder filter, quoting.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { csvField, exportCollection, exportRows } from "../lib/collectionexport.js";
import { importManaBoxCsv, parseCsv } from "../lib/manabox.js";
import { ID, seedCards, stubScryfall, tempDb } from "./fixtures.js";

const insert = (db, [id, qty, o = {}]) => db.prepare(
  `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(id, o.finish ?? "normal", o.language ?? "en", o.condition ?? "near_mint", o.binder ?? "", qty, o.price ?? null, o.currency ?? null, o.source ?? "manabox");

const ROWS = [
  [ID.sol, 2, { binder: "Trade, \"Good\" Stuff", price: 1.5, currency: "EUR" }],
  [ID.lightning, 3, { finish: "foil", source: "scan" }],
  [ID.counterspell7ed, 1, { language: "de", condition: "lightly_played", binder: "Blue", source: "app" }],
  [ID.azorius, 1, { finish: "etched", binder: "Blue" }],
];
const keyOf = (r) => [r.scryfall_id, r.finish, r.language, r.condition, r.binder, r.quantity].join("|");
const collectionKeys = (db) => db.prepare("SELECT * FROM collection").all().map(keyOf).sort();

describe("collection export", () => {
  let ctx;
  let stub;
  beforeEach(() => {
    ctx = tempDb();
    seedCards(ctx.db);
    for (const r of ROWS) insert(ctx.db, r);
    stub = stubScryfall();
  });
  afterEach(() => { stub.restore(); ctx.cleanup(); });

  test("csvField quotes only when needed", () => {
    assert.equal(csvField("plain"), "plain");
    assert.equal(csvField('a "b", c'), '"a ""b"", c"');
    assert.equal(csvField("line\nbreak"), '"line\nbreak"');
    assert.equal(csvField(" pad"), '" pad"');
    assert.equal(csvField(null), "");
    assert.equal(csvField(0), "0");
  });

  test("ManaBox layout round-trips through the importer (every row, binder, finish, language, condition)", async () => {
    const { text, rows } = exportCollection(ctx.db, { format: "manabox" });
    assert.equal(rows, 4);
    const parsed = parseCsv(text);
    assert.deepEqual(Object.keys(parsed[0]).slice(0, 4), ["binder name", "binder type", "name", "set code"]);
    const sol = parsed.find((r) => r.name === "Sol Ring");
    assert.equal(sol["binder name"], 'Trade, "Good" Stuff');
    assert.equal(sol["purchase price"], "1.5");
    assert.equal(sol["purchase price currency"], "EUR");

    const other = tempDb();
    try {
      const summary = await importManaBoxCsv(other.db, text, { mode: "replace" });
      assert.equal(summary.unresolved?.length ?? 0, 0);
      assert.deepEqual(collectionKeys(other.db), collectionKeys(ctx.db));
    } finally {
      other.cleanup();
    }
  });

  test("binder filter: exact, case-insensitive; '' = Unsorted", () => {
    assert.deepEqual(exportRows(ctx.db, { binder: "blue" }).map((r) => r.name).sort(), ["Azorius Charm", "Counterspell"]);
    assert.deepEqual(exportRows(ctx.db, { binder: "" }).map((r) => r.name), ["Lightning Bolt"]);
    assert.equal(exportRows(ctx.db, { binder: "nope" }).length, 0);
  });

  test("plain CSV has EUR price and value per line, the source, never USD", () => {
    const { text } = exportCollection(ctx.db, { format: "csv" });
    const rows = parseCsv(text);
    assert.deepEqual(Object.keys(rows[0]), ["name", "set", "set_name", "collector_number", "finish", "language", "condition",
      "binder", "quantity", "price_eur", "value_eur", "source", "scryfall_id"]);
    for (const r of rows) {
      if (r.price_eur) assert.equal(Number(r.value_eur).toFixed(2), (Number(r.price_eur) * Number(r.quantity)).toFixed(2));
    }
    assert.equal(rows.find((r) => r.name === "Lightning Bolt").source, "scan");
    assert.throws(() => exportCollection(ctx.db, { format: "xlsx" }), /format must be/);
  });

  test("a ManaBox deck binder is exported with binder type deck", () => {
    ctx.db.prepare("INSERT INTO decks (name, source, status, manabox_binder) VALUES ('Blue', 'manabox', 'built', 'Blue')").run();
    const types = new Set(exportRows(ctx.db, { binder: "Blue" }).map((r) => r.binder_type));
    assert.deepEqual([...types], ["deck"]);
  });
});
