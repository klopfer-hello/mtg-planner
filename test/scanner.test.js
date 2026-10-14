// Scanner decision logic (lib/scanner.js) with stubbed OCR, index, matcher and
// Claude, plus the Claude vision runner (lib/claude.js runVision, hourly cap,
// shared concurrency gate) against a fake CLI binary.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// claude.js reads CLAUDE_BIN and the token at import time: point it at a fake
// CLI before the dynamic imports below.
const fakeDir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-claude-"));
const fakeBin = path.join(fakeDir, "claude");
const fakeLog = path.join(fakeDir, "calls.log");
writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }) + "\\n");
  const mode = process.env.FAKE_CLAUDE_MODE || "ok";
  const answer = { english_name: "Lightning Bolt", printed_name: "Lightning Bolt", set_code: "m10", collector_number: "146",
    language: "en", foil_indicator: "dot", confidence: 0.9, notes: "read" };
  const done = () => {
    if (mode === "error") {
      console.log(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key" }));
    } else {
      console.log(JSON.stringify({ type: "system", subtype: "init" }));
      console.log(JSON.stringify({ type: "result", is_error: false, result: "\`\`\`json\\n" + JSON.stringify(answer) + "\\n\`\`\`", total_cost_usd: 0.0078 }));
    }
  };
  setTimeout(done, Number(process.env.FAKE_CLAUDE_DELAY || 0));
});
`);
chmodSync(fakeBin, 0o755);
process.env.CLAUDE_BIN = fakeBin;
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-not-real";
process.env.CLAUDE_MAX_CONCURRENT = "2";

const { identify, identifyOriented, decideFinish, finishFromLine, DEFAULT_THRESHOLDS, verifyClaude, resetLangGuess } = await import("../lib/scanner.js");
// The speculative title language follows the last collector line: start every test from English.
beforeEach(() => resetLangGuess());
const { createHourlyCap, parseJsonReply, runVision, activeClaudeRuns, SCAN_PROMPT } = await import("../lib/claude.js");
const { nameSimilarity } = await import("../lib/ocr.js");

after(() => rmSync(fakeDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Stubs

const P = (o) => ({
  oracle_id: `o-${o.name.toLowerCase().replace(/\W+/g, "-")}`, printed_name: null, parent_set_code: null, set_name: o.set_code?.toUpperCase(),
  released_at: "2020-01-01", rarity: "common", finishes: ["nonfoil", "foil"], promo_types: [], faces: [],
  image_small: `https://cards.scryfall.io/small/${o.id}.jpg`, image_normal: `https://cards.scryfall.io/normal/${o.id}.jpg`,
  ...o,
});

const PRINTINGS = [
  // Modern card in three languages (dmu 107), plus a prerelease twin.
  P({ id: "dmu-107-en", name: "Shivan Devastator", set_code: "dmu", collector_number: "107", lang: "en", released_at: "2022-09-09" }),
  P({ id: "dmu-107-de", name: "Shivan Devastator", printed_name: "Shivan-Verwüster", set_code: "dmu", collector_number: "107", lang: "de", released_at: "2022-09-09" }),
  P({ id: "dmu-107-fr", name: "Shivan Devastator", printed_name: "Dévastateur shivân", set_code: "dmu", collector_number: "107", lang: "fr", released_at: "2022-09-09" }),
  P({ id: "pdmu-107s-en", name: "Shivan Devastator", set_code: "pdmu", parent_set_code: "dmu", collector_number: "107s", lang: "en", released_at: "2022-09-09", finishes: ["foil"], promo_types: ["prerelease"] }),
  // A Japanese-only printing: storage falls back to English.
  P({ id: "neo-301-ja", name: "Ancestral Katana", printed_name: "祖先の刀", set_code: "neo", collector_number: "301", lang: "ja", released_at: "2022-02-18" }),
  P({ id: "neo-301-en", name: "Ancestral Katana", set_code: "neo", collector_number: "301", lang: "en", released_at: "2022-02-18" }),
  // A different card that shares set code confusion (dmo 107).
  P({ id: "dmo-107-en", name: "Ghostly Prison", set_code: "dmo", collector_number: "107", lang: "en", released_at: "2023-01-01" }),
  // Single-finish printings.
  P({ id: "one-359-en", name: "Sword of Forge and Frontier", set_code: "one", collector_number: "359", lang: "en", released_at: "2023-02-03", finishes: ["foil"] }),
  P({ id: "cmr-600-en", name: "Etched Thing", set_code: "cmr", collector_number: "600", lang: "en", released_at: "2020-11-20", finishes: ["etched"] }),
  // 1998-2014: "146/249" in M10 (and a same-number card in another 249-card set).
  P({ id: "m10-146-en", name: "Lightning Bolt", set_code: "m10", collector_number: "146", lang: "en", released_at: "2009-07-17", total: 249 }),
  P({ id: "m10-146-de", name: "Lightning Bolt", printed_name: "Blitzschlag", set_code: "m10", collector_number: "146", lang: "de", released_at: "2009-07-17", total: 249 }),
  P({ id: "xyz-146-en", name: "Other Card", set_code: "xyz", collector_number: "146", lang: "en", released_at: "2010-01-01", total: 249 }),
  // Pre-1998: same art in two sets (no collector line).
  P({ id: "3ed-1-en", name: "Serra Angel", set_code: "3ed", collector_number: "1", lang: "en", released_at: "1994-04-01", finishes: ["nonfoil"] }),
  P({ id: "4ed-1-en", name: "Serra Angel", set_code: "4ed", collector_number: "1", lang: "en", released_at: "1995-04-01", finishes: ["nonfoil"] }),
  P({ id: "lea-2-en", name: "Unique Old Card", set_code: "lea", collector_number: "2", lang: "en", released_at: "1993-08-05", finishes: ["nonfoil"] }),
];

const cn = (s) => { const m = /\d+/.exec(String(s)); return m ? parseInt(m[0], 10) : null; };

function makeIndex(printings = PRINTINGS) {
  const byId = new Map(printings.map((p) => [p.id, p]));
  const calls = [];
  return {
    calls,
    setCodes: () => [...new Set(printings.map((p) => p.set_code))],
    lookupCollector(_idx, { set, number, lang }) {
      calls.push(["lookupCollector", set, number, lang]);
      return printings
        .filter((p) => (p.set_code === set || p.parent_set_code === set) && cn(p.collector_number) === cn(number) && (!lang || p.lang === lang))
        .sort((a, b) => (a.set_code === set ? 0 : 1) - (b.set_code === set ? 0 : 1));
    },
    lookupLegacyNumber(_idx, { number, total }) {
      return printings.filter((p) => p.total === Number(total) && cn(p.collector_number) === cn(number))
        .map((p) => ({ ...p, size_match: "printed_size" }));
    },
    searchTitle(_idx, text, { limit = 10 } = {}) {
      return printings.map((p) => ({ id: p.id, oracle_id: p.oracle_id, name: p.name, printed_name: p.printed_name, lang: p.lang,
        score: nameSimilarity(text, p.printed_name || p.name) }))
        .sort((a, b) => b.score - a.score).slice(0, limit);
    },
    getPrinting: (_idx, id) => byId.get(id) ?? null,
    storagePrinting(_idx, p, lang) {
      if (p.lang === lang) return p;
      return printings.find((x) => x.set_code === p.set_code && x.collector_number === p.collector_number && x.lang === lang)
        || printings.find((x) => x.set_code === p.set_code && x.collector_number === p.collector_number && x.lang === "en") || p;
    },
    variantsOf(_idx, p) {
      return printings.filter((x) => x.id !== p.id && x.oracle_id === p.oracle_id && cn(x.collector_number) === cn(p.collector_number)
        && x.lang === p.lang && (x.set_code === p.set_code || x.parent_set_code === p.set_code || p.parent_set_code === x.set_code));
    },
    printingsOf: (_idx, oid) => printings.filter((p) => p.oracle_id === oid),
  };
}

