// Claude runner: one headless Claude Code CLI process per chat turn.
//
// The CLI is authenticated by CLAUDE_CODE_OAUTH_TOKEN (the user's subscription,
// created with `claude setup-token`) and keeps its sessions in CLAUDE_CONFIG_DIR,
// so follow-up turns continue the conversation with --resume. All built-in
// tools (Bash, Read, Write, Web, ...) are disabled; Claude only gets two MCP
// servers: our own "collection" server (same SQLite DB as the web app) and
// scryfall-mcp (card search, prices, rules, deck analysis).
//
// Output is read as stream-json and turned into small events for the web UI:
//   {type:'text', text}            streamed answer text (deltas)
//   {type:'tool', name, input}     a tool call, e.g. "collection.check_owned"
//
// The CLI is NOT part of the image (it is proprietary and not redistributed):
// scripts/entrypoint.sh installs the pinned CLAUDE_CODE_VERSION into the
// /claude volume at /claude/cli on start and exports CLAUDE_BIN. When that
// install failed, chat and vision report a clear "not installed" error and
// the rest of the app keeps working.
//
// runVision() is the scanner's fallback for uncertain scans: a stateless,
// tool-less call with image input, capped per hour and sharing the
// MAX_CONCURRENT gate with chat turns.

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_FILE = path.resolve(process.env.DB_FILE || "/data/mtg-planner.db");
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 10 * 60 * 1000;
const WORKDIR = process.env.CLAUDE_WORKDIR || path.join(path.dirname(DB_FILE), "workspace");
const SCRYFALL_MCP_ENTRY = process.env.SCRYFALL_MCP_ENTRY || "/opt/scryfall-mcp/dist/index.js";
const STDERR_TAIL = 4000;

export const MAX_CONCURRENT = Math.max(1, Number(process.env.CLAUDE_MAX_CONCURRENT) || 2);

export const PLANNER_PROMPT = `You are a Magic: The Gathering deck-building assistant in "mtg-planner", a planner for the user's OWN collection (synced from the ManaBox app and the app's scanner). The user reads your answers on a phone and wants them short and scannable.

Tools:
- mcp__collection__* : what the user owns and their saved decks (collection_overview, search_collection, check_owned, get_card, list_decks, get_deck, save_deck).
- mcp__scryfall__* : every card ever printed, prices, rules, synergies, alternatives, deck analysis.

Card rules:
- Check ownership (check_owned or search_collection) before recommending cards. Prefer cards the user owns; mark the rest as to buy, with EUR prices (EUR only, never USD).
- Decks must be legal in their format. Commander: exactly 100 cards incl. the commander, singleton except basic lands, within the commander's color identity.
- To build, create, save or change a deck, call save_deck (deck_id to change an existing one).

Answer style (strict):
- Start with the answer itself in 1-2 short sentences. No preamble, no restating the question, no explanation of what you did or which tools you used.
- Write no text before or between tool calls (no "let me check", no "the search was too strict"): the user sees every word, so only write the final answer.
- Then at most 3-5 short bullets (one line each, about 15 words). **Bold** the key card names and numbers.
- No tables, no long lists, no headings, no closing remarks.
- After a deck build or change, only summarize it: commander, theme, cards owned vs to buy (counts), cost to buy in €, and that it is saved in the Decks tab. Never list the whole deck.
- If more detail could help, end with ONE short question offering it (e.g. "Want the buy list?").
- Reply in the user's language.`;

// ---------------------------------------------------------------------------
// Locating the CLI (installed at runtime into the /claude volume)

/** Install prefix of the runtime-installed CLI (env CLAUDE_CLI_PREFIX, default <CLAUDE_CONFIG_DIR>/cli). */
export const cliPrefix = () => process.env.CLAUDE_CLI_PREFIX || path.join(process.env.CLAUDE_CONFIG_DIR || "/claude", "cli");

const isExecutable = (file) => {
  try { accessSync(file, fsConstants.X_OK); return true; } catch { return false; }
};

