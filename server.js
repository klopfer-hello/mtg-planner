// mtg-planner web server: JSON API, ManaBox CSV import, decks, Claude chat
// (Server-Sent Events) and the static single-page app. Node stdlib only.
//
// Unauthenticated by design: meant for a trusted LAN (see README "Security").

import http from "node:http";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { cardPrice, openDb, stats } from "./lib/db.js";
import { QUERY_HELP, searchCollection } from "./lib/query.js";
import { importManaBoxCsv, refreshOwnedCards } from "./lib/manabox.js";
import { deckDetail, exportDeck, listDecks, parseDecklist, saveDeck } from "./lib/decks.js";
import { MAX_CONCURRENT, claudeConfigured, killAll, prepareMcpConfig, runTurn } from "./lib/claude.js";

const PORT = Number(process.env.PORT) || 8080;
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || "/app/public");
const VERSION = process.env.APP_VERSION || "dev";
const JSON_LIMIT = 1024 * 1024;
const CSV_LIMIT = 25 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 20000;

const db = openDb();

// ---------------------------------------------------------------------------
// HTTP helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' cdnjs.cloudflare.com 'unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "font-src fonts.gstatic.com",
    "img-src 'self' data: https://cards.scryfall.io https://svgs.scryfall.io",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

function sendEmpty(res, status = 204) {
  res.writeHead(status);
  res.end();
}

/** Read the request body as a Buffer, rejecting with 413 above `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, `Request body too large (max ${Math.round(limit / 1024 / 1024)} MB)`));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, `Request body too large (max ${Math.round(limit / 1024 / 1024)} MB)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", (err) => { if (!failed) { failed = true; reject(err); } });
  });
}

async function readJson(req) {
  requireContentType(req, "application/json");
  const buf = await readBody(req, JSON_LIMIT);
  if (buf.length === 0) return {};
  let body;
  try { body = JSON.parse(buf.toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "JSON body must be an object");
  return body;
}

const optString = (v, field, max = 2000) => {
  if (v == null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return s;
};

const parseJsonField = (s, fallback) => {
  if (s == null || s === "") return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// ---------------------------------------------------------------------------
// Collection & cards

function collectionRows(query) {
  const group = query.get("group") === "printing" ? "printing" : "card";
  const limit = Math.min(Math.max(parseInt(query.get("limit"), 10) || 60, 1), 500);
  const offset = Math.max(parseInt(query.get("offset"), 10) || 0, 0);
  const dir = query.get("dir") === "asc" || query.get("dir") === "desc" ? query.get("dir") : undefined;
  let result;
  try {
    result = searchCollection(db, { q: query.get("q") || "", group, sort: query.get("sort") || "name", dir, limit, offset });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  for (const row of result.rows) {
    row.prices = parseJsonField(row.prices, {});
    // Price of the row's representative (most valuable) owned printing+finish.
    row.price = cardPrice(row, row.finish || "normal");
  }
  return result;
}

function cardDetail(id) {
  const card = db.prepare("SELECT * FROM cards WHERE scryfall_id = ?").get(id);
  if (!card) throw new HttpError(404, "Card not found");
  card.prices = parseJsonField(card.prices, {});
  card.legalities = parseJsonField(card.legalities, {});
  card.keywords = parseJsonField(card.keywords, []);
  card.price = cardPrice(card);
  const owned = db.prepare(
    `SELECT c.scryfall_id, c.set_code, c.set_name, c.collector_number, col.finish, col.language,
            col.condition, col.binder, col.quantity, c.image_small
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id = ?
      ORDER BY c.set_code, c.collector_number, col.finish`,
  ).all(card.oracle_id);
  const decks = db.prepare(
    `SELECT d.id, d.name, dc.board, SUM(dc.quantity) AS quantity
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
       LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE c.oracle_id = ? OR (dc.scryfall_id IS NULL AND dc.name = ? COLLATE NOCASE)
      GROUP BY d.id, dc.board
      ORDER BY d.updated_at DESC`,
  ).all(card.oracle_id, card.name);
  return { card, owned, decks };
}

// ---------------------------------------------------------------------------
// Imports (one at a time: they hit Scryfall and rewrite the collection)

let importBusy = false;

async function exclusive(fn) {
  if (importBusy) throw new HttpError(409, "Another import or price refresh is running");
  importBusy = true;
  try { return await fn(); } finally { importBusy = false; }
}

/**
 * Scryfall outages/network errors become 502; a Scryfall 4xx (it rejected
 * something from the user's file) and everything else (bad CSV) become 400.
 */
