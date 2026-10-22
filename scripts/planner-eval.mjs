// Planner eval (developer tool, not part of `npm test`): sends a fixed set of planner requests to a running
// mtg-planner through the chat API and scores the answers with deterministic checks, so a prompt, tool or model
// change can be judged by numbers (plan v1.3.0, ticket #065). No model-as-judge: every check reads the saved deck
// (GET /api/decks/:id: legality, bracket, to buy, free copies) or the stored answer (tools, cost, length).
//
// Run it against a COPY of a real collection (a backup from the Settings tab): builds need real cards, and every
// case writes decks and chats. The server needs the Claude CLI and a token, so use the app image:
//   docker build -t mtg-planner-test:eval .
//   docker run -d --name mtg-planner-test-eval -v mtg-planner-test-claude:/claude -v <dir with app.db>:/data \
//     -e DB_FILE=/data/app.db -e CLAUDE_CODE_OAUTH_TOKEN -e SCHEDULER_ENABLED=false -e SCAN_AUTO_INDEX=false \
//     [-e CLAUDE_MODEL=opus] mtg-planner-test:eval
//   docker run --rm --network container:mtg-planner-test-eval -v "$PWD":/w -v <dir>:/data node:24-slim \
//     node /w/scripts/planner-eval.mjs
//   docker rm -f mtg-planner-test-eval
// Settings (environment): BASE (default http://localhost:8080), CASES (comma-separated ids, default all),
// RUNS (runs per case, default 2; a case passes only when all pass), OUT (JSONL file the run summary is appended to,
// default /data/planner-eval.jsonl), LABEL (free text for the run). Deck cases restore the shared deck after each run;
// decks a run created are deleted after scoring (it runs on a copy).

import { appendFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:8080";
const OUT = process.env.OUT || "/data/planner-eval.jsonl";
const ONLY = process.env.CASES ? new Set(process.env.CASES.split(",").map((s) => s.trim())) : null;
const HEADERS = { "Content-Type": "application/json", Origin: BASE };

// expect: deck (a deck must be saved or changed), same_deck (the {deck} placeholder's deck is changed in place),
// format, legal, free_only (no card to buy, none taken from another built deck), max_buy_eur, max_bracket,
// max_swaps (cards changed in the existing deck), min_lands (Commander land floor, video tip 1), answer (regex the
// answer must match), tools_any (one of these tools must be called), max_tools, max_chars (the phone answer style).
const CMD = { format: "commander", legal: true, min_lands: 34, max_chars: 650 };
const CASES = [
  { id: "cmd-free", text: "Build a new Commander deck only from my free cards (don't break my built decks). Pick a commander I own.",
    expect: { deck: true, ...CMD, free_only: true } },
  { id: "cmd-b3-budget", text: "Build a Bracket 3 Commander deck around a commander I own. Buy at most €30 of cards.",
    expect: { deck: true, ...CMD, max_bracket: 3, max_buy_eur: 30 } },
  { id: "cmd-b2-precon", text: "Build a casual Bracket 2 Commander deck (precon level) from cards I own; buying up to €10 is fine.",
    expect: { deck: true, ...CMD, max_bracket: 2, max_buy_eur: 10 } },
  { id: "cmd-upgrade", needs: "commander_deck", text: "Upgrade my deck \"{deck}\" for at most €25. Keep its theme.",
    expect: { same_deck: true, legal: true, min_lands: 34, max_buy_eur: 25, max_chars: 650, tools_any: ["deck_gaps", "commander_staples"] } },
  { id: "cmd-weakest10", needs: "commander_deck", text: "Replace the 10 weakest cards in \"{deck}\" with free cards I own.",
    expect: { same_deck: true, legal: true, min_lands: 34, max_swaps: 10, max_buy_eur: 0, max_chars: 650 } },
  { id: "cmd-gaps", needs: "commander_deck", text: "What is \"{deck}\" missing? Short answer, don't change the deck.",
    expect: { deck: false, max_chars: 650, max_tools: 6, tools_any: ["deck_gaps"] } },
  { id: "cmd-sim", needs: "commander_deck", text: "How consistent is \"{deck}\"? How often do I cast my commander on curve? Don't change the deck.",
    expect: { deck: false, max_chars: 650, answer: /\d+\s?%/, tools_any: ["simulate_deck"] } },
  { id: "cmd-combos", needs: "commander_deck", text: "Which combos could I already build in the colours of \"{deck}\" from my free cards? Don't change the deck.",
    expect: { deck: false, max_chars: 650, tools_any: ["owned_combos"] } },
  { id: "new-cards", needs: "commander_deck", text: "Are there new cards from the last months that would fit \"{deck}\"? Don't change the deck.",
    expect: { deck: false, max_chars: 650, tools_any: ["recent_cards"] } },
  { id: "synergy", needs: "commander_deck", text: "Which 3 cards I own (free copies) would add the most synergy to \"{deck}\"? Don't change the deck.",
    expect: { deck: false, tools_any: ["get_cards", "deck_gaps", "commander_staples", "search_collection"], max_chars: 650 } },
  { id: "pauper-build", text: "Build a Pauper deck from cards I own: 60 cards main, 15 sideboard, any archetype.",
    expect: { deck: true, format: "pauper", legal: true, max_chars: 650 } },
  { id: "pauper-burn", text: "Build a Pauper Burn deck. Buy at most €15 of cards.",
    expect: { deck: true, format: "pauper", legal: true, max_buy_eur: 15, max_chars: 650 } },
  { id: "pauper-meta", text: "Which competitive Pauper deck could I build most cheaply from my cards? Don't save anything.",
    expect: { deck: false, max_chars: 650, tools_any: ["meta_decks", "compare_to_meta"] } },
  { id: "own-check", text: "Do I own Sol Ring, Arcane Signet and Lightning Greaves? How many are free?",
    expect: { deck: false, tools_any: ["check_owned", "get_cards", "search_collection"], max_tools: 2, max_chars: 650 } },
  { id: "func-search", text: "Which of my free cards make a token when a creature dies? List at most 5.",
    expect: { deck: false, tools_any: ["search_collection"], max_tools: 3, max_chars: 650 } },
  { id: "rules-blood-artist", text: "Blood Artist and three other creatures die to a board wipe at the same time. How many times does Blood Artist trigger?",
    expect: { deck: false, answer: /\b(4|four|vier)\b/i, tools_any: ["get_cards", "get_card", "rules_lookup", "get_rulings"], max_chars: 650 } },
  { id: "rules-split-second", text: "Can I counter a spell with split second using Counterspell?",
    expect: { deck: false, answer: /\b(no|nein|cannot|can't|kannst nicht)\b/i, tools_any: ["rules_lookup", "get_rulings", "get_cards"], max_chars: 650 } },
  { id: "rules-commander-tax", text: "My commander died twice and went back to the command zone. How much more does it cost now? Cite the rule.",
    expect: { deck: false, answer: /903\.8/, tools_any: ["rules_lookup"], max_chars: 650 } },
];

const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

/** One chat turn: POST the message, read the SSE stream until done/error. */
async function turn(chatId, text) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/chats/${chatId}/messages`, { method: "POST", headers: HEADERS, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error(`chat turn: HTTP ${r.status} ${await r.text()}`);
  const tools = [];
  let buf = "", end = null;
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!ev.startsWith("data: ")) continue;
      const msg = JSON.parse(ev.slice(6));
      if (msg.type === "tool") tools.push(msg.name);
      if (msg.type === "done" || msg.type === "error") end = msg;
    }
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (!end || end.type === "error") return { error: end?.error || "stream ended without an answer", tools, secs };
  return { answer: end.message.content, cost: end.message.cost_usd ?? null, tools, secs };
}

const shortTool = (name) => String(name).replace(/^mcp__\w+?__/, "").replace(/^(collection|scryfall)[:.]\s*/, "");
const basic = (name) => /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(name);
const keyOf = (c) => c.oracle_id || c.name.toLowerCase();

/** Pauper rules the app does not check yet (#074): 60+ main, ≤ 15 side, ≤ 4 copies but basics, all pauper-legal. */
function pauperProblems(deck) {
  const problems = [];
  const main = deck.counts?.main ?? 0, side = deck.counts?.side ?? 0;
  if (main < 60) problems.push(`${main} main cards`);
  if (side > 15) problems.push(`${side} sideboard cards`);
  const per = new Map();
  for (const c of deck.cards.filter((x) => x.board === "main" || x.board === "side")) {
    per.set(keyOf(c), { name: c.name, n: (per.get(keyOf(c))?.n ?? 0) + c.quantity });
    let legal = null;
    try { legal = JSON.parse(c.legalities || "{}").pauper; } catch { /* ignore */ }
    if (legal !== "legal") problems.push(`${c.name} not pauper-legal`);
  }
  for (const { name, n } of per.values()) if (n > 4 && !basic(name)) problems.push(`${n}x ${name}`);
  return problems;
}

/** Cards changed between two decklists (removed copies, so a 1-for-1 swap counts 1). */
function swaps(before, after) {
  const count = (cards) => {
    const m = new Map();
    for (const c of cards.filter((x) => x.board !== "maybe")) m.set(keyOf(c), (m.get(keyOf(c)) ?? 0) + c.quantity);
    return m;
  };
  const a = count(before), b = count(after);
  let removed = 0;
  for (const [k, n] of a) removed += Math.max(0, n - (b.get(k) ?? 0));
  return removed;
}

function score(c, res, deck, before) {
  const e = c.expect, checks = [];
  const check = (name, ok, info = "") => checks.push({ name, ok: Boolean(ok), info });
  if (res.error) { check("answered", false, res.error); return checks; }
  check("answered", true);
  if (e.max_chars) check("short", res.answer.length <= e.max_chars, `${res.answer.length} chars`);
  check("no table", !/^\s*\|.*\|\s*$/m.test(res.answer));
  if (e.answer) check("answer", e.answer.test(res.answer), res.answer.slice(0, 120).replace(/\s+/g, " "));
  const used = res.tools.map(shortTool);
  if (e.tools_any) check("tools used", e.tools_any.some((t) => used.includes(t)), used.join(","));
  if (e.max_tools != null) check("tool calls", res.tools.length <= e.max_tools, `${res.tools.length}`);
  if (e.deck === false) check("deck unchanged", !deck, deck ? `changed #${deck.id}` : "");
  if (e.deck || e.same_deck) check("deck saved", !!deck, deck ? `#${deck.id} ${deck.name}` : "none");
  if (!deck) return checks;
  if (e.same_deck) check("same deck", before && deck.id === before.id, `#${deck.id}`);
  if (e.format) check("format", deck.format === e.format, deck.format ?? "none");
  if (e.legal) {
    const fmt = e.format ?? deck.format;
    const problems = fmt === "pauper" ? pauperProblems(deck)
      : (deck.power?.legality?.problems ?? [{ text: "no Commander legality" }]).map((p) => p.text);
    check("legal", problems.length === 0, problems.slice(0, 3).join("; "));
  }
  if (e.free_only) check("free only", deck.to_buy_count === 0 && deck.in_use_count === 0, `buy ${deck.to_buy_count}, from other decks ${deck.in_use_count}`);
  if (e.max_buy_eur != null) check("budget", (deck.to_buy_eur ?? 0) <= e.max_buy_eur, `€${(deck.to_buy_eur ?? 0).toFixed(2)}`);
  if (e.max_bracket != null) {
    const b = deck.power?.bracket;
    check("bracket", b && b.value <= e.max_bracket && !b.partial, b ? `B${b.display}` : "none");
  }
  if (e.min_lands != null) check("lands", (deck.stats?.lands ?? 0) >= e.min_lands, `${deck.stats?.lands ?? "?"} lands`);
  if (e.max_swaps != null && before) check("swaps", swaps(before.cards, deck.cards) <= e.max_swaps, `${swaps(before.cards, deck.cards)} changed`);
  return checks;
}

const health = await api("GET", "/healthz");
if (!health.claude_configured || health.claude_cli?.status !== "installed") {
  console.error(`planner eval: the server cannot chat (token set: ${health.claude_configured}, CLI: ${health.claude_cli?.status ?? "?"})`);
  process.exit(1);
}
const decks0 = await api("GET", "/api/decks");
const cmdDeck = decks0.filter((d) => d.format === "commander").sort((a, b) => (a.status === "built" ? -1 : 1) - (b.status === "built" ? -1 : 1))[0];
console.log(`planner eval · ${BASE} · version ${health.version ?? "?"} · ${decks0.length} decks${cmdDeck ? ` · deck case uses #${cmdDeck.id} ${cmdDeck.name}` : ""}`);

const RUNS = Math.max(1, Number(process.env.RUNS) || 2);
const results = [];
for (const c of CASES) {
  if (ONLY && !ONLY.has(c.id)) continue;
  if (c.needs === "commander_deck" && !cmdDeck) { console.log(`- ${c.id}: skipped (no Commander deck)`); continue; }
  for (let run = 1; run <= RUNS; run++) {
    const before = c.needs === "commander_deck" ? await api("GET", `/api/decks/${cmdDeck.id}`) : null;
    const version = before ? (await api("GET", `/api/decks/${cmdDeck.id}/history`)).versions[0]?.id : null;
    const stamp = new Map((await api("GET", "/api/decks")).map((d) => [d.id, d.updated_at]));
    const chat = await api("POST", "/api/chats", { title: `eval: ${c.id}` });
    const res = await turn(chat.id, c.text.replace("{deck}", cmdDeck?.name ?? ""));
    const changed = (await api("GET", "/api/decks")).filter((d) => stamp.get(d.id) !== d.updated_at);
    const target = changed.find((d) => d.id === before?.id) ?? changed.at(-1);
    const deck = target ? await api("GET", `/api/decks/${target.id}`) : null;
    // Every case and run starts from the same list of the shared Commander deck.
    if (version && changed.some((d) => d.id === before.id)) await api("POST", `/api/decks/${cmdDeck.id}/history/${version}/restore`, { confirm: true });
    // ...and a deck a run created is removed, so the next run cannot find and reuse it.
    for (const d of changed.filter((x) => !stamp.has(x.id))) await api("DELETE", `/api/decks/${d.id}`);
    const checks = score(c, res, deck, before);
    const passed = checks.filter((k) => k.ok).length;
    results.push({ id: c.id, run, passed, total: checks.length, cost: res.cost, secs: res.secs, tools: res.tools.length,
      chars: res.answer?.length ?? null, checks });
    console.log(`${passed === checks.length ? "✔" : "✖"} ${c.id}${RUNS > 1 ? ` #${run}` : ""}: ${passed}/${checks.length} · ${res.tools.length} tools · ` +
      `${res.answer ? `${res.answer.length} chars · ` : ""}${res.cost != null ? `$${res.cost.toFixed(3)}` : "cost ?"} · ${res.secs}s`);
    for (const k of checks.filter((x) => !x.ok)) console.log(`    ✖ ${k.name}${k.info ? `: ${k.info}` : ""}`);
  }
}

// A case passes only when every run passes (one lucky run is noise).
const byCase = new Map();
for (const r of results) byCase.set(r.id, (byCase.get(r.id) ?? true) && r.passed === r.total);
const sum = (f) => results.reduce((a, r) => a + (f(r) ?? 0), 0);
const lengths = results.map((r) => r.chars).filter((n) => n != null).sort((a, b) => a - b);
const summary = {
  at: new Date().toISOString(), label: process.env.LABEL || "", version: health.version ?? null, model: process.env.CLAUDE_MODEL || null,
  runs: RUNS, cases: byCase.size, cases_passed: [...byCase.values()].filter(Boolean).length,
  checks: sum((r) => r.total), checks_passed: sum((r) => r.passed),
  median_chars: lengths.length ? lengths[Math.floor(lengths.length / 2)] : null, max_chars: lengths.at(-1) ?? null,
  cost_usd: Math.round(sum((r) => r.cost) * 1000) / 1000, secs: sum((r) => r.secs), tool_calls: sum((r) => r.tools), results,
};
console.log(`\n${summary.cases_passed}/${summary.cases} cases (all ${RUNS} runs) · ${summary.checks_passed}/${summary.checks} checks · ` +
  `answers median ${summary.median_chars} / max ${summary.max_chars} chars · $${summary.cost_usd} · ${summary.tool_calls} tool calls · ${summary.secs}s`);
try { appendFileSync(OUT, JSON.stringify(summary) + "\n"); console.log(`appended to ${OUT}`); } catch (err) { console.log(`not saved (${err.message})`); }