/** First executable `name` on PATH, or null. */
function onPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/**
 * The CLI to spawn: env CLAUDE_BIN, else <prefix>/bin/claude when installed,
 * else "claude" from PATH. Resolved per call, so a later install is picked up.
 */
export function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const local = path.join(cliPrefix(), "bin", "claude");
  return isExecutable(local) ? local : "claude";
}

/** Installed CLI version from its package.json under the prefix (or env), else null. */
function installedVersion() {
  try {
    const pkg = path.join(cliPrefix(), "lib", "node_modules", "@anthropic-ai", "claude-code", "package.json");
    return JSON.parse(readFileSync(pkg, "utf8")).version || null;
  } catch {
    return process.env.CLAUDE_CLI_INSTALLED_VERSION || null;
  }
}

/**
 * CLI presence for /healthz: {status: 'installed'|'missing', version, wanted, bin}.
 * `wanted` is the pinned CLAUDE_CODE_VERSION the entrypoint installs.
 */
export function claudeCliStatus() {
  const bin = resolveClaudeBin();
  const found = bin.includes("/") ? isExecutable(bin) : Boolean(onPath(bin));
  return {
    status: found ? "installed" : "missing",
    version: found ? installedVersion() : null,
    wanted: process.env.CLAUDE_CODE_VERSION || null,
    bin,
  };
}

/** Error text for a missing CLI (the chat and the scanner show it as is). */
export function cliMissingError(bin = resolveClaudeBin()) {
  return `Claude Code CLI is not installed (${bin}). The container installs it into ${cliPrefix()} on start ` +
    `(CLAUDE_CODE_VERSION${process.env.CLAUDE_CODE_VERSION ? "=" + process.env.CLAUDE_CODE_VERSION : ""}); ` +
    "check the container log for the install error (e.g. no network) and restart the container.";
}

/** The bin to spawn, or null when it is clearly missing. */
function spawnableBin() {
  const bin = resolveClaudeBin();
  if (bin.includes("/") ? isExecutable(bin) : onPath(bin)) return bin;
  return null;
}

/** True when the CLI has credentials to run. */
export const claudeConfigured = () => Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);

// ---------------------------------------------------------------------------
// MCP config (written once to a temp file and passed via --mcp-config)

let mcpConfigFile = null;

export function prepareMcpConfig() {
  if (mcpConfigFile) return mcpConfigFile;
  const servers = {
    collection: {
      type: "stdio",
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", path.join(APP_DIR, "mcp-collection.js")],
      env: { DB_FILE },
    },
  };
  if (existsSync(SCRYFALL_MCP_ENTRY)) {
    servers.scryfall = {
      type: "stdio",
      command: process.execPath,
      args: [SCRYFALL_MCP_ENTRY],
      env: {
        LOG_LEVEL: "error",
        SCRYFALL_USER_AGENT: "mtg-planner/1.0 (+https://github.com/klopfer-hello/mtg-planner)",
      },
    };
  } else {
    console.warn(`[claude] scryfall-mcp not found at ${SCRYFALL_MCP_ENTRY}; Claude runs without the scryfall tools`);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-"));
  mcpConfigFile = path.join(dir, "mcp.json");
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: servers }, null, 2));
  return mcpConfigFile;
}

// ---------------------------------------------------------------------------
// Helpers

