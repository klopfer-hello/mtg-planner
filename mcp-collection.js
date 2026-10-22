#!/usr/bin/env node
// "collection" MCP server: gives the Claude CLI read access to the owned
// collection and decks (incl. what built decks claim: owned vs free copies,
// conflicts, shopping list), plus three write tools: save_deck (decks the user then
// sees in the app), update_deck_notes (a deck's Markdown notes only) and edit_copies (fix language / printing / finish / condition
// of owned copies; lib/edits.js, actor 'claude', logged and undoable in the app),
// plus list_wishlist / add_to_wishlist (lib/wishlist.js; Claude may add, never remove).
// evaluate_deck is a dry run: stats, Commander bracket and 1-10 score of a draft
// list (lib/power.js) without saving it. Its combo check (Commander Spellbook,
// lib/spellbook.js) uses this process's own DB connection but the server's
// settings, rate slots and backoff from the shared meta table, so turning it off
// in the app (or SPELLBOOK_ENABLED=false) also stops it here.
// No delete, backup or restore tools by design: deleting is app-only. Spawned by
// the CLI per chat turn via --mcp-config.
//
// Protocol: MCP over stdio, hand-rolled (no SDK) — newline-delimited JSON-RPC
// 2.0 on stdin/stdout. stdout carries protocol messages ONLY; logs go to stderr.
// Requests are handled concurrently (save_deck may wait on Scryfall) and every
// response carries the id of its request, so out-of-order replies are fine.
//
// Layout: this file = the JSON-RPC loop; mcp/context.js = DB, card index and
// combo checks; mcp/format.js = shared text helpers; mcp/tools/*.js = the tool
// definitions with their handlers.

import { createInterface } from "node:readline";
import { VERSION, closeAll, log } from "./mcp/context.js";
import { ToolError } from "./mcp/format.js";
import { TOOLS as COLLECTION_TOOLS } from "./mcp/tools/collection.js";
import { TOOLS as DECK_TOOLS } from "./mcp/tools/decks.js";
import { TOOLS as EDIT_TOOLS } from "./mcp/tools/edits.js";
import { TOOLS as WISHLIST_TOOLS } from "./mcp/tools/wishlist.js";
import { TOOLS as KNOWLEDGE_TOOLS } from "./mcp/tools/knowledge.js";

const DEFAULT_PROTOCOL = "2025-06-18";

// The tools in the order tools/list shows them (mcp/tools/*.js).
const TOOLS = [...COLLECTION_TOOLS, ...DECK_TOOLS, ...KNOWLEDGE_TOOLS, ...EDIT_TOOLS, ...WISHLIST_TOOLS];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC plumbing

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(params) {
  const tool = TOOL_BY_NAME.get(params?.name);
  if (!tool) return { protocolError: [-32602, `Unknown tool: ${params?.name}`] };
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  const started = Date.now();
  try {
    const text = await tool.run(args);
    log(`${tool.name} ok in ${Date.now() - started} ms`);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    log(`${tool.name} failed:`, err instanceof ToolError ? err.message : err);
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

/** Handle one JSON-RPC message; resolves to a response object or null (notifications/responses). */
async function handle(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
    return fail(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== "string") {
    // A response to a server->client request (we never send any) — ignore.
    return "result" in msg || "error" in msg ? null : fail(id ?? null, -32600, "Invalid Request");
  }
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "mtg-collection", version: VERSION },
        instructions:
          "Read access to the user's Magic: The Gathering collection (synced from ManaBox) and decks, plus save_deck " +
          "to hand decks over to the app and edit_copies to correct owned copies (state the exact change first, ask when " +
          "unclear; no deleting, that is app-only). Check ownership with check_owned / search_collection and read the cards with get_cards before recommending them; " +
          "built decks claim their cards and locked binders (deck boxes, precons, binders the user locked) keep theirs, so 'free' " +
          "copies (avail) are what is left for new decks; claimed or locked copies are still owned (in use in another deck or " +
          "locked binder, can be " +
          "moved), not purchases.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const result = await callTool(params);
      return result.protocolError ? fail(id, ...result.protocolError) : reply(id, result);
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send(fail(null, -32700, "Parse error"));
    return;
  }
  try {
    if (Array.isArray(msg)) {
      if (!msg.length) { send(fail(null, -32600, "Invalid Request")); return; }
      // One failing message answers for itself; the rest of the batch still gets its replies.
      const one = (m) => handle(m).catch((err) => {
        log("internal error:", err);
        return m && typeof m === "object" && m.id != null ? fail(m.id, -32603, `Internal error: ${err.message}`) : null;
      });
      const out = (await Promise.all(msg.map(one))).filter(Boolean);
      if (out.length) send(out);
    } else {
      const out = await handle(msg);
      if (out) send(out);
    }
  } catch (err) {
    log("internal error:", err);
    if (msg && !Array.isArray(msg) && msg.id != null) send(fail(msg.id, -32603, `Internal error: ${err.message}`));
  }
}

const pending = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  // Don't await: a slow save_deck must not hold up other requests.
  const p = handleLine(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on("close", async () => {
  // stdin closed: finish in-flight calls, then exit.
  await Promise.allSettled([...pending]);
  closeAll();
  process.exit(0);
});
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
log(`started (version ${VERSION}, db ${process.env.DB_FILE || "/data/mtg-planner.db"})`);