function importError(err) {
  if (err instanceof HttpError) return err;
  if (err.status >= 400 && err.status < 500 && err.status !== 429) return new HttpError(400, `Scryfall rejected the request: ${err.message}`);
  // scryfall() sets err.status; fetch() network failures are TypeErrors with a cause.
  if (err.status || (err instanceof TypeError && err.cause)) return new HttpError(502, `Scryfall request failed: ${err.message}`);
  return new HttpError(400, err.message);
}

// ---------------------------------------------------------------------------
// Decks

function getDeckOr404(id) {
  const detail = deckDetail(db, id);
  if (!detail) throw new HttpError(404, "Deck not found");
  for (const c of detail.cards) c.prices = parseJsonField(c.prices, null);
  return detail;
}

async function createDeck(req) {
  const body = await readJson(req);
  const name = optString(body.name, "name", 200);
  if (!name) throw new HttpError(400, "name is required");
  const text = optString(body.text, "text", 200000) || "";
  const { items, errors } = parseDecklist(text);
  if (items.length === 0) throw new HttpError(400, errors.length ? `No cards recognised (e.g. "${errors[0]}")` : "The decklist is empty");
  let saved;
  try {
    saved = await saveDeck(db, {
      name,
      format: optString(body.format, "format", 50) || null,
      description: optString(body.description, "description", 5000) || null,
      source: "manual",
      items,
    });
  } catch (err) {
    throw importError(err);
  }
  return { id: saved.id, unresolved: saved.unresolved, parse_errors: errors };
}

async function patchDeck(req, id) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
  if (!deck) throw new HttpError(404, "Deck not found");
  const body = await readJson(req);
  const name = body.name === undefined ? deck.name : optString(body.name, "name", 200);
  if (!name) throw new HttpError(400, "name must not be empty");
  const format = body.format === undefined ? deck.format : optString(body.format, "format", 50) || null;
  const description = body.description === undefined ? deck.description : optString(body.description, "description", 5000) || null;
  db.prepare("UPDATE decks SET name = ?, format = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, format, description, id);
  return db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
}

function exportFilename(name) {
  const ascii = name.replace(/[^\w .()-]+/g, "_").trim() || "deck";
  return `attachment; filename="${ascii}.txt"; filename*=UTF-8''${encodeURIComponent(name)}.txt`;
}

// ---------------------------------------------------------------------------
// Chats

/** chatId → AbortController of the running Claude turn. */
const runs = new Map();

function messageRow(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    tools: parseJsonField(m.tools, []),
    cost_usd: m.cost_usd,
    created_at: m.created_at,
  };
}

function getChatOr404(id) {
  const chat = db.prepare("SELECT id, title, session_id, created_at, updated_at FROM chats WHERE id = ?").get(id);
  if (!chat) throw new HttpError(404, "Chat not found");
  return chat;
}

