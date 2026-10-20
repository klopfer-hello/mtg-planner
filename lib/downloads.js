// Phone app downloads (GET /api/downloads, /api/downloads/:name).
//
// Why it exists: getting an Android APK onto a phone is easiest from the app
// itself: open Settings on the phone, tap Download, install. The server only
// offers files the owner put into DOWNLOAD_DIR (default <db dir>/downloads);
// nothing is uploaded through the API. Only plain `.apk` file names are
// listed or served. An optional sidecar `<name>.json` {title, version, notes}
// adds a label. The SHA-256 is shown so a download can be checked; it is
// cached per (name, size, mtime) because an APK is tens of MB.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { StatusError } from "./errors.js";

export const DOWNLOAD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.apk$/;
export const APK_TYPE = "application/vnd.android.package-archive";

/** DOWNLOAD_DIR (default <db dir>/downloads). */
export const defaultDownloadDir = () =>
  path.resolve(process.env.DOWNLOAD_DIR || path.join(path.dirname(path.resolve(process.env.DB_FILE || "/data/mtg-planner.db")), "downloads"));

/** Error with an HTTP status for the API layer. */
export class DownloadError extends StatusError {}

const hashCache = new Map(); // path -> {key, sha256}

async function sha256Of(file, info) {
  const key = `${info.size}:${info.mtimeMs}`;
  const hit = hashCache.get(file);
  if (hit?.key === key) return hit.sha256;
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(file).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject);
  });
  const sha256 = hash.digest("hex");
  hashCache.set(file, { key, sha256 });
  return sha256;
}

const short = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

async function sidecar(file) {
  try {
    const j = JSON.parse(await readFile(`${file}.json`, "utf8"));
    return { title: short(j.title, 80), version: short(j.version, 40), notes: short(j.notes, 300) };
  } catch {
    return { title: null, version: null, notes: null };
  }
}

/** Offered files, newest first: [{name, title, version, notes, size, modified_at, sha256}]. Missing dir → []. */
export async function listDownloads(dir) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => DOWNLOAD_NAME_RE.test(n))) {
    const file = path.join(dir, name);
    let info;
    try { info = await stat(file); } catch { continue; }
    if (!info.isFile()) continue;
    out.push({ name, ...(await sidecar(file)), size: info.size, modified_at: info.mtime.toISOString(), sha256: await sha256Of(file, info) });
  }
  return out.sort((a, b) => b.modified_at.localeCompare(a.modified_at) || a.name.localeCompare(b.name));
}

/** Path of an offered file (400 bad name, 404 missing). */
export async function downloadPath(dir, name) {
  if (!DOWNLOAD_NAME_RE.test(name)) throw new DownloadError(400, "Not a download name");
  const file = path.join(dir, name);
  try {
    if ((await stat(file)).isFile()) return file;
  } catch { /* fall through */ }
  throw new DownloadError(404, "Download not found");
}
