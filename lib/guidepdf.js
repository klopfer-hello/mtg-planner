// The deck guide (lib/deckguide.js composeGuide) as a printable A4 PDF (lib/pdf.js). Page 1 is the
// deck at a glance (commander picture, facts, summary, mana curve, how it wins); then the turn-by-turn
// plan, mulligan, key cards with pictures, one box per technique, mistakes, practice, tokens and the
// glossary. Card pictures are fetched from Scryfall's image CDN by fetchGuideImages (optional: offline,
// the PDF has text only). Layout favours short lines, big headings and white space (beginners, ADHD).

import { A4, FONTS, Flow, PdfDoc, textWidth } from "./pdf.js";

const INK = "#1d1b18", MUTED = "#6b665e", ACCENT = "#5b3fd1", SOFT = "#f1eefb", SOFT_LINE = "#dcd6f5";
const USER_AGENT = "mtg-planner (deck guide; self-hosted)";

/** Every picture URL the PDF may show: the commander(s) and the key cards. */
export function guideImageUrls(guide) {
  return [...new Set([...(guide?.commander ?? []).map((c) => c.image), ...(guide?.key_cards ?? []).map((k) => k.image)].filter(Boolean))];
}

/**
 * Fetch the guide's card pictures (JPEG) → Map(url → Buffer). Failures are skipped (the PDF then has no
 * picture there). Only cards.scryfall.io URLs are fetched. fetchImpl/timeoutMs for tests.
 */
export async function fetchGuideImages(guide, { fetchImpl = globalThis.fetch, timeoutMs = 8000, max = 10 } = {}) {
  const out = new Map();
  const urls = guideImageUrls(guide).filter((u) => /^https:\/\/cards\.scryfall\.io\//.test(u)).slice(0, max);
  await Promise.all(urls.map(async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg" }, signal: ctl.signal });
      if (!res.ok) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0 && buf.length < 3_000_000) out.set(url, buf);
    } catch { /* offline or slow: no picture */ } finally { clearTimeout(t); }
  }));
  return out;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const eur = (v) => (v == null ? null : `€${Number(v).toFixed(2)}`);

/** The guide as a PDF Buffer. images = Map(url → JPEG Buffer) from fetchGuideImages (may be empty). */
export function renderGuidePdf(guide, { images = new Map(), date = new Date() } = {}) {
  const doc = new PdfDoc({ title: `${guide.deck.name}: deck guide`, author: "mtg-planner", subject: "Beginner's guide to a Magic: The Gathering deck" });
  const reg = new Map();
  const imgOf = (url) => {
    if (!url || !images.has(url)) return null;
    if (!reg.has(url)) reg.set(url, doc.addJpeg(images.get(url)));
    return reg.get(url);
  };
  const footer = `${guide.deck.name} · deck guide · ${date.toISOString().slice(0, 10)} · made with mtg-planner`;
  const f = new Flow(doc, { footer: () => (footer.length > 110 ? `${footer.slice(0, 107)}…` : footer) });
  const s = guide.strategy;

  // --- page 1: at a glance ---
  f.text(guide.deck.name, { font: FONTS.bold, size: 22, leading: 1.2 });
  const sub = ["A beginner's guide", guide.deck.format && cap(guide.deck.format), guide.colours?.names?.length ? guide.colours.names.map(cap).join(" / ") : null].filter(Boolean).join(" · ");
  f.text(sub, { size: 11, color: MUTED });
  f.space(12);
  const cmd = guide.commander?.[0];
  const cmdImg = imgOf(cmd?.image);
  const facts = [
    guide.commander?.length ? `Commander: ${guide.commander.map((c) => c.name).join(" + ")}` : null,
    `${guide.counts.cards} cards, ${guide.counts.lands ?? "?"} of them lands`,
    guide.counts.avg_mv != null ? `Average mana value: ${guide.counts.avg_mv}` : null,
    guide.power ? `Bracket ${guide.power.bracket} (${guide.power.bracket_label}): ${guide.power.bracket_meaning}` : null,
    guide.power ? `Power score: ${guide.power.score} of 10` : null,
    guide.value_eur != null ? `Worth about ${eur(guide.value_eur)}` : null,
    guide.types ? `Creatures ${guide.types.creature ?? 0} · Instants ${guide.types.instant ?? 0} · Sorceries ${guide.types.sorcery ?? 0} · Artifacts ${guide.types.artifact ?? 0} · Enchantments ${guide.types.enchantment ?? 0}` : null,
  ].filter(Boolean);
  const y0 = f.y;
  if (cmdImg) {
    const w = 150, h = w * (cmdImg.height / cmdImg.width);
    f.need(h);
    f.image(cmdImg, f.left, f.y, w, h);
    const colX = f.left + w + 18, colW = f.width - w - 18;
    for (const line of facts) { f.text(line, { x: colX, width: colW, size: 11 }); f.space(3); }
    f.y = Math.max(f.y, y0 + h);
  } else {
    for (const line of facts) { f.text(line, { size: 11 }); f.space(2); }
  }
  f.space(14);
  if (s?.summary) { f.text(s.summary, { size: 13, leading: 1.45 }); f.space(10); }
  if (guide.curve) curveChart(f, guide.curve);
  if (s?.how_it_wins?.length) { f.heading("How it wins"); f.bullets(s.how_it_wins); }

  // --- strategy ---
  if (s) {
    f.heading("Turn by turn");
    f.subheading("Early: turns 1-3"); f.bullets(s.game_plan.early);
    f.subheading("Middle: turns 4-6"); f.bullets(s.game_plan.mid);
    f.subheading("Late: turn 7 and after"); f.bullets(s.game_plan.late);
    f.heading("Mulligan");
    f.subheading("Keep the hand when"); f.bullets(s.mulligan.keep);
    f.subheading("Shuffle it away when"); f.bullets(s.mulligan.ship);
  }

  if (guide.key_cards?.length) {
    f.heading("Key cards");
    for (const k of guide.key_cards) {
      const img = imgOf(k.image);
      const w = 56, h = img ? w * (img.height / img.width) : 0;
      const tx = f.left + (img ? w + 12 : 0), tw = f.width - (img ? w + 12 : 0);
      const textH = f.wrap(k.name, { font: FONTS.bold, size: 11.5, width: tw }).length * 15 + f.wrap(k.why, { size: 10.5, width: tw }).length * 14.5;
      f.need(Math.max(h, textH) + 8);
      const top = f.y;
      if (img) f.image(img, f.left, top, w, h);
      f.text(k.name, { font: FONTS.bold, size: 11.5, x: tx, width: tw, leading: 1.3 });
      f.text(k.why, { size: 10.5, x: tx, width: tw, color: INK });
      f.y = Math.max(f.y, top + h) + 10;
    }
  }

  if (guide.techniques?.length) {
    f.heading("Techniques this deck uses");
    f.text("Each box explains one way the deck plays and which of its cards do it.", { size: 10.5, color: MUTED });
    f.space(6);
    for (const t of guide.techniques) techniqueBox(f, t);
  }

  if (s?.pitfalls?.length) { f.heading("Watch out"); f.bullets(s.pitfalls); }
  if (s?.practice?.length) { f.heading("Learn it"); f.bullets(s.practice, { dot: "»" }); }
  if (guide.tokens?.length) {
    f.heading("Tokens you need");
    f.bullets(guide.tokens.map((t) => `${t.name}${t.pt ? ` ${t.pt}` : ""}${t.estimate ? ` (about ${t.estimate})` : ""}`));
  }
  if (guide.glossary?.length) {
    f.heading("Words to know");
    for (const g of guide.glossary) {
      f.need(30);
      f.text(g.term, { font: FONTS.bold, size: 10.5, leading: 1.25 });
      f.text(g.meaning, { size: 10.5, x: f.left + 12, width: f.width - 12, color: INK });
      f.space(5);
    }
  }
  if (!s) {
    f.space(10);
    f.text("This guide has the facts only. With Claude connected, the app also writes how the deck wins, a turn-by-turn plan, mulligan rules and tips.", { size: 10, color: MUTED });
  }
  f.finish();
  return doc.toBuffer();
}

