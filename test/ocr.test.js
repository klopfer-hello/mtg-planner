// Scanner OCR: collector-line parsing, set-code matching, the ★/• pixel
// classifier and PNM handling run offline on fixtures. Tests that spawn
// tesseract/djpeg skip when the binaries are missing; CI runs the suite inside
// the built image, which has them (see docs/development.md).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  classifySeparator, cropFrac, decodeGray, digitize, encodePgm, hasBinary, invert, matchSetCode, nameSimilarity,
  ocrTools, parseCollectorText, parseLegacy, parsePnm, parseTsv, PRINTED_LANGS, readCollectorLine, readTitle, rotateGray180,
  rotatedOcrInputs, tessLangFor, wlev,
} from "../lib/ocr.js";

const SETS = ["dft", "dsk", "dsc", "dmc", "ddc", "m15", "m20", "clb", "aclb", "blb", "neo", "nec", "j22", "j20", "afc",
  "mom", "mkm", "pmkm", "ltr", "ltc", "sld", "cmr", "ncc", "war", "one", "40k", "lci", "pip", "pio", "tdm", "dom", "snc"];

describe("parseCollectorText: modern block", () => {
  test("MOM+ format: rarity first, 4-digit number", () => {
    const r = parseCollectorText("M 0317\nDFT • EN Artist Name", { setCodes: SETS });
    assert.equal(r.format, "mom");
    assert.equal(r.rarity, "M");
    assert.equal(r.number, "317");
    assert.equal(r.total, null);
    assert.equal(r.setCandidates[0].code, "dft");
    assert.equal(r.setCandidates[0].score, 1);
    assert.equal(r.langCode, "EN");
    assert.equal(r.lang, "en");
    assert.ok(r.confidence > 0.6);
  });

  test("M15 format with total, zeros stripped", () => {
    const r = parseCollectorText("001/269 M\nM15 • EN", { setCodes: SETS });
    assert.equal(r.format, "m15");
    assert.equal(r.number, "1");
    assert.equal(r.total, "269");
    assert.equal(r.rarity, "M");
    assert.equal(r.setCandidates[0].code, "m15");
  });

  test("M15 format without total (Commander, Secret Lair)", () => {
    const r = parseCollectorText("681 R\nCLB • EN", { setCodes: SETS });
    assert.equal(r.format, "m15");
    assert.equal(r.number, "681");
    assert.equal(r.rarity, "R");
    assert.equal(r.setCandidates[0].code, "clb");
  });

  test("glued separator and OCR noise around the line", () => {
    const r = parseCollectorText("prolif\n187 M\nNCC*EN ioe", { setCodes: SETS });
    assert.equal(r.number, "187");
    assert.equal(r.setCandidates[0].code, "ncc");
    assert.equal(r.lang, "en");
  });

  test("confusion-weighted set and language codes (OSC→DSC, JP)", () => {
    const r = parseCollectorText("R O712\nOSC + JP & Vincent Proce", { setCodes: SETS });
    assert.equal(r.number, "712");
    assert.ok(r.setCandidates.some((c) => c.code === "dsc" && c.cost === 0.5));
    assert.equal(r.langCode, "JP");
    assert.equal(r.lang, "ja");
  });

  test("J22 read as 422 and DE read as OF still resolve", () => {
    const r = parseCollectorText("240 c\n422 + OF & Ceansrorwre Morice", { setCodes: SETS });
    assert.equal(r.number, "240");
    assert.equal(r.setCandidates[0].code, "j22");
    assert.equal(r.lang, "de");
  });

  test("letters standing in for digits lower confidence and add readings", () => {
    const r = parseCollectorText("O8S/302 C\nNEO • DE", { setCodes: SETS });
    assert.equal(r.number, "85");
    assert.ok(r.numberCandidates.includes("83"));
    const clean = parseCollectorText("083/302 C\nNEO • DE", { setCodes: SETS });
    assert.ok(r.confidence < clean.confidence);
  });

  test("printed language codes map to Scryfall langs", () => {
    const want = { SP: "es", CS: "zhs", CT: "zht", KR: "ko", JP: "ja", RU: "ru", PT: "pt", IT: "it", FR: "fr", DE: "de", PH: "ph" };
    for (const [code, lang] of Object.entries(want)) {
      assert.equal(PRINTED_LANGS[code], lang);
      const r = parseCollectorText(`M 0001\nMOM • ${code}`, { setCodes: SETS });
      assert.equal(r.lang, lang, code);
    }
  });

  test("set codes may be given as a function and in any case", () => {
    const r = parseCollectorText("U 0028\nLTR • EN", { setCodes: () => ["LTR", "LTC"] });
    assert.equal(r.setCandidates[0].code, "ltr");
  });

  test("a power/toughness box next to the line is never the collector number", () => {
    const r = parseCollectorText("6/6\nBLB • DE Artist Name", { setCodes: [...SETS, "blb"] });
    assert.equal(r.setCandidates[0].code, "blb");
    assert.equal(r.number, null);
    const x = parseCollectorText("Flavour text */2\nC 0089\nBLB • DE", { setCodes: [...SETS, "blb"] });
    assert.equal(x.number, "89");
    const m15 = parseCollectorText("001/269 M\nM15 • EN", { setCodes: SETS });
    assert.equal(m15.number, "1");
  });

  test("artist names and copyright prose are never a set line", () => {
    const r = parseCollectorText("—<aAlan Pollack\nChristopher Moeller\n™ & © 1993-2003 Wizards of the Coast, Inc.", { setCodes: ["aa1", "chr", "ala"] });
    assert.equal(r.format, null);
    assert.deepEqual(r.setCandidates, []);
  });
});

