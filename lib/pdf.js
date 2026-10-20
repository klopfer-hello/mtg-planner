// Minimal PDF writer (stdlib only; no npm dependencies by design) for the deck guide (lib/guidepdf.js).
//
// PDF 1.4, A4 portrait, the standard Helvetica fonts (no embedding: every PDF reader has them) with
// WinAnsiEncoding, so Western European text works (umlauts, €, quotes, dashes) and anything outside
// it is transliterated or becomes "?". Text is wrapped with the fonts' real glyph widths (AFM). JPEG
// images are embedded as-is (DCTDecode). Mana symbols written as {G} in text become small coloured
// circles. A Flow keeps a cursor, breaks pages and adds "page n of m" footers at the end.
// Content streams stay uncompressed: guides are small and tests can read the text back.

// --- fonts ------------------------------------------------------------------------------------------
// Glyph widths (1/1000 em) for WinAnsi codes 32..255, from the Adobe AFM files.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350,
  556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 222, 222, 333, 333, 350, 556, 1000, 333,
  1000, 500, 333, 944, 350, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333,
  365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778,
  778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278,
  278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350,
  556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 278, 278, 500, 500, 350, 556, 1000, 333,
  1000, 556, 333, 944, 350, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333,
  365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778,
  778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278,
  278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];
export const FONTS = {
  regular: { name: "F1", base: "Helvetica", widths: HELV },
  bold: { name: "F2", base: "Helvetica-Bold", widths: HELV_BOLD },
  italic: { name: "F3", base: "Helvetica-Oblique", widths: HELV },
};

