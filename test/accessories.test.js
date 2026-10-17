// Tokens & extras (lib/accessories.js) and the deck cover (lib/decks.js deckCover):
// token phrases, counters/markers, estimate math, owned token matching, schema v15,
// the backfill of all_parts + token rows, deck detail / build list / text output.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ESTIMATE_CAP, accessoriesText, createAccessoryFetcher, deckAccessories, diceSizes, ensureAccessoryData, markersOf, namedCounters, tokenPhrases,
} from "../lib/accessories.js";
import { SCHEMA_VERSION, getAppMeta, migrate, setAppMeta, upsertCards } from "../lib/db.js";
import { artCropUrl, deckCover, deckDetail, deckToText, listDecks } from "../lib/decks.js";
import { buildChecklist, setBuildPick } from "../lib/deckbuild.js";
import { CARD_FACTS_META, backfillCardFacts, cardFactsPending, tokenFactsPending } from "../lib/manabox.js";
import { normalizeCard, trimParts } from "../lib/scryfall.js";
import { stubScryfall, tempDb } from "./fixtures.js";

const legal = { pauper: "legal", commander: "legal" };
const img = (id) => ({ small: `https://cards.scryfall.io/small/front/0/0/${id}.jpg?1`, normal: `https://cards.scryfall.io/normal/front/0/0/${id}.jpg?1` });
const card = (id, name, extra = {}) => ({
  id, oracle_id: `o-${id}`, name, set: "tst", set_name: "Test", collector_number: id.slice(-3), lang: "en", rarity: "common",
  type_line: "Sorcery", mana_cost: "{1}", cmc: 1, colors: ["W"], color_identity: ["W"], keywords: [], legalities: legal,
  prices: { eur: "0.10" }, image_uris: img(id), layout: "normal", game_changer: false, ...extra,
});
const BIRD = card("t0000000-0000-0000-0000-000000000001", "Bird", {
  layout: "token", type_line: "Token Creature — Bird", power: "1", toughness: "1", oracle_text: "Flying", keywords: ["Flying"], cmc: 0, prices: {},
});
const CLUE = card("t0000000-0000-0000-0000-000000000002", "Clue", {
  layout: "token", type_line: "Token Artifact — Clue", colors: [], oracle_text: "{2}, Sacrifice this token: Draw a card.", cmc: 0, prices: {},
});
const part = (c, component = "token") => ({ object: "related_card", id: c.id, component, name: c.name, type_line: c.type_line, uri: "x" });
const SCREECH = card("c0000000-0000-0000-0000-000000000001", "Battle Screech", {
  oracle_text: "Create two 1/1 white Bird creature tokens with flying.\nFlashback—Tap three untapped white creatures you control.",
  keywords: ["Flashback"], prices: { eur: "0.50" },
});
SCREECH.all_parts = [part(SCREECH, "combo_piece"), part(BIRD)];
const INSPECTOR = card("c0000000-0000-0000-0000-000000000002", "Thraben Inspector", {
  type_line: "Creature — Human Soldier", power: "1", toughness: "2", keywords: ["Investigate"], prices: { eur: "0.20" },
  oracle_text: "When this creature enters, investigate. (To investigate, create a Clue token. It's an artifact with \"{2}, Sacrifice this token: Draw a card.\")",
});
INSPECTOR.all_parts = [part(INSPECTOR, "combo_piece"), part(CLUE)];
const INFORMANT = card("c0000000-0000-0000-0000-000000000003", "Raffine's Informant", {
  type_line: "Creature — Human Wizard", power: "2", toughness: "1", keywords: ["Connive"], prices: { eur: "2.00" },
  oracle_text: "When this creature enters, it connives. (Draw a card, then discard a card. If you discarded a nonland card, put a +1/+1 counter on this creature.)",
});
const PLAINS = card("c0000000-0000-0000-0000-000000000004", "Plains", { type_line: "Basic Land — Plains", prices: { eur: "9.00" }, cmc: 0 });
const POOL = [BIRD, CLUE, SCREECH, INSPECTOR, INFORMANT, PLAINS];