describe("parseCollectorText: 1998-2014 and older", () => {
  test("legacy nnn/ttt after the copyright notice", () => {
    const r = parseCollectorText("Christopher Moeller\n™ & © 1993-2009 Wizards of the Coast LLC 146/249", { setCodes: SETS });
    assert.equal(r.format, "legacy");
    assert.equal(r.number, "146");
    assert.equal(r.total, "249");
    assert.deepEqual(r.setCandidates, []);
    assert.equal(r.lang, null);
    assert.ok(r.confidence > 0.5);
  });

  test("slash read as 1 or dropped", () => {
    assert.deepEqual(pick(parseLegacy(["SE -1993:-2009 WIZARDS OFTHE GOAST 1 LC 1461249"])), ["146", "249"]);
    assert.deepEqual(pick(parseLegacy(["ACR 1993-2003 WIZARDS OF THE COAST, INC. 150306 AFK"])), ["150", "306"]);
    assert.deepEqual(pick(parseLegacy(["“ & ©2013 WIZARDS OF THE COAST 100249"])), ["100", "249"]);
  });

  test("copyright years are not collector numbers", () => {
    assert.deepEqual(parseLegacy(["ME D 2012 WIZARDS OF THE COAST 00 ~ :"]), []);
    assert.deepEqual(parseLegacy(["™ & © 1993\" 2009 WIZARDS OF TIT COAST LLC TT"]), []);
  });

  test("power/toughness is ignored", () => {
    const r = parseCollectorText("Illus. John Matson\n1/2\n3/6", { setCodes: SETS });
    assert.equal(r.format, null);
    assert.equal(r.number, null);
  });

  test("blurred totals get look-alike readings", () => {
    const c = parseLegacy(["2000. WIZARDS OF THE COAST, INC. 100/360"]);
    assert.deepEqual(pick(c), ["100", "360"]);
    assert.ok(c.some((x) => x.number === "100" && x.total === "350"));
  });

  test("zero-padded number without a set line is M15-style", () => {
    const r = parseCollectorText("040/168 &\n40% +08 & Games", { setCodes: SETS });
    assert.equal(r.format, "m15");
    assert.equal(r.number, "40");
  });

  test("pre-1998 cards have nothing to read", () => {
    const r = parseCollectorText("Illus. Ron Spencer\n©1993-2000 Wizards of the Coast, Inc.", { setCodes: SETS });
    assert.equal(r.format, null);
    assert.equal(r.confidence, 0);
  });
});

