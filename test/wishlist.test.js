// Wishlist (lib/wishlist.js): adding by id / oracle / name (Scryfall only for
// unknown cards), merge, any-printing vs exact-printing price and owned count,
// got it, below max price, validation, the shopping section, and the price
// refresh covering wishlist printings.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { upsertCards } from "../lib/db.js";
import { normalizeCard } from "../lib/scryfall.js";
import {
  WishlistError, addWishlistItem, deleteWishlistItem, deleteWishlistItems, listWishlist, updateWishlistItem, wishlistShopping, wishlistText,
} from "../lib/wishlist.js";
import { buyListText } from "../lib/decktext.js";
import { refreshOwnedCards } from "../lib/manabox.js";
import { ID, SCRYFALL_CARDS, seedCards, seedCollection, stubScryfall, tempDb } from "./fixtures.js";

let ctx, stub;
beforeEach(() => { ctx = tempDb(); stub = stubScryfall(); });
afterEach(() => { stub.restore(); ctx.cleanup(); });

const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof WishlistError && e.status === status && re.test(e.message));

describe("addWishlistItem", () => {
  test("by Scryfall id: unknown card is fetched once; exact printing by default", async () => {
    const { item, merged } = await addWishlistItem(ctx.db, { scryfall_id: ID.atraxa, quantity: 2, max_price_eur: 25, priority: "high", note: "for a deck" });
    assert.equal(merged, false);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual([item.name, item.any_printing, item.quantity, item.price_eur, item.owned, item.to_buy, item.cost_eur, item.below_max, item.priority, item.source],
      ["Atraxa, Praetors' Voice", false, 2, 20, 0, 2, 40, true, "high", "app"]);
    assert.equal(item.set_code, "2xm");
  });

  test("by name: a known card needs no Scryfall call; any printing = cheapest known; owned counts every printing", async () => {
    seedCards(ctx.db);
    seedCollection(ctx.db, [[ID.counterspell7ed, 1]]);
    const { item } = await addWishlistItem(ctx.db, { name: "counterspell", quantity: 3 });
    assert.equal(stub.calls.length, 0);
    assert.equal(item.any_printing, true);
    assert.equal(item.price_eur, 1, "MH2 €1.00 beats 7ED €3.00");
    assert.equal(item.price_printing_id, ID.counterspell);
    assert.deepEqual([item.owned, item.to_buy, item.cost_eur], [1, 2, 2]);
    // The exact 7ED printing: only its own price and copies.
    const exact = (await addWishlistItem(ctx.db, { scryfall_id: ID.counterspell7ed })).item;
    assert.deepEqual([exact.any_printing, exact.price_eur, exact.owned, exact.got_it], [false, 3, 1, true]);
  });

  test("by name not known locally: resolved on Scryfall; unknown name 404", async () => {
    const { item } = await addWishlistItem(ctx.db, { name: "Serra Angel" }, { source: "claude" });
    assert.equal(item.source, "claude");
    assert.equal(item.scryfall_id, ID.serra);
    await rejects(addWishlistItem(ctx.db, { name: "No Such Card" }), 404, /No card named/);
  });

  test("by oracle id (deck to-buy rows) uses a known printing", async () => {
    seedCards(ctx.db);
    const { item } = await addWishlistItem(ctx.db, { oracle_id: "o-bolt", name: "Lightning Bolt" });
    assert.deepEqual([item.name, item.any_printing, item.price_eur], ["Lightning Bolt", true, 2]);
  });

  test("the same card again merges: quantity added, given fields replaced", async () => {
    seedCards(ctx.db);
    await addWishlistItem(ctx.db, { name: "Sol Ring", quantity: 1, note: "a" });
    const { item, merged } = await addWishlistItem(ctx.db, { name: "Sol Ring", quantity: 2, max_price_eur: 1 });
    assert.equal(merged, true);
    assert.deepEqual([item.quantity, item.note, item.max_price_eur, item.below_max], [3, "a", 1, false]);
    // A different finish is another item.
    const foil = await addWishlistItem(ctx.db, { name: "Sol Ring", finish: "foil" });
    assert.equal(foil.merged, false);
    assert.equal(foil.item.price_eur, null, "no EUR foil price: unpriced, never USD");
    assert.equal(listWishlist(ctx.db).items.length, 2);
  });

  test("validation", async () => {
    seedCards(ctx.db);
    await rejects(addWishlistItem(ctx.db, {}), 400, /required/);
    await rejects(addWishlistItem(ctx.db, { name: "Sol Ring", quantity: 0 }), 400, /quantity/);
    await rejects(addWishlistItem(ctx.db, { name: "Sol Ring", max_price_eur: -1 }), 400, /max_price_eur/);
    await rejects(addWishlistItem(ctx.db, { name: "Sol Ring", finish: "shiny" }), 400, /finish/);
    await rejects(addWishlistItem(ctx.db, { name: "Sol Ring", language: "german!" }), 400, /language/);
    await rejects(addWishlistItem(ctx.db, { name: "Sol Ring", priority: 7 }), 400, /priority/);
    await rejects(addWishlistItem(ctx.db, { scryfall_id: "nope" }), 400, /Scryfall id/);
    await rejects(addWishlistItem(ctx.db, { scryfall_id: "-".repeat(36) }), 400, /Scryfall id/);
    // The same language codes as copy edits accept (db.js LANG_RE), e.g. ManaBox's pt_br.
    const { item } = await addWishlistItem(ctx.db, { name: "Sol Ring", language: "pt_br" });
    assert.equal(item.language, "pt_br");
  });
});

