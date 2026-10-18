// Local Scryfall card index: bulk ingest (local file and stubbed download),
// collector-line lookups, fuzzy titles, storage-language printing. Offline.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import {
  cnDigits, getPrinting, indexStatus, localizedNames, lookupCollector, lookupLegacyNumber, normTitle, openIndex,
  printingsOf, refreshIndex, refreshIndexInWorker, searchTitle, setCodes, storagePrinting, variantsOf,
} from "../lib/cardindex.js";
import http from "node:http";

let n = 0;
const uid = () => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
const img = (id) => ({ small: `https://cards.scryfall.io/small/front/0/0/${id}.jpg`, normal: `https://cards.scryfall.io/normal/front/0/0/${id}.jpg` });
function card(o) {
  const id = o.id || uid();
  return {
    object: "card", id, oracle_id: `o-${o.name}`, lang: "en", games: ["paper"], digital: false, released_at: "2020-01-01",
    rarity: "rare", finishes: ["nonfoil", "foil"], promo_types: [], illustration_id: `ill-${o.name}`, frame: "2015",
    border_color: "black", full_art: false, frame_effects: [], layout: "normal", image_status: "highres_scan",
    image_uris: img(id), type_line: "Creature", mana_cost: "{1}", set_type: "expansion", ...o, id,
  };
}

const SETS = [
  { code: "m15", name: "Magic 2015", set_type: "core", released_at: "2014-07-18", card_count: 284, printed_size: 269 },
  { code: "mom", name: "March of the Machine", set_type: "expansion", released_at: "2023-04-21", card_count: 400 },
  { code: "bro", name: "The Brothers' War", set_type: "expansion", released_at: "2022-11-18", card_count: 400 },
  { code: "pbro", name: "BRO Promos", set_type: "promo", released_at: "2022-11-18", card_count: 171, parent_set_code: "bro" },
  { code: "thb", name: "Theros Beyond Death", set_type: "expansion", released_at: "2020-01-24", card_count: 350 },
  { code: "plst", name: "The List", set_type: "masters", released_at: "2020-09-26", card_count: 5663 },
  { code: "10e", name: "Tenth Edition", set_type: "core", released_at: "2007-07-13", card_count: 510, printed_size: 383 },
  { code: "war", name: "War of the Spark", set_type: "expansion", released_at: "2019-05-03", card_count: 311 },
  { code: "mid", name: "Innistrad: Midnight Hunt", set_type: "expansion", released_at: "2021-09-24", card_count: 400 },
];

const CARDS = [
  card({ name: "Ajani Steadfast", set: "m15", collector_number: "1" }),
  card({ name: "Ajani Steadfast", set: "m15", collector_number: "1", lang: "de", printed_name: "Ajani der Unerschütterliche", image_status: "lowres" }),
  card({ name: "Invasion of Ravnica", set: "mom", collector_number: "1", lang: "de", printed_name: "Invasion von Ravnica" }),
  card({ name: "Aeronaut Cavalry", set: "bro", collector_number: "1" }),
  card({ name: "Aeronaut Cavalry", set: "pbro", collector_number: "1s", finishes: ["foil"], promo_types: ["prerelease", "datestamped"], released_at: "2022-11-19" }),
  card({ name: "Lampad of Death's Vigil", set: "thb", collector_number: "103" }),
  card({ name: "Lampad of Death's Vigil", set: "plst", collector_number: "THB-103", released_at: "2021-01-01" }),
  card({ name: "Unrelated List Card", set: "plst", collector_number: "M15-103" }),
  card({ name: "Vedalken Mastermind", set: "10e", collector_number: "123", released_at: "2007-07-13", frame: "2003" }),
  card({ name: "Karn, the Great Creator", set: "war", collector_number: "1", lang: "ja", printed_name: "大いなる創造者、カーン" }),
  card({ name: "Karn, the Great Creator", set: "war", collector_number: "1★", lang: "ja", printed_name: "大いなる創造者、カーン", promo_types: ["jpwalker"] }),
  card({ name: "Lightning Bolt", set: "m15", collector_number: "155", lang: "de", printed_name: "Blitzschlag", image_status: "placeholder" }),
  card({ name: "Lightning Bolt", set: "m15", collector_number: "155" }),
  card({
    name: "Brutal Cathar // Moonrage Brute", set: "mid", collector_number: "7", layout: "transform", image_uris: undefined, illustration_id: undefined,
    card_faces: [
      { name: "Brutal Cathar", illustration_id: "ill-cathar", image_uris: img("cathar-front") },
      { name: "Moonrage Brute", illustration_id: "ill-brute", image_uris: img("cathar-back") },
    ],
  }),
  card({ name: "Digital Only", set: "m15", collector_number: "999", digital: true }),
  card({ name: "Arena Only", set: "m15", collector_number: "998", games: ["arena"] }),
];