const pick = (c) => [c[0]?.number, c[0]?.total];

describe("tessLangFor", () => {
  test("Scryfall lang -> tesseract spec; specs pass through; unknown -> eng", () => {
    assert.equal(tessLangFor("en"), "eng");
    assert.equal(tessLangFor("ph"), "eng", "same read as English (no extra speculative read)");
    assert.equal(tessLangFor("de"), "deu+eng");
    assert.equal(tessLangFor("ja"), "jpn");
    assert.equal(tessLangFor("deu+eng"), "deu+eng");
    assert.equal(tessLangFor("x"), "eng");
    assert.equal(tessLangFor(), "eng");
  });
});

describe("set-code matching helpers", () => {
  test("wlev weights OCR confusions at 0.5", () => {
    assert.equal(wlev("OSC", "DSC"), 0.5);
    assert.equal(wlev("422", "J22"), 0.5);
    assert.equal(wlev("XYZ", "DSC"), 3);
  });

  test("matchSetCode ranks and scores", () => {
    const m = matchSetCode("NEO", SETS);
    assert.equal(m[0].code, "neo");
    assert.equal(m[0].score, 1);
    assert.ok(m.every((x) => x.cost <= 1));
  });

  test("digitize maps look-alikes", () => {
    assert.equal(digitize("O72"), "072");
    assert.equal(digitize("I5B"), "158");
  });
});

describe("parseTsv", () => {
  test("groups level-5 words into lines with boxes", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "1\t1\t0\t0\t0\t0\t0\t0\t400\t60\t-1\t",
      "5\t1\t1\t1\t1\t1\t10\t5\t60\t20\t91.5\t001/269",
      "5\t1\t1\t1\t1\t2\t80\t5\t15\t20\t88\tM",
      "5\t1\t1\t1\t2\t1\t10\t30\t45\t20\t90\tM15",
      "5\t1\t1\t1\t2\t2\t60\t32\t10\t12\t40\t+",
      "5\t1\t1\t1\t2\t3\t75\t30\t30\t20\t93\tEN",
      "5\t1\t1\t1\t2\t4\t110\t30\t30\t20\t-1\t ",
    ].join("\n");
    const { words, lines, text } = parseTsv(tsv);
    assert.equal(words.length, 5);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].text, "M15 + EN");
    assert.deepEqual([lines[1].left, lines[1].top, lines[1].width, lines[1].height], [10, 30, 95, 20]);
    assert.equal(text, "001/269 M\nM15 + EN");
    const r = parseCollectorText(lines, { setCodes: SETS });
    assert.equal(r.number, "1");
    assert.ok(r.confidence > 0.7);
  });
});

// Synthetic collector line: three letter blocks, a separator glyph, two letter blocks, light glyphs on a
// dark band. `floor` adds a light area below the band (the white box floor in the strip padding).
function syntheticLine(sepH, sepW, { floor = 0, wordH = null, words = null } = {}) {
  const width = 140, cap = 20, top = 10, height = 40 + floor;
  const data = new Uint8Array(width * height).fill(20); // dark border
  const box = (x, y, w, h, v = 230) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data[yy * width + xx] = v;
  };
  if (floor) box(0, 40, width, floor, 245);
  [10, 24, 38].forEach((x) => box(x, top, 10, cap)); // "NEO"
  if (sepH) box(58 + Math.round((14 - sepW) / 2), top + Math.round((cap - sepH) / 2), sepW, sepH); // separator
  [80, 94].forEach((x) => box(x, top, 10, cap)); // "DE"
  const wt = wordH ? top - Math.round((wordH - cap) / 2) : top, wh = wordH ?? cap;
  const line = {
    left: 10, top, width: 94, height: cap,
    words: words ?? [
      { text: "NEO", left: 10, top: wt, width: 38, height: wh },
      { text: "+", left: 58, top: top + 4, width: 14, height: 12 },
      { text: "DE", left: 80, top: wt, width: 24, height: wh },
    ],
  };
  return { img: { width, height, data }, line };
}

