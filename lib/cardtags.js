// Function tags for search: the app's own role tags (role:) and Scryfall Tagger
// tags (otag:), so "owned cards that trigger when a creature dies" is one query
// instead of guessed oracle wording (plan v1.3.0, #067).
//
// Roles come from lib/cardclass.js and are cached per oracle card in card_roles
// (re-classified when the cached printing is re-fetched), so the SQL can filter
// on them. Tagger tags are community data that only Scryfall's search exposes
// (`otag:` queries): a tag is fetched once, all pages, and kept 30 days in
// card_tags. Coverage is partial, so a missing tag never means "lacks the function".

import { CARD_TAGS, classifyCard } from "./cardclass.js";
import { nowIso } from "./db.js";
import { scryfall } from "./scryfall.js";

/** role: values: the classification tags plus groups (ramp includes fast mana: Sol Ring is ramp to a player). */
export const ROLE_ALIASES = Object.freeze({
  ramp: ["ramp", "fast_mana"],
  draw: ["draw_engine", "draw_burst"],
  interaction: ["removal", "counter", "wipe"],
});
export const ROLE_VALUES = Object.freeze([...new Set([...CARD_TAGS, ...Object.keys(ROLE_ALIASES)])]);

/** Tags a role: value stands for (throws on an unknown one). */
export function roleTags(value) {
  const v = String(value).toLowerCase().replace(/-/g, "_");
  if (ROLE_ALIASES[v]) return ROLE_ALIASES[v];
  if (CARD_TAGS.includes(v)) return [v];
  throw new Error(`Unknown role "${value}". Roles: ${ROLE_VALUES.join(", ")}`);
}

/** Classify every oracle card whose cached roles are missing or stale (cheap after the first run). */
export function syncCardRoles(db) {
  // New oracle cards (any printing), or the printing the roles were taken from was re-fetched (only that row matches).
  const rows = db.prepare(
    `SELECT c.* FROM cards c
      WHERE c.oracle_id IS NOT NULL AND c.oracle_text IS NOT NULL
        AND (NOT EXISTS (SELECT 1 FROM card_roles r WHERE r.oracle_id = c.oracle_id)
          OR EXISTS (SELECT 1 FROM card_roles r WHERE r.oracle_id = c.oracle_id AND r.scryfall_id = c.scryfall_id AND r.fetched_at IS NOT c.fetched_at))
      GROUP BY c.oracle_id`,
  ).all();
  if (!rows.length) return 0;
  const put = db.prepare("INSERT OR REPLACE INTO card_roles (oracle_id, scryfall_id, fetched_at, tags) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const c of rows) put.run(c.oracle_id, c.scryfall_id, c.fetched_at ?? null, `,${classifyCard(c).map((t) => t.tag).join(",")},`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

const OTAG_TTL_MS = 30 * 24 * 3600 * 1000;
const OTAG_RETRY_MS = 10 * 60 * 1000; // a failed fetch is not retried on every search
const OTAG_MAX_PAGES = 25; // 175 cards a page
const OTAG_NAME = /^[a-z0-9-]+$/; // Tagger tag names; anything else would change the Scryfall query

/** Valid otag:/function: values of a query string (lower-case, deduplicated). */
export function otagsIn(q) {
  const out = new Set();
  for (const m of String(q || "").matchAll(/(?:^|[\s(-])(?:otag|function|oracletag):(?:"([^"]+)"|([^\s()"]+))/gi)) {
    const tag = (m[1] ?? m[2]).toLowerCase();
    if (OTAG_NAME.test(tag)) out.add(tag);
  }
  return [...out];
}

/**
 * Make sure each Tagger tag is cached (fetched within 30 days). Returns {fetched, failed: [{tag, error}]};
 * never throws, so a search still runs (an unfetched tag then matches nothing).
 */
export async function ensureOtags(db, tags, { signal } = {}) {
  const fetched = [], failed = [];
  for (const tag of tags) {
    const known = db.prepare("SELECT fetched_at, complete FROM card_tag_sets WHERE tag = ?").get(tag);
    const age = known ? Date.now() - Date.parse(known.fetched_at) : Infinity;
    if (known?.complete === -1 && age < OTAG_RETRY_MS) { failed.push({ tag, error: "Scryfall failed a few minutes ago, retrying later" }); continue; }
    if (known && known.complete !== -1 && age < OTAG_TTL_MS) continue;
    try {
      const ids = new Set();
      let path = `/cards/search?q=${encodeURIComponent(`otag:${tag}`)}&unique=cards`;
      let pages = 0, complete = 1;
      while (path) {
        let page;
        try { page = await scryfall(path, { signal }); } catch (err) { if (err.status === 404) break; throw err; } // 404 = no cards
        for (const c of page.data || []) if (c.oracle_id) ids.add(c.oracle_id);
        if (++pages >= OTAG_MAX_PAGES && page.has_more) { complete = 0; break; }
        path = page.has_more && page.next_page ? page.next_page.replace(/^https:\/\/api\.scryfall\.com/, "") : null;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM card_tags WHERE tag = ?").run(tag);
        const put = db.prepare("INSERT OR IGNORE INTO card_tags (tag, oracle_id) VALUES (?, ?)");
        for (const id of ids) put.run(tag, id);
        db.prepare("INSERT OR REPLACE INTO card_tag_sets (tag, fetched_at, count, complete) VALUES (?, ?, ?, ?)").run(tag, nowIso(), ids.size, complete);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      fetched.push(tag);
    } catch (err) {
      failed.push({ tag, error: err.message });
      // Remember the failure (complete = -1) without touching tags fetched before: they stay usable.
      db.prepare(`INSERT INTO card_tag_sets (tag, fetched_at, count, complete) VALUES (?, ?, 0, -1)
        ON CONFLICT(tag) DO UPDATE SET fetched_at = excluded.fetched_at, complete = -1`).run(tag, nowIso());
    }
  }
  return { fetched, failed };
}

/** Tagger tags cached for one oracle card (for get_cards). */
export const otagsOf = (db, oracleId) =>
  db.prepare("SELECT tag FROM card_tags WHERE oracle_id = ? ORDER BY tag").all(oracleId).map((r) => r.tag);