const modernLine = (o = {}) => ({
  raw: "R 0107\nDMU • EN", format: "mom", rarity: "R", number: "107", numberCandidates: ["107"], total: null,
  setCandidates: [{ code: "dmu", score: 1, cost: 0 }], langCode: "EN", lang: "en", separator: "dot", separatorConfidence: 0.9,
  separatorRel: 0.52, confidence: 0.8, ...o,
});

function makeOcr({ line = null, title = "" } = {}) {
  const calls = { title: [] };
  return {
    calls,
    readCollectorLine: async () => line,
    readTitle: async (_buf, { lang }) => { calls.title.push(lang); return { text: title, confidence: title ? 0.85 : 0 }; },
    nameSimilarity,
  };
}

/**
 * Fake matcher. `scores` maps printing id -> distance; `top` is the global
 * result list [{printing_id, oracle_id, name, score, printing_ids}].
 */
function makeMatcher({ scores = {}, top = [], gap = null } = {}) {
  return {
    match() {
      const r = top.map((x) => ({ ...x, printing_ids: x.printing_ids ?? [x.printing_id] }));
      Object.defineProperty(r, "bestOther", { value: null });
      return r;
    },
    nameGap: () => gap,
    scorePrintings(_h, ids) { return new Map(ids.filter((id) => id in scores).map((id) => [id, { score: scores[id], key: id }])); },
  };
}
const fpStub = { decodeJpeg: async () => ({ width: 1, height: 1, channels: 1, data: new Uint8Array(1) }), hashQuery: () => [Buffer.alloc(88)] };

function makeClaude(json, { limit = 60, error = null } = {}) {
  const calls = [];
  return {
    calls,
    cap: createHourlyCap(limit),
    runVision: async (opts) => { calls.push(opts); return error ? { error, json: null } : { text: JSON.stringify(json), json, costUsd: 0.01, error: null }; },
  };
}

const CARD = Buffer.from([0xff, 0xd8, 1, 2, 3]);
const STRIP = Buffer.from([0xff, 0xd8, 4, 5, 6]);

function run({ line, title, matcher, claude, settings = {}, index = makeIndex(), thresholds } = {}) {
  const ocr = makeOcr({ line, title });
  const ctx = { db: null, idx: {}, matcher: matcher ?? null, claude: claude ?? null, ocr, fp: fpStub, index, thresholds: thresholds ?? DEFAULT_THRESHOLDS };
  return identify(ctx, { card: CARD, strip: STRIP, settings: { storageLang: "en", foil: "auto", ...settings } }).then((r) => ({ r, ocr, index }));
}

// ---------------------------------------------------------------------------

describe("identify: modern collector line", () => {
  test("exact line + matching title -> auto (ocr), base printing over the prerelease twin", async () => {
    const { r } = await run({ line: modernLine(), title: "Shivan Devastator {X}{R}" });
    assert.equal(r.status, "auto");
    assert.equal(r.method, "ocr");
    assert.equal(r.printing.id, "dmu-107-en");
    assert.equal(r.store.id, "dmu-107-en");
    assert.equal(r.lang_detected, "en");
    assert.ok(r.variants.some((v) => v.id === "pdmu-107s-en"), "prerelease twin offered as variant");
    assert.equal(r.candidates[0].id, "dmu-107-en");
    assert.ok(r.candidates.length <= 5);
    assert.ok(r.confidence > 0.8);
    assert.equal(r.claude_used, false);
    assert.ok(r.features.collector && r.features.title && r.features.local);
  });

  test("German card stored in English (storage language), title OCR runs in German", async () => {
    const deLine = modernLine({ langCode: "DE", lang: "de", raw: "R 0107\nDMU • DE" });
    const { r, ocr } = await run({ line: deLine, title: "Shivan-Verwüster" });
    assert.deepEqual(ocr.calls.title, ["en", "de"], "the speculative English read is re-read in German");
    assert.ok(Number.isFinite(r.timings.title_reread));
    // The next scan reads German (the last line) and English (no-line fallback) up front: no re-read.
    const again = await run({ line: deLine, title: "Shivan-Verwüster" });
    assert.deepEqual(again.ocr.calls.title, ["de", "en"]);
    assert.equal(again.r.timings.title_reread, undefined);
    assert.equal(again.r.printing.id, "dmu-107-de");
    assert.equal(again.r.features.title.lang, "de");
    // No line on the next card: the English read is used.
    const noLine = await run({ line: null, title: "Shivan Devastator" });
    assert.deepEqual(noLine.ocr.calls.title, ["de", "en"]);
    assert.equal(noLine.r.timings.title_reread, undefined);
    assert.equal(noLine.r.features.title.lang, "en");
    assert.equal(r.status, "auto");
    assert.equal(r.printing.id, "dmu-107-de");
    assert.equal(r.lang_detected, "de");
    assert.equal(r.store.id, "dmu-107-en");
    assert.equal(r.store.lang, "en");
  });

  test("storage language: same set + number in that language, else English", async () => {
    const fr = await run({ line: modernLine(), title: "Shivan Devastator", settings: { storageLang: "fr" } });
    assert.equal(fr.r.store.id, "dmu-107-fr");
    const line = modernLine({ setCandidates: [{ code: "neo", score: 1, cost: 0 }], number: "301", numberCandidates: ["301"], langCode: "JP", lang: "ja" });
    const ja = await run({ line, title: "祖先の刀", settings: { storageLang: "de" } });
    assert.equal(ja.r.printing.id, "neo-301-ja");
    assert.equal(ja.r.store.id, "neo-301-en", "no German printing -> English");
  });

  test("exact line, unreadable title, fingerprint confirms -> auto (ocr+fingerprint)", async () => {
    const matcher = makeMatcher({ scores: { "dmu-107-en": 0.12 }, top: [{ printing_id: "dmu-107-en", oracle_id: "o-shivan-devastator", name: "Shivan Devastator", score: 0.12 }], gap: 0.2 });
    const { r } = await run({ line: modernLine(), title: "", matcher });
    assert.equal(r.status, "auto");
    assert.equal(r.method, "ocr+fingerprint");
    assert.equal(r.features.fingerprint.name_gate, true);
  });

  test("exact line but nothing confirms it -> suggest", async () => {
    const { r } = await run({ line: modernLine(), title: "" });
    assert.equal(r.status, "suggest");
    assert.equal(r.printing.id, "dmu-107-en");
  });

  test("low collector confidence -> never auto", async () => {
    const { r } = await run({ line: modernLine({ confidence: 0.2 }), title: "Shivan Devastator" });
    assert.equal(r.status, "suggest");
  });

  test("fingerprint contradicts the line -> review, Claude consulted", async () => {
    const matcher = makeMatcher({
      scores: { "dmu-107-en": 0.45 },
      top: [{ printing_id: "dmo-107-en", oracle_id: "o-ghostly-prison", name: "Ghostly Prison", score: 0.1 }], gap: 0.2,
    });
    const claude = makeClaude(null, { error: "Claude is busy" });
    const { r } = await run({ line: modernLine(), title: "", matcher, claude });
    assert.equal(r.status, "review");
    assert.equal(claude.calls.length, 1);
    assert.equal(r.claude_used, true);
    assert.ok(r.features.local.reasons.some((x) => /fingerprint says|art does not match/.test(x)));
  });

  test("two different cards from an ambiguous set code -> review with both candidates", async () => {
    const line = modernLine({ setCandidates: [{ code: "dmu", score: 0.9, cost: 0.5 }, { code: "dmo", score: 0.9, cost: 0.5 }] });
    const { r } = await run({ line, title: "" });
    assert.equal(r.status, "review");
    const ids = r.candidates.map((c) => c.id);
    assert.ok(ids.includes("dmu-107-en") && ids.includes("dmo-107-en"));
  });

  test("the title resolves an ambiguous set code", async () => {
    const line = modernLine({ setCandidates: [{ code: "dmu", score: 0.9, cost: 0.5 }, { code: "dmo", score: 0.9, cost: 0.5 }] });
    const { r } = await run({ line, title: "Ghostly Prison" });
    assert.equal(r.printing.id, "dmo-107-en");
    assert.equal(r.status, "suggest", "set code was not an exact read: not auto");
  });
});