describe("classifySeparator", () => {
  test("a small round blob is a dot", () => {
    const { img, line } = syntheticLine(9, 9);
    const r = classifySeparator(img, line, { setText: "NEO" });
    assert.equal(r.separator, "dot");
    assert.ok(r.rel < 0.62);
    assert.ok(r.confidence > 0.5);
  });

  test("a blob of >= 0.62 cap height is a star", () => {
    const { img, line } = syntheticLine(15, 14);
    const r = classifySeparator(img, line, { setText: "NEO" });
    assert.equal(r.separator, "star");
    assert.ok(r.rel >= 0.62);
    assert.equal(r.cap, 20);
    assert.ok(r.confidence > 0.5);
  });

  test("threshold is configurable", () => {
    const { img, line } = syntheticLine(15, 14);
    assert.equal(classifySeparator(img, line, { starMin: 0.9 }).separator, "dot");
  });

  test("either polarity: dark glyphs on a light background read the same", () => {
    const { img, line } = syntheticLine(15, 14);
    const r = classifySeparator(invert(img), line, { setText: "NEO" });
    assert.equal(r.separator, "star");
    assert.equal(r.light, false);
  });

  test("a light box floor under a dark line does not flip the polarity", () => {
    const { img, line } = syntheticLine(15, 14, { floor: 120 }); // whole-image median is light now
    const r = classifySeparator(img, line, { setText: "NEO" });
    assert.equal(r.separator, "star");
    assert.equal(r.light, true);
  });

  test("★ glued into the language word and oversized word boxes", () => {
    const glued = syntheticLine(15, 14, { words: [
      { text: "NEO", left: 10, top: 10, width: 38, height: 20 },
      { text: "*DE", left: 58, top: 10, width: 46, height: 20 },
    ] });
    assert.equal(classifySeparator(glued.img, glued.line, { setText: "NEO" }).separator, "star");
    const tallBox = syntheticLine(15, 14, { wordH: 34 }); // tesseract's box 34 px for 20 px letters
    const r = classifySeparator(tallBox.img, tallBox.line, { setText: "NEO" });
    assert.equal(r.separator, "star");
    assert.equal(r.cap, 20);
  });

  test("the set word is found by its text after a junk token", () => {
    const { img, line } = syntheticLine(9, 9);
    const junk = { ...line, words: [{ text: "i", left: 0, top: 10, width: 4, height: 20 }, ...line.words] };
    assert.equal(classifySeparator(img, junk, { setText: "NEO" }).separator, "dot");
  });

  test("no words, a missing separator or language letters means undecided", () => {
    const { img, line } = syntheticLine(9, 9);
    assert.equal(classifySeparator(img, { ...line, words: [] }).separator, null);
    const noSep = syntheticLine(0, 0); // "NEO DE": the 'separator' column would be the D
    const r = classifySeparator(noSep.img, noSep.line, { setText: "NEO" });
    assert.equal(r.separator, null);
    assert.equal(r.confidence, 0);
  });

  test("a separator column wider than a letter has no confidence", () => {
    const { img, line } = syntheticLine(9, 9);
    for (let y = 15; y < 24; y++) for (let x = 52; x < 79; x++) img.data[y * img.width + x] = 230; // a dash, not a dot
    const r = classifySeparator(img, line, { setText: "NEO" });
    assert.equal(r.confidence, 0);
  });
});