/** Small stacked bar chart of the mana curve (creatures dark, other spells light). */
function curveChart(f, curve) {
  const buckets = curve.buckets ?? [];
  const totals = buckets.map((_, i) => (curve.creature?.[i] ?? 0) + (curve.other?.[i] ?? 0));
  const max = Math.max(1, ...totals);
  const h = 62, labelH = 14, titleH = 16;
  f.need(h + labelH + titleH + 20);
  f.text("Mana curve: how many spells cost 0, 1, 2 … mana (dark = creatures)", { size: 9.5, color: MUTED });
  // headroom above the tallest bar for its number
  const top = f.y + 14, bw = Math.min(42, (f.width - 10) / buckets.length - 8);
  buckets.forEach((label, i) => {
    const x = f.left + i * (bw + 8);
    const c = curve.creature?.[i] ?? 0, o = curve.other?.[i] ?? 0;
    const hc = (c / max) * h, ho = (o / max) * h;
    if (ho > 0) f.rect(x, top + h - hc - ho, bw, ho, { fill: SOFT_LINE });
    if (hc > 0) f.rect(x, top + h - hc, bw, hc, { fill: ACCENT });
    const num = String(c + o);
    if (c + o > 0) f.textAt(num, x + bw / 2 - textWidth(num, FONTS.bold, 8.5) / 2, top + h - hc - ho - 3, { font: FONTS.bold, size: 8.5, color: INK });
    f.textAt(label, x + bw / 2 - textWidth(label, FONTS.regular, 9) / 2, top + h + 12, { size: 9, color: MUTED });
  });
  f.y = top + h + labelH + 8;
}

/** One technique as a rounded box: name + count, what it is, how this deck uses it, its cards. */
function techniqueBox(f, t) {
  const pad = 10, innerW = f.width - 2 * pad;
  const parts = [
    { text: `${t.name} (${t.count} card${t.count === 1 ? "" : "s"})`, font: FONTS.bold, size: 12, color: INK },
    { text: t.what, font: FONTS.regular, size: 10.5, color: INK },
    t.tip ? { text: `In this deck: ${t.tip}`, font: FONTS.regular, size: 10.5, color: INK } : null,
    { text: `${t.cards.join(", ")}${t.count > t.cards.length ? ", …" : ""}`, font: FONTS.italic, size: 9.5, color: MUTED },
  ].filter(Boolean);
  const heights = parts.map((p) => f.wrap(p.text, { font: p.font, size: p.size, width: innerW }).length * p.size * 1.38 + 3);
  const total = heights.reduce((a, b) => a + b, 0) + 2 * pad;
  if (total < A4.height - 120) f.need(total + 8);
  const top = f.y;
  f.rect(f.left, top, f.width, total, { fill: SOFT, stroke: SOFT_LINE, radius: 6, lineWidth: 0.8 });
  f.y = top + pad;
  parts.forEach((p) => { f.text(p.text, { font: p.font, size: p.size, color: p.color, x: f.left + pad, width: innerW }); f.space(3); });
  f.y = top + total + 8;
}
