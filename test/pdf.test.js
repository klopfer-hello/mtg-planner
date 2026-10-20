// lib/pdf.js (minimal PDF writer) and lib/guidepdf.js (deck guide → PDF): structure, text, images, fonts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FONTS, Flow, PdfDoc, jpegInfo, textWidth, winAnsi } from "../lib/pdf.js";
import { fetchGuideImages, guideImageUrls, renderGuidePdf } from "../lib/guidepdf.js";

// 8x11 px red JPEG (Pillow)
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAALAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDLoooriPpj/9k=", "base64");

/** Check the cross-reference table: every offset points at "<n> 0 obj", startxref at "xref". */
function checkStructure(buf) {
  const s = buf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4\n"));
  assert.ok(s.trimEnd().endsWith("%%EOF"));
  const startxref = Number(/startxref\n(\d+)\n%%EOF\s*$/.exec(s)[1]);
  assert.equal(s.slice(startxref, startxref + 4), "xref");
  const [, count] = /xref\n0 (\d+)\n/.exec(s.slice(startxref));
  const rows = s.slice(startxref).split("\n").slice(2, 2 + Number(count));
  rows.slice(1).forEach((row, i) => {
    const off = Number(row.slice(0, 10));
    assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1}`);
  });
  return { s, objects: Number(count) - 1, pages: Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)[1]) };
}
/** The text drawn with Tj, decoded from WinAnsi escapes. */
const shownText = (s) => [...s.matchAll(/\((?:\\.|[^\\)])*\) Tj/g)].map((m) => m[0].slice(1, -4)
  .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, "$1")).join(" ");

describe("pdf writer", () => {
  test("WinAnsi encoding and Helvetica widths", () => {
    assert.deepEqual(winAnsi("Aü€—≥日"), [65, 0xfc, 0x80, 0x97, 62, 61, 63]);
    assert.equal(textWidth("A", FONTS.regular, 1000), 667);
    assert.equal(textWidth("m", FONTS.bold, 1000), 889);
    assert.equal(textWidth("iii", FONTS.regular, 10), 6.66);
  });

  test("jpegInfo reads the size; non-JPEG is null", () => {
    assert.deepEqual(jpegInfo(JPEG), { width: 8, height: 11, components: 3 });
    assert.equal(jpegInfo(Buffer.from("nope")), null);
  });

  test("a flow document: valid xref, page breaks, footers, escaped text, mana symbols, images", () => {
    const doc = new PdfDoc({ title: "Täst (1)" });
    const f = new Flow(doc, { footer: (p, n) => `foot ${p} of ${n}` });
    f.heading("Grüße (and) back\\slash");
    f.text("Pay {2}{G} to win. " + "word ".repeat(1500));
    f.bullets(["first {W/U}", "second"]);
    const img = doc.addJpeg(JPEG);
    assert.equal(doc.addJpeg(Buffer.from("x")), null);
    f.image(img, f.left, f.y, 40, 55);
    f.finish();
    const { s, pages } = checkStructure(doc.toBuffer());
    assert.ok(pages >= 2, `${pages} pages`);
    const text = shownText(s);
    assert.match(text, /Grüße \(and\) back\\slash/);
    assert.match(text, /foot 1 of \d/);
    assert.match(s, /\/Filter \/DCTDecode/);
    assert.match(s, /\/Im1 Do/);
    assert.match(s, / c B Q/, "a mana symbol circle");
    assert.match(s, /\/Title \(T\\344st \\\(1\\\)\)/);
  });

  test("wrap keeps lines inside the width and splits over-long words", () => {
    const doc = new PdfDoc();
    const f = new Flow(doc);
    for (const line of f.wrap("x".repeat(400) + " short words here", { size: 11, width: 200 })) {
      const w = line.reduce((a, t) => Math.max(a, (t.x ?? 0) + t.w), 0);
      assert.ok(w <= 200.01, `line width ${w}`);
    }
  });
});

const GUIDE = {
  deck: { id: 1, name: "Angels (Test)", format: "commander", status: "idea" },
  commander: [{ name: "Atraxa", image: "https://cards.scryfall.io/normal/front/a.jpg" }],
  colours: { identity: "WUBG", names: ["white", "blue", "black", "green"] },
  counts: { cards: 100, lands: 37, avg_mv: 3.1 },
  curve: { buckets: ["0", "1", "2", "3", "4", "5", "6", "7+"], creature: [0, 1, 4, 6, 5, 3, 1, 1], other: [0, 6, 7, 5, 3, 2, 1, 0] },
  types: { creature: 21, instant: 8, sorcery: 6, artifact: 10, enchantment: 6, land: 37 },
  value_eur: 123.45,
  power: { bracket: "3", bracket_label: "Upgraded", bracket_meaning: "stronger than precons", score: "5.5" },
  key_cards: [{ name: "Serra Angel", why: "A big flier for {3}{W}{W}.", image: "https://cards.scryfall.io/normal/front/b.jpg" }, { name: "No Image", why: "Still listed.", image: null }],
  techniques: [{ key: "evasion", name: "Evasion", what: "Hard to block.", tip: "Fly over.", cards: ["Serra Angel"], count: 1 }],
  glossary: [{ term: "Flying", meaning: "Only fliers block it." }],
  tokens: [{ name: "Angel", pt: "4/4", estimate: 2 }],
  strategy: {
    summary: "Fly and win.", how_it_wins: ["Attack in the air"], game_plan: { early: ["Ramp"], mid: ["Cast angels"], late: ["Swing"] },
    mulligan: { keep: ["3 lands"], ship: ["0 lands"] }, pitfalls: ["Overextending"], practice: ["Goldfish"],
  },
};

describe("guide pdf", () => {
  test("renders every section; pictures where fetched; facts-only note without a strategy", () => {
    const images = new Map([["https://cards.scryfall.io/normal/front/a.jpg", JPEG], ["https://cards.scryfall.io/normal/front/b.jpg", JPEG]]);
    const { s } = checkStructure(renderGuidePdf(GUIDE, { images, date: new Date("2026-10-20T10:00:00Z") }));
    const text = shownText(s);
    for (const h of ["How it wins", "Turn by turn", "Mulligan", "Key cards", "Techniques this deck uses", "Watch out", "Learn it", "Tokens you need", "Words to know"]) {
      assert.ok(text.includes(h), h);
    }
    assert.ok(text.includes("Angels (Test)"));
    assert.ok(text.includes(`${String.fromCharCode(0x80)}123.45`), "€ is WinAnsi 0x80");
    assert.ok(text.includes("2026-10-20"));
    assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 2, "the same picture twice is embedded once per url");
    const plain = shownText(checkStructure(renderGuidePdf({ ...GUIDE, strategy: null })).s);
    assert.ok(!plain.includes("Turn by turn"));
    assert.ok(plain.includes("facts only"));
  });

  test("fetchGuideImages: only Scryfall image URLs, failures skipped", async () => {
    const g = { ...GUIDE, key_cards: [...GUIDE.key_cards, { name: "Evil", why: "x", image: "https://evil.example/x.jpg" }] };
    assert.equal(guideImageUrls(g).length, 3);
    const seen = [];
    const fake = async (url) => {
      seen.push(url);
      if (url.endsWith("b.jpg")) throw new Error("offline");
      return { ok: true, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) };
    };
    const map = await fetchGuideImages(g, { fetchImpl: fake });
    assert.deepEqual([...map.keys()], ["https://cards.scryfall.io/normal/front/a.jpg"]);
    assert.ok(!seen.some((u) => u.includes("evil")));
  });
});