describe("pixels", () => {
  test("PGM round trip, comments, crop and invert", () => {
    const img = { width: 4, height: 2, data: Uint8Array.from([0, 50, 100, 150, 200, 250, 10, 20]) };
    const back = parsePnm(encodePgm(img));
    assert.deepEqual([back.width, back.height, [...back.data]], [4, 2, [...img.data]]);
    const withComment = Buffer.concat([Buffer.from("P5\n# made by test\n4 2\n255\n"), Buffer.from(img.data)]);
    assert.deepEqual([...parsePnm(withComment).data], [...img.data]);
    const c = cropFrac(img, 0.5, 0, 1, 1);
    assert.deepEqual([c.width, c.height, [...c.data]], [2, 2, [100, 150, 10, 20]]);
    assert.deepEqual([...invert(c).data], [155, 105, 245, 235]);
  });

  test("rotateGray180 turns the pixels; rotatedOcrInputs takes a PGM too", async () => {
    const img = { width: 3, height: 2, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) };
    assert.deepEqual([...rotateGray180(img).data], [6, 5, 4, 3, 2, 1]);
    // 4x20 card, rows 0..19 valued by row: the turned card's bottom 15% = rows 2, 1, 0.
    const card = { width: 4, height: 20, data: Uint8Array.from({ length: 80 }, (_, i) => Math.floor(i / 4) * 10) };
    const r = await rotatedOcrInputs(encodePgm(card));
    const turned = parsePnm(r.card), band = parsePnm(r.strip);
    assert.deepEqual([turned.width, turned.height, turned.data[0]], [4, 20, 190]);
    assert.deepEqual([band.width, band.height, [...band.data].filter((_, i) => i % 4 === 0)], [4, 3, [20, 10, 0]]);
  });

  test("P6 is converted to gray", () => {
    const ppm = Buffer.concat([Buffer.from("P6 1 1 255\n"), Buffer.from([255, 255, 255])]);
    assert.deepEqual([...parsePnm(ppm).data], [255]);
  });

  test("rejects non-images", async () => {
    await assert.rejects(decodeGray(Buffer.from("hello")), /JPEG or PGM/);
  });
});

describe("nameSimilarity", () => {
  test("best window of the OCR line, accents folded", () => {
    assert.ok(nameSimilarity("Lightning Bolt 3R", "Lightning Bolt") > 0.95);
    assert.ok(nameSimilarity("Dralnu, Lichfurst", "Dralnu, Lichfürst") > 0.95);
    assert.ok(nameSimilarity("Ugln der Gelsterdrache", "Ugin der Geisterdrache") > 0.85);
    assert.ok(nameSimilarity("Storm Crow", "Lightning Bolt") < 0.4);
    assert.ok(nameSimilarity("ぁ容赦なき稲妻使い", "容赦なき稲妻使い") > 0.95);
    assert.equal(nameSimilarity("", "x"), 0);
  });
});

// ---------------------------------------------------------------------------
// Binary-dependent tests (run in the app image, skipped elsewhere)

const tools = await ocrTools();
const hasCjpeg = await hasBinary("cjpeg");
const skipBins = !(tools.tesseract && tools.djpeg && hasCjpeg) && "tesseract/djpeg/cjpeg not installed";

function jpegOf(img) {
  const r = spawnSync("cjpeg", ["-quality", "90"], { input: encodePgm(img) });
  assert.equal(r.status, 0);
  return r.stdout;
}

describe("with tesseract and djpeg", { skip: skipBins }, () => {
  test("decodeGray decodes JPEG via djpeg", async () => {
    const img = { width: 64, height: 32, data: new Uint8Array(64 * 32).fill(128) };
    const g = await decodeGray(jpegOf(img));
    assert.equal(g.width, 64);
    assert.equal(g.height, 32);
    assert.ok(Math.abs(g.data[100] - 128) <= 2);
  });

  test("blank strip and card read as nothing, without errors", async () => {
    const strip = { width: 700, height: 100, data: new Uint8Array(700 * 100).fill(15) };
    const r = await readCollectorLine(jpegOf(strip), { setCodes: SETS });
    assert.equal(r.format, null);
    assert.equal(r.number, null);
    assert.equal(r.passes.length, 2); // left part, then full width
    const card = { width: 500, height: 700, data: new Uint8Array(500 * 700).fill(200) };
    const t = await readTitle(jpegOf(card), { lang: "de" });
    assert.ok(t.confidence < 0.3, "blank title must not read with confidence"); // psm 7 may hallucinate a short low-conf word
    assert.equal(t.tessLang, "deu+eng");
    // A pre-decoded gray image (or its promise) gives the same read as the JPEG.
    const pre = await readTitle(Buffer.from("not decoded"), { lang: "de", gray: decodeGray(jpegOf(card)) });
    assert.equal(pre.text, t.text);
    assert.equal(pre.confidence, t.confidence);
  });
});

