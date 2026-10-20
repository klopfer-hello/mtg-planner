// Docs screenshots (developer tool, not part of the app): opens a running mtg-planner in headless Chromium and
// saves the screens shown in README.md and docs/*.md as WebP files (phone 390x844 @2x, one desktop shot).
// It photographs whatever data the app has: run it against a copy you are happy to publish.
//
// Playwright is not a dependency of the app; use the official image, e.g. with the app on the host's port 8080:
//   docker run --rm --network host -v "$PWD":/w mcr.microsoft.com/playwright:v1.48.0-noble sh -c \
//     "cp /w/scripts/screenshots.mjs /tmp/ && cd /tmp && npm i playwright@1.48.0 >/dev/null && OUT=/w/docs/img node screenshots.mjs"
// (Playwright is installed in /tmp, never in the repo.)
// Settings (environment): BASE (default http://localhost:8080), OUT (docs/img), QUALITY (0.78),
// DECK (deck id; default: the first deck with a guide, else the first deck), BINDER (default: the binder with
// the most copies), SET (set code; default: the owned set with the most owned cards), CHAT (a chat title
// substring for the Planner shot; default: the newest chat with an answer; none = no Planner shot).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://localhost:8080";
const OUT = process.env.OUT || "docs/img";
const QUALITY = Number(process.env.QUALITY || 0.78);
mkdirSync(OUT, { recursive: true });

const api = (p) => fetch(`${BASE}${p}`).then((r) => (r.ok ? r.json() : null));
const decks = (await api("/api/decks")) ?? [];
const deckId = Number(process.env.DECK) || (await (async () => {
  for (const d of decks) { const g = await api(`/api/decks/${d.id}/guide`); if (g?.guide) return d.id; }
  return decks[0]?.id ?? null;
})());
const binders = (await api("/api/binders"))?.binders ?? [];
const binder = process.env.BINDER || [...binders].sort((a, b) => b.copies - a.copies)[0]?.name || null;
const sets = (await api("/api/sets"))?.sets ?? [];
const setCode = process.env.SET || [...sets].sort((a, b) => b.owned - a.owned)[0]?.code || null;
const chats = (await api("/api/chats")) ?? [];
const chat = process.env.CHAT ? chats.find((c) => c.title?.includes(process.env.CHAT)) : chats.find((c) => c.message_count !== 1) ?? chats[0];
console.log(`deck ${deckId} · binder ${binder} · set ${setCode} · chat ${chat?.title ?? "none"}`);

const browser = await chromium.launch();
async function settle(page, ms = 1500) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete)
    .map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 8000); }))));
  await page.waitForTimeout(ms);
}
/** Screenshot → WebP via the page's own canvas (no image library needed). */
async function shot(page, name, ms) {
  await settle(page, ms);
  const png = await page.screenshot();
  const webp = await page.evaluate(async ({ b64, q }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", q).split(",")[1];
  }, { b64: png.toString("base64"), q: QUALITY });
  writeFileSync(path.join(OUT, `${name}.webp`), Buffer.from(webp, "base64"));
  console.log("saved", `${name}.webp`);
}
async function phone() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "light" });
  return ctx.newPage();
}

const page = await phone();
await page.goto(`${BASE}/#collection`);
await page.waitForSelector(".binder-grid");
await shot(page, "binders");
if (binder) {
  await page.goto(`${BASE}/#collection/binder/${encodeURIComponent(binder)}`);
  await page.getByRole("button", { name: /Open all/ }).click().catch(() => {});
  await page.waitForSelector(".tile", { timeout: 30000 });
  await page.evaluate(() => document.querySelector(".tile")?.closest("details, section")?.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -70));
  await shot(page, "binder");
  await page.locator(".tile").first().click();
  await page.waitForSelector("[role=dialog]");
  await shot(page, "card");
  await page.keyboard.press("Escape");
}
await page.goto(`${BASE}/#collection/sets`);
await page.waitForSelector(".set-row", { timeout: 60000 }).catch(() => {});
await shot(page, "sets");
if (setCode) {
  await page.goto(`${BASE}/#collection/set/${setCode}`);
  await page.waitForSelector(".set-card");
  await shot(page, "set");
}
await page.goto(`${BASE}/#decks`);
await page.waitForTimeout(1000);
await shot(page, "decks");
if (deckId) {
  await page.goto(`${BASE}/#decks/${deckId}`);
  await page.waitForSelector(".deck-row");
  await shot(page, "deck");
  await page.locator(".cards-bar").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
  await page.locator(".deck-line").nth(1).getByRole("button", { name: /^Actions for/ }).click();
  await page.waitForSelector(".card-menu");
  await shot(page, "deck-menu", 600);
  await page.keyboard.press("Escape");
  const guideChip = page.locator(".deck-chips").getByRole("button", { name: /Guide/ });
  if (await guideChip.count()) {
    await guideChip.first().click();
    await page.waitForSelector(".guide-glance");
    await shot(page, "guide");
    await page.keyboard.press("Escape");
  }
}
await page.goto(`${BASE}/#value`);
await shot(page, "market", 2500);
await page.goto(`${BASE}/#value/buy`);
await shot(page, "to-buy");
if (chat) {
  await page.goto(`${BASE}/#planner`);
  await page.evaluate((id) => localStorage.setItem("mtg.chat", JSON.stringify(id)), chat.id);
  await page.reload();
  await shot(page, "planner", 2500);
}
await page.goto(`${BASE}/#import`);
await shot(page, "settings");

if (deckId) {
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "light" })).newPage();
  await desk.goto(`${BASE}/#decks/${deckId}`);
  await desk.waitForSelector(".deck-row");
  await shot(desk, "desktop-deck");
}
await browser.close();