describe("identify: finish rules", () => {
  test("★ on a modern line -> foil (source star); • -> normal", async () => {
    const star = await run({ line: modernLine({ separator: "star", separatorConfidence: 0.9 }), title: "Shivan Devastator" });
    assert.equal(star.r.finish, "foil");
    assert.equal(star.r.finishSource, "star");
    const dot = await run({ line: modernLine(), title: "Shivan Devastator", settings: { foil: "foil" } });
    assert.equal(dot.r.finish, "normal");
    assert.equal(dot.r.finishSource, "star");
  });

  test("undecided separator -> sticky session toggle", async () => {
    const r1 = await run({ line: modernLine({ separator: null, separatorConfidence: 0 }), title: "Shivan Devastator", settings: { foil: "foil" } });
    assert.equal(r1.r.finish, "foil");
    assert.equal(r1.r.finishSource, "toggle");
    const r2 = await run({ line: modernLine({ separator: "star", separatorConfidence: 0.2 }), title: "Shivan Devastator", settings: { foil: "auto" } });
    assert.equal(r2.r.finish, "normal");
    assert.equal(r2.r.finishSource, "toggle");
  });

  test("single-finish printings force their finish", async () => {
    const line = modernLine({ setCandidates: [{ code: "one", score: 1, cost: 0 }], number: "359", numberCandidates: ["359"] });
    const { r } = await run({ line, title: "Sword of Forge and Frontier", settings: { foil: "nonfoil" } });
    assert.equal(r.finish, "foil");
    assert.equal(r.finishSource, "finishes");
  });

  test("★ counts when the card was found by title/fingerprint and the line's set fits", async () => {
    // number misread (no collector hit), set code read: beta.1 dropped this ★ (finish from the toggle)
    const line = modernLine({ number: "999", numberCandidates: ["999"], separator: "star", separatorConfidence: 0.9 });
    const { r } = await run({ line, title: "Shivan Devastator" });
    assert.equal(r.printing.id, "dmu-107-en");
    assert.equal(r.finish, "foil");
    assert.equal(r.finishSource, "star");
    // a line of another set says nothing about this card
    const other = modernLine({ number: "999", numberCandidates: ["999"], setCandidates: [{ code: "one", score: 1, cost: 0 }], separator: "star", separatorConfidence: 0.9 });
    const o = await run({ line: other, title: "Shivan Devastator" });
    assert.equal(o.r.printing.id, "dmu-107-en");
    assert.equal(o.r.finishSource, "toggle");
  });

  test("features.collector keeps the classifier's why/cap/fill", async () => {
    const line = modernLine({ separator: "star", separatorConfidence: 0.9, separatorWhy: null, separatorCap: 22, separatorFill: 0.5 });
    const { r } = await run({ line, title: "Shivan Devastator" });
    assert.equal(r.features.collector.separatorCap, 22);
    assert.equal(r.features.collector.separatorFill, 0.5);
    assert.ok("separatorWhy" in r.features.collector);
  });

  test("finishFromLine re-decides the finish for a picked printing", () => {
    const collector = modernLine({ separator: "star", separatorConfidence: 0.9 });
    const dmu = PRINTINGS.find((p) => p.id === "dmu-107-en");
    assert.deepEqual(finishFromLine(dmu, collector), { finish: "foil", source: "star" });
    // the line is another set's: back to the toggle
    const dmo = PRINTINGS.find((p) => p.id === "dmo-107-en");
    assert.deepEqual(finishFromLine(dmo, collector, { foilMode: "auto" }), { finish: "normal", source: "toggle" });
    // the parent set counts; a single-finish printing still decides; pre-M15 printings ignore the line
    assert.deepEqual(finishFromLine(PRINTINGS.find((p) => p.id === "pdmu-107s-en"), collector), { finish: "foil", source: "finishes" });
    const promo = { ...PRINTINGS.find((p) => p.id === "pdmu-107s-en"), finishes: ["nonfoil", "foil"] };
    assert.deepEqual(finishFromLine(promo, modernLine({ separator: "dot", separatorConfidence: 0.9 })), { finish: "normal", source: "star" });
    assert.equal(finishFromLine({ ...dmu, released_at: "2010-01-01" }, collector).source, "toggle");
    assert.equal(finishFromLine(dmu, null, { foilMode: "foil" }).finish, "foil");
    assert.equal(finishFromLine(dmu, { ...collector, format: "legacy" }).source, "toggle");
  });

  test("decideFinish: etched, special cases", () => {
    assert.deepEqual(decideFinish({ finishes: ["etched"] }), { finish: "etched", source: "finishes" });
    assert.equal(decideFinish({ finishes: ["nonfoil", "etched"] }, { line: { separator: "star", separatorConfidence: 1 } }).finish, "etched");
    assert.equal(decideFinish({ finishes: ["nonfoil", "foil", "etched"] }, { line: { separator: "star", separatorConfidence: 1 } }).finish, "foil");
    assert.deepEqual(decideFinish({ finishes: ["nonfoil", "foil"] }, { claudeFoil: "star" }), { finish: "foil", source: "claude" });
    assert.deepEqual(decideFinish({ finishes: ["nonfoil", "foil"] }, { foilMode: "nonfoil" }), { finish: "normal", source: "toggle" });
    assert.deepEqual(decideFinish({ finishes: [] }), { finish: "normal", source: "finishes" });
  });
});