const truncate = (s, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** "mcp__collection__search_collection" → "collection.search_collection". */
export function toolLabel(name = "") {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}.${m[2]}` : name;
}

/** One-line summary of a tool's input for the UI. */
export function summarizeInput(input) {
  if (input == null) return "";
  if (typeof input !== "object") return truncate(String(input));
  if (Array.isArray(input.names)) return truncate(input.names.join(", "));
  if (Array.isArray(input.cards)) {
    const label = input.name ?? input.deck ?? input.commander ?? "";
    return truncate(`${label}${label ? " " : ""}(${input.cards.length} cards)`);
  }
  for (const key of ["query", "q", "name", "deck", "card_name", "commander", "card", "set", "question", "text"]) {
    const v = input[key];
    if (typeof v === "string" || typeof v === "number") return truncate(String(v));
  }
  const json = JSON.stringify(input);
  return json === "{}" ? "" : truncate(json);
}

const AUTH_ERROR = /invalid api key|please run \/login|oauth token|not logged in|authentication[_ ]error|unauthori[sz]ed|\b401\b/i;
const SESSION_GONE = /no conversation found/i;

function friendlyError(message) {
  const msg = String(message || "").trim() || "Claude exited without a result";
  if (AUTH_ERROR.test(msg)) {
    return `Claude authentication failed: check CLAUDE_CODE_OAUTH_TOKEN (create one with \`claude setup-token\`). Details: ${truncate(msg, 300)}`;
  }
  return truncate(msg, 1000);
}

// ---------------------------------------------------------------------------
// Process tracking (for graceful shutdown)

const children = new Set();

/** Kill every running claude process (SIGTERM, then SIGKILL after 5 s). */
export function killAll() {
  for (const child of children) terminate(child);
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5000).unref();
}

// ---------------------------------------------------------------------------
// Concurrency gate shared by chat turns and scanner vision calls

let activeTurns = 0;
let activeVision = 0;

/** Claude processes in flight: { turns, vision }. */
export const activeClaudeRuns = () => ({ turns: activeTurns, vision: activeVision });

// ---------------------------------------------------------------------------
// Running a turn

/**
 * Run one chat turn. onEvent receives {type:'text'|'tool', ...} as they stream.
 * `recap` (optional) is a short text summary of the earlier conversation, used
 * only when the stored session can no longer be resumed.
 * Resolves (never rejects) with { text, sessionId, costUsd, tools, isError, error }.
 */
export async function runTurn({ prompt, sessionId = null, onEvent = () => {}, recap = "", signal } = {}) {
  activeTurns++;
  try {
    const first = await runOnce({ prompt, sessionId, onEvent, signal });
    if (first.sessionGone && sessionId && !signal?.aborted) {
      console.warn(`[claude] session ${sessionId} not found, starting a new one with a recap`);
      const recapped = recap
        ? `(The previous conversation could not be restored. Recap of the last messages:)\n${recap}\n\n(New message:)\n${prompt}`
        : prompt;
      return await runOnce({ prompt: recapped, sessionId: null, onEvent, signal });
    }
    return first;
  } finally {
    activeTurns--;
  }
}