// ---------------------------------------------------------------------------
// Persistent OCR helper (lib/ocr.js OCR_HELPER). Each block imports its own
// module instance (query string) because OCR_HELPER is read at load time.

async function ocrModule(tag, helperPath) {
  const prev = process.env.OCR_HELPER;
  process.env.OCR_HELPER = helperPath;
  try {
    return await import(`../lib/ocr.js?${tag}`);
  } finally {
    if (prev === undefined) delete process.env.OCR_HELPER;
    else process.env.OCR_HELPER = prev;
  }
}

// A fake helper speaking the mtg-ocr protocol; the mode comes from its file
// name (ok|err|crash|hang|hangbig: hangs on images over 100 bytes). "ok" answers one TSV word
// "<lang>|<psm>|<whitelist>|<image bytes>|<pid>".
const FAKE_HELPER = String.raw`#!/usr/bin/env node
const MODE = process.argv[1].match(/fake-(\w+)\.mjs$/)[1];
let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 20) return;
    const psm = buf.readUInt32LE(4), ll = buf.readUInt32LE(8), wl = buf.readUInt32LE(12), il = buf.readUInt32LE(16);
    if (buf.length < 20 + ll + wl + il) return;
    const lang = buf.toString("utf8", 20, 20 + ll), white = buf.toString("utf8", 20 + ll, 20 + ll + wl);
    buf = buf.subarray(20 + ll + wl + il);
    if (MODE === "crash") process.exit(7);
    if (MODE === "hang" || (MODE === "hangbig" && il > 100)) return;
    const reply = (status, text) => {
      const body = Buffer.from(text), h = Buffer.alloc(12);
      h.write("MOCR"); h.writeUInt32LE(status, 4); h.writeUInt32LE(body.length, 8);
      process.stdout.write(Buffer.concat([h, body]));
    };
    if (MODE === "err") { reply(1, "boom"); continue; }
    reply(0, "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
      "5\t1\t1\t1\t1\t1\t2\t3\t40\t20\t96.5\t" + [lang, psm, white, il, process.pid].join("|") + "\n");
  }
});
`;

