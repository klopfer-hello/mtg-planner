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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_FILE = path.resolve(process.env.DB_FILE || "/data/mtg-planner.db");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 10 * 60 * 1000;
const WORKDIR = process.env.CLAUDE_WORKDIR || path.join(path.dirname(DB_FILE), "workspace");
const SCRYFALL_MCP_ENTRY = process.env.SCRYFALL_MCP_ENTRY || "/opt/scryfall-mcp/dist/index.js";
const STDERR_TAIL = 4000;

export const MAX_CONCURRENT = Math.max(1, Number(process.env.CLAUDE_MAX_CONCURRENT) || 2);

export const PLANNER_PROMPT = `You are an expert Magic: The Gathering deck-building assistant inside "mtg-planner", a planner for the user's OWN card collection. The user maintains the collection in the ManaBox app; it is synced into this app's database.

Tools:
- mcp__collection__* : what the user owns and their saved decks. collection_overview, search_collection (Scryfall-like query syntax), check_owned (batch ownership check by name), get_card, list_decks, get_deck, save_deck.
- mcp__scryfall__* : every Magic card ever printed, current prices, comprehensive rules, synergy and staple searches, alternatives, deck/mana-base analysis.

Rules:
- Always check ownership (check_owned or search_collection) before recommending cards. Prefer cards the user already owns.
- When recommending, clearly separate "owned" from "to buy" and give prices for the cards to buy (and a total).
- Build decks that are legal in the requested format. Commander: exactly 100 cards including the commander, singleton except basic lands, every card within the commander's color identity, commander legal.
- When the user asks to build, create, save or modify a deck, call save_deck (to modify an existing deck pass its deck_id) and then tell them it is saved in the Decks tab.
- Be concise. Use markdown lists and tables. Reply in the user's language.`;

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
// Running a turn

/**
 * Run one chat turn. onEvent receives {type:'text'|'tool', ...} as they stream.
 * `recap` (optional) is a short text summary of the earlier conversation, used
 * only when the stored session can no longer be resumed.
 * Resolves (never rejects) with { text, sessionId, costUsd, tools, isError, error }.
 */
export async function runTurn({ prompt, sessionId = null, onEvent = () => {}, recap = "", signal } = {}) {
  const first = await runOnce({ prompt, sessionId, onEvent, signal });
  if (first.sessionGone && sessionId && !signal?.aborted) {
    console.warn(`[claude] session ${sessionId} not found, starting a new one with a recap`);
    const recapped = recap
      ? `(The previous conversation could not be restored. Recap of the last messages:)\n${recap}\n\n(New message:)\n${prompt}`
      : prompt;
    return runOnce({ prompt: recapped, sessionId: null, onEvent, signal });
  }
  return first;
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

    mkdirSync(WORKDIR, { recursive: true });
    const env = { ...process.env };
    env.DISABLE_AUTOUPDATER ??= "1";

    // The prompt goes in on stdin: robust for long prompts and prompts that
    // start with "-", and it cannot be swallowed by a variadic option.
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve(fail(`Could not start Claude CLI (${CLAUDE_BIN}): ${err.message}`));
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
          ? `Claude CLI not found (CLAUDE_BIN=${CLAUDE_BIN})`
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