describe("token phrases", () => {
  test("create counts, X, repeatable, keyword actions, reminder text ignored", () => {
    const p = tokenPhrases("Create two 1/1 white Bird creature tokens with flying.");
    assert.deepEqual(p.map((x) => [x.names, x.count, x.pt, x.colors, x.repeatable]), [[["Bird"], 2, "1/1", "W", false]]);
    const q = tokenPhrases("Whenever you cast a spell, create a Treasure token.\n{2}, {T}: Create X 2/2 black Zombie creature tokens.");
    assert.deepEqual(q.map((x) => [x.names.join(" "), x.count, x.repeatable]), [["Treasure", 1, true], ["Zombie", null, true]]);
    assert.deepEqual(tokenPhrases(INSPECTOR.oracle_text).map((x) => [x.names, x.count]), [[["Clue"], 1]], "reminder text not counted twice");
    assert.equal(tokenPhrases("Investigate twice.")[0].count, 2);
    assert.equal(tokenPhrases("Create a token that's a copy of target creature.")[0].copy, true);
    assert.deepEqual(tokenPhrases("Afterlife 2 (When this dies, create two 1/1 ...)").map((x) => [x.names, x.count]), [[["Spirit"], 2]]);
    assert.equal(tokenPhrases("For each opponent, create a 1/1 red Goblin creature token.")[0].count, null, "for each = variable");
  });

  test("counters and markers", () => {
    const m = (text, extra = {}) => markersOf({ oracle_text: text, keywords: "[]", type_line: "Instant", ...extra });
    assert.deepEqual(m(INFORMANT.oracle_text, { keywords: JSON.stringify(["Connive"]) }), ["plus1"]);
    assert.ok(m("", { type_line: "Legendary Planeswalker — Ajani" }).includes("loyalty"));
    assert.ok(m("", { type_line: "Enchantment — Saga" }).includes("lore"));
    assert.ok(m("Toxic 1").includes("poison"));
    assert.ok(m("Roll a d20.").includes("dice"));
    assert.deepEqual(diceSizes("Roll a d20. Then roll a six-sided die."), ["d20", "d6"]);
    assert.ok(m("Flip a coin.").includes("coin"));
    assert.ok(m("When this enters, you become the monarch.").includes("monarch"));
    assert.ok(m("You take the initiative.").includes("initiative"));
    assert.ok(m("", { keywords: JSON.stringify(["Daybound"]) }).includes("daynight"));
    assert.ok(m("Venture into the dungeon.").includes("dungeon"));
    assert.ok(m("The Ring tempts you.").includes("ring"));
    assert.ok(m("", { keywords: JSON.stringify(["Morph"]) }).includes("facedown"));
    assert.ok(m("", { keywords: JSON.stringify(["Myriad"]) }).includes("copies"));
    assert.deepEqual(namedCounters("Put a shield counter and two oil counters on it. Counter target spell."), ["shield", "oil"]);
    assert.ok(!m("Counter target spell.").length, "the verb is not a counter");
  });
});