function recapOf(chatId, beforeId) {
  const rows = db.prepare("SELECT role, content FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT 6")
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
  if (runs.size >= MAX_CONCURRENT) throw new HttpError(429, `Too many Claude runs in progress (max ${MAX_CONCURRENT}); try again shortly`);

  const controller = new AbortController();
  runs.set(chatId, controller);

  let userMsgId;
  try {
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

  // The run is not tied to the HTTP response: it finishes and is stored even
  // if the browser goes away.
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
  }

  try {
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

// ---------------------------------------------------------------------------
// Cross-site request guard
//
// No auth (LAN-only), but any web page open in a LAN browser could still fire
// "simple" cross-origin POSTs (text/plain, no preflight) at the API, e.g. a
// replace import that wipes the collection. Reject state-changing requests
// that a browser marks as cross-site, and require the content types the SPA
// sends so a cross-origin request would always need a (failing) preflight.

function checkSameOrigin(req) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Cross-site request refused");
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) throw new HttpError(403, "Cross-origin request refused");
  } else if (origin === "null") throw new HttpError(403, "Cross-origin request refused");
}

/** Body content type must be one of `types` (only checked when there is a body). */
function requireContentType(req, ...types) {
  const hasBody = Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"];
  if (!hasBody) return;
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!types.includes(type)) throw new HttpError(415, `Content-Type must be ${types.join(" or ")}`);
}

// ---------------------------------------------------------------------------
// Routing

async function handleApi(req, res, url) {
  const { pathname, searchParams: query } = url;
  const method = req.method;
  let m;
  checkSameOrigin(req);

  if (pathname === "/api/stats" && method === "GET") return sendJson(res, 200, stats(db));
  if (pathname === "/api/query-help" && method === "GET") return sendJson(res, 200, { help: QUERY_HELP });
  if (pathname === "/api/collection" && method === "GET") return sendJson(res, 200, collectionRows(query));
  if ((m = /^\/api\/cards\/([0-9a-f-]{36})$/i.exec(pathname)) && method === "GET") {
    return sendJson(res, 200, cardDetail(m[1].toLowerCase()));
  }
  if (pathname.startsWith("/api/cards/") && method === "GET") throw new HttpError(404, "Card not found");

  if (pathname === "/api/import/manabox" && method === "POST") {
    const mode = query.get("mode") || "replace";
    if (mode !== "replace" && mode !== "add") throw new HttpError(400, 'mode must be "replace" or "add"');
    const filename = (query.get("filename") || "").slice(0, 255) || null;
    // text/csv is not a CORS-safelisted type; text/plain is accepted only with
    // the SPA's X-Requested-With header (which also forces a preflight).
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!(type === "text/csv" || (type === "text/plain" && req.headers["x-requested-with"]))) {
      throw new HttpError(415, "Content-Type must be text/csv");
    }
    const buf = await readBody(req, CSV_LIMIT);
    const text = buf.toString("utf8");
    if (!text.trim()) throw new HttpError(400, "The CSV file is empty.");
    const summary = await exclusive(() => importManaBoxCsv(db, text, { mode, filename }).catch((err) => { throw importError(err); }));
    return sendJson(res, 200, summary);
  }
  if (pathname === "/api/refresh-prices" && method === "POST") {
    const result = await exclusive(() => refreshOwnedCards(db).catch((err) => { throw importError(err); }));
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/imports" && method === "GET") {
    const rows = db.prepare("SELECT id, kind, filename, mode, summary, created_at FROM imports ORDER BY id DESC LIMIT 20").all();
    return sendJson(res, 200, rows.map((r) => ({ ...r, summary: parseJsonField(r.summary, {}) })));
  }

  if (pathname === "/api/decks") {
    if (method === "GET") return sendJson(res, 200, listDecks(db));
    if (method === "POST") return sendJson(res, 201, await createDeck(req));
  }
  if ((m = /^\/api\/decks\/(\d+)(\/export)?$/.exec(pathname))) {
    const id = Number(m[1]);
    if (m[2]) {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const detail = getDeckOr404(id);
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": exportFilename(detail.name),
        "Cache-Control": "no-store",
      });
      return res.end(exportDeck(detail));
    }
    if (method === "GET") return sendJson(res, 200, getDeckOr404(id));
    if (method === "PATCH") return sendJson(res, 200, await patchDeck(req, id));
    if (method === "DELETE") {
      const info = db.prepare("DELETE FROM decks WHERE id = ?").run(id);
      if (!info.changes) throw new HttpError(404, "Deck not found");
      return sendEmpty(res);
    }
  }

  if (pathname === "/api/chats") {
    if (method === "GET") {
      return sendJson(res, 200, db.prepare("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC, created_at DESC, rowid DESC").all());
    }
    if (method === "POST") {
      const body = await readJson(req);
      const title = optString(body.title, "title", 200) || "New chat";
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO chats (id, title) VALUES (?, ?)").run(id, title);
      return sendJson(res, 201, db.prepare("SELECT id, title, created_at, updated_at FROM chats WHERE id = ?").get(id));
    }
  }
  if ((m = /^\/api\/chats\/([0-9a-f-]{36})(\/messages)?$/i.exec(pathname))) {
    const id = m[1].toLowerCase();
    if (m[2]) {
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      return postMessage(req, res, id);
    }
    if (method === "GET") {
      const chat = getChatOr404(id);
      const messages = db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id").all(id).map(messageRow);
      const { session_id, ...publicChat } = chat;
      return sendJson(res, 200, { chat: publicChat, messages, busy: runs.has(id) });
    }
    if (method === "DELETE") {
      runs.get(id)?.abort();
      const info = db.prepare("DELETE FROM chats WHERE id = ?").run(id);
      if (!info.changes) throw new HttpError(404, "Chat not found");
      return sendEmpty(res);
    }
  }
  if (pathname.startsWith("/api/chats/")) throw new HttpError(404, "Chat not found");

  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
