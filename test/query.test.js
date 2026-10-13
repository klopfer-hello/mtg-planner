// Collection search: the query compiler and searchCollection against a seeded DB.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { compileQuery, QUERY_HELP, searchCollection } from "../lib/query.js";
import { cardPrice, formatPrice, stats } from "../lib/db.js";
import { ID, seedCards, seedCollection, tempDb } from "./fixtures.js";

describe("compileQuery", () => {
  test("empty query matches everything", () => {
    const { where, having } = compileQuery("");
    assert.equal(where.sql, "1");
    assert.equal(having.sql, "1");
    assert.deepEqual(where.params, []);
  });

  test("bare words and quoted values become name LIKE terms", () => {
    const { where } = compileQuery('bolt "sol ring"');
    assert.match(where.sql, /c\.name LIKE \?.*AND.*c\.name LIKE \?/);
    assert.deepEqual(where.params, ["%bolt%", "%sol ring%"]);
  });

  test("negation wraps the clause in NOT", () => {
    const { where } = compileQuery("-t:creature");
    assert.equal(where.sql, "NOT (c.type_line LIKE ?)");
    assert.deepEqual(where.params, ["%creature%"]);
  });

  test("qty terms go to HAVING, everything else to WHERE", () => {
    const { where, having } = compileQuery("t:instant qty>=4");
    assert.deepEqual(where.params, ["%instant%"]);
    assert.equal(having.sql, "(SUM(col.quantity) >= ?)");
    assert.deepEqual(having.params, [4]);
  });

  const accepted = [
    "n:bolt", "name:bolt", "t:creature", "type:creature", 'o:"draw a card"', "oracle:draw", "text:draw",
    "k:flying", "kw:flying", "keyword:flying", "c:wu", "color:red", "c=r", "c<=bg", "c<wu", "c>u", "c>=u", "c:m", "c:c",
    "id:bg", "ci:wubrg", "identity=g", "cmc<=3", "mv=2", "cmc:4", "cmc!=1", "r:mythic", "r:m", "rarity:common",
    "s:mh2", "e:mh2", "set:MH2", "f:commander", "format:modern", "legal:pauper", "is:foil", "is:nonfoil", "is:etched",
    "is:commander", "eur>5", "usd<1", "qty>=4", "count=1", 'b:"trade binder"', "binder:deck", "lang:de",
  ];
  for (const q of accepted) {
    test(`accepts ${q}`, () => {
      const { where, having } = compileQuery(q);
      assert.ok(where.sql !== "1" || having.sql !== "1", `${q} produced no clause`);
      assert.doesNotThrow(() => compileQuery(`-${q}`));
    });
  }

  test("keys are case-insensitive", () => {
    assert.deepEqual(compileQuery("T:Creature").where, compileQuery("t:Creature").where);
  });

  test("unknown key throws with the help text", () => {
    assert.throws(() => compileQuery("foo:bar"), (err) => /Unknown search key "foo"/.test(err.message) && err.message.includes(QUERY_HELP));
  });

  test("bad values throw", () => {
    assert.throws(() => compileQuery("r:legendary"), /Unknown rarity/);
    assert.throws(() => compileQuery("is:shiny"), /Unknown is: value/);
    assert.throws(() => compileQuery("cmc>abc"), /Not a number/);
    assert.throws(() => compileQuery("eur>cheap"), /Not a number/);
    assert.throws(() => compileQuery("c:gold"), /Unknown color: gold/);
    assert.throws(() => compileQuery("id:purple"), /Unknown color/);
  });

  test("user values are bound as parameters, never inlined", () => {
    const evil = `'; DROP TABLE cards; --`;
    const { where } = compileQuery(`o:"${evil}" s:"${evil}"`);
    assert.ok(!where.sql.includes("DROP"));
    assert.deepEqual(where.params, [`%${evil}%`, evil.toLowerCase()]);
  });
});