describe("identify: 1998-2014 and older cards", () => {
  const legacy = { raw: "146/249", format: "legacy", number: "146", total: 249, numberCandidates: ["146"], legacyCandidates: [{ number: "146", total: 249, score: 1 }], setCandidates: [], lang: null, langCode: null, separator: null, separatorConfidence: 0, confidence: 0.7 };

  test("number/total + title + fingerprint agree -> auto; title picks the language", async () => {
    const matcher = makeMatcher({ scores: { "m10-146-en": 0.1, "m10-146-de": 0.12, "xyz-146-en": 0.45 }, top: [{ printing_id: "m10-146-en", oracle_id: "o-lightning-bolt", name: "Lightning Bolt", score: 0.1 }], gap: 0.15 });
    const en = await run({ line: legacy, title: "Lightning Bolt", matcher });
    assert.equal(en.r.status, "auto");
    assert.equal(en.r.printing.id, "m10-146-en");
    const de = await run({ line: legacy, title: "Blitzschlag", matcher, settings: { storageLang: "en" } });
    assert.equal(de.r.printing.id, "m10-146-de");
    assert.equal(de.r.store.id, "m10-146-en");
  });

  test("number/total without art confirmation -> not auto", async () => {
    const { r } = await run({ line: legacy, title: "Lightning Bolt" });
    assert.notEqual(r.status, "auto");
    assert.equal(r.printing.id, "m10-146-en");
  });

  test("no line: fingerprint name gate + unique printing + title -> auto", async () => {
    const matcher = makeMatcher({ scores: { "lea-2-en": 0.1 }, top: [{ printing_id: "lea-2-en", oracle_id: "o-unique-old-card", name: "Unique Old Card", score: 0.1 }], gap: 0.2 });
    const { r } = await run({ line: null, title: "Unique Old Card", matcher });
    assert.equal(r.status, "auto");
    assert.equal(r.method, "fingerprint");
  });

  test("no line: same art in two sets -> suggest with both printings; the set hint picks one", async () => {
    const matcher = makeMatcher({
      scores: { "3ed-1-en": 0.1, "4ed-1-en": 0.1 },
      top: [{ printing_id: "3ed-1-en", oracle_id: "o-serra-angel", name: "Serra Angel", score: 0.1, printing_ids: ["3ed-1-en", "4ed-1-en"] }], gap: 0.2,
    });
    const { r } = await run({ line: null, title: "Serra Angel", matcher });
    assert.equal(r.status, "suggest");
    assert.deepEqual(r.candidates.map((c) => c.id).sort(), ["3ed-1-en", "4ed-1-en"]);
    const hinted = await run({ line: null, title: "Serra Angel", matcher, settings: { setHint: "4ed" } });
    assert.equal(hinted.r.printing.id, "4ed-1-en");
    assert.equal(hinted.r.status, "auto");
  });

  test("no line and a weak fingerprint -> review (no Claude without a client)", async () => {
    const matcher = makeMatcher({ scores: { "lea-2-en": 0.3 }, top: [{ printing_id: "lea-2-en", oracle_id: "o-unique-old-card", name: "Unique Old Card", score: 0.3 }], gap: 0.01 });
    const { r } = await run({ line: null, title: "", matcher });
    assert.equal(r.status, "review");
  });

  test("nothing at all -> failed", async () => {
    const { r } = await run({ line: null, title: "" });
    assert.equal(r.status, "failed");
    assert.equal(r.printing, null);
    assert.deepEqual(r.candidates, []);
  });
});

describe("identify: Claude fallback", () => {
  const boltAnswer = { english_name: "Lightning Bolt", printed_name: "Lightning Bolt", set_code: "m10", collector_number: "146", language: "en", foil_indicator: "dot", confidence: 0.9, notes: "" };
  const boltMatcher = (d) => makeMatcher({ scores: { "m10-146-en": d }, top: [], gap: null });

  test("verified answer (index + fingerprint) -> suggest via claude, never auto by default", async () => {
    const claude = makeClaude(boltAnswer);
    const { r } = await run({ line: null, title: "", matcher: boltMatcher(0.2), claude });
    assert.equal(claude.calls.length, 1);
    assert.equal(claude.calls[0].images.length, 2, "card + strip");
    assert.equal(claude.calls[0].images[0].media_type, "image/jpeg");
    assert.equal(r.status, "suggest");
    assert.equal(r.method, "claude");
    assert.equal(r.printing.id, "m10-146-en");
    assert.equal(r.claude_used, true);
    assert.equal(r.finish, "normal");
    assert.equal(r.features.claude.verdict.ok, true);
  });

  test("answer whose art does not match the photo is rejected", async () => {
    const claude = makeClaude(boltAnswer);
    const { r } = await run({ line: null, title: "", matcher: boltMatcher(0.42), claude });
    assert.equal(r.status, "failed");
    assert.equal(r.features.claude.verdict.ok, false);
    assert.match(r.features.claude.verdict.reason, /art does not match/);
  });

  test("answer not in the index / wrong name / no hash and no OCR backing is rejected", async () => {
    const notInIndex = await run({ line: null, title: "", matcher: boltMatcher(0.1), claude: makeClaude({ ...boltAnswer, collector_number: "999" }) });
    assert.match(notInIndex.r.features.claude.verdict.reason, /not in the index/);
    const wrongName = await run({ line: null, title: "", matcher: boltMatcher(0.1), claude: makeClaude({ ...boltAnswer, english_name: "Giant Growth", printed_name: null }) });
    assert.match(wrongName.r.features.claude.verdict.reason, /name does not match/);
    const noHash = await run({ line: null, title: "", matcher: makeMatcher({}), claude: makeClaude(boltAnswer) });
    assert.equal(noHash.r.features.claude.verdict.ok, false);
    assert.match(noHash.r.features.claude.verdict.reason, /no fingerprint/);
  });

  test("hourly cap: exhausted -> skipped; 0 disables; allowClaude:false never calls", async () => {
    const claude = makeClaude(boltAnswer, { limit: 1 });
    const matcher = boltMatcher(0.2);
    const first = await run({ line: null, title: "", matcher, claude });
    assert.equal(first.r.claude_used, true);
    const second = await run({ line: null, title: "", matcher, claude });
    assert.equal(second.r.claude_used, false);
    assert.equal(second.r.features.claude.skipped, "hourly cap reached");
    assert.equal(claude.calls.length, 1);

    const off = makeClaude(boltAnswer, { limit: 0 });
    const r3 = await run({ line: null, title: "", matcher, claude: off });
    assert.equal(r3.r.features.claude.skipped, "disabled");
    assert.equal(off.calls.length, 0);

    const opt = makeClaude(boltAnswer);
    await run({ line: null, title: "", matcher, claude: opt, settings: { allowClaude: false } });
    assert.equal(opt.calls.length, 0);
  });

  test("certain local results never call Claude", async () => {
    const claude = makeClaude(boltAnswer);
    await run({ line: modernLine(), title: "Shivan Devastator", claude });
    await run({ line: modernLine(), title: "", claude });
    assert.equal(claude.calls.length, 0, "auto and suggest stay local");
  });

  test("verifyClaude uses OCR candidates when the printing has no reference hash", async () => {
    const index = makeIndex();
    const p = index.getPrinting(null, "m10-146-en");
    const cands = new Map([["m10-146-en", { p, ocr: 0.8, title: null }]]);
    const v = await verifyClaude(boltAnswer, { idx: {}, index, sim: nameSimilarity, T: DEFAULT_THRESHOLDS, hashes: null, matcher: null, cands, fpById: new Map() });
    assert.equal(v.ok, true);
    assert.equal(v.printing.id, "m10-146-en");
  });

  test("verifyClaude: a legacy number without a set resolves by name + number, backed by the title OCR", async () => {
    const index = makeIndex();
    const ans = { ...boltAnswer, set_code: null, collector_number: "146" };
    const args = { idx: {}, index, sim: nameSimilarity, T: DEFAULT_THRESHOLDS, hashes: null, matcher: null, cands: new Map(), fpById: new Map() };
    const v = await verifyClaude(ans, { ...args, titleText: "Lightning Bolt" });
    assert.equal(v.ok, true);
    assert.equal(v.printing.set_code, "m10");
    // Same answer without local evidence: rejected, but the printing is offered for the picker.
    const r = await verifyClaude(ans, { ...args, titleText: "" });
    assert.equal(r.ok, false);
    assert.equal(r.printing?.set_code, "m10");
  });
});

