// UI smoke test (developer tool, not part of `npm test`): opens a running mtg-planner in headless Chromium at
// phone and desktop sizes, visits every tab and route and opens the main sheets (card, deck chips, settings
// sections, scan settings), and fails on page errors, console errors, failed API requests or a horizontal page
// scroll. It only reads: no button that saves, deletes or starts a job is pressed. Run it against test data.
//
// Playwright is not a dependency of the app; use the official image, e.g. with the app on the host's port 8080:
//   docker run --rm --network host -v "$PWD":/w mcr.microsoft.com/playwright:v1.48.0-noble sh -c \
//     "cp /w/scripts/ui-smoke.mjs /tmp/ && cd /tmp && npm i playwright@1.48.0 >/dev/null && node ui-smoke.mjs"
// (with the app in a container: --network container:<name> instead of --network host.)
// Settings (environment): BASE (default http://localhost:8080), SIZES (default 320x700,390x844,1280x900).
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:8080";
const SIZES = (process.env.SIZES || "320x700,390x844,1280x900").split(",").map((s) => s.split("x").map(Number));

const api = (p) => fetch(`${BASE}${p}`).then((r) => (r.ok ? r.json() : null));
const decks = (await api("/api/decks")) ?? [];
const binders = (await api("/api/binders"))?.binders ?? [];
const sets = (await api("/api/sets"))?.sets ?? [];
const ROUTES = [
  "#scan", "#collection", "#collection/all", "#collection/unsorted", "#collection/sets",
  ...binders.slice(0, 2).map((b) => `#collection/binder/${encodeURIComponent(b.name)}`),
  ...sets.slice(0, 1).map((s) => `#collection/set/${s.code}`),
  "#decks", ...decks.slice(0, 3).map((d) => `#decks/${d.id}`),
  "#value", "#value/wishlist", "#value/buy", "#planner", "#import",
];
console.log(`${decks.length} decks · ${binders.length} binders · ${sets.length} sets · ${ROUTES.length} routes`);

const failures = [];
const browser = await chromium.launch();

async function run([width, height]) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  let where = "load";
  let opened = 0;
  const fail = (what) => { failures.push(`${width}px ${where}: ${what}`); console.log(`  ✖ ${what}`); };
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") fail(`console error: ${m.text()}`); });
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.origin === new URL(BASE).origin && r.status() >= 400) fail(`HTTP ${r.status()} ${r.request().method()} ${u.pathname}${u.search}`);
  });
  page.on("requestfailed", (r) => { if (r.url().startsWith(BASE)) fail(`request failed: ${r.url()} ${r.failure()?.errorText}`); });

  const settle = async (ms = 600) => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(ms);
  };
  const noSideScroll = async () => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) fail(`horizontal scroll (${over}px)`);
  };
  const closeSheets = async () => {
    for (let i = 0; i < 4 && (await page.locator(".sheet").count()); i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(250); }
  };
  /** Click each element of `selector` in turn (re-queried every time), let it open, check, close. */
  const openEach = async (selector, label, max = 12) => {
    const n = Math.min(max, await page.locator(selector).count());
    for (let i = 0; i < n; i++) {
      const el = page.locator(selector).nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const name = ((await el.getAttribute("aria-label")) || (await el.innerText().catch(() => "")) || `#${i}`).trim().split("\n")[0].slice(0, 40);
      where = `${label} "${name}"`;
      await el.click({ timeout: 3000 }).catch((e) => fail(`click: ${e.message.split("\n")[0]}`));
      await settle(400);
      await noSideScroll();
      await closeSheets();
      opened++;
    }
  };

  console.log(`${width}x${height}`);
  await page.goto(`${BASE}/#collection`);
  await page.waitForSelector(".tabbar", { timeout: 60000 }).catch(() => fail("the app did not render (.tabbar missing)"));
  await settle(1500);

  for (const route of ROUTES) {
    where = route;
    await page.evaluate((h) => { location.hash = h; }, route);
    await settle();
    const text = await page.locator("#root").innerText().catch(() => "");
    if (!text.trim()) fail("empty page");
    await noSideScroll();
    if (route === "#collection/all") await openEach(".tile", "card", 2);
    if (/^#decks\/\d+$/.test(route)) await openEach(".deck-chips button", "deck chip");
    if (route === "#import") await openEach(".settings-row", "settings");
    if (route === "#scan") await openEach("button[aria-label='Scan settings']", "scan settings", 1);
  }
  // The tab bar itself (buttons, not hashes).
  where = "tab bar";
  const tabs = page.locator(".tabbar [role='tab']");
  for (let i = 0; i < (await tabs.count()); i++) { await tabs.nth(i).click(); await settle(300); await noSideScroll(); }
  console.log(`  ${ROUTES.length} routes, ${opened} sheets/menus opened`);
  await ctx.close();
}

for (const size of SIZES) await run(size);
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} problem(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nUI smoke test passed");
