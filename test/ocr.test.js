// Scanner OCR: collector-line parsing, set-code matching, the ★/• pixel
// classifier and PNM handling run offline on fixtures. Tests that spawn
// tesseract/djpeg skip when the binaries are missing; CI runs the suite inside
// the built image, which has them (see README "Development").

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  classifySeparator, cropFrac, decodeGray, digitize, encodePgm, invert, matchSetCode, nameSimilarity,
  ocrTools, parseCollectorText, parseLegacy, parsePnm, parseTsv, PRINTED_LANGS, readCollectorLine, readTitle, wlev,
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

// Synthetic collector line: three letter blocks, a separator glyph, two letter blocks.
function syntheticLine(sepH, sepW) {
  const width = 140, height = 40, cap = 20, top = 10;
  const data = new Uint8Array(width * height).fill(20); // dark border
  const box = (x, y, w, h) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data[yy * width + xx] = 230;
  };
  [10, 24, 38].forEach((x) => box(x, top, 10, cap)); // "NEO"
  box(58 + Math.round((14 - sepW) / 2), top + Math.round((cap - sepH) / 2), sepW, sepH); // separator
  [80, 94].forEach((x) => box(x, top, 10, cap)); // "DE"
  const line = {
    left: 10, top, width: 94, height: cap,
    words: [
      { text: "NEO", left: 10, top, width: 38, height: cap },
      { text: "+", left: 58, top: top + 4, width: 14, height: 12 },
      { text: "DE", left: 80, top, width: 24, height: cap },
    ],
  };
  return { img: { width, height, data }, line };
}

describe("classifySeparator", () => {
  test("a small round blob is a dot", () => {
    const { img, line } = syntheticLine(9, 9);
    const r = classifySeparator(img, line);
    assert.equal(r.separator, "dot");
    assert.ok(r.rel < 0.62);
    assert.ok(r.confidence > 0.5);
  });

  test("a blob of >= 0.62 cap height is a star", () => {
    const { img, line } = syntheticLine(15, 14);
    const r = classifySeparator(img, line);
    assert.equal(r.separator, "star");
    assert.ok(r.rel >= 0.62);
  });

  test("threshold is configurable", () => {
    const { img, line } = syntheticLine(15, 14);
    assert.equal(classifySeparator(img, line, { starMin: 0.9 }).separator, "dot");
  });

  test("no words or no language code means undecided", () => {
    const { img, line } = syntheticLine(9, 9);
    assert.equal(classifySeparator(img, { ...line, words: [] }).separator, null);
    const noLang = { ...line, words: line.words.slice(0, 1) };
    assert.equal(classifySeparator(img, noLang).separator, null);
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
const hasCjpeg = spawnSync("cjpeg", ["-version"]).error == null;
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
  });
});
