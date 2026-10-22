// Rules knowledge (lib/rules.js): CR parsing, download + cache + fallback, lookup, card rulings.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cardRulings, ensureRules, parseRules, rulesLookup } from "../lib/rules.js";
import { ID, seedCards, tempDb } from "./fixtures.js";
import { stubWeb } from "./helpers/web.js";

const NB = String.fromCharCode(0xa0);
const CR = [
  "Magic: The Gathering Comprehensive Rules", "", "Contents", "603. Handling Triggered Abilities", "", "Glossary", "", "Credits", "",
  "603. Handling Triggered Abilities", "",
  "603.10. Normally, objects that exist immediately after an event are checked.", "",
  "603.10a Some zone-change triggers look back in time. These are leaves-the-battlefield abilities.", "",
  "Example: Two creatures are on the battlefield along with an artifact that has the ability \"Whenever a creature dies, you gain 1 life.\"", "",
  "702.61. Split Second", "", "702.61a Split second is a static ability that functions only while the spell with split second is on the stack.", "",
  "Glossary", "", "Commander Tax", "Informal term for the additional cost to cast a commander from the command zone.", NB,
  "Split Second", "A keyword ability that makes it nearly impossible for a player to respond to a spell.", NB, "", "Credits", "Thanks.",
].join("\r\n");

let ctx;
before(() => { ctx = tempDb(); seedCards(ctx.db); });
after(() => ctx.cleanup());

test("parseRules: numbered rules (contents dropped, examples kept with their rule) and the glossary", () => {
  const rows = parseRules(`﻿${CR}`);
  const by = (no) => rows.filter((r) => r.rule_no === no).map((r) => r.text);
  assert.deepEqual(by("603"), ["Handling Triggered Abilities"]);
  assert.match(by("603.10a")[0], /^Some zone-change triggers look back in time\. .* Example: Two creatures/);
  assert.deepEqual(by("glossary"), [
    "Commander Tax: Informal term for the additional cost to cast a commander from the command zone.",
    "Split Second: A keyword ability that makes it nearly impossible for a player to respond to a spell.",
  ]);
});

test("ensureRules: the rules page's .txt link, cached 30 days, fallback file when offline; rulesLookup by words or number", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rules-"));
  let web = stubWeb([
    [/magic\.wizards\.com\/en\/rules/, () => '<a href="https://media.wizards.com/2026/downloads/MagicCompRules 20260925.txt">TXT</a>'],
    [/MagicCompRules/, () => CR],
  ]);
  try {
    const r = await ensureRules(ctx.db);
    assert.equal(r.source, "https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.txt");
    assert.ok(r.rules >= 6);
    const n = web.calls.length;
    await ensureRules(ctx.db);
    assert.equal(web.calls.length, n, "cached");
  } finally { web.restore(); }
  assert.deepEqual(rulesLookup(ctx.db, "leaves the battlefield look back").map((x) => x.rule_no), ["603.10a"]);
  assert.deepEqual(rulesLookup(ctx.db, "702.61").map((x) => x.rule_no), ["702.61", "702.61a"]);
  assert.equal(rulesLookup(ctx.db, "commander tax")[0].rule_no, "glossary");
  assert.deepEqual(rulesLookup(ctx.db, "!!"), []);

  // Offline with an empty table: the bundled file fills it; with a full table the old rules stay.
  const fresh = tempDb();
  writeFileSync(path.join(dir, "mtgrules.txt"), CR);
  process.env.RULES_FALLBACK_FILE = path.join(dir, "mtgrules.txt");
  web = stubWeb([]);
  try {
    const { ensureRules: ensure } = await import(`../lib/rules.js?fallback=${Date.now()}`);
    const r = await ensure(fresh.db);
    assert.equal(r.source, path.join(dir, "mtgrules.txt"));
    assert.match(r.error, /404/);
    assert.ok(r.rules > 0);
    const kept = await ensureRules(ctx.db, { force: true });
    assert.ok(kept.rules > 0 && kept.error);
  } finally { web.restore(); delete process.env.RULES_FALLBACK_FILE; fresh.cleanup(); }
});

test("cardRulings: cached per oracle id, stale cache when Scryfall fails, unknown card → null", async () => {
  let web = stubWeb([
    [new RegExp(`/cards/${ID.lightning}/rulings`), () => ({ data: [{ published_at: "2024-01-01", comment: "Bolt can target a battle." }] })],
    [/\/cards\/collection/, (u, init) => ({ data: [], not_found: JSON.parse(init.body).identifiers })],
  ]);
  try {
    const r = await cardRulings(ctx.db, "lightning bolt");
    assert.deepEqual(r, { name: "Lightning Bolt", rulings: [{ date: "2024-01-01", text: "Bolt can target a battle." }] });
    assert.equal(await cardRulings(ctx.db, "No Such Card"), null);
  } finally { web.restore(); }
  ctx.db.prepare("UPDATE card_rulings SET fetched_at = '2000-01-01T00:00:00Z'").run();
  web = stubWeb([]);
  try {
    assert.equal((await cardRulings(ctx.db, "Lightning Bolt")).stale, true);
    await assert.rejects(() => cardRulings(ctx.db, "Sol Ring"), /not stubbed|404/);
  } finally { web.restore(); }
});