const posix = process.platform !== "win32";
describe("persistent OCR helper protocol (fake helper)", { skip: !posix && "needs a POSIX shebang helper" }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = posix ? fs.mkdtempSync(path.join(os.tmpdir(), "mtg-ocr-fake-")) : "";
  const fake = (mode) => {
    const f = path.join(dir, `fake-${mode}.mjs`);
    fs.writeFileSync(f, FAKE_HELPER, { mode: 0o755 });
    return f;
  };
  const img = encodePgm({ width: 4, height: 2, data: new Uint8Array(8).fill(255) });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  test("answers come from one long-lived helper per slot, options reach it", async () => {
    const M = await ocrModule("fake-ok", fake("ok"));
    const a = await M.ocrImage(img, { lang: "deu+eng", psm: 7 });
    const b = await M.ocrImage(img, { lang: "deu+eng", psm: 6, whitelist: "0123456789/" });
    const [lang, psm, white, bytes, pid] = a.words[0].text.split("|");
    assert.deepEqual([lang, psm, white, +bytes], ["deu+eng", "7", "", img.length]);
    assert.equal(a.words[0].conf, 96.5);
    assert.equal(b.words[0].text.split("|")[2], "0123456789/");
    assert.equal(b.words[0].text.split("|")[4], pid, "same process answers the second call");
    await Promise.all([1, 2, 3, 4].map(() => M.ocrImage(img, { lang: "eng" })));
    const st = M.ocrHelperStatus();
    assert.equal(st.active, true);
    assert.ok(st.spawned <= 2, `at most OCR_MAX_CONCURRENT helpers, got ${st.spawned}`);
    assert.equal(st.crashes + st.timeouts + st.fallbacks, 0);
    M.closeOcrHelpers();
    await settle();
    assert.equal(M.ocrHelperStatus().running, 0);
  });

  test("an error answer rejects and keeps the helper", async () => {
    const M = await ocrModule("fake-err", fake("err"));
    await assert.rejects(M.ocrImage(img), /boom/);
    assert.equal(M.ocrHelperStatus().running, 1);
    M.closeOcrHelpers();
  });

  test("a hung helper times out, is killed and replaced on the next call", async () => {
    const M = await ocrModule("fake-hang", fake("hang"));
    await assert.rejects(M.ocrImage(img, { timeoutMs: 300 }), /timed out after 300 ms/);
    await settle();
    assert.equal(M.ocrHelperStatus().timeouts, 1);
    assert.equal(M.ocrHelperStatus().running, 0);
    await assert.rejects(M.ocrImage(img, { timeoutMs: 300 }), /timed out/);
    assert.equal(M.ocrHelperStatus().spawned, 2);
    M.closeOcrHelpers();
  });

  test("a call queued behind a timeout never gets the dying helper (no false crash)", async () => {
    const M = await ocrModule("fake-hangbig", fake("hangbig"));
    const big = encodePgm({ width: 40, height: 20, data: new Uint8Array(800).fill(255) });
    // Both slots (OCR_MAX_CONCURRENT 2) hang; the third call waits for a slot and runs the moment
    // the first timeout frees one, before the killed helper's exit event.
    const hung = [1, 2].map(() => assert.rejects(M.ocrImage(big, { lang: "eng", timeoutMs: 300 }), /timed out after 300 ms/));
    const r = await M.ocrImage(img, { lang: "eng", timeoutMs: 5000 });
    await Promise.all(hung);
    assert.ok(r.words[0].text.startsWith("eng|"));
    const st = M.ocrHelperStatus();
    assert.deepEqual([st.timeouts, st.crashes, st.fallbacks, st.spawned], [2, 0, 0, 3]);
    M.closeOcrHelpers();
  });

  test("a crashed helper falls back to the tesseract CLI for that call", async () => {
    const M = await ocrModule("fake-crash", fake("crash"));
    const p = M.ocrImage(img, { timeoutMs: 10_000 });
    if (tools.tesseract) await p; // the CLI answers
    else await assert.rejects(p, /tesseract is not installed/);
    const st = M.ocrHelperStatus();
    assert.equal(st.crashes, 1);
    assert.equal(st.fallbacks, 1);
    assert.match(st.lastError, /exited \(7\)/);
  });

  test("a missing helper binary or OCR_HELPER=off means the spawn path", async () => {
    const M = await ocrModule("fake-missing", path.join(dir || ".", "does-not-exist"));
    assert.equal(M.ocrHelperStatus().installed, false);
    assert.equal(M.ocrHelperStatus().active, false);
    const off = await ocrModule("fake-off", "off");
    assert.equal(off.ocrHelperStatus().active, false);
  });

  test("bad options are refused before any process starts", async () => {
    const M = await ocrModule("fake-ok2", fake("ok"));
    await assert.rejects(M.ocrImage(img, { lang: "eng; rm" }), /invalid tesseract language/);
    await assert.rejects(M.ocrImage(img, { psm: 99 }), /invalid psm/);
    await assert.rejects(M.ocrImage(img, { whitelist: "a\0b" }), /invalid whitelist/);
    assert.equal(M.ocrHelperStatus().spawned, 0);
  });
});