describe("deckAccessories", () => {
  const rows = (parts = true) => [
    { board: "main", name: "Battle Screech", quantity: 4, scryfall_id: SCREECH.id, oracle_text: SCREECH.oracle_text, keywords: '["Flashback"]',
      type_line: "Sorcery", all_parts: parts ? JSON.stringify(trimParts(SCREECH)) : null, fetched_at: "x" },
    { board: "main", name: "Thraben Inspector", quantity: 4, scryfall_id: INSPECTOR.id, oracle_text: INSPECTOR.oracle_text, keywords: '["Investigate"]',
      type_line: INSPECTOR.type_line, all_parts: parts ? JSON.stringify(trimParts(INSPECTOR)) : null, fetched_at: "x" },
    { board: "side", name: "Raffine's Informant", quantity: 2, scryfall_id: INFORMANT.id, oracle_text: INFORMANT.oracle_text, keywords: '["Connive"]',
      type_line: INFORMANT.type_line, all_parts: "[]", fetched_at: "x" },
    { board: "maybe", name: "Lots of Tokens", quantity: 1, scryfall_id: null, oracle_text: "Create ten 1/1 Goblin tokens." },
  ];
  const tokensById = new Map([[BIRD.id, normalizeCard(BIRD)], [CLUE.id, normalizeCard(CLUE)]]);

  test("all_parts + token rows: details, estimate (flashback x2), owned by name+P/T+colours, side flag, maybe skipped", () => {
    const owned = [
      { name: "Bird", power: "1", toughness: "1", colors: "W", binder: "Tokens", quantity: 3 },
      { name: "Bird", power: "2", toughness: "2", colors: "U", binder: "Tokens", quantity: 5 },
      { name: "Clue", power: null, toughness: null, colors: "", binder: "", quantity: 2 },
    ];
    const a = deckAccessories(rows(), { tokensById, owned });
    assert.equal(a.status, "ok");
    assert.deepEqual(a.fetch_ids, []);
    const bird = a.tokens.find((t) => t.name === "Bird");
    assert.equal(bird.pt, "1/1");
    assert.equal(bird.colors, "W");
    assert.equal(bird.estimate, 16, "2 birds x 4 copies x 2 (flashback)");
    assert.match(bird.estimate_note, /twice/);
    assert.deepEqual(bird.owned, { quantity: 3, binders: [{ binder: "Tokens", quantity: 3 }] }, "the blue 2/2 Bird does not count");
    assert.equal(bird.image_small, img(BIRD.id).small);
    assert.deepEqual(bird.from, [{ name: "Battle Screech", quantity: 4 }]);
    const clue = a.tokens.find((t) => t.name === "Clue");
    assert.equal(clue.estimate, 4);
    assert.equal(clue.owned.quantity, 2);
    const plus = a.markers.find((m) => m.key === "plus1");
    assert.deepEqual(plus.from, [{ name: "Raffine's Informant", quantity: 2, side: true }]);
    assert.equal(plus.side_only, true);
    assert.equal(a.maybe_skipped, 1);
    assert.ok(!a.tokens.some((t) => t.name === "Goblin"), "maybe board left out");
  });

  test("unknown all_parts: text fallback + fetch_ids; missing token rows: name-only + fetch ids", () => {
    const a = deckAccessories(rows(false));
    assert.equal(a.status, "pending");
    assert.deepEqual(a.fetch_ids.sort(), [SCREECH.id, INSPECTOR.id].sort());
    const bird = a.tokens.find((t) => t.name === "Bird");
    assert.equal(bird.source, "text");
    assert.equal(bird.pt, "1/1");
    assert.equal(bird.estimate, 16);
    assert.ok(a.tokens.some((t) => t.name === "Clue"), "investigate → Clue");
    const b = deckAccessories(rows());
    assert.deepEqual(b.fetch_ids.sort(), [BIRD.id, CLUE.id].sort());
    assert.equal(b.tokens.find((t) => t.name === "Bird").source, "scryfall-name");
  });

  test("estimate cap and text line", () => {
    const r = [{ board: "main", name: "Spam", quantity: 4, scryfall_id: null, oracle_text: "Whenever a creature dies, create three 1/1 black Rat creature tokens.", keywords: "[]" }];
    const a = deckAccessories(r);
    assert.equal(a.tokens[0].estimate, ESTIMATE_CAP);
    assert.match(a.tokens[0].estimate_note, /repeatable.*capped/);
    assert.match(accessoriesText(a), /^Tokens & extras: tokens Rat 1\/1 B ~20\+/);
    assert.equal(accessoriesText(deckAccessories([])), null);
  });
});