describe("searchCollection", () => {
  let ctx;
  before(() => {
    ctx = tempDb();
    seedCards(ctx.db);
    seedCollection(ctx.db, [
      [ID.sol, 2, { binder: "Trade Binder" }],
      [ID.lightning, 3],
      [ID.lightning, 1, { finish: "foil" }],
      [ID.serra, 4],
      [ID.atraxa, 1],
      [ID.counterspell, 2],
      [ID.counterspell7ed, 1, { language: "de" }],
      [ID.delver, 1],
      [ID.azorius, 1, { finish: "etched" }],
    ]);
    // Forest is cached in `cards` but not owned: must never show up.
  });
  after(() => ctx.cleanup());

  const names = (q, opts = {}) => searchCollection(ctx.db, { q, ...opts }).rows.map((r) => r.name).sort();

  test("everything owned, one row per oracle card", () => {
    const res = searchCollection(ctx.db, {});
    assert.equal(res.total, 7);
    const counter = res.rows.find((r) => r.name === "Counterspell");
    assert.equal(counter.qty, 3);
    assert.equal(counter.printing_count, 2);
    assert.ok(!res.rows.some((r) => r.name === "Forest"));
  });

  test("group=printing splits printings", () => {
    const res = searchCollection(ctx.db, { q: "counterspell", group: "printing" });
    assert.equal(res.total, 2);
    assert.deepEqual(res.rows.map((r) => r.set_code).sort(), ["7ed", "mh2"]);
  });

  test("name, type, oracle, keyword", () => {
    assert.deepEqual(names("bolt"), ["Lightning Bolt"]);
    assert.deepEqual(names("n:angel"), ["Serra Angel"]);
    assert.deepEqual(names("t:creature"), ["Atraxa, Praetors' Voice", "Delver of Secrets // Insectile Aberration", "Serra Angel"]);
    assert.deepEqual(names("-t:creature"), ["Azorius Charm", "Counterspell", "Lightning Bolt", "Sol Ring"]);
    assert.deepEqual(names('o:"draw a card"'), ["Azorius Charm"]);
    assert.deepEqual(names("k:flying"), ["Atraxa, Praetors' Voice", "Delver of Secrets // Insectile Aberration", "Serra Angel"]);
    assert.deepEqual(names("k:vigilance -t:legendary"), ["Serra Angel"]);
  });

  test("color operators", () => {
    assert.deepEqual(names("c:wu"), ["Atraxa, Praetors' Voice", "Azorius Charm"]);
    assert.deepEqual(names("c=wu"), ["Azorius Charm"]);
    assert.deepEqual(names("c<=wu"), ["Azorius Charm", "Counterspell", "Delver of Secrets // Insectile Aberration", "Serra Angel", "Sol Ring"]);
    assert.deepEqual(names("c<wu"), ["Counterspell", "Delver of Secrets // Insectile Aberration", "Serra Angel", "Sol Ring"]);
    assert.deepEqual(names("c>wu"), ["Atraxa, Praetors' Voice"]);
    assert.deepEqual(names("c:red"), ["Lightning Bolt"]);
    assert.deepEqual(names("c:m"), ["Atraxa, Praetors' Voice", "Azorius Charm"]);
    assert.deepEqual(names("c:c"), ["Sol Ring"]);
    assert.deepEqual(names("-c:u"), ["Lightning Bolt", "Serra Angel", "Sol Ring"]);
  });

  test("guild/shard names and c!= (not exactly)", () => {
    assert.deepEqual(names("c=azorius"), ["Azorius Charm"]);
    assert.deepEqual(names("c:azorius"), names("c:wu"));
    assert.deepEqual(names("id:esper"), names("id:wub"));
    assert.deepEqual(names("c:boros"), [], "boros is red-white, not black-red");
    assert.deepEqual(names("c!=r"), names("-c=r"));
    assert.ok(!names("c!=r").includes("Lightning Bolt"));
    assert.ok(names("c!=wu").includes("Atraxa, Praetors' Voice"));
  });

  test("color identity is a subset match (commander deck building)", () => {
    assert.deepEqual(names("id:r"), ["Lightning Bolt", "Sol Ring"]);
    assert.deepEqual(names("id:wubg -c:c"), ["Atraxa, Praetors' Voice", "Azorius Charm", "Counterspell", "Delver of Secrets // Insectile Aberration", "Serra Angel"]);
    assert.deepEqual(names("id=wu"), ["Azorius Charm"]);
  });

  test("numbers: cmc / mv / prices", () => {
    assert.deepEqual(names("cmc<=1"), ["Delver of Secrets // Insectile Aberration", "Lightning Bolt", "Sol Ring"]);
    assert.deepEqual(names("mv=5"), ["Serra Angel"]);
    assert.deepEqual(names("cmc:4"), ["Atraxa, Praetors' Voice"]);
    assert.deepEqual(names("eur>10"), ["Atraxa, Praetors' Voice"]);
    assert.deepEqual(names("usd<0.5"), ["Azorius Charm", "Delver of Secrets // Insectile Aberration", "Serra Angel"]);
    // Price filters use the owned finish: the foil Bolt is €5.
    assert.deepEqual(names("eur>=5"), ["Atraxa, Praetors' Voice", "Lightning Bolt"]);
  });

  test("rarity, set, format legality", () => {
    assert.deepEqual(names("r:m"), ["Atraxa, Praetors' Voice"]);
    assert.deepEqual(names("r:common"), ["Counterspell", "Delver of Secrets // Insectile Aberration", "Lightning Bolt"]);
    assert.deepEqual(names("s:MH2"), ["Counterspell"]);
    assert.equal(searchCollection(ctx.db, { q: "s:mh2" }).rows[0].qty, 2, "set filter only counts that printing");
    assert.deepEqual(names("f:standard"), ["Serra Angel"]);
    assert.deepEqual(names("f:pauper -c:u"), ["Lightning Bolt"]);
  });

  test("finishes, commander, binder, language", () => {
    const foil = searchCollection(ctx.db, { q: "is:foil" }).rows;
    assert.deepEqual(foil.map((r) => [r.name, r.qty]), [["Lightning Bolt", 1]]);
    assert.deepEqual(names("is:etched"), ["Azorius Charm"]);
    assert.ok(names("is:nonfoil").includes("Lightning Bolt"));
    assert.ok(!names("is:nonfoil").includes("Azorius Charm"));
    assert.deepEqual(names("is:commander"), ["Atraxa, Praetors' Voice"]);
    assert.deepEqual(names('b:"trade binder"'), ["Sol Ring"]);
    assert.deepEqual(names("lang:de"), ["Counterspell"]);
  });

  test("quantity filter uses the summed count", () => {
    assert.deepEqual(names("qty>=4"), ["Lightning Bolt", "Serra Angel"]);
    assert.deepEqual(names("qty=3"), ["Counterspell"]);
    assert.deepEqual(names("-qty>=2"), ["Atraxa, Praetors' Voice", "Azorius Charm", "Delver of Secrets // Insectile Aberration"]);
  });

  test("sorting and paging", () => {
    const byPrice = searchCollection(ctx.db, { sort: "price" }).rows.map((r) => r.name);
    assert.equal(byPrice[0], "Atraxa, Praetors' Voice", "price sorts descending by default");
    const byCmc = searchCollection(ctx.db, { sort: "cmc", dir: "desc" }).rows;
    assert.equal(byCmc[0].name, "Serra Angel");
    const byQty = searchCollection(ctx.db, { sort: "qty" }).rows;
    assert.ok(byQty[0].qty >= byQty.at(-1).qty);
    const page = searchCollection(ctx.db, { limit: 2, offset: 2 });
    assert.equal(page.total, 7);
    assert.equal(page.rows.length, 2);
    assert.deepEqual(page.rows.map((r) => r.name), names("").slice(2, 4));
  });

  test("card rows show and sort by their most valuable owned printing/finish", () => {
    const rows = searchCollection(ctx.db, { sort: "price" }).rows;
    assert.deepEqual(rows.map((r) => r.name), [
      "Atraxa, Praetors' Voice", "Lightning Bolt", "Counterspell", "Sol Ring",
      "Delver of Secrets // Insectile Aberration", "Azorius Charm", "Serra Angel",
    ]);
    const bolt = rows.find((r) => r.name === "Lightning Bolt");
    assert.equal(bolt.finish, "foil");
    assert.equal(bolt.price_value, 5);
    const counter = rows.find((r) => r.name === "Counterspell");
    assert.equal(counter.set_code, "7ed", "the €3 printing, not the €1 one");
    assert.equal(cardPrice(counter, counter.finish).value, 3);
    assert.equal(rows.find((r) => r.name === "Azorius Charm").price_value, 0.3, "etched copy falls back to the usd price");
  });

  test("sort=set applies the direction to the set too", () => {
    const sets = (dir) => searchCollection(ctx.db, { group: "printing", sort: "set", dir }).rows.map((r) => r.set_code);
    const asc = sets("asc");
    assert.deepEqual(asc, [...asc].sort());
    assert.deepEqual(sets("desc"), [...asc].reverse());
  });

  test("rows carry finishes, colors and raw JSON prices", () => {
    const bolt = searchCollection(ctx.db, { q: "bolt" }).rows[0];
    assert.deepEqual(bolt.finishes.split(",").sort(), ["foil", "normal"]);
    assert.equal(bolt.colors, "R");
    assert.equal(typeof bolt.prices, "string");
    assert.equal(JSON.parse(bolt.prices).eur, "2.00");
    const atraxa = searchCollection(ctx.db, { q: "atraxa" }).rows[0];
    assert.equal(atraxa.colors, "WUBG", "colors are stored in WUBRG order");
  });

  test("double-faced cards are normalised from their faces", () => {
    const delver = searchCollection(ctx.db, { q: "delver" }).rows[0];
    assert.equal(delver.colors, "U");
    assert.match(delver.type_line, /Human Wizard \/\/ .*Human Insect/);
    assert.equal(delver.mana_cost, "{U}");
    assert.equal(delver.image_small, "https://img/delver-s.jpg");
  });

  test("bad query throws", () => {
    assert.throws(() => searchCollection(ctx.db, { q: "zzz:1" }), /Unknown search key/);
  });

  test("stats() totals and EUR value", () => {
    const s = stats(ctx.db);
    assert.equal(s.unique_cards, 7);
    assert.equal(s.printings, 8);
    assert.equal(s.total_cards, 16);
    // 2*1.5 + 3*2 + 1*5(foil) + 4*0.1 + 20 + 2*1 + 1*3 + 0.5 ; Azorius Charm has only a USD price
    assert.equal(s.value_eur, 39.9);
    assert.equal(s.decks, 0);
    assert.equal(s.last_import, null);
  });
});

describe("cardPrice / formatPrice", () => {
  test("finish-specific price with fallbacks", () => {
    const card = { prices: JSON.stringify({ eur: "2.00", eur_foil: "5.00", usd: "3.00", usd_etched: "9.00" }) };
    assert.deepEqual(cardPrice(card), { value: 2, currency: "€" });
    assert.deepEqual(cardPrice(card, "foil"), { value: 5, currency: "€" });
    assert.deepEqual(cardPrice(card, "etched"), { value: 2, currency: "€" }, "falls back to the plain EUR price");
    assert.deepEqual(cardPrice({ prices: { usd: "0.30" } }), { value: 0.3, currency: "$" });
    assert.deepEqual(cardPrice({ prices: { usd_etched: "4.23" } }), { value: 4.23, currency: "$" }, "etched-only printing");
    assert.deepEqual(cardPrice({ prices: { eur_foil: "1.10", usd: null } }), { value: 1.1, currency: "€" }, "foil-only printing");
    assert.equal(cardPrice({ prices: "{}" }), null);
    assert.equal(cardPrice({ prices: null }), null);
    assert.equal(formatPrice({ value: 1.5, currency: "€" }), "€1.50");
    assert.equal(formatPrice(null), "n/a");
  });
});