describe("identify: fingerprint-only uniqueness and Claude re-verification", () => {
  const SD = [
    P({ id: "4ed-sd", name: "Shivan Dragon", set_code: "4ed", collector_number: "175", lang: "en", released_at: "1995-04-01", finishes: ["nonfoil"], illustration_id: "ill-sd" }),
    P({ id: "5ed-sd", name: "Shivan Dragon", set_code: "5ed", collector_number: "264", lang: "en", released_at: "1997-03-24", finishes: ["nonfoil"], illustration_id: "ill-sd" }),
    P({ id: "m10-bolt", name: "Lightning Bolt", set_code: "m10", collector_number: "146", lang: "en", released_at: "2009-07-17" }),
    P({ id: "cmm-712", name: "Right Card", set_code: "cmm", collector_number: "712", lang: "en", released_at: "2023-08-04" }),
    P({ id: "cmm-12", name: "Wrong Card", set_code: "cmm", collector_number: "12", lang: "en", released_at: "2023-08-04" }),
  ];
  const index = makeIndex(SD);
  const top5 = { printing_id: "5ed-sd", oracle_id: "o-shivan-dragon", name: "Shivan Dragon", score: 0.12 };
  const go = (matcher, extra = {}, line = null, title = "Shivan Dragon") => identify(
    { db: null, idx: {}, matcher, claude: extra.claude ?? null, ocr: makeOcr({ line, title }), fp: fpStub, index, thresholds: DEFAULT_THRESHOLDS, ...extra },
    { card: CARD, strip: STRIP, settings: { storageLang: "en", foil: "auto" } });

  test("a same-art sibling without a reference hash blocks AUTO", async () => {
    const r = await go(makeMatcher({ scores: { "5ed-sd": 0.12 }, top: [top5], gap: 0.2 }));
    assert.equal(r.status, "suggest");
    assert.equal(r.printing.id, "5ed-sd");
    assert.ok(r.features.local.reasons.some((x) => /share this art/.test(x)));
  });

  test("hashed siblings: AUTO only with a real margin", async () => {
    const close = await go(makeMatcher({ scores: { "5ed-sd": 0.12, "4ed-sd": 0.15 }, top: [top5], gap: 0.2 }));
    assert.equal(close.status, "suggest");
    const clear = await go(makeMatcher({ scores: { "5ed-sd": 0.12, "4ed-sd": 0.25 }, top: [top5], gap: 0.2 }));
    assert.equal(clear.status, "auto");
    assert.equal(clear.printing.id, "5ed-sd");
  });

  test("incomplete fingerprint index blocks fingerprint-only AUTO", async () => {
    const r = await go(makeMatcher({ scores: { "5ed-sd": 0.12, "4ed-sd": 0.25 }, top: [top5], gap: 0.2 }), { fingerprintsComplete: false });
    assert.equal(r.status, "suggest");
    assert.ok(r.features.local.reasons.includes("fingerprint index incomplete"));
  });

  test("REVIEW picker offers the fingerprint's card when the collector line points elsewhere", async () => {
    const line = modernLine({ number: "12", numberCandidates: ["12"], setCandidates: [{ code: "cmm", score: 1, cost: 0 }] });
    const matcher = makeMatcher({ scores: { "cmm-712": 0.1, "cmm-12": 0.45 }, top: [{ printing_id: "cmm-712", oracle_id: "o-right-card", name: "Right Card", score: 0.1 }], gap: 0.2 });
    const r = await go(matcher, {}, line, "");
    assert.equal(r.status, "review");
    assert.ok(r.candidates.some((c) => c.id === "cmm-712"), "fingerprint hit is a candidate");
  });

  test("verifyClaude: an answer the fingerprint contradicts is rejected (but offered)", async () => {
    const ans = { english_name: "Lightning Bolt", printed_name: "Lightning Bolt", set_code: "m10", collector_number: "146", language: "en" };
    const base = { idx: {}, index, sim: nameSimilarity, T: DEFAULT_THRESHOLDS, hashes: [Buffer.alloc(88)], matcher: null, cands: new Map() };
    const gate = await verifyClaude(ans, { ...base, fpById: new Map([["m10-bolt", 0.2]]), nameGate: true, fpTop: top5, d1: 0.12 });
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /fingerprint says Shivan Dragon/);
    assert.equal(gate.printing.id, "m10-bolt");
    const closer = await verifyClaude(ans, { ...base, fpById: new Map([["m10-bolt", 0.2]]), nameGate: false, fpTop: top5, d1: 0.12 });
    assert.equal(closer.ok, false);
    assert.match(closer.reason, /closer to Shivan Dragon/);
    const loose = await verifyClaude(ans, { ...base, fpById: new Map([["m10-bolt", 0.28]]) });
    assert.equal(loose.ok, false, "0.28 is above claudeFpMax");
    const fine = await verifyClaude(ans, { ...base, fpById: new Map([["m10-bolt", 0.14]]), fpTop: top5, d1: 0.12 });
    assert.equal(fine.ok, true);
  });
});

// ---------------------------------------------------------------------------

