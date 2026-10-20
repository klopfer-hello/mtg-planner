// HTTP helpers shared by the server and its route modules: errors with a
// status, JSON/text/file responses, bounded body reading and the cross-site
// guard. Node stdlib only; nothing here knows about the app's data.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/** An error with an HTTP status; `extra` adds JSON fields to the error body (e.g. {code}). */
export class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const JSON_LIMIT = 1024 * 1024;

export const SECURITY_HEADERS = {
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

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

export function sendEmpty(res, status = 204) {
  res.writeHead(status);
  res.end();
}

/** Content-Disposition for a download named `name`.`ext` (ASCII fallback + RFC 5987 UTF-8 name). */
export function attachment(name, ext, fallback = "download") {
  const ascii = name.replace(/[^\w .()-]+/g, "_").trim() || fallback;
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}.${ext}`;
}

/** Send a text list as a .txt download (deck exports, wishlist, To buy lists). */
export function sendTextFile(res, name, text) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": attachment(name, "txt", "deck"), "Cache-Control": "no-store" });
  return res.end(text);
}

/** Stream a file with its Content-Length plus `headers`; HEAD sends the headers only. A missing file throws stat's error. */
export async function sendFile(req, res, file, headers) {
  const info = await stat(file);
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  return stream.pipe(res);
}

/** "16 KB" / "12 MB" for a byte limit (413 messages). */
const sizeLabel = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${Math.round(n / 1024 / 1024)} MB`);

/** Read the request body as a Buffer, rejecting with 413 above `limit` bytes. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, `Request body too large (max ${sizeLabel(limit)})`));
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
        reject(new HttpError(413, `Request body too large (max ${sizeLabel(limit)})`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", (err) => { if (!failed) { failed = true; reject(err); } });
  });
}

/** The JSON object body (empty body = {}); 415 for another content type, 400 for anything but an object. */
export async function readJson(req, limit = JSON_LIMIT) {
  requireContentType(req, "application/json");
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  let body;
  try { body = JSON.parse(buf.toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "JSON body must be an object");
  return body;
}

/** The request's media type, lowercase, without parameters ('' when none). */
export const contentType = (req) => String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();

/** Body content type must be one of `types` (only checked when there is a body). */
export function requireContentType(req, ...types) {
  const hasBody = Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"];
  if (!hasBody) return;
  if (!types.includes(contentType(req))) throw new HttpError(415, `Content-Type must be ${types.join(" or ")}`);
}

/** Optional trimmed string field: null when absent, 400 when not a string or longer than `max`. */
export const optString = (v, field, max = 2000) => {
  if (v == null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return s;
};

/** JSON text column → value, `fallback` when empty or broken. */
export const parseJsonField = (s, fallback) => {
  if (s == null || s === "") return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

/** decodeURIComponent of a path parameter; 400 with `message` when it is malformed. */
export function decodeParam(raw, message) {
  try { return decodeURIComponent(raw); } catch { throw new HttpError(400, message); }
}

// Cross-site request guard
//
// No auth (LAN-only), but any web page open in a LAN browser could still fire
// "simple" cross-origin POSTs (text/plain, no preflight) at the API, e.g. a
// replace import that wipes the collection. Reject state-changing requests
// that a browser marks as cross-site; readJson/requireContentType demand the
// content types the SPA sends, so a cross-origin request always needs a
// (failing) preflight.

export function checkSameOrigin(req) {
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