function runOnce({ prompt, sessionId, onEvent, signal }) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config", prepareMcpConfig(),
      "--strict-mcp-config",
      "--tools", "",
      "--allowedTools", "mcp__collection", "mcp__scryfall",
      // Chat text starting with "/" must not run CLI slash commands such as
      // "/config model=opus", which would persist settings in CLAUDE_CONFIG_DIR.
      "--disable-slash-commands",
      "--append-system-prompt", PLANNER_PROMPT,
    ];
    if (sessionId) args.push("--resume", sessionId);
    if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);

    const bin = spawnableBin();
    if (!bin) { resolve(fail(cliMissingError())); return; }
    mkdirSync(WORKDIR, { recursive: true });
    const env = { ...process.env };
    env.DISABLE_AUTOUPDATER ??= "1";

    // The prompt goes in on stdin: robust for long prompts and prompts that
    // start with "-", and it cannot be swallowed by a variadic option.
    let child;
    try {
      child = spawn(bin, args, { cwd: WORKDIR, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve(fail(`Could not start Claude CLI (${bin}): ${err.message}`));
      return;
    }
    children.add(child);

    const state = {
      text: "",
      tools: [],
      sessionId: null,
      costUsd: null,
      result: null,
      deltasSinceAssistant: 0,
      pendingSeparator: false,
      sawEvent: false,
    };
    let stderr = "";
    let buffer = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const emit = (ev) => {
      try { onEvent(ev); } catch (err) { console.error("[claude] onEvent failed:", err); }
    };
    const appendText = (t, separate) => {
      if (!t) return;
      if (separate && state.text && !state.text.endsWith("\n\n")) t = (state.text.endsWith("\n") ? "\n" : "\n\n") + t;
      state.text += t;
      emit({ type: "text", text: t });
    };

    const handle = (msg) => {
      state.sawEvent = true;
      if (msg.session_id && !state.sessionId) state.sessionId = msg.session_id;
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init" && msg.session_id) state.sessionId = msg.session_id;
          break;
        case "stream_event": {
          const ev = msg.event || {};
          if (ev.type === "content_block_start" && ev.content_block?.type === "text") state.pendingSeparator = true;
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            appendText(ev.delta.text, state.pendingSeparator);
            state.pendingSeparator = false;
            state.deltasSinceAssistant++;
          }
          break;
        }
        case "assistant": {
          const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
          // API failures (auth, rate limits) arrive as a synthetic assistant
          // message carrying `error`; they are reported via the result instead.
          if (msg.error) { state.deltasSinceAssistant = 0; break; }
          for (const block of content) {
            if (block.type === "tool_use") {
              const tool = { name: toolLabel(block.name), input: summarizeInput(block.input) };
              state.tools.push(tool);
              emit({ type: "tool", ...tool });
            } else if (block.type === "text" && state.deltasSinceAssistant === 0) {
              // No partial deltas for this message: emit the complete text.
              appendText(block.text, true);
            }
          }
          state.deltasSinceAssistant = 0;
          break;
        }
        case "result":
          state.result = msg;
          if (msg.session_id) state.sessionId = msg.session_id;
          if (typeof msg.total_cost_usd === "number") state.costUsd = msg.total_cost_usd;
          break;
      }
    };

    const processLine = (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON noise
      if (msg && typeof msg === "object") handle(msg);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        processLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => {}); // EPIPE if the CLI exits early
    child.stdin.end(prompt);

    const timer = setTimeout(() => { timedOut = true; terminate(child); }, TIMEOUT_MS);
    timer.unref();
    const onAbort = () => { aborted = true; terminate(child); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      children.delete(child);
      if (buffer) { processLine(buffer); buffer = ""; }

      const r = state.result;
      // Final text fallback: nothing streamed at all, use the result string.
      if (!state.text && r && !r.is_error && typeof r.result === "string") appendText(r.result, false);

      const base = { text: state.text, sessionId: state.sessionId, costUsd: state.costUsd, tools: state.tools };
      let error = null;
      if (spawnError) {
        error = spawnError.code === "ENOENT"
          ? cliMissingError(bin)
          : `Could not start Claude CLI: ${spawnError.message}`;
      } else if (aborted) error = "Cancelled";
      else if (timedOut) error = `Claude timed out after ${Math.round(TIMEOUT_MS / 1000)} s`;
      else if (r?.is_error) {
        error = friendlyError(typeof r.result === "string" && r.result ? r.result
          : [r.subtype || "error", ...(Array.isArray(r.errors) ? r.errors : []), stderr].filter(Boolean).join(": "));
      }
      else if (!r) error = friendlyError(stderr || `Claude exited with code ${code}`);

      const sessionGone = Boolean(error) && !state.text && state.tools.length === 0
        && (SESSION_GONE.test(stderr) || SESSION_GONE.test(r?.result || "") || (r?.errors || []).some((e) => SESSION_GONE.test(String(e))));
      resolve({ ...base, isError: Boolean(error), error, sessionGone });
    };

    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code, null));
  });
}

function fail(error) {
  return { text: "", sessionId: null, costUsd: null, tools: [], isError: true, error, sessionGone: false };
}

// ---------------------------------------------------------------------------
// Scanner vision fallback
//
// One stateless CLI call per uncertain scan: the card photo (and a high-res
// crop of its collector line) go in on stdin as stream-json image blocks; the
// answer is a single JSON object. No tools, no MCP servers, no settings, no
// session files. The answer is NEVER taken as final: lib/scanner.js re-checks
// it against the local card index and the image fingerprint.