describe("identify: overlapped stages (speed step 1)", () => {
  const defer = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

  test("title OCR and the global match start before the collector OCR ends; same result", async () => {
    const lineGate = defer();
    const events = [];
    const ocr = {
      readCollectorLine: async () => { events.push("collector:start"); await lineGate.p; events.push("collector:end"); return modernLine(); },
      readTitle: async (_b, { lang }) => { events.push(`title:${lang}`); return { text: "Shivan Devastator", confidence: 0.85 }; },
      nameSimilarity,
    };
    const base = makeMatcher({ scores: { "dmu-107-en": 0.12 }, top: [{ printing_id: "dmu-107-en", oracle_id: "o-shivan-devastator", name: "Shivan Devastator", score: 0.12 }], gap: 0.2 });
    const matcher = {
      ...base,
      hashImage: async (_c, opts) => { events.push(`hash:${opts?.variants ?? 27}`); return [Buffer.alloc(88)]; },
      match: async (...a) => { events.push("match"); return base.match(...a); },
    };
    const ctx = { db: null, idx: {}, matcher, ocr, fp: fpStub, index: makeIndex(), thresholds: DEFAULT_THRESHOLDS };
    const pending = identify(ctx, { card: CARD, strip: STRIP, settings: { storageLang: "en" } });
    for (let i = 0; i < 20 && !events.includes("match"); i++) await new Promise((r) => setImmediate(r));
    assert.ok(events.includes("title:en") && events.includes("match"), `started while the collector OCR runs: ${events}`);
    assert.ok(!events.includes("collector:end"));
    lineGate.resolve();
    const r = await pending;
    assert.equal(r.status, "auto");
    assert.equal(r.printing.id, "dmu-107-en");
    assert.ok("match" in r.timings && "title" in r.timings);
    assert.deepEqual(events.filter((e) => e.startsWith("title")), ["title:en"], "English line: no re-read");
  });

  test("settings.precise hashes 9 variants only when preciseVariants is 9 (default 27 = off)", async () => {
    const seen = [];
    const matcher = { ...makeMatcher({}), hashImage: async (_c, opts) => { seen.push(opts?.variants ?? 27); return [Buffer.alloc(88)]; } };
    const mk = (thresholds = DEFAULT_THRESHOLDS) => ({ db: null, idx: {}, matcher, ocr: makeOcr({ line: modernLine(), title: "Shivan Devastator" }), fp: fpStub, index: makeIndex(), thresholds });
    assert.equal(DEFAULT_THRESHOLDS.preciseVariants, 27);
    const precise = await identify(mk(), { card: CARD, strip: STRIP, settings: { precise: true } });
    await identify(mk({ ...DEFAULT_THRESHOLDS, preciseVariants: 9 }), { card: CARD, strip: STRIP, settings: { precise: true } });
    await identify(mk({ ...DEFAULT_THRESHOLDS, preciseVariants: 9 }), { card: CARD, strip: STRIP, settings: {} });
    assert.deepEqual(seen, [27, 9, 27]);
    assert.equal(precise.features.settings.precise, true);
  });

  test("a failing title read and a failing match are reported, not thrown", async () => {
    const ocr = { readCollectorLine: async () => modernLine(), readTitle: async () => { throw new Error("boom"); }, nameSimilarity };
    const matcher = { ...makeMatcher({}), hashImage: async () => [Buffer.alloc(88)], match: async () => { throw new Error("worker gone"); } };
    const r = await identify({ db: null, idx: {}, matcher, ocr, fp: fpStub, index: makeIndex(), thresholds: DEFAULT_THRESHOLDS }, { card: CARD, strip: STRIP, settings: {} });
    assert.ok(r.features.errors.includes("title: boom"));
    assert.ok(r.features.errors.includes("fingerprint: worker gone"));
    assert.equal(r.status, "suggest", "exact line without confirmation");
  });
});