describe("schema v15 + data", () => {
  let ctx, stub;
  beforeEach(() => { ctx = tempDb(); stub = stubScryfall(POOL); });
  afterEach(() => { stub.restore(); ctx.cleanup(); });

  test("normalizeCard keeps parts and P/T; offline rows never wipe them", () => {
    const r = normalizeCard(SCREECH);
    assert.deepEqual(JSON.parse(r.all_parts), [{ id: BIRD.id, component: "token", name: "Bird", type_line: "Token Creature — Bird" }]);
    assert.equal(normalizeCard(BIRD).power, "1");
    assert.equal(normalizeCard({ ...PLAINS }).all_parts, "[]");
    upsertCards(ctx.db, [r]);
    upsertCards(ctx.db, [{ ...r, all_parts: null, fetched_at: "" }]);
    assert.ok(ctx.db.prepare("SELECT all_parts FROM cards WHERE scryfall_id = ?").get(SCREECH.id).all_parts.includes(BIRD.id));
  });

  test("v14 → v15 adds the columns, resets the backfill meta; backfill fetches deck cards, then their tokens", async () => {
    const db = ctx.db;
    upsertCards(db, [SCREECH, INSPECTOR].map(normalizeCard));
    db.prepare("INSERT INTO decks (name, format) VALUES ('Skies', 'pauper')").run();
    db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'main', 'Battle Screech', ?, 4), (1, 'main', 'Thraben Inspector', ?, 4)")
      .run(SCREECH.id, INSPECTOR.id);
    // Back to a v14 database: the new columns gone, a finished v9 backfill recorded.
    for (const c of ["all_parts", "power", "toughness"]) db.exec(`ALTER TABLE cards DROP COLUMN ${c}`);
    setAppMeta(db, CARD_FACTS_META, JSON.stringify({ done_at: "x", refreshed: 1, skipped: [] }));
    db.exec("PRAGMA user_version = 14");
    migrate(db);
    assert.ok(SCHEMA_VERSION >= 15);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    assert.equal(getAppMeta(db, CARD_FACTS_META), null);
    migrate(db); // idempotent
    assert.deepEqual(cardFactsPending(db).sort(), [SCREECH.id, INSPECTOR.id].sort());
    const before = deckDetail(db, 1);
    assert.equal(before.accessories.status, "pending");
    assert.ok(before.accessories.tokens.some((t) => t.name === "Bird" && t.source === "text"), "text fallback meanwhile");
    const r = await backfillCardFacts(db);
    assert.equal(r.refreshed, 4, "2 cards, then 2 tokens");
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(tokenFactsPending(db), []);
    const after = deckDetail(db, 1);
    assert.equal(after.accessories.status, "ok");
    assert.deepEqual(after.accessories.tokens.map((t) => [t.name, t.pt, t.estimate, t.source]), [["Bird", "1/1", 16, "scryfall"], ["Clue", null, 4, "scryfall"]]);
    assert.ok(!("all_parts" in after.cards[0]), "all_parts not in the deck rows' JSON");
  });

  test("ensureAccessoryData (MCP/evaluate) + owned tokens + build list group + deck text", async () => {
    const db = ctx.db;
    upsertCards(db, [{ ...normalizeCard(SCREECH), all_parts: null }, normalizeCard(INFORMANT)]);
    db.prepare("INSERT INTO decks (name, format) VALUES ('Skies', 'pauper')").run();
    db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'main', 'Battle Screech', ?, 4), (1, 'main', ?, ?, 4)")
      .run(SCREECH.id, INFORMANT.name, INFORMANT.id);
    await ensureAccessoryData(db, deckDetail(db, 1).cards);
    db.prepare("INSERT INTO collection (scryfall_id, binder, quantity, source) VALUES (?, 'Tokens', 10, 'app')").run(BIRD.id);
    const d = deckDetail(db, 1);
    assert.equal(d.accessories.status, "ok");
    const bird = d.accessories.tokens[0];
    assert.deepEqual([bird.name, bird.owned.quantity, bird.owned.binders[0].binder], ["Bird", 10, "Tokens"]);
    assert.match(deckToText(d), /Tokens & extras: tokens Bird 1\/1 W ~16, own 10 in Tokens\. also \+1\/\+1 counters\./);
    const list = buildChecklist(db, 1);
    const g = list.groups.at(-1);
    assert.equal(g.kind, "tokens");
    assert.deepEqual(g.lines.map((l) => [l.name, l.source, l.quantity]), [["Bird", "t:tokens", 10], ["Bird", "tneed", 6], ["+1/+1 counters", "extra", 1]]);
    const total = list.total;
    const after = setBuildPick(db, 1, { key: g.lines[0].key, source: "t:tokens", quantity: 10 });
    assert.equal(after.total, total, "tokens stay outside the progress");
    assert.equal(after.picked, 0);
    assert.equal(after.groups.at(-1).picked, 10);
  });

  test("background fetcher: pending → ok; failures → unavailable", async () => {
    const db = ctx.db;
    let ok = true;
    const f = createAccessoryFetcher({ db: () => db, delayMs: 1, log: null });
    // Scryfall's client throttles /cards/collection to 2 req/s: poll.
    const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 30)); };
    f.ensure([BIRD.id]);
    assert.equal(f.status([BIRD.id]), "pending");
    await until(() => db.prepare("SELECT 1 FROM cards WHERE scryfall_id = ?").get(BIRD.id));
    assert.ok(db.prepare("SELECT 1 FROM cards WHERE scryfall_id = ?").get(BIRD.id));
    f.ensure(["nope-id"]);
    await until(() => f.status(["nope-id"]) === "unavailable");
    assert.equal(f.status(["nope-id"]), "unavailable", "not found on Scryfall");
    const off = createAccessoryFetcher({ db: () => db, enabled: () => !ok });
    assert.equal(off.status([CLUE.id]), "unavailable");
    ok = false;
  });
});

