// Planner chats: list/create/read/delete, and one Claude turn per message
// streamed as Server-Sent Events (start, text, tool, done, error). A turn is
// not tied to the HTTP response: it finishes and is stored even if the
// browser goes away. A deck chat (chats.deck_id, one per deck) is reopened by
// "Ask the planner" on that deck; a turn that starts a new CLI session gets the
// deck's current state (as get_deck shows it) in front of the message.
// Answers can be rated (PUT …/feedback); a while after the last rating the ratings are merged into the
// planner's lessons (lib/plannerlessons.js) in the background, never next to a running turn.

import crypto from "node:crypto";

import { claudeConfigured, MAX_CONCURRENT, runGuide, runTurn } from "../../lib/claude.js";
import { distillLessons, feedbackCounts, getLessons, lessonsText, rateMessage } from "../../lib/plannerlessons.js";
import { nowIso } from "../../lib/db.js";
import { getProfile, plannerModel, profileText } from "../../lib/plannerprofile.js";
import { deckDetail } from "../../lib/decks.js";
import { deckToText } from "../../lib/decktext.js";
import { HttpError, optString, parseJsonField, readJson, sendEmpty, sendJson } from "../http.js";

const MAX_MESSAGE_CHARS = 20000;
const UUID = ":id([0-9a-fA-F-]{36})";
const LESSONS_DELAY_MS = 20000; // after the last rating (several ratings in a row = one Claude call)
const LESSONS_RETRY_MS = 60000; // while a chat turn or another Claude run is busy

function messageRow(m) {
  return { id: m.id, role: m.role, content: m.content, tools: parseJsonField(m.tools, []), cost_usd: m.cost_usd, created_at: m.created_at,
    rating: m.rating ?? null, feedback_note: m.feedback_note ?? null };
}

export function chatRoutes(router, app) {
  const { runs, lessons } = app;

  /** Merge pending ratings into the lessons LESSONS_DELAY_MS after the last call (no-op without Claude). */
  function scheduleLessons(delay = LESSONS_DELAY_MS) {
    if (!claudeConfigured() || lessons.running) return;
    clearTimeout(lessons.timer);
    lessons.timer = setTimeout(runLessons, delay);
    lessons.timer.unref?.();
  }
  async function runLessons() {
    lessons.timer = null;
    if (runs.size || app.claudeBusy() || app.restoring) return scheduleLessons(LESSONS_RETRY_MS);
    if (!feedbackCounts(app.db).pending) return;
    lessons.running = true;
    try {
      const r = await distillLessons(app.db, runGuide);
      lessons.last_error = r.ok ? null : { at: nowIso(), error: r.error };
    } catch (err) {
      lessons.last_error = { at: nowIso(), error: err.message };
      console.warn(`[lessons] ${err.message}`);
    } finally {
      lessons.running = false;
    }
  }

  function getChatOr404(id) {
    const chat = app.db.prepare("SELECT id, title, deck_id, session_id, created_at, updated_at FROM chats WHERE id = ?").get(id);
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  }

  /** A deck chat's deck as Claude's get_deck shows it ("" once the deck is gone). */
  function deckContext(deckId) {
    const detail = deckDetail(app.db, deckId);
    return detail ? `(This chat is about the user's deck #${deckId}. Its current state; call get_deck again after changes:)\n${deckToText(detail)}` : "";
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
      const title = isFirst && !chat.deck_id ? text.replace(/\s+/g, " ").slice(0, 60) : chat.title;
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
      // Only a new session needs the deck: a resumed one has it (and get_deck) already. If the stored
      // session is gone, runTurn starts over with the recap, so the deck goes there too.
      const deck = chat.deck_id ? deckContext(chat.deck_id) : "";
      const recap = chat.session_id ? recapOf(chatId, userMsgId) : "";
      result = await runTurn({
        prompt: deck && !chat.session_id ? `${deck}\n\n(Message:)\n${text}` : text,
        sessionId: chat.session_id,
        recap: deck && recap ? `${deck}\n\n${recap}` : recap,
        onEvent: send,
        signal: controller.signal,
        profile: [profileText(getProfile(app.db)), lessonsText(getLessons(app.db))].filter(Boolean).join("\n\n"),
        model: plannerModel(app.db) || null,
      });
    } catch (err) {
      result = { text: "", tools: [], costUsd: null, sessionId: null, isError: true, error: err.message };
    } finally {
      runs.delete(chatId);
      clearInterval(keepAlive);
      app.background.scheduleEnglishPrices();
      app.scheduleChangedDecks(turnStart);
      if (feedbackCounts(app.db).pending) scheduleLessons(); // ratings that waited for this turn
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
    app.db.prepare("SELECT id, title, deck_id, created_at, updated_at FROM chats ORDER BY updated_at DESC, created_at DESC, rowid DESC").all());
  router.post("/api/chats", async ({ req, res }) => {
    const body = await readJson(req);
    const title = optString(body.title, "title", 200) || "New chat";
    const id = crypto.randomUUID();
    app.db.prepare("INSERT INTO chats (id, title) VALUES (?, ?)").run(id, title);
    sendJson(res, 201, app.db.prepare("SELECT id, title, deck_id, created_at, updated_at FROM chats WHERE id = ?").get(id));
  });
  // The deck's chat: the existing one (200, title follows a renamed deck) or a new empty one (201).
  router.post("/api/decks/:id(\\d+)/chat", ({ res, params }) => {
    const db = app.db;
    const deck = db.prepare("SELECT id, name FROM decks WHERE id = ?").get(Number(params.id));
    if (!deck) throw new HttpError(404, "Deck not found");
    const title = `Deck: ${deck.name}`.slice(0, 60);
    const row = () => db.prepare("SELECT id, title, deck_id, created_at, updated_at FROM chats WHERE deck_id = ?").get(deck.id);
    const found = row();
    if (found) {
      if (found.title !== title) db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, found.id);
      return { ...found, title };
    }
    db.prepare("INSERT INTO chats (id, title, deck_id) VALUES (?, ?, ?)").run(crypto.randomUUID(), title, deck.id);
    sendJson(res, 201, row());
  });
  router.post(`/api/chats/${UUID}/messages`, ({ req, res, params }) => postMessage(req, res, params.id.toLowerCase()));
  router.get(`/api/chats/${UUID}`, ({ params }) => {
    const id = params.id.toLowerCase();
    const { session_id: _s, ...chat } = getChatOr404(id);
    chat.deck = chat.deck_id ? app.db.prepare("SELECT id, name, format, status FROM decks WHERE id = ?").get(chat.deck_id) ?? null : null;
    const messages = app.db.prepare(`SELECT m.*, f.rating, f.note AS feedback_note FROM messages m
      LEFT JOIN planner_feedback f ON f.message_id = m.id WHERE m.chat_id = ? ORDER BY m.id`).all(id).map(messageRow);
    return { chat, messages, busy: runs.has(id) };
  });
  /** PUT /api/chats/:id/messages/:mid/feedback {rating: 1|-1|0, note?} → {rating, note}; 0 removes the rating. */
  router.put(`/api/chats/${UUID}/messages/:mid(\\d+)/feedback`, async ({ req, params }) => {
    const body = await readJson(req);
    const out = rateMessage(app.db, params.id.toLowerCase(), Number(params.mid), { rating: body.rating, note: body.note });
    if (out.rating) scheduleLessons();
    return out;
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
