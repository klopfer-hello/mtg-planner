// JSON answers of web sources (EDHREC, Commander Spellbook, Scryfall searches)
// kept in web_cache, so a planner turn asks each source once per TTL and a
// failed request falls back to the last answer instead of failing the turn.

import { nowIso } from "./db.js";

/** Polite User-Agent for the non-Scryfall sources. */
export const WEB_UA = "mtg-planner/1.3 (+https://github.com/klopfer-hello/mtg-planner)";

/**
 * The cached payload of `key` when younger than ttlMs, else `await fetcher()` (stored). Returns
 * {data, fetched_at, cached, stale?, error?}; throws only when the fetch fails and nothing is cached.
 */
export async function cachedJson(db, key, ttlMs, fetcher) {
  const row = db.prepare("SELECT payload, fetched_at FROM web_cache WHERE key = ?").get(key);
  if (row && Date.now() - Date.parse(row.fetched_at) < ttlMs) return { data: JSON.parse(row.payload), fetched_at: row.fetched_at, cached: true };
  try {
    const data = await fetcher();
    const at = nowIso();
    db.prepare("INSERT OR REPLACE INTO web_cache (key, payload, fetched_at) VALUES (?, ?, ?)").run(key, JSON.stringify(data), at);
    return { data, fetched_at: at, cached: false };
  } catch (err) {
    if (row) return { data: JSON.parse(row.payload), fetched_at: row.fetched_at, cached: true, stale: true, error: err.message };
    throw err;
  }
}

async function request(url, { method = "GET", body, timeoutMs = 15000, signal, accept }) {
  const res = await fetch(url, {
    method, headers: { "User-Agent": WEB_UA, Accept: accept, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) { const err = new Error(`${new URL(url).host} ${res.status}`); err.status = res.status; throw err; }
  return res;
}

/** fetch → JSON with the app's User-Agent and a timeout; non-2xx throws "<host> <status>" (err.status). */
export const getJson = async (url, opts = {}) => (await request(url, { ...opts, accept: "application/json" })).json();

/** fetch → text (HTML pages, the rules file), same User-Agent, timeout and errors as getJson. */
export const getText = async (url, opts = {}) => (await request(url, { timeoutMs: 30000, ...opts, accept: "text/html,text/plain,*/*" })).text();
