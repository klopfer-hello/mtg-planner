// Static files of the single-page app (public/): path-traversal safe, weak
// ETags from size+mtime, and the SPA fallback (route-like paths get
// index.html, missing assets stay 404).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { HttpError } from "./http.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
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

/** A request handler serving `staticDir` (GET/HEAD only; the caller checks the method). */
export function createStaticHandler(staticDir) {
  return async function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, "Bad path"); }
    if (rel.includes("\0")) throw new HttpError(400, "Bad path");
    if (rel.endsWith("/")) rel += "index.html";
    let file = path.join(staticDir, path.normalize(rel));
    if (file !== staticDir && !file.startsWith(staticDir + path.sep)) throw new HttpError(404, "Not found");

    let info = await fileInfo(file);
    if (!info) {
      if (path.extname(rel) && path.extname(rel) !== ".html") throw new HttpError(404, "Not found");
      file = path.join(staticDir, "index.html");
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
  };
}
