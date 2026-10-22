// Function tags (lib/cardtags.js): role values and Scryfall Tagger tags fetched page by page and cached.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ensureOtags, otagsIn, otagsOf, roleTags } from "../lib/cardtags.js";
import { seedCards, tempDb } from "./fixtures.js";
import { stubWeb } from "./helpers/web.js";

let ctx;
before(() => { ctx = tempDb(); seedCards(ctx.db); });
after(() => ctx.cleanup());

test("roleTags: tags, groups, unknown", () => {
  assert.deepEqual(roleTags("Ramp"), ["ramp", "fast_mana"]);
  assert.deepEqual(roleTags("draw"), ["draw_engine", "draw_burst"]);
  assert.deepEqual(roleTags("recursion"), ["recursion"]);
  assert.throws(() => roleTags("x"), /Unknown role/);
});

test("otagsIn finds otag:/function: terms, quoted or bare, deduplicated", () => {
  assert.deepEqual(otagsIn('id<=bg otag:death-trigger -function:"Sacrifice-Outlet" (otag:death-trigger or t:elf)'), ["death-trigger", "sacrifice-outlet"]);
  assert.deepEqual(otagsIn("lightning bolt"), []);
  assert.deepEqual(otagsIn('otag:"two words" otag:ok-tag'), ["ok-tag"], "only Tagger-style names reach Scryfall");
});

test("ensureOtags: all pages, cached 30 days, 404 = empty tag, errors reported not thrown", async () => {
  const web = stubWeb([
    [/q=otag%3Aburn/, (u) => (u.searchParams.get("page") === "2"
      ? { data: [{ oracle_id: "o-x" }], has_more: false }
      : { data: [{ oracle_id: "o-bolt" }, { oracle_id: "o-x" }], has_more: true, next_page: "https://api.scryfall.com/cards/search?q=otag%3Aburn&page=2" })],
    [/q=otag%3Abroken/, () => new Response("{}", { status: 400 })],
  ]);
  try {
    const r = await ensureOtags(ctx.db, ["burn", "nothing-here", "broken"]);
    assert.deepEqual(r.fetched, ["burn", "nothing-here"]);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].tag, "broken");
    assert.deepEqual(otagsOf(ctx.db, "o-bolt"), ["burn"]);
    assert.equal(ctx.db.prepare("SELECT count FROM card_tag_sets WHERE tag = 'burn'").get().count, 2);
    assert.equal(ctx.db.prepare("SELECT count FROM card_tag_sets WHERE tag = 'nothing-here'").get().count, 0);
    const before = web.calls.length;
    await ensureOtags(ctx.db, ["burn"]);
    assert.equal(web.calls.length, before, "cached: no new request");
    const again = await ensureOtags(ctx.db, ["broken"]);
    assert.equal(web.calls.length, before, "a failure is not retried for a few minutes");
    assert.match(again.failed[0].error, /retrying later/);
  } finally {
    web.restore();
  }
});