describe("deck cover", () => {
  test("commander wins, else the most expensive non-basic by EUR; art crop URL", () => {
    const row = (board, name, eur, id = name) => ({ board, name, scryfall_id: id, prices: JSON.stringify({ eur, usd: "99" }), image_small: `s-${name}`, image_normal: `https://cards.scryfall.io/normal/front/a/b/${id}.jpg?1` });
    const cards = [row("main", "Plains", "50"), row("main", "Cheap", "0.10"), row("side", "Pricey", "5.00"), row("maybe", "Maybe", "90")];
    const c = deckCover(cards);
    assert.equal(c.name, "Pricey");
    assert.equal(c.source, "top");
    assert.equal(c.image_art, "https://cards.scryfall.io/art_crop/front/a/b/Pricey.jpg?1");
    assert.equal(deckCover([...cards, row("commander", "Boss", "0.01")]).name, "Boss");
    assert.equal(deckCover([row("main", "Plains", "50")]), null, "basics never");
    assert.equal(deckCover([{ board: "main", name: "x", scryfall_id: null }]), null);
    // Tie → name; no EUR price counts lowest (never USD).
    assert.equal(deckCover([row("main", "B", "1"), row("main", "A", "1"), row("main", "Z", null)]).name, "A");
    assert.equal(artCropUrl("https://example.com/x.jpg"), null);
  });

  test("list rows and detail carry the cover", () => {
    const ctx = tempDb();
    try {
      upsertCards(ctx.db, [INFORMANT, PLAINS, INSPECTOR].map(normalizeCard));
      ctx.db.prepare("INSERT INTO decks (name) VALUES ('D')").run();
      ctx.db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'main', 'Plains', ?, 10), (1, 'main', ?, ?, 1), (1, 'main', 'Thraben Inspector', ?, 1)")
        .run(PLAINS.id, INFORMANT.name, INFORMANT.id, INSPECTOR.id);
      assert.equal(listDecks(ctx.db)[0].cover.name, "Raffine's Informant");
      assert.equal(deckDetail(ctx.db, 1).cover.image_small, img(INFORMANT.id).small);
      assert.equal(deckDetail(ctx.db, 1).cover.image_art, `https://cards.scryfall.io/art_crop/front/0/0/${INFORMANT.id}.jpg?1`);
    } finally { ctx.cleanup(); }
  });
});