// Unicode → WinAnsi (cp1252) for the 0x80-0x9F block; 0xA0-0xFF map 1:1 to Latin-1.
const CP1252 = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
const TRANSLIT = { "−": "-", "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "★": "*", "☆": "*", "✓": "", "✗": "x", "⚠": "!", "⇄": "<>", " ": " " };

/** A JS string → WinAnsi byte values (unknown characters become "?"). */
export function winAnsi(str) {
  const out = [];
  for (const ch of String(str ?? "").normalize("NFC")) {
    if (TRANSLIT[ch] !== undefined) { for (const c of TRANSLIT[ch]) out.push(c.charCodeAt(0)); continue; }
    const cp = ch.codePointAt(0);
    if (cp >= 32 && cp <= 126) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (CP1252[ch] !== undefined) out.push(CP1252[ch]);
    else if (cp === 9) out.push(32);
    else out.push(63);
  }
  return out;
}

/** Width of a string in points. */
export function textWidth(str, font = FONTS.regular, size = 11) {
  let w = 0;
  for (const b of winAnsi(str)) w += font.widths[b - 32] ?? 556;
  return (w * size) / 1000;
}

const pdfString = (str) => {
  let s = "(";
  for (const b of winAnsi(str)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) s += `\\${b.toString(8).padStart(3, "0")}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
};
const n = (x) => (Math.round(x * 100) / 100).toString();
const rgb = (hex) => {
  const v = String(hex).replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((x) => n(x)).join(" ");
};

// --- JPEG -------------------------------------------------------------------------------------------
/** {width, height, components} of a JPEG from its SOF marker, or null. */
export function jpegInfo(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

// --- document ---------------------------------------------------------------------------------------
export const A4 = { width: 595.28, height: 841.89 };
export const MANA_COLOURS = { W: "#f8f6d8", U: "#c1d7e9", B: "#bab1ab", R: "#e49977", G: "#a3c095", C: "#cac5c0" };

/** Low-level PDF document: pages with content-stream operators, fonts, JPEG images. */
export class PdfDoc {
  constructor({ title = "", author = "", subject = "" } = {}) {
    this.info = { title, author, subject };
    this.pages = [];
    this.images = [];
  }

  addPage() { const p = { ops: [] }; this.pages.push(p); return p; }

  /** Register a JPEG (Buffer); returns {name, width, height} or null when it isn't a usable JPEG. */
  addJpeg(buf) {
    const info = jpegInfo(buf);
    if (!info || ![1, 3].includes(info.components)) return null;
    const img = { name: `Im${this.images.length + 1}`, buf, ...info };
    this.images.push(img);
    return img;
  }

  /** The finished file as a Buffer. */
  toBuffer() {
    const objs = []; // [content Buffer]
    const add = (body) => { objs.push(body); return objs.length; };
    const reserve = () => { objs.push(null); return objs.length; };
    const catalog = reserve();
    const pagesId = reserve();
    const fontIds = {};
    for (const [key, f] of Object.entries(FONTS)) {
      fontIds[key] = add(Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`));
    }
    const imageIds = this.images.map((img) => add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.components === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.buf.length} >>\nstream\n`),
      img.buf, Buffer.from("\nendstream"),
    ])));
    const fontRes = Object.values(FONTS).map((f, i) => `/${f.name} ${Object.values(fontIds)[i]} 0 R`).join(" ");
    const imgRes = this.images.map((img, i) => `/${img.name} ${imageIds[i]} 0 R`).join(" ");
    const resources = `<< /Font << ${fontRes} >>${imgRes ? ` /XObject << ${imgRes} >>` : ""} >>`;
    const pageIds = [];
    for (const p of this.pages) {
      const content = Buffer.from(p.ops.join("\n"), "latin1");
      const cid = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]));
      pageIds.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(A4.width)} ${n(A4.height)}] /Resources ${resources} /Contents ${cid} 0 R >>`)));
    }
    objs[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
    objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const infoId = add(Buffer.from(`<< /Title ${pdfString(this.info.title)} /Author ${pdfString(this.info.author)} /Subject ${pdfString(this.info.subject)} /Producer (mtg-planner) >>`));
    const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets = [];
    objs.forEach((body, i) => {
      offsets.push(offset);
      const c = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
      chunks.push(c);
      offset += c.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
    return Buffer.concat(chunks);
  }
}

// --- flow layout ------------------------------------------------------------------------------------
const SYMBOL_RE = /\{([WUBRGCSXYZ0-9]{1,2}|[WUBRG2]\/[WUBRGP])\}/g;

/** Split text into tokens: words (with their trailing space) and mana symbols. */
function tokens(text) {
  const out = [];
  for (const part of String(text ?? "").split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { if (out.length) out[out.length - 1].space = true; continue; }
    let last = 0;
    for (const m of part.matchAll(SYMBOL_RE)) {
      if (m.index > last) out.push({ text: part.slice(last, m.index) });
      out.push({ sym: m[1] });
      last = m.index + m[0].length;
    }
    if (last < part.length) out.push({ text: part.slice(last) });
  }
  return out;
}

/**
 * A cursor over a PdfDoc: margins, page breaks, wrapped text with inline mana symbols, bullets,
 * headings, boxes, images. y grows DOWN from the top margin (converted to PDF coordinates on draw).
 */
export class Flow {
  constructor(doc, { margin = 48, footer = null, bottom = 56 } = {}) {
    this.doc = doc;
    this.margin = margin;
    this.bottom = bottom;
    this.footer = footer; // (pageNo, pageCount) => string
    this.width = A4.width - 2 * margin;
    this.newPage();
  }

  newPage() { this.page = this.doc.addPage(); this.y = this.margin; return this; }
  get left() { return this.margin; }
  space(h) { this.y += h; return this; }
  /** Break the page unless `h` points still fit. */
  need(h) { if (this.y + h > A4.height - this.bottom) this.newPage(); return this; }
  op(s) { this.page.ops.push(s); }
  py(y) { return A4.height - y; }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 1, radius = 0 } = {}) {
    const ops = [];
    if (fill) ops.push(`${rgb(fill)} rg`);
    if (stroke) ops.push(`${rgb(stroke)} RG ${n(lineWidth)} w`);
    if (radius > 0) {
      const r = Math.min(radius, w / 2, h / 2), k = 0.5523 * r;
      const x0 = x, x1 = x + w, y0 = this.py(y + h), y1 = this.py(y);
      ops.push(`${n(x0 + r)} ${n(y0)} m ${n(x1 - r)} ${n(y0)} l ${n(x1 - r + k)} ${n(y0)} ${n(x1)} ${n(y0 + r - k)} ${n(x1)} ${n(y0 + r)} c`
        + ` ${n(x1)} ${n(y1 - r)} l ${n(x1)} ${n(y1 - r + k)} ${n(x1 - r + k)} ${n(y1)} ${n(x1 - r)} ${n(y1)} c`
        + ` ${n(x0 + r)} ${n(y1)} l ${n(x0 + r - k)} ${n(y1)} ${n(x0)} ${n(y1 - r + k)} ${n(x0)} ${n(y1 - r)} c`
        + ` ${n(x0)} ${n(y0 + r)} l ${n(x0)} ${n(y0 + r - k)} ${n(x0 + r - k)} ${n(y0)} ${n(x0 + r)} ${n(y0)} c h`);
    } else {
      ops.push(`${n(x)} ${n(this.py(y + h))} ${n(w)} ${n(h)} re`);
    }
    ops.push(fill && stroke ? "B" : fill ? "f" : "S");
    this.op(`q ${ops.join(" ")} Q`);
  }

  circle(cx, cy, r, fill, stroke = "#555555") {
    const k = 0.5523 * r, X = cx, Y = this.py(cy);
    this.op(`q ${rgb(fill)} rg ${rgb(stroke)} RG 0.4 w ${n(X + r)} ${n(Y)} m ${n(X + r)} ${n(Y + k)} ${n(X + k)} ${n(Y + r)} ${n(X)} ${n(Y + r)} c`
      + ` ${n(X - k)} ${n(Y + r)} ${n(X - r)} ${n(Y + k)} ${n(X - r)} ${n(Y)} c ${n(X - r)} ${n(Y - k)} ${n(X - k)} ${n(Y - r)} ${n(X)} ${n(Y - r)} c`
      + ` ${n(X + k)} ${n(Y - r)} ${n(X + r)} ${n(Y - k)} ${n(X + r)} ${n(Y)} c B Q`);
  }

  /** One line of text at (x, baseline y) without wrapping. */
  textAt(str, x, y, { font = FONTS.regular, size = 11, color = "#1d1b18" } = {}) {
    this.op(`BT ${rgb(color)} rg /${font.name} ${n(size)} Tf ${n(x)} ${n(this.py(y))} Td ${pdfString(str)} Tj ET`);
  }

  symbol(sym, x, baselineY, size) {
    const r = size * 0.46, cy = baselineY - size * 0.33;
    const key = /^[WUBRGC]$/.test(sym) ? sym : sym.includes("/") ? sym[0] : "C";
    this.circle(x + r, cy, r, MANA_COLOURS[key] ?? MANA_COLOURS.C);
    const label = sym.replace("/", "");
    const fs = size * (label.length > 1 ? 0.5 : 0.62), w = textWidth(label, FONTS.bold, fs);
    this.textAt(label, x + r - w / 2, cy + fs * 0.35, { font: FONTS.bold, size: fs, color: "#111111" });
    return 2 * r + size * 0.12;
  }

  /** Lines of `text` wrapped into `width`: [[token…]] with measured widths. */
  wrap(text, { font = FONTS.regular, size = 11, width = this.width } = {}) {
    const space = textWidth(" ", font, size);
    const lines = [];
    let line = [], w = 0;
    for (const t of tokens(text)) {
      let tw = t.sym ? size * 1.04 : textWidth(t.text, font, size);
      // A word longer than the line is cut into pieces.
      if (!t.sym && tw > width) {
        let rest = t.text;
        while (rest) {
          let k = rest.length;
          while (k > 1 && textWidth(rest.slice(0, k), font, size) > width) k--;
          if (line.length) { lines.push(line); line = []; w = 0; }
          lines.push([{ text: rest.slice(0, k), w: textWidth(rest.slice(0, k), font, size) }]);
          rest = rest.slice(k);
        }
        continue;
      }
      const lead = line.length && line[line.length - 1].space ? space : 0;
      if (line.length && w + lead + tw > width) { lines.push(line); line = []; w = 0; }
      const gap = line.length && line[line.length - 1].space ? space : 0;
      line.push({ ...t, w: tw, x: w + gap });
      w += gap + tw;
    }
    if (line.length) lines.push(line);
    return lines;
  }

  /** Wrapped paragraph at the cursor (or at x/width); returns its height. */
  text(str, { font = FONTS.regular, size = 11, color = "#1d1b18", x = this.left, width = this.width, leading = 1.38, keep = false } = {}) {
    const lines = this.wrap(str, { font, size, width });
    const lh = size * leading;
    if (keep) this.need(lines.length * lh);
    for (const line of lines) {
      this.need(lh);
      const base = this.y + size;
      let cx = x, prevEnd = 0;
      for (const t of line) {
        const tx = x + (t.x ?? prevEnd);
        if (t.sym) this.symbol(t.sym, tx, base, size);
        else this.textAt(t.text, tx, base, { font, size, color });
        prevEnd = (t.x ?? prevEnd) + t.w;
        cx = tx;
      }
      void cx;
      this.y += lh;
    }
    return lines.length * lh;
  }

  heading(str, { size = 16, color = "#1d1b18", bar = "#5b3fd1" } = {}) {
    this.need(size * 3.2);
    this.space(size * 0.5);
    if (bar) this.rect(this.left, this.y + 2, 5, size * 1.15, { fill: bar });
    this.text(str, { font: FONTS.bold, size, color, x: this.left + (bar ? 12 : 0), width: this.width - 12 });
    this.space(size * 0.25);
  }

  subheading(str, { size = 10, color = "#6b665e" } = {}) {
    this.need(size * 4);
    this.space(size * 0.4);
    this.text(String(str).toUpperCase(), { font: FONTS.bold, size, color });
  }

  bullets(items, { size = 11, indent = 16, dot = "•", color = "#1d1b18", gap = 3 } = {}) {
    for (const item of items ?? []) {
      const lines = this.wrap(item, { size, width: this.width - indent });
      this.need(size * 1.38 * Math.min(lines.length, 2));
      this.textAt(dot, this.left + 3, this.y + size, { size, color: "#5b3fd1", font: FONTS.bold });
      this.text(item, { size, color, x: this.left + indent, width: this.width - indent });
      this.space(gap);
    }
  }

  /** Draw a registered image (PdfDoc.addJpeg) with its top-left at (x, y) in flow coordinates. */
  image(img, x, y, w, h) {
    this.op(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(this.py(y + h))} cm /${img.name} Do Q`);
  }

  /** Add the footers ("page n of m" etc.) to every page. Call once, after the content. */
  finish() {
    if (!this.footer) return;
    const total = this.doc.pages.length;
    this.doc.pages.forEach((p, i) => {
      const saved = this.page;
      this.page = p;
      const txt = this.footer(i + 1, total);
      this.rect(this.left, A4.height - 40, this.width, 0.6, { fill: "#dcd8d0" });
      this.textAt(txt, this.left, A4.height - 26, { size: 8.5, color: "#6b665e" });
      const pn = `${i + 1} / ${total}`;
      this.textAt(pn, this.left + this.width - textWidth(pn, FONTS.regular, 8.5), A4.height - 26, { size: 8.5, color: "#6b665e" });
      this.page = saved;
    });
  }
}