// The real helper (built into the image) must answer exactly like the CLI.
const REAL_HELPER = process.env.OCR_HELPER || "/usr/local/bin/mtg-ocr";
const hasHelper = posix && REAL_HELPER !== "off" && spawnSync("test", ["-x", REAL_HELPER]).status === 0;

/** Blocky glyph-like shapes (I, L, T, O) on light gray: tesseract reads "something" with boxes and confidences. */
function glyphImage(seed, { width = 360, height = 60 } = {}) {
  const data = new Uint8Array(width * height).fill(235);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rect = (x0, y0, w, h) => {
    for (let y = y0; y < Math.min(height, y0 + h); y++) for (let x = x0; x < Math.min(width, x0 + w); x++) data[y * width + x] = 20;
  };
  for (let x = 12; x < width - 30; x += 22 + Math.floor(rnd() * 10)) {
    const k = Math.floor(rnd() * 4), top = 14, h = 30;
    if (k === 0) rect(x, top, 5, h);
    else if (k === 1) { rect(x, top, 5, h); rect(x, top + h - 5, 16, 5); }
    else if (k === 2) { rect(x, top, 18, 5); rect(x + 7, top, 5, h); }
    else { rect(x, top, 16, 5); rect(x, top + h - 5, 16, 5); rect(x, top, 5, h); rect(x + 11, top, 5, h); }
  }
  return { width, height, data };
}

describe("persistent OCR helper vs tesseract CLI", { skip: !(hasHelper && tools.tesseract) && "mtg-ocr helper or tesseract not installed" }, async () => {
  const H = await ocrModule("real-helper", REAL_HELPER);
  const S = await ocrModule("real-spawn", "off");
  const strip = ({ ms, ...r }) => r;

  test("identical words, boxes and confidences for every language set, psm and whitelist", async () => {
    const cases = [];
    for (const seed of [1, 2, 3]) for (const [lang, psm] of [["eng", 6], ["eng", 7], ["deu+eng", 7], ["jpn", 7]]) cases.push([seed, lang, psm, ""]);
    cases.push([4, "eng", 7, "ILTO0"], [5, "eng", 6, "0123456789"], [4, "eng", 7, ""]); // the whitelist must not stick
    for (const [seed, lang, psm, whitelist] of cases) {
      const buf = encodePgm(glyphImage(seed));
      const a = await H.ocrImage(buf, { lang, psm, whitelist });
      const b = await S.ocrImage(buf, { lang, psm, whitelist });
      assert.deepEqual(strip(a), strip(b), `seed ${seed} ${lang} psm ${psm} whitelist ${JSON.stringify(whitelist)}`);
    }
    const st = H.ocrHelperStatus();
    assert.equal(st.active, true);
    assert.equal(st.crashes + st.timeouts + st.fallbacks, 0);
    assert.ok(st.spawned >= 1 && st.spawned <= 2);
  });

  test("an unknown language is an error on both paths and the helper survives", async () => {
    const buf = encodePgm(glyphImage(7));
    await assert.rejects(H.ocrImage(buf, { lang: "xxx" }), /failed loading language/);
    await assert.rejects(S.ocrImage(buf, { lang: "xxx" }), /tesseract exited/);
    assert.equal(H.ocrHelperStatus().crashes, 0);
    const again = await H.ocrImage(buf, { lang: "eng", psm: 7 });
    assert.deepEqual(strip(again), strip(await S.ocrImage(buf, { lang: "eng", psm: 7 })));
  });

  test("a killed helper is replaced and the next call still answers", async () => {
    const buf = encodePgm(glyphImage(8));
    const before = H.ocrHelperStatus().spawned;
    H.closeOcrHelpers();
    await new Promise((r) => setTimeout(r, 150));
    const r = await H.ocrImage(buf, { lang: "eng", psm: 7 });
    assert.deepEqual(strip(r), strip(await S.ocrImage(buf, { lang: "eng", psm: 7 })));
    assert.equal(H.ocrHelperStatus().spawned, before + 1);
    H.closeOcrHelpers();
  });
});