let dir, file, idx;
before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-"));
  file = path.join(dir, "all.jsonl.gz");
  writeFileSync(file, gzipSync(CARDS.map((c) => JSON.stringify(c)).join("\n") + "\n"));
  idx = openIndex(path.join(dir, "cardindex.db"));
  await refreshIndex(idx, { source: file, setsSource: SETS });
});
after(() => { try { idx.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const keys = (ps) => ps.map((p) => `${p.set_code}/${p.collector_number}/${p.lang}`);

describe("helpers", () => {
  test("cnDigits strips zeros and suffixes, reads SET-N", () => {
    assert.equal(cnDigits("0010"), 10);
    assert.equal(cnDigits("10s"), 10);
    assert.equal(cnDigits("1★"), 1);
    assert.equal(cnDigits("THB-103"), 103);
    assert.equal(cnDigits("M15-10"), 10);
    assert.equal(cnDigits("abc"), null);
  });
  test("normTitle lowercases and strips accents/punctuation", () => {
    assert.equal(normTitle("  Ajani, der  Unerschütterliche! "), "ajani der unerschutterliche");
  });
});

describe("refreshIndex", () => {
  test("keeps paper printings only, builds sets and status", () => {
    const st = indexStatus(idx);
    assert.equal(st.printings, CARDS.length - 2);
    assert.equal(st.sets, SETS.length);
    assert.ok(st.last_refresh);
    assert.equal(st.fingerprints, 0);
    assert.ok(setCodes(idx).includes("pbro"));
  });

  test("parent set and JSON columns are populated", () => {
    const p = lookupCollector(idx, { set: "bro", number: "1" }).find((x) => x.set_code === "pbro");
    assert.equal(p.parent_set_code, "bro");
    assert.deepEqual(p.finishes, ["foil"]);
    assert.deepEqual(p.promo_types, ["prerelease", "datestamped"]);
    const dfc = lookupCollector(idx, { set: "mid", number: "7" })[0];
    assert.equal(dfc.faces.length, 2);
    assert.equal(dfc.faces[1].image_small, img("cathar-back").small);
    assert.equal(dfc.image_small, img("cathar-front").small, "top-level image falls back to face 0");
    assert.equal(dfc.illustration_id, "ill-cathar");
  });

  test("download path: bulk-data API with UA, gzip stream, vanished rows removed", async () => {
    const orig = globalThis.fetch;
    const calls = [];
    const subset = CARDS.filter((c) => c.set !== "war");
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), ua: init.headers?.["User-Agent"] });
      if (String(url).endsWith("/bulk-data")) {
        return Response.json({ data: [{ type: "default_cards" }, { type: "all_cards", jsonl_download_uri: "https://data.example/all.jsonl.gz", updated_at: "2026-10-13T09:00:00Z" }] });
      }
      if (String(url).endsWith("/sets")) return Response.json({ data: SETS, has_more: false });
      return new Response(gzipSync(subset.map((c) => JSON.stringify(c)).join("\n")));
    };
    const other = openIndex(path.join(dir, "dl.db"));
    try {
      await refreshIndex(other, { source: file, setsSource: SETS });
      assert.equal(lookupCollector(other, { set: "war", number: "1" }).length, 2);
      const r = await refreshIndex(other);
      assert.equal(r.printings, subset.length - 2);
      assert.equal(lookupCollector(other, { set: "war", number: "1" }).length, 0, "printings gone upstream are dropped");
      assert.equal(indexStatus(other).bulk_updated_at, "2026-10-13T09:00:00Z");
      assert.ok(calls.every((c) => c.ua && /mtg-planner/.test(c.ua)), "every request sends a User-Agent");
    } finally {
      globalThis.fetch = orig;
      other.close();
    }
  });

  test("a failed download keeps the existing index", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    try {
      await assert.rejects(refreshIndex(idx, { source: "https://data.example/broken.jsonl.gz", setsSource: SETS }));
      assert.equal(indexStatus(idx).printings, CARDS.length - 2);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("refreshIndex failure modes", () => {
  test("a connection dropped mid-download rejects (no uncaught error) and keeps the index", async () => {
    const gz = gzipSync(CARDS.map((c) => JSON.stringify(c)).join("\n"));
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": gz.length });
      res.write(gz.subarray(0, Math.floor(gz.length / 2)));
      setTimeout(() => res.socket.destroy(), 20);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const url = `http://127.0.0.1:${server.address().port}/all.jsonl.gz`;
      await assert.rejects(refreshIndex(idx, { source: url, setsSource: SETS }));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(uncaught, []);
      assert.equal(indexStatus(idx).printings, CARDS.length - 2);
    } finally {
      process.off("uncaughtException", onUncaught);
      server.close();
    }
  });

  test("a failing /sets keeps the previous set list (parent sets survive)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response("busy", { status: 503 });
    const other = openIndex(path.join(dir, "sets.db"));
    try {
      await refreshIndex(other, { source: file, setsSource: SETS });
      await refreshIndex(other, { source: file, setsRetry: { retries: 2, backoffMs: 1 } });
      assert.equal(lookupCollector(other, { set: "bro", number: "1" }).find((x) => x.set_code === "pbro")?.parent_set_code, "bro");
      // No previous sets and a remote bulk source: refuse instead of degrading silently.
      const fresh = openIndex(path.join(dir, "fresh.db"));
      try {
        await assert.rejects(refreshIndex(fresh, { source: "https://data.example/all.jsonl.gz", setsRetry: { retries: 1 } }), /\/sets failed/);
      } finally { fresh.close(); }
    } finally {
      globalThis.fetch = orig;
      other.close();
    }
  });

  test("refreshIndexInWorker builds the index off the main thread", async () => {
    const f = path.join(dir, "worker.db");
    const progress = [];
    const r = await refreshIndexInWorker(f, { source: file, setsSource: SETS, onProgress: (p) => progress.push(p.phase) });
    assert.equal(r.printings, CARDS.length - 2);
    assert.ok(progress.includes("done"));
    const w = openIndex(f);
    try { assert.equal(indexStatus(w).printings, CARDS.length - 2); } finally { w.close(); }
  });
});

describe("lookupCollector", () => {
  test("M15 line, leading zeros, language filter", () => {
    assert.deepEqual(keys(lookupCollector(idx, { set: "M15", number: "001", lang: "en" })), ["m15/1/en"]);
    assert.deepEqual(keys(lookupCollector(idx, { set: "m15", number: "1" })).sort(), ["m15/1/de", "m15/1/en"]);
  });
  test("MOM+ 4-digit number", () => {
    assert.deepEqual(keys(lookupCollector(idx, { set: "MOM", number: "0001", lang: "de" })), ["mom/1/de"]);
  });
  test("prerelease promo matched through its parent set, base printing first", () => {
    assert.deepEqual(keys(lookupCollector(idx, { set: "BRO", number: "1", lang: "en" })), ["bro/1/en", "pbro/1s/en"]);
  });
  test("The List: original SET-N line, other plst rows excluded", () => {
    assert.deepEqual(keys(lookupCollector(idx, { set: "THB", number: "103", lang: "en" })), ["thb/103/en", "plst/THB-103/en"]);
  });
  test("star-suffixed JP alt art", () => {
    assert.deepEqual(keys(lookupCollector(idx, { set: "WAR", number: "001", lang: "ja" })), ["war/1/ja", "war/1★/ja"]);
  });
  test("garbage input gives no rows", () => {
    assert.deepEqual(lookupCollector(idx, { set: "", number: "1" }), []);
    assert.deepEqual(lookupCollector(idx, { set: "m15", number: "x" }), []);
  });
});

describe("lookupLegacyNumber", () => {
  test("nnn/ttt matches set printed_size in the 1998–2014 era", () => {
    assert.deepEqual(keys(lookupLegacyNumber(idx, { number: "123", total: "383" })), ["10e/123/en"]);
    assert.equal(lookupLegacyNumber(idx, { number: "123", total: "383" })[0].size_match, "printed_size");
    assert.deepEqual(lookupLegacyNumber(idx, { number: "123", total: "249" }), []);
    assert.deepEqual(lookupLegacyNumber(idx, { number: "1", total: "269" }), [], "M15 is outside the legacy era");
    assert.deepEqual(keys(lookupLegacyNumber(idx, { number: "1", total: "269", anyEra: true })).sort(), ["m15/1/de", "m15/1/en"]);
  });
});

describe("searchTitle", () => {
  test("OCR-noisy German printed name", () => {
    const [hit] = searchTitle(idx, "Ajanl der Unerschutterliche", { lang: "de" });
    assert.equal(hit.name, "Ajani Steadfast");
    assert.equal(hit.lang, "de");
    assert.ok(hit.score > 0.85);
  });
  test("English name, language filter, DFC face name, CJK", () => {
    assert.equal(searchTitle(idx, "Lightnirg Bolt", { lang: "en" })[0].name, "Lightning Bolt");
    assert.equal(searchTitle(idx, "Blitzschlaq", { lang: "de" })[0].printed_name, "Blitzschlag");
    assert.equal(searchTitle(idx, "Moonrage Brute")[0].name, "Brutal Cathar // Moonrage Brute");
    assert.equal(searchTitle(idx, "大いなる創造者、カーン", { lang: "ja" })[0].lang, "ja");
    assert.deepEqual(searchTitle(idx, "  "), []);
  });
});

describe("printings and storage language", () => {
  test("printingsOf newest first, optional lang", () => {
    const ps = printingsOf(idx, "o-Aeronaut Cavalry");
    assert.deepEqual(keys(ps), ["pbro/1s/en", "bro/1/en"]);
    assert.equal(printingsOf(idx, "o-Ajani Steadfast", { lang: "de" }).length, 1);
    // Build list: German printed names per oracle id; cards without a German printing are left out.
    assert.deepEqual(localizedNames(idx, ["o-Ajani Steadfast", "o-Lightning Bolt", "o-Karn, the Great Creator", "nope", "", null], "de"),
      { "o-Ajani Steadfast": "Ajani der Unerschütterliche", "o-Lightning Bolt": "Blitzschlag" });
    assert.deepEqual(localizedNames(idx, ["o-Karn, the Great Creator"], "ja"), { "o-Karn, the Great Creator": "大いなる創造者、カーン" });
  });
  test("storagePrinting: same set+number in storage lang, else en, else input", () => {
    const de = lookupCollector(idx, { set: "m15", number: "1", lang: "de" })[0];
    const en = lookupCollector(idx, { set: "m15", number: "1", lang: "en" })[0];
    assert.equal(storagePrinting(idx, de, "en").id, en.id);
    assert.equal(storagePrinting(idx, en, "de").id, de.id);
    assert.equal(storagePrinting(idx, de, "fr").id, en.id, "missing language falls back to English");
    const ja = lookupCollector(idx, { set: "war", number: "1", lang: "ja" })[0];
    assert.equal(storagePrinting(idx, ja, "de").id, ja.id, "no en either: keep the detected printing");
    assert.equal(getPrinting(idx, en.id).name, "Ajani Steadfast");
    assert.equal(getPrinting(idx, "nope"), null);
  });
  test("variantsOf: same-line twins across parent/promo/plst", () => {
    const bro = lookupCollector(idx, { set: "bro", number: "1", lang: "en" })[0];
    assert.deepEqual(keys(variantsOf(idx, bro)), ["pbro/1s/en"]);
    const promo = lookupCollector(idx, { set: "bro", number: "1", lang: "en" })[1];
    assert.deepEqual(keys(variantsOf(idx, promo)), ["bro/1/en"]);
    const thb = lookupCollector(idx, { set: "thb", number: "103" })[0];
    assert.deepEqual(keys(variantsOf(idx, thb)), ["plst/THB-103/en"]);
    const plst = lookupCollector(idx, { set: "thb", number: "103" })[1];
    assert.deepEqual(keys(variantsOf(idx, plst)), ["thb/103/en"]);
  });
});