// Static files

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

async function fileInfo(file) {
  try {
    const s = await stat(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, "Bad path"); }
  if (rel.includes("\0")) throw new HttpError(400, "Bad path");
  if (rel.endsWith("/")) rel += "index.html";
  let file = path.join(STATIC_DIR, path.normalize(rel));
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) throw new HttpError(404, "Not found");

  let info = await fileInfo(file);
  if (!info) {
    // SPA fallback for route-like paths; missing assets stay 404.
    if (path.extname(rel) && path.extname(rel) !== ".html") throw new HttpError(404, "Not found");
    file = path.join(STATIC_DIR, "index.html");
    info = await fileInfo(file);
    if (!info) throw new HttpError(404, "Not found");
  }

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Server

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.on("close", () => {
    const aborted = res.writableFinished ? "" : " (client closed)";
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms${aborted}`);
  });

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "Bad request URL" });
  }

  try {
    if (url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, version: VERSION, claude_configured: claudeConfigured() });
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(`[error] ${req.method} ${req.url}:`, err);
    else if (status >= 500) console.warn(`[warn] ${req.method} ${req.url}: ${err.message}`);
    if (res.headersSent) {
      // e.g. an SSE stream already started: report in-band and close.
      try { if (!res.writableEnded) res.end(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`); } catch { /* ignore */ }
      return;
    }
    // Drain any unread body so the connection can be reused.
    req.resume();
    sendJson(res, status, { error: status === 500 ? `Internal error: ${err.message}` : err.message });
  }
});

server.requestTimeout = 0; // SSE turns and large imports can take minutes
server.headersTimeout = 60000;
server.keepAliveTimeout = 5000;

prepareMcpConfig();
server.listen(PORT, () => {
  console.log(`mtg-planner ${VERSION} listening on :${PORT} (static: ${STATIC_DIR}, claude: ${claudeConfigured() ? "configured" : "not configured"})`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  for (const controller of runs.values()) controller.abort();
  killAll();
  // Give aborted runs a moment to store their partial answers, then close.
  const deadline = Date.now() + 8000;
  const timer = setInterval(() => {
    if (runs.size === 0 || Date.now() > deadline) {
      clearInterval(timer);
      server.closeAllConnections();
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    }
  }, 100);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