/** Tested scan prompt (claude-vision research), with memory-filling forbidden. */
export const SCAN_PROMPT = `You identify Magic: The Gathering cards from photos for a collection scanner. Reply with ONLY a JSON object (no prose, no code fences) with exactly these keys:
{"english_name": string|null, "printed_name": string|null, "set_code": string|null, "collector_number": string|null, "language": string|null, "foil_indicator": "star"|"dot"|"none"|"unknown", "confidence": number, "notes": string}
Rules:
- printed_name: the name exactly as printed on the card (in its printed language/script). english_name: the official English Oracle name (for a double-faced card give "Front // Back" only if both faces are visible, otherwise the visible face).
- Read the collector info line at the bottom-left first (the second image, when present, is a high-resolution crop of the card's bottom edge). Modern cards (since ~2020) print e.g. "R 0263" on line 1 and "DMU • EN" or "DMU ★ EN" on line 2: collector number (strip leading zeros), rarity letter, set code, separator, language code. 2015-2019 cards print e.g. "151/184 C" over "AER • EN". 1998-2014 cards print only "123/250"; older cards print nothing.
- set_code: lowercase Scryfall set code (e.g. "dmu"). collector_number: as Scryfall writes it, no leading zeros. language: Scryfall code: en, de, fr, it, es, pt, ja, ko, ru, zhs, zht, ph (cards print "JP" for Japanese -> "ja", "SP" for Spanish -> "es", "CS"/"CT" -> "zhs"/"zht", "KR" -> "ko").
- NEVER fill collector_number, set_code or english_name from memory or knowledge of a set: only report what you can actually read on this card (or, for english_name, translate a name you read). If the number or set code is not legible, use null and say so in notes. A wrong value is far worse than null.
- foil_indicator: "star" or "dot" only if you actually read that glyph between set code and language code; "none" if the card has no such line; "unknown" if unreadable. Never guess foil from shine.
- Do not invent values: use null for anything you cannot read, and lower confidence. confidence = your probability that set_code+collector_number+language are all correct.`;

const VISION_TIMEOUT_MS = Number(process.env.CLAUDE_SCAN_TIMEOUT_MS) || 90 * 1000;
const VISION_MAX_BUDGET = process.env.CLAUDE_SCAN_MAX_BUDGET_USD || "0.25";
let visionDir = null;