describe("identifyOriented: 180° retry", () => {
  // OCR inputs and hashes are tagged by orientation: the retry's turned card
  // and its top band (ROT_*) and the re-encoded upright images (UP_*).
  const ROT_CARD = Buffer.from("P5 turned card");
  const ROT_STRIP = Buffer.from("P5 turned top band");
  const UP_CARD = Buffer.from([0xff, 0xd8, 9, 9, 1]);
  const UP_STRIP = Buffer.from([0xff, 0xd8, 9, 9, 2]);
  const lea = (score) => ({ printing_id: "lea-2-en", oracle_id: "o-unique-old-card", name: "Unique Old Card", score });
  const far = { printing_id: "dmo-107-en", oracle_id: "o-ghostly-prison", name: "Ghostly Prison", score: 0.43 };

  function go({ up = {}, rot = {}, claude = null, settings = {}, signal, uprightJpegs, retryMode, hashErr } = {}) {
    const calls = { hash: [], collector: [], title: [], band: null, upright: 0 };
    const pass = (rotated) => (rotated ? rot : up);
    const ocr = {
      rotatedOcrInputs: async (_card, { band }) => { calls.band = band; return { card: ROT_CARD, strip: ROT_STRIP }; },
      readCollectorLine: async (buf) => { calls.collector.push(buf === ROT_STRIP ? 180 : 0); return pass(buf === ROT_STRIP).line ?? null; },
      readTitle: async (buf) => {
        calls.title.push(buf === ROT_CARD ? 180 : 0);
        const t = pass(buf === ROT_CARD).title ?? "";
        return { text: t, confidence: t ? 0.85 : 0 };
      },
      nameSimilarity,
    };
    const matcher = {
      hashImage: async (_card, opts) => {
        calls.hash.push(opts?.rotate ?? 0);
        if (hashErr) throw new Error(hashErr);
        return [Buffer.from([opts?.rotate ? 1 : 0])];
      },
      match: async (h) => {
        const r = (pass(h[0][0] === 1).top ?? []).map((x) => ({ ...x, printing_ids: x.printing_ids ?? [x.printing_id] }));
        Object.defineProperty(r, "bestOther", { value: null });
        return r;
      },
      nameGap: (r) => (r.length ? (r.find((x) => x.oracle_id !== r[0].oracle_id)?.score ?? 0.5) - r[0].score : null),
      scorePrintings: async (h, ids) => {
        const scores = pass(h[0][0] === 1).scores ?? {};
        return new Map(ids.filter((id) => id in scores).map((id) => [id, { score: scores[id], key: id }]));
      },
    };
    const fp = { uprightJpegs: uprightJpegs ?? (async () => { calls.upright++; return { card: UP_CARD, strip: UP_STRIP }; }) };
    const ctx = { db: null, idx: {}, matcher, claude, ocr, fp, index: makeIndex(), thresholds: DEFAULT_THRESHOLDS, fingerprintsComplete: true, signal, retry: retryMode };
    return identifyOriented(ctx, { card: CARD, strip: STRIP, settings: { storageLang: "en", foil: "auto", ...settings } }).then((r) => ({ r, calls }));
  }
  // An upside-down pre-1998 card: upright, the art and title say nothing; turned, they name it.
  const upsideDown = { up: { top: [far] }, rot: { top: [lea(0.1), far], title: "Unique Old Card", scores: { "lea-2-en": 0.1 } } };

  test("upside-down card: the turned pass identifies it; upright images to store", async () => {
    const { r, calls } = await go(upsideDown);
    assert.equal(r.status, "auto");
    assert.equal(r.printing.id, "lea-2-en");
    assert.equal(r.features.rotation, 180);
    assert.equal(r.features.strip_used, "card_top");
    assert.equal(r.features.stored_upright, true);
    assert.deepEqual(calls.hash, [0, 180], "hash of the turned pixels");
    assert.deepEqual(calls.title, [0, 180]);
    assert.deepEqual(calls.collector, [0, 180], "the card's own top band is the collector strip");
    assert.deepEqual(calls.band, [0.85, 1]);
    assert.equal(calls.upright, 1);
    assert.deepEqual(r.upright, { card: UP_CARD, strip: UP_STRIP });
    assert.equal(r.features.retry.chosen, 180);
    assert.equal(r.features.retry.upright.status, "failed");
    assert.equal(r.features.retry.rotated.status, "auto");
    assert.ok(Number.isFinite(r.timings.retry) && Number.isFinite(r.timings.total));
    assert.ok(r.timings.upright && "hash" in r.timings.upright, "the upright pass's timings are kept");
  });

  test("certain upright results never retry", async () => {
    const { r, calls } = await go({ up: { line: modernLine(), title: "Shivan Devastator" } });
    assert.equal(r.status, "auto");
    assert.deepEqual(calls.hash, [0]);
    assert.equal(calls.band, null, "no turned OCR inputs");
    assert.equal(r.features.rotation, 0);
    assert.equal(r.features.strip_used, "strip");
    assert.equal(r.features.retry, undefined);
    assert.equal(r.upright, undefined);
  });

  test("REVIEW: a near fingerprint does not retry; a far one does, also with a (bogus) collector line", async () => {
    const near = await go({ up: { top: [lea(0.22), { ...far, score: 0.23 }], scores: { "lea-2-en": 0.22 } } });
    assert.equal(near.r.status, "review");
    assert.ok(near.r.features.fingerprint.d1 <= DEFAULT_THRESHOLDS.retryFpMin);
    assert.deepEqual(near.calls.hash, [0]);
    // The upside-down title band can read as a collector line; the art still decides.
    const withLine = await go({ up: { line: modernLine({ confidence: 0.2 }), top: [far], scores: { "dmu-107-en": 0.45 } }, rot: upsideDown.rot });
    assert.deepEqual(withLine.calls.hash, [0, 180]);
    assert.equal(withLine.r.features.retry.upright.status, "review");
    assert.equal(withLine.r.printing.id, "lea-2-en");
    assert.equal(withLine.r.features.rotation, 180);
  });

  test("matcher warming up: the turned pass is OCR only (no second hash wait)", async () => {
    const { r, calls } = await go({ up: { top: [far] }, rot: { line: modernLine(), title: "Shivan Devastator" }, hashErr: "scanner warming up" });
    assert.deepEqual(calls.hash, [0], "the rotated pass does not wait on the matcher again");
    assert.deepEqual(calls.collector, [0, 180], "the turned OCR still runs");
    assert.equal(r.features.rotation, 180);
    assert.equal(r.printing.id, "dmu-107-en");
    assert.ok(r.features.errors.some((e) => /upright hash: scanner warming up/.test(e)), r.features.errors.join("; "));
  });

  test("same status: a turned collector line wins only when the turned art (or title) backs it", async () => {
    // An upright old-frame card whose turned title band reads as a bogus line.
    const up = { top: [lea(0.3)], scores: { "lea-2-en": 0.3 } };
    const bogus = await go({ up, rot: { line: modernLine({ confidence: 0.2 }), top: [far], scores: { "dmu-107-en": 0.45 } } });
    assert.equal(bogus.r.features.retry.upright.status, "review");
    assert.equal(bogus.r.features.retry.rotated.status, "review");
    assert.equal(bogus.r.features.rotation, 0, "a bogus line does not turn an upright photo");
    assert.equal(bogus.r.printing.id, "lea-2-en");
    const art = await go({ up, rot: { line: modernLine({ confidence: 0.2 }), top: [{ ...far, score: 0.305 }], scores: { "dmu-107-en": 0.35 } } });
    assert.equal(art.r.features.retry.rotated.status, "review");
    assert.equal(art.r.features.rotation, 180, "the turned art backs the line");
    assert.equal(art.r.printing.id, "dmu-107-en");
  });

  test("ctx.retry: 'never' skips the retry, 'always' forces it", async () => {
    const never = await go({ ...upsideDown, retryMode: "never" });
    assert.equal(never.r.features.rotation, 0);
    assert.equal(never.r.features.retry, undefined);
    assert.deepEqual(never.calls.hash, [0]);
    const always = await go({ up: { line: modernLine(), title: "Shivan Devastator" }, retryMode: "always" });
    assert.equal(always.r.features.retry.chosen, 0, "a certain upright result keeps winning");
    assert.equal(always.r.status, "auto");
    assert.deepEqual(always.calls.hash, [0, 180]);
  });

  test("a retry that finds nothing better keeps the upright result; Claude runs once on the original photo", async () => {
    const claude = makeClaude({ english_name: "Lightning Bolt", printed_name: "Lightning Bolt", set_code: "m10", collector_number: "146", language: "en" });
    const { r, calls } = await go({ up: { top: [far] }, rot: { top: [far] }, claude });
    assert.deepEqual(calls.hash, [0, 180]);
    assert.equal(r.features.rotation, 0);
    assert.equal(r.features.strip_used, "strip");
    assert.equal(r.features.retry.chosen, 0);
    assert.equal(r.features.retry.rotated.status, "failed");
    assert.equal(calls.upright, 0, "nothing re-encoded");
    assert.equal(claude.calls.length, 1, "Claude at most once");
    assert.equal(claude.calls[0].images[0].data, CARD.toString("base64"));
    assert.equal(claude.calls[0].images[1].data, STRIP.toString("base64"));

    const off = makeClaude({ english_name: "Lightning Bolt" });
    await go({ up: { top: [far] }, rot: { top: [far] }, claude: off, settings: { allowClaude: false } });
    assert.equal(off.calls.length, 0);
  });

  test("a turned REVIEW result asks Claude with the upright images", async () => {
    const claude = makeClaude({ english_name: "Nope", printed_name: "Nope", set_code: "zzz", collector_number: "1", language: "en" });
    const { r } = await go({ up: { top: [far] }, rot: { top: [lea(0.3)], scores: { "lea-2-en": 0.3 } }, claude });
    assert.equal(r.status, "review");
    assert.equal(r.features.rotation, 180);
    assert.equal(claude.calls.length, 1);
    assert.deepEqual(claude.calls[0].images.map((i) => i.data), [UP_CARD.toString("base64"), UP_STRIP.toString("base64")]);
  });

  test("a client that left: no turned pass, no Claude", async () => {
    const ac = new AbortController();
    ac.abort();
    const claude = makeClaude({ english_name: "Lightning Bolt" });
    const { r, calls } = await go({ ...upsideDown, claude, signal: ac.signal });
    assert.deepEqual(calls.hash, [0]);
    assert.equal(r.features.rotation, 0);
    assert.equal(claude.calls.length, 0);
    assert.equal(r.features.claude?.skipped, "cancelled");
  });

  test("★ read from the card's top band is SUGGEST at most", async () => {
    const neo = modernLine({ raw: "R 0301\nNEO ★ EN", number: "301", numberCandidates: ["301"], setCandidates: [{ code: "neo", score: 1, cost: 0 }], separator: "star" });
    const upright = await go({ up: { line: neo, title: "Ancestral Katana" } });
    assert.equal(upright.r.status, "auto", "the client's strip may decide the finish");
    assert.equal(upright.r.finish, "foil");
    const { r } = await go({ up: { top: [far] }, rot: { line: neo, title: "Ancestral Katana" } });
    assert.equal(r.features.rotation, 180);
    assert.equal(r.printing.id, "neo-301-en");
    assert.equal(r.finish, "foil");
    assert.equal(r.status, "suggest");
    assert.ok(r.features.local.reasons.some((x) => /top band/.test(x)));
  });

  test("re-encoding fails: the result stands, the original photo is stored", async () => {
    const { r } = await go({ ...upsideDown, uprightJpegs: async () => { throw new Error("cjpeg missing"); } });
    assert.equal(r.status, "auto");
    assert.equal(r.features.rotation, 180);
    assert.equal(r.features.stored_upright, false);
    assert.equal(r.upright, undefined);
    assert.ok(r.features.errors.some((e) => /upright: cjpeg missing/.test(e)));
  });
});