describe("bulk remove + text export", () => {
  test("wishlistText: items still to buy, printing for exact items, finish marks; got-it items left out", async () => {
    seedCards(ctx.db);
    seedCollection(ctx.db, [[ID.sol, 1]]);
    await addWishlistItem(ctx.db, { name: "Sol Ring" }); // got it
    const bolt = (await addWishlistItem(ctx.db, { name: "Lightning Bolt", quantity: 3, any_printing: true })).item;
    const atraxa = (await addWishlistItem(ctx.db, { scryfall_id: ID.atraxa, any_printing: false, finish: "foil" })).item;
    const set = atraxa.set_code.toUpperCase();
    assert.equal(bolt.any_printing, true);
    assert.equal(wishlistText(ctx.db), `3 Lightning Bolt\n1 Atraxa, Praetors' Voice (${set}) ${atraxa.collector_number} *F*\n`);
    assert.equal(wishlistText(tempDb().db), "", "empty list = empty file");
  });

  test("deleteWishlistItems: removes the given ids, skips gone ones, validates", async () => {
    seedCards(ctx.db);
    const ids = [];
    for (const name of ["Sol Ring", "Lightning Bolt", "Serra Angel"]) ids.push((await addWishlistItem(ctx.db, { name })).item.id);
    assert.equal(deleteWishlistItems(ctx.db, [ids[0], ids[1], ids[1], 99999]), 2);
    assert.deepEqual(listWishlist(ctx.db).items.map((i) => i.name), ["Serra Angel"]);
    for (const bad of [[], "1", [0], [1.5], ["2"]]) assert.throws(() => deleteWishlistItems(ctx.db, bad), (e) => e instanceof WishlistError && e.status === 400);
    assert.throws(() => deleteWishlistItems(ctx.db, Array.from({ length: 1001 }, (_, i) => i + 1)), /At most 1000/);
  });

  test("buyListText: one line per card, sorted by name, zero/blank rows dropped", () => {
    assert.equal(buyListText([{ name: "Sol Ring", need: 1 }, { name: "Arcane Signet", need: 2 }, { name: "X", need: 0 }, { need: 3 }]),
      "2 Arcane Signet\n1 Sol Ring\n");
    assert.equal(buyListText([{ name: "Bolt", short: 4, need: 9 }], "short"), "4 Bolt\n");
    assert.equal(buyListText([]), "");
  });
});

describe("list, update, delete, shopping", () => {
  test("got it items go last; totals and shopping section count only open items", async () => {
    seedCards(ctx.db);
    seedCollection(ctx.db, [[ID.sol, 1]]);
    const sol = (await addWishlistItem(ctx.db, { name: "Sol Ring" })).item;
    const bolt = (await addWishlistItem(ctx.db, { name: "Lightning Bolt", quantity: 2, priority: "low", max_price_eur: 2 })).item;
    const list = listWishlist(ctx.db);
    assert.deepEqual(list.items.map((i) => [i.name, i.got_it]), [["Lightning Bolt", false], ["Sol Ring", true]]);
    assert.deepEqual(list.totals, { items: 2, to_buy: 2, to_buy_eur: 4, unpriced: 0, got_it: 1, below_max: 1 });
    const shop = wishlistShopping(ctx.db);
    assert.deepEqual(shop.items.map((i) => [i.name, i.need, i.cost_eur, i.below_max]), [["Lightning Bolt", 2, 4, true]]);
    assert.equal(shop.total_eur, 4);

    const upd = updateWishlistItem(ctx.db, bolt.id, { quantity: 1, max_price_eur: null, priority: 1, note: "  x  " });
    assert.deepEqual([upd.quantity, upd.max_price_eur, upd.priority, upd.note], [1, null, "high", "x"]);
    assert.throws(() => updateWishlistItem(ctx.db, 999, { quantity: 1 }), (e) => e.status === 404);
    assert.equal(deleteWishlistItem(ctx.db, sol.id), true);
    assert.equal(deleteWishlistItem(ctx.db, sol.id), false);
    assert.equal(listWishlist(ctx.db).items.length, 1);
  });

  test("the price refresh also fetches wishlist printings (and other known printings of any-printing items)", async () => {
    upsertCards(ctx.db, SCRYFALL_CARDS.filter((c) => c.oracle_id === "o-counter").map(normalizeCard));
    await addWishlistItem(ctx.db, { scryfall_id: ID.counterspell, any_printing: true });
    stub.calls.length = 0;
    const r = await refreshOwnedCards(ctx.db);
    assert.equal(r.refreshed, 2);
    assert.deepEqual(stub.calls.flat().map((i) => i.id).sort(), [ID.counterspell, ID.counterspell7ed].sort());
  });
});