function prepareVisionDir() {
  if (visionDir) return visionDir;
  visionDir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-vision-"));
  writeFileSync(path.join(visionDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  return visionDir;
}

/** First JSON object in a model reply (tolerates code fences and stray prose). */
export function parseJsonReply(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/```(?:json)?/gi, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Sliding-window hourly cap. limit 0 disables the feature; take() records a
 * call and returns false when the window is full. The window lives in memory;
 * restore()/persistWith() let the caller keep it across restarts.
 */
export function createHourlyCap(limit, windowMs = 60 * 60 * 1000, now = () => Date.now()) {
  const stamps = [];
  let save = null;
  const prune = () => { const t = now() - windowMs; while (stamps.length && stamps[0] <= t) stamps.shift(); };
  const changed = () => { if (save) { try { save([...stamps]); } catch { /* best effort */ } } };
  return {
    limit,
    enabled: () => limit > 0,
    remaining() { prune(); return Math.max(0, limit - stamps.length); },
    available() { return this.remaining() > 0; },
    take() { if (!this.available()) return false; stamps.push(now()); changed(); return true; },
    release() { stamps.pop(); changed(); },
    /** Load call timestamps (ms) saved by an earlier process. */
    restore(list) {
      stamps.length = 0;
      for (const t of Array.isArray(list) ? list : []) if (Number.isFinite(t)) stamps.push(t);
      stamps.sort((a, b) => a - b);
      prune();
    },
    /** Call save(timestamps) after every change. */
    persistWith(fn) { save = typeof fn === "function" ? fn : null; },
    used() { prune(); return stamps.length; },
    resetsAt() { prune(); return stamps.length ? new Date(stamps[0] + windowMs).toISOString() : null; },
  };
}

// An empty value (SCAN_CLAUDE_PER_HOUR=) means "default", like the other blank .env entries.
const perHourRaw = process.env.SCAN_CLAUDE_PER_HOUR;
const perHour = perHourRaw == null || perHourRaw.trim() === "" ? 60 : Number(perHourRaw);
/** The scanner's vision-call cap (env SCAN_CLAUDE_PER_HOUR, default 60, 0 = off). */
export const visionCap = createHourlyCap(Number.isFinite(perHour) && perHour >= 0 ? Math.floor(perHour) : 60);

/**
 * Identify a card from images with Claude vision. Shares the MAX_CONCURRENT
 * gate with chat turns (returns {error, busy:true} instead of queueing).
 * Resolves (never rejects) with { text, json, costUsd, error }.
 * @param {{images: {media_type: string, data: string}[], prompt?: string, signal?: AbortSignal, timeoutMs?: number}} opts
 */
export async function runVision({ images = [], prompt = "Identify the card.", signal, timeoutMs = VISION_TIMEOUT_MS } = {}) {
  if (!claudeConfigured()) return { text: "", json: null, costUsd: null, error: "Claude is not configured" };
  if (!images.length) return { text: "", json: null, costUsd: null, error: "No image" };
  if (activeTurns + activeVision >= MAX_CONCURRENT) {
    return { text: "", json: null, costUsd: null, error: "Claude is busy", busy: true };
  }
  activeVision++;
  try {
    return await visionOnce({ images, prompt, signal, timeoutMs });
  } finally {
    activeVision--;
  }
}

function visionOnce({ images, prompt, signal, timeoutMs }) {
  return new Promise((resolve) => {
    const dir = prepareVisionDir();
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--model", process.env.CLAUDE_SCAN_MODEL || "sonnet",
      "--tools", "",
      "--mcp-config", path.join(dir, "mcp.json"),
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--setting-sources", "",
      "--max-budget-usd", VISION_MAX_BUDGET,
      "--system-prompt", SCAN_PROMPT,
    ];
    const content = [];
    images.forEach((img) => content.push({ type: "image", source: { type: "base64", media_type: img.media_type || "image/jpeg", data: img.data } }));
    content.push({ type: "text", text: prompt });
    const input = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";

    const bin = spawnableBin();
    if (!bin) { resolve({ text: "", json: null, costUsd: null, error: cliMissingError() }); return; }
    const env = { ...process.env };
    env.DISABLE_AUTOUPDATER ??= "1";
    let child;
    try {
      child = spawn(bin, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ text: "", json: null, costUsd: null, error: `Could not start Claude CLI: ${err.message}` });
      return;
    }
    children.add(child);
    let buffer = "";
    let stderr = "";
    let result = null;
    let lastText = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const processLine = (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.type === "result") result = msg;
      else if (msg?.type === "assistant" && !msg.error) {
        const t = (msg.message?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
        if (t) lastText = t;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) { processLine(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);

    const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
    timer.unref();
    const onAbort = () => { aborted = true; terminate(child); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      children.delete(child);
      if (buffer) { processLine(buffer); buffer = ""; }
      const text = typeof result?.result === "string" && result.result ? result.result : lastText;
      const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null;
      let error = null;
      if (spawnError) error = spawnError.code === "ENOENT" ? cliMissingError(bin) : `Could not start Claude CLI: ${spawnError.message}`;
      else if (aborted) error = "Cancelled";
      else if (timedOut) error = `Claude timed out after ${Math.round(timeoutMs / 1000)} s`;
      else if (result?.is_error) error = friendlyError(typeof result.result === "string" && result.result ? result.result : [result.subtype || "error", stderr].filter(Boolean).join(": "));
      else if (!result) error = friendlyError(stderr || `Claude exited with code ${code}`);
      const json = error ? null : parseJsonReply(text);
      if (!error && !json) error = "Claude did not answer with JSON";
      resolve({ text, json, costUsd, error });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code, null));
  });
}