describe("claude.js vision runner", () => {
  test("createHourlyCap: sliding window", () => {
    let t = 0;
    const cap = createHourlyCap(2, 1000, () => t);
    assert.equal(cap.take(), true);
    assert.equal(cap.take(), true);
    assert.equal(cap.take(), false);
    assert.equal(cap.remaining(), 0);
    t = 1001;
    assert.equal(cap.remaining(), 2);
    assert.equal(createHourlyCap(0).enabled(), false);
  });

  test("parseJsonReply tolerates fences and prose", () => {
    assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonReply('Here: {"a": {"b": 2}} done'), { a: { b: 2 } });
    assert.equal(parseJsonReply("no json"), null);
    assert.equal(parseJsonReply("[1,2]"), null);
  });

  test("runVision: stream-json image input, hardened flags, parsed answer", async () => {
    const r = await runVision({ images: [{ media_type: "image/jpeg", data: "AAAA" }], prompt: "Identify the card." });
    assert.equal(r.error, null);
    assert.equal(r.json.set_code, "m10");
    assert.equal(r.costUsd, 0.0078);
    const call = JSON.parse(readFileSync(fakeLog, "utf8").trim().split("\n").pop());
    const a = call.args;
    const val = (flag) => a[a.indexOf(flag) + 1];
    assert.equal(val("--input-format"), "stream-json");
    assert.equal(val("--output-format"), "stream-json");
    assert.equal(val("--model"), "sonnet");
    assert.equal(val("--tools"), "");
    assert.equal(val("--setting-sources"), "");
    assert.equal(val("--system-prompt"), SCAN_PROMPT);
    for (const f of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "-p"]) assert.ok(a.includes(f), f);
    assert.ok(!a.includes("--resume"));
    const msg = JSON.parse(call.input.trim());
    assert.equal(msg.type, "user");
    assert.equal(msg.message.content[0].type, "image");
    assert.equal(msg.message.content[0].source.data, "AAAA");
    assert.equal(msg.message.content.at(-1).text, "Identify the card.");
    assert.notEqual(call.cwd, process.cwd(), "runs in a scratch dir");
    assert.match(SCAN_PROMPT, /NEVER fill collector_number/);
    for (const k of ["english_name", "printed_name", "set_code", "collector_number", "language", "foil_indicator", "confidence", "notes"]) {
      assert.ok(SCAN_PROMPT.includes(`"${k}"`), k);
    }
  });

  test("runVision: CLI errors are reported, not thrown", async () => {
    process.env.FAKE_CLAUDE_MODE = "error";
    try {
      const r = await runVision({ images: [{ media_type: "image/jpeg", data: "AAAA" }] });
      assert.equal(r.json, null);
      assert.match(r.error, /authentication failed/i);
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
  });

  test("runVision shares the MAX_CONCURRENT gate (busy instead of queueing)", async () => {
    process.env.FAKE_CLAUDE_DELAY = "400";
    try {
      const img = [{ media_type: "image/jpeg", data: "AAAA" }];
      const p1 = runVision({ images: img });
      const p2 = runVision({ images: img });
      assert.equal(activeClaudeRuns().vision, 2);
      const third = await runVision({ images: img });
      assert.equal(third.busy, true);
      const [a, b] = await Promise.all([p1, p2]);
      assert.equal(a.error, null);
      assert.equal(b.error, null);
      assert.equal(activeClaudeRuns().vision, 0);
    } finally {
      delete process.env.FAKE_CLAUDE_DELAY;
    }
  });
});

// ---------------------------------------------------------------------------
// Contract check against the real lib/cardindex.js (tiny bulk file, offline).

describe("identify with the real card index", () => {
  let dir, idx, index;
  const img = (id) => ({ small: `https://cards.scryfall.io/small/${id}.jpg`, normal: `https://cards.scryfall.io/normal/${id}.jpg` });
  let n = 0;
  const card = (o) => {
    const id = `10000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
    return {
      object: "card", id, oracle_id: `o-${o.name}`, lang: "en", games: ["paper"], digital: false, released_at: "2020-01-01",
      rarity: "rare", finishes: ["nonfoil", "foil"], promo_types: [], illustration_id: `ill-${o.name}`, frame: "2015",
      border_color: "black", full_art: false, frame_effects: [], layout: "normal", image_status: "highres_scan",
      image_uris: img(id), type_line: "Creature", mana_cost: "{1}", set_type: "expansion", ...o,
    };
  };
  before(async () => {
    const { gzipSync } = await import("node:zlib");
    index = await import("../lib/cardindex.js");
    dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-idx-"));
    const file = path.join(dir, "all.jsonl.gz");
    const cards = [
      card({ name: "Ajani Steadfast", set: "m15", collector_number: "1", released_at: "2014-07-18" }),
      card({ name: "Ajani Steadfast", set: "m15", collector_number: "1", lang: "de", printed_name: "Ajani der Unerschütterliche", released_at: "2014-07-18" }),
      card({ name: "Aeronaut Cavalry", set: "bro", collector_number: "1", released_at: "2022-11-18" }),
      card({ name: "Aeronaut Cavalry", set: "pbro", collector_number: "1s", finishes: ["foil"], promo_types: ["prerelease"], released_at: "2022-11-19" }),
    ];
    writeFileSync(file, gzipSync(cards.map((c) => JSON.stringify(c)).join("\n") + "\n"));
    idx = index.openIndex(path.join(dir, "cardindex.db"));
    await index.refreshIndex(idx, {
      source: file,
      setsSource: [
        { code: "m15", name: "Magic 2015", set_type: "core", released_at: "2014-07-18", card_count: 284, printed_size: 269 },
        { code: "bro", name: "The Brothers' War", set_type: "expansion", released_at: "2022-11-18", card_count: 400 },
        { code: "pbro", name: "BRO Promos", set_type: "promo", released_at: "2022-11-18", card_count: 171, parent_set_code: "bro" },
      ],
    });
  });
  after(() => { try { idx.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

  const ctxFor = (line, title) => ({ db: null, idx, matcher: null, claude: null, ocr: makeOcr({ line, title }), fp: fpStub, thresholds: DEFAULT_THRESHOLDS });

  test("German M15 card: detected de printing, stored as the English one", async () => {
    const line = modernLine({ format: "m15", number: "1", numberCandidates: ["1"], total: 269, setCandidates: [{ code: "m15", score: 1, cost: 0 }], langCode: "DE", lang: "de" });
    const r = await identify(ctxFor(line, "Ajani der Unerschütterliche"), { card: CARD, strip: STRIP, settings: { storageLang: "en", foil: "auto" } });
    assert.equal(r.status, "auto");
    assert.equal(r.printing.lang, "de");
    assert.equal(r.store.lang, "en");
    assert.equal(r.store.set_code, "m15");
    assert.equal(r.store.collector_number, "1");
  });

  test("promo twin printing the parent line: base printing chosen, twin as variant", async () => {
    const line = modernLine({ number: "1", numberCandidates: ["1"], setCandidates: [{ code: "bro", score: 1, cost: 0 }] });
    const r = await identify(ctxFor(line, "Aeronaut Cavalry"), { card: CARD, strip: STRIP, settings: { storageLang: "en", foil: "auto" } });
    assert.equal(r.printing.set_code, "bro");
    assert.equal(r.status, "auto");
    assert.ok(r.variants.some((v) => v.set_code === "pbro"));
  });

  test("★ with a foil-only promo twin -> suggest (the star cannot tell them apart)", async () => {
    const line = modernLine({ number: "1", numberCandidates: ["1"], setCandidates: [{ code: "bro", score: 1, cost: 0 }], separator: "star", separatorConfidence: 0.9 });
    const r = await identify(ctxFor(line, "Aeronaut Cavalry"), { card: CARD, strip: STRIP, settings: { storageLang: "en", foil: "auto" } });
    assert.equal(r.printing.set_code, "bro");
    assert.equal(r.finish, "foil");
    assert.equal(r.status, "suggest");
  });
});
