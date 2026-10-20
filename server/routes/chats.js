// Planner chats: list/create/read/delete, and one Claude turn per message
// streamed as Server-Sent Events (start, text, tool, done, error). A turn is
// not tied to the HTTP response: it finishes and is stored even if the
// browser goes away.

import crypto from "node:crypto";

import { claudeConfigured, MAX_CONCURRENT, runTurn } from "../../lib/claude.js";
import { HttpError, optString, parseJsonField, readJson, sendEmpty, sendJson } from "../http.js";

const MAX_MESSAGE_CHARS = 20000;
const UUID = ":id([0-9a-fA-F-]{36})";

function messageRow(m) {
  return { id: m.id, role: m.role, content: m.content, tools: parseJsonField(m.tools, []), cost_usd: m.cost_usd, created_at: m.created_at };
}

export function chatRoutes(router, app) {
  const { runs } = app;

  function getChatOr404(id) {
    const chat = app.db.prepare("SELECT id, title, session_id, created_at, updated_at FROM chats WHERE id = ?").get(id);
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  }

  /** The last few messages before `beforeId`, for a turn that resumes a CLI session. */
  function recapOf(chatId, beforeId) {
    const rows = app.db.prepare("SELECT role, content FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT 6")
      .all(chatId, beforeId).reverse();
    return rows.map((m) => {
      const text = m.content.length > 800 ? m.content.slice(0, 800) + " […]" : m.content;
      return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
    }).join("\n\n");
  }

  async function postMessage(req, res, chatId) {
    const chat = getChatOr404(chatId);
    const body = await readJson(req);
    const text = optString(body.text, "text", MAX_MESSAGE_CHARS);
    if (!text) throw new HttpError(400, "text is required");
    if (!claudeConfigured()) throw new HttpError(503, "Claude is not configured: set CLAUDE_CODE_OAUTH_TOKEN");
    if (runs.has(chatId)) throw new HttpError(409, "This chat is already answering; wait for it to finish");
    if (app.claudeBusy()) throw new HttpError(429, `Too many Claude runs in progress (max ${MAX_CONCURRENT}); try again shortly`);

    const controller = new AbortController();
    runs.set(chatId, controller);
    const turnStart = app.sqlNow(); // decks Claude saves in this turn get their combos checked afterwards

    let userMsgId;
    try {
      const db = app.db;
      const isFirst = !db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' LIMIT 1").get(chatId);
      userMsgId = Number(db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', ?)").run(chatId, text).lastInsertRowid);
      const title = isFirst ? text.replace(/\s+/g, " ").slice(0, 60) : chat.title;
      db.prepare("UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, chatId);
    } catch (err) {
      runs.delete(chatId);
      throw err;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    let open = true;
    res.on("close", () => { open = false; });
    const send = (ev) => {
      if (open && !res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    // Comment line every 15 s keeps proxies from closing a quiet stream.
    const keepAlive = setInterval(() => { if (open) res.write(": ping\n\n"); }, 15000);
    send({ type: "start" });

    let result;
    try {
      result = await runTurn({
        prompt: text,
        sessionId: chat.session_id,
        recap: chat.session_id ? recapOf(chatId, userMsgId) : "",
        onEvent: send,
        signal: controller.signal,
      });
    } catch (err) {
      result = { text: "", tools: [], costUsd: null, sessionId: null, isError: true, error: err.message };
    } finally {
      runs.delete(chatId);
      clearInterval(keepAlive);
      app.background.scheduleEnglishPrices();
      app.scheduleChangedDecks(turnStart);
    }

    try {
      const db = app.db;
      if (!db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId)) {
        send({ type: "error", error: "Chat was deleted" });
      } else {
        let content = result.text || "";
        if (result.isError) content = `${content}${content ? "\n\n" : ""}**Error:** ${result.error}`;
        const info = db.prepare("INSERT INTO messages (chat_id, role, content, tools, cost_usd) VALUES (?, 'assistant', ?, ?, ?)")
          .run(chatId, content, JSON.stringify(result.tools || []), result.costUsd ?? null);
        db.prepare("UPDATE chats SET session_id = COALESCE(?, session_id), updated_at = datetime('now') WHERE id = ?")
          // A turn that failed before producing anything (auth error, ...) leaves
          // no useful session behind; keep resuming the previous one instead. One
          // that ran tools (timeout, cancel) did real work worth resuming.
          .run(result.isError && !result.text && !(result.tools || []).length ? null : result.sessionId || null, chatId);
        const stored = messageRow(db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(info.lastInsertRowid)));
        if (result.isError) send({ type: "error", error: result.error });
        else send({ type: "done", message: stored });
      }
    } catch (err) {
      console.error("[chat] storing the answer failed:", err);
      send({ type: "error", error: `Could not store the answer: ${err.message}` });
    }
    if (open) res.end();
  }

  router.get("/api/chats", () =>
    app.db.prepare("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC, created_at DESC, rowid DESC").all());
  router.post("/api/chats", async ({ req, res }) => {
    const body = await readJson(req);
    const title = optString(body.title, "title", 200) || "New chat";
    const id = crypto.randomUUID();
    app.db.prepare("INSERT INTO chats (id, title) VALUES (?, ?)").run(id, title);
    sendJson(res, 201, app.db.prepare("SELECT id, title, created_at, updated_at FROM chats WHERE id = ?").get(id));
  });
  router.post(`/api/chats/${UUID}/messages`, ({ req, res, params }) => postMessage(req, res, params.id.toLowerCase()));
  router.get(`/api/chats/${UUID}`, ({ params }) => {
    const id = params.id.toLowerCase();
    const { session_id: _s, ...chat } = getChatOr404(id);
    const messages = app.db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id").all(id).map(messageRow);
    return { chat, messages, busy: runs.has(id) };
  });
  router.delete(`/api/chats/${UUID}`, ({ res, params }) => {
    const id = params.id.toLowerCase();
    runs.get(id)?.abort();
    const info = app.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    if (!info.changes) throw new HttpError(404, "Chat not found");
    sendEmpty(res);
  });
  router.notFound("/api/chats/:rest(.*)", "Chat not found");
}
