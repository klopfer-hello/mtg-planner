// Editing and deleting owned copies, with an undo log.
//
// A collection row is keyed by (scryfall_id, finish, language, condition,
// binder, source). Fixing a copy's language, printing, finish or condition
// therefore moves copies from one key to another: a partial quantity splits a
// row, and copies merge into an existing row of the new key. Deleting copies
// lowers or removes rows.
//
// Every change goes into `collection_edits` (migration v8) with the exact
// before/after state of each row key it touched, so it can be undone exactly
// (row ids, quantities, sources, purchase prices). An undo is refused (409
// {code:'conflict'}) when the rows no longer look like the edit left them or a
// newer, not undone log entry touched the same keys: undo newest first.
//
// ManaBox rows follow the rules of lib/binders.js: an edited ManaBox copy
// becomes an 'app' row (confirm_master the first time, the app becomes the
// collection master), and deleting ManaBox copies is refused while ManaBox is
// the master (409 {code:'manabox_rows'}; confirm_master flips the master).
//
// Imports afterwards: an edit of a ManaBox-origin copy (source manabox or app)
// also logs `moves` {origin: the ManaBox line's (printing, finish, language,
// condition), to: the new one, n}. A delta import (the default once the app is
// the master) compares the file with manabox_snapshot, which still lists the
// edited copy under its ManaBox key, so the same file adds nothing and a
// deleted copy is not re-added; when the user makes the same fix in ManaBox
// (old key down, new key up) the delta nets it against the move instead of
// adding the copy again (lib/editlog.js editMoves; the entry then can't be
// undone). A delete of ManaBox-origin copies logs moves with to: null: delta
// counts ManaBox's later decrease of that line as the same delete (not
// reported). A replace import nets edited app copies against their old line,
// then app rows per (printing, finish, language, condition), and leaves out
// copies deleted in the app while ManaBox still lists them; when ManaBox made
// the same edit/delete since the last export it counts as done (netted).
//
// relanguageScans is the one-off data fix for scans committed in the storage
// language instead of the detected one (beta.2 test): it moves exactly those
// scans' copies to the detected printing + language, logged and undoable.

import { setAppMeta, transaction, upsertCards } from "./db.js";
import { BinderError, MASTER_KEY, checkMaster, collectionMaster, ensureBinder, selectCopies } from "./binders.js";
import { fetchCollectionPolitely } from "./manabox.js";
import { KEY_COLS, ROW_BY_KEY, copyList, deleteMoves, editMoves, keyOf, keyStr, nowIso, originParts, printKey, tracker, writeLog } from "./editlog.js";
import { normalizeCard } from "./scryfall.js";

export const EDIT_KINDS = ["edit", "delete", "relanguage", "add"];
export const EDIT_ACTORS = ["app", "claude", "maintenance"];
// Same list as lib/scans.js CONDITIONS (not imported: scans.js pulls in the scanner).
export const EDIT_CONDITIONS = ["mint", "near_mint", "excellent", "good", "light_played", "played", "poor"];
export const EDIT_FINISHES = ["normal", "foil", "etched"];
const LANG_RE = /^[a-z]{2,3}(?:[_-][a-z]{2,4})?$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SET_KEYS = ["language", "printing_id", "finish", "condition"];
// cards.fetched_at of a row built from the local index (same marker as lib/scans.js).
const FALLBACK_FETCHED_AT = "";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const finishOf = (f) => (f === "nonfoil" ? "normal" : f);

const defaultFetch = (ids) => fetchCollectionPolitely(ids.map((id) => ({ id })));

const UPSERT = `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (scryfall_id, finish, language, condition, binder, source)
  DO UPDATE SET quantity = quantity + excluded.quantity,
                purchase_price = COALESCE(purchase_price, excluded.purchase_price),
                purchase_currency = COALESCE(purchase_currency, excluded.purchase_currency)`;
/** Move n copies of a row (current DB state) to another key. */
function shiftCopies(db, row, n, to) {
  if (n >= row.quantity) db.prepare("DELETE FROM collection WHERE id = ?").run(row.id);
  else db.prepare("UPDATE collection SET quantity = quantity - ? WHERE id = ?").run(n, row.id);
  db.prepare(UPSERT).run(to.scryfall_id, to.finish, to.language, to.condition, to.binder, n, row.purchase_price ?? null, row.purchase_currency ?? null, to.source);
}

function checkActor(actor) {
  if (!EDIT_ACTORS.includes(actor)) throw new BinderError(400, `actor must be one of ${EDIT_ACTORS.join(", ")}`);
}

/** Validated `set` of an edit: {language?, printing_id?, finish?, condition?}. */
function validateSet(set) {
  if (!set || typeof set !== "object" || Array.isArray(set)) throw new BinderError(400, "set is required ({language?, printing_id?, finish?, condition?})");
  const unknown = Object.keys(set).filter((k) => !SET_KEYS.includes(k) && set[k] !== undefined);
  if (unknown.length) throw new BinderError(400, `Unknown field in set: ${unknown.join(", ")} (allowed: ${SET_KEYS.join(", ")})`);
  const out = {};
  const str = (k) => {
    if (set[k] == null) return null;
    if (typeof set[k] !== "string" || !set[k].trim()) throw new BinderError(400, `set.${k} must be a non-empty string`);
    return set[k].trim();
  };
  const lang = str("language");
  if (lang != null) {
    const l = lang.toLowerCase();
    if (!LANG_RE.test(l)) throw new BinderError(400, `set.language "${lang}" is not a language code (en, de, it, ja, zhs, ...)`);
    out.language = l;
  }
  const pid = str("printing_id");
  if (pid != null) {
    if (!ID_RE.test(pid)) throw new BinderError(400, "set.printing_id must be a Scryfall id");
    out.printing_id = pid.toLowerCase();
  }
  const fin = str("finish");
  if (fin != null) {
    const f = finishOf(fin.toLowerCase());
    if (!EDIT_FINISHES.includes(f)) throw new BinderError(400, `set.finish must be one of ${EDIT_FINISHES.join(", ")}`);
    out.finish = f;
  }
  const cond = str("condition");
  if (cond != null) {
    const c = cond.toLowerCase().replace(/[\s-]+/g, "_");
    if (!EDIT_CONDITIONS.includes(c)) throw new BinderError(400, `set.condition must be one of ${EDIT_CONDITIONS.join(", ")}`);
    out.condition = c;
  }
  if (!Object.keys(out).length) throw new BinderError(400, "set needs at least one of language, printing_id, finish, condition");
  return out;
}

// A cards row from the local index (offline fallback, re-fetched by the next scan commit).
function cardRowFromIndex(p) {
  const colors = "WUBRG".split("").filter((c) => String(p.mana_cost || "").includes(c)).join("");
  const prices = {};
  for (const k of ["eur", "eur_foil", "eur_etched"]) if (p[k] != null) prices[k] = String(p[k]);
  return {
    scryfall_id: p.id, oracle_id: p.oracle_id || p.id, name: p.name, set_code: p.set_code, set_name: p.set_name ?? null,
    collector_number: p.collector_number, lang: p.lang, rarity: p.rarity ?? null, type_line: p.type_line ?? null,
    mana_cost: p.mana_cost ?? null, cmc: null, colors, color_identity: colors, oracle_text: null, keywords: "[]",
    legalities: "{}", prices: JSON.stringify(prices), image_small: p.image_small ?? p.faces?.[0]?.image_small ?? null,
    image_normal: p.image_normal ?? p.faces?.[0]?.image_normal ?? null, scryfall_uri: null, fetched_at: FALLBACK_FETCHED_AT,
    // Index facts when the index has them; NULL never wipes a known value (db.js upsertCards).
    game_changer: p.game_changer ?? null, produced_mana: p.produced_mana ?? null, layout: p.layout ?? null,
  };
}

/**
 * Card facts for printings: Map(id -> {id, oracle_id, lang, name, set_code, collector_number,
 * finishes (['normal','foil','etched'] subset) | null when unknown}) plus the cards rows that
 * the main DB still lacks (Scryfall /cards/collection first, the local index offline).
 * getPrinting(id) is the index lookup (async or sync, may be null).
 */
async function resolvePrintings(db, ids, { getPrinting = null, fetchCards = defaultFetch } = {}) {
  const cardRow = db.prepare("SELECT * FROM cards WHERE scryfall_id = ?");
  const indexed = new Map();
  for (const id of ids) {
    if (!getPrinting) break;
    try {
      const p = await getPrinting(id);
      if (p) indexed.set(id, p);
    } catch { /* index unavailable: Scryfall below */ }
  }
  // Scryfall only for printings without a cards row (finishes are unknown, so not checked,
  // for a printing that is neither in the index nor fetched).
  const need = ids.filter((id) => !cardRow.get(id));
  let fetched = [];
  if (need.length && fetchCards) {
    try { fetched = (await fetchCards(need))?.cards || []; } catch (err) {
      console.warn(`[edits] Scryfall lookup failed (${err.message}); using the local data`);
    }
  }
  const byId = new Map(fetched.map((c) => [c.id, c]));
  const info = new Map();
  const cardRows = [];
  for (const id of ids) {
    const have = cardRow.get(id);
    const p = indexed.get(id);
    const c = byId.get(id);
    let base = have;
    if (!base) {
      if (c) base = normalizeCard(c);
      else if (p) base = cardRowFromIndex(p);
      else throw new BinderError(404, `Printing ${id} not found`);
      cardRows.push(base);
    }
    const finishes = p?.finishes?.length ? p.finishes : c?.finishes?.length ? c.finishes : null;
    info.set(id, {
      id, oracle_id: base.oracle_id, lang: p?.lang ?? c?.lang ?? base.lang ?? null, name: base.name,
      set_code: base.set_code, collector_number: base.collector_number,
      finishes: finishes ? [...new Set(finishes.map(finishOf))] : null,
    });
  }
  return { info, cardRows };
}

const cardOf = (db, id) => db.prepare("SELECT scryfall_id, oracle_id, name, lang, set_code, collector_number FROM cards WHERE scryfall_id = ?").get(id);

/**
 * Edit owned copies: language, printing (same oracle card), finish, condition.
 * body: {items (as POST /api/collection/move: row keys with quantity, or {oracle_id|printing_id,
 * from_binder?}), set:{language?, printing_id?, finish?, condition?}, confirm_master?, actor?}.
 * A partial quantity splits a row; copies merge into an existing row of the new key. ManaBox
 * rows become 'app' (409 confirm_master first while ManaBox is the master). A new printing
 * without language keeps the row's language, except that a foreign printing sets its own
 * language and an English printing replaces a language that only came from the old printing.
 * opts: {getPrinting(id) (card index), fetchCards(ids) (Scryfall /cards/collection)}.
 * Returns {edit_id (null when nothing changed), edited_copies, converted_copies, rows:[new row keys + quantity]}.
 */
export async function editCopies(db, { items, set, confirm_master = false, actor = "app" } = {}, opts = {}) {
  checkActor(actor);
  const changes = validateSet(set);
  const picks = [...selectCopies(db, items, { verb: "edit" }).values()].filter((a) => a.n > 0);

  // Printings whose facts are needed: the new one, or each row's own when only the finish changes.
  const ids = new Set();
  if (changes.printing_id) ids.add(changes.printing_id);
  else if (changes.finish) for (const { row } of picks) ids.add(row.scryfall_id);
  const { info, cardRows } = ids.size ? await resolvePrintings(db, [...ids], opts) : { info: new Map(), cardRows: [] };

  const plan = [];
  for (const { row, n } of picks) {
    const old = cardOf(db, row.scryfall_id);
    const target = changes.printing_id ?? row.scryfall_id;
    const p = info.get(target);
    if (changes.printing_id && p.oracle_id !== old?.oracle_id) {
      throw new BinderError(400, `${p.name} (${String(p.set_code).toUpperCase()} ${p.collector_number}) is a different card than ${old?.name ?? row.scryfall_id}; ` +
        "a printing can only change to another printing of the same card");
    }
    let language = changes.language;
    if (language == null) {
      language = row.language;
      if (changes.printing_id && target !== row.scryfall_id && p.lang) {
        if (p.lang !== "en") language = p.lang;
        else if (old?.lang && old.lang !== "en" && row.language === old.lang) language = "en";
      }
    }
    const finish = changes.finish ?? row.finish;
    if ((changes.finish || changes.printing_id) && p?.finishes && !p.finishes.includes(finish)) {
      throw new BinderError(400, `${p.name} (${String(p.set_code).toUpperCase()} ${p.collector_number}) has no ${finish} finish ` +
        `(only ${p.finishes.join(", ")}); set finish too`);
    }
    const to = {
      scryfall_id: target, finish, language, condition: changes.condition ?? row.condition, binder: row.binder,
      source: row.source === "manabox" ? "app" : row.source,
    };
    // Nothing about the copy changes: leave the row alone (no source conversion either).
    if (KEY_COLS.every((c) => c === "source" || to[c] === row[c])) continue;
    const label = (c) => (c ? `${String(c.set_code ?? "?").toUpperCase()} ${c.collector_number ?? "?"}` : "?");
    plan.push({ row, n, to, name: old?.name ?? p?.name ?? row.scryfall_id, fromLabel: label(old), toLabel: label(p ?? old) });
  }
  const manabox = plan.filter((x) => x.row.source === "manabox").reduce((s, x) => s + x.n, 0);
  checkMaster(db, manabox, confirm_master);
  if (!plan.length) return { edit_id: null, edited_copies: 0, converted_copies: 0, rows: [] };

  return transaction(db, () => {
    upsertCards(db, cardRows);
    const t = tracker(db);
    const byId = db.prepare("SELECT * FROM collection WHERE id = ?");
    const earlier = editMoves(db);
    const used = new Map();
    const moves = [];
    let edited = 0, converted = 0;
    for (const { row, n, to } of plan) {
      // The copies were picked before the card lookup (await): make sure they are still there.
      const cur = byId.get(row.id);
      if (!cur || keyStr(cur) !== keyStr(row) || cur.quantity < n) {
        throw new BinderError(409, "The collection changed meanwhile; reload and try again", { code: "changed" });
      }
      t.touch(cur);
      t.touch(to);
      shiftCopies(db, cur, n, to);
      edited += n;
      if (cur.source === "manabox") converted += n;
      // Which ManaBox line these copies came from (scan rows have none): an app row that an
      // earlier edit moved here still comes from that edit's line, unless an import already
      // counted that edit (then ManaBox lists this key); per copy, see originParts.
      const dest = printKey(to.scryfall_id, to.finish, to.language, to.condition);
      for (const { origin, n: k } of originParts(cur, n, earlier, used)) {
        if (origin === dest) continue;
        const m = moves.find((x) => x.origin === origin && x.to === dest);
        if (m) m.n += k;
        else moves.push({ origin, to: dest, n: k, netted: 0 });
      }
    }
    if (converted) setAppMeta(db, MASTER_KEY, "app");
    const rows = t.finish();
    const summary = editSummary(plan, edited);
    const editId = writeLog(db, { kind: "edit", actor, summary, copies: edited, rows, moves });
    const get = db.prepare(ROW_BY_KEY);
    const seen = new Set();
    const out = [];
    for (const { to } of plan) {
      const s = keyStr(to);
      if (seen.has(s)) continue;
      seen.add(s);
      const r = get.get(...KEY_COLS.map((c) => to[c]));
      if (r) out.push({ ...keyOf(r), quantity: r.quantity });
    }
    return { edit_id: editId, edited_copies: edited, converted_copies: converted, rows: out, summary, collection_master: collectionMaster(db) };
  });
}

function editSummary(plan, copies) {
  const names = [...new Set(plan.map((x) => x.name))];
  const who = names.length === 1 ? `${plural(copies, "copy", "copies")} of ${names[0]}` : `${plural(copies, "copy", "copies")} (${names.length} cards)`;
  const parts = [];
  const span = (field) => {
    const from = [...new Set(plan.map((x) => x.row[field]))];
    const to = [...new Set(plan.map((x) => x.to[field]))];
    return `${from.join("/")} → ${to.join("/")}`;
  };
  // A same set+number sibling in another language reads as a language change only.
  const moved = plan.filter((x) => x.row.scryfall_id !== x.to.scryfall_id && x.fromLabel !== x.toLabel);
  if (moved.length) {
    const from = [...new Set(moved.map((x) => x.fromLabel))];
    parts.push(`printing ${from.join("/")} → ${moved[0].toLabel}`);
  }
  if (plan.some((x) => x.row.language !== x.to.language)) parts.push(`language ${span("language")}`);
  if (plan.some((x) => x.row.finish !== x.to.finish)) parts.push(`finish ${span("finish")}`);
  if (plan.some((x) => x.row.condition !== x.to.condition)) parts.push(`condition ${span("condition")}`);
  if (!parts.length) parts.push(`printing ${plan[0].toLabel} (another variant)`);
  return `Edited ${who}: ${parts.join(", ")}`;
}

/**
 * Delete owned copies. body: {items (as editCopies), confirm: true (else 400), expected_copies?,
 * confirm_master?, actor?}. expected_copies = the count the user confirmed: when the items now
 * select another number of copies (something was added or removed meanwhile) nothing is deleted,
 * 409 {code:'changed', copies}.
 * ManaBox copies are refused with 409 {code:'manabox_rows'} while ManaBox is the master (the
 * user decides once that the app owns the collection); with confirm_master the app becomes the
 * master first. The log entry's moves keep imports from loading the copies again.
 * An emptied binder stays as an empty binder. Returns {edit_id, deleted_copies, collection_master}.
 */
export function deleteCopies(db, { items, confirm = false, expected_copies = null, confirm_master = false, actor = "app" } = {}) {
  checkActor(actor);
  if (confirm !== true) throw new BinderError(400, "Deleting copies needs confirm: true");
  if (expected_copies != null && !(Number.isInteger(expected_copies) && expected_copies >= 0)) {
    throw new BinderError(400, "expected_copies must be a whole number");
  }
  const picks = [...selectCopies(db, items, { verb: "delete" }).values()].filter((a) => a.n > 0);
  const total = picks.reduce((s, a) => s + a.n, 0);
  if (expected_copies != null && total !== expected_copies) {
    throw new BinderError(409, `These cards now have ${plural(total, "copy", "copies")}, not ${expected_copies}; check again`,
      { code: "changed", copies: total });
  }
  const manabox = picks.filter((a) => a.row.source === "manabox").reduce((s, a) => s + a.n, 0);
  if (manabox > 0 && collectionMaster(db) !== "app" && !confirm_master) {
    throw new BinderError(409,
      `This deletes ${plural(manabox, "copy", "copies")} imported from ManaBox. While ManaBox is the master of your collection ` +
      "ManaBox decides what you own: make mtg-planner the master first (confirm_master), or delete them in ManaBox.",
      { code: "manabox_rows", manabox_copies: manabox });
  }
  return transaction(db, () => {
    if (manabox > 0) setAppMeta(db, MASTER_KEY, "app");
    // Which ManaBox lines the deleted copies came from (read before the rows change).
    const moves = deleteMoves(db, picks);
    const t = tracker(db);
    const names = new Map();
    let deleted = 0;
    for (const { row, n } of picks) {
      t.touch(row);
      // The binder survives as an empty binder (as with moves).
      if (row.binder) ensureBinder(db, row.binder, row.source === "manabox" ? "manabox" : "app");
      if (n >= row.quantity) db.prepare("DELETE FROM collection WHERE id = ?").run(row.id);
      else db.prepare("UPDATE collection SET quantity = quantity - ? WHERE id = ?").run(n, row.id);
      deleted += n;
      const name = cardOf(db, row.scryfall_id)?.name ?? row.scryfall_id;
      names.set(name, (names.get(name) ?? 0) + n);
    }
    const summary = `Deleted ${plural(deleted, "copy", "copies")}: ${copyList(names)}`;
    const editId = writeLog(db, { kind: "delete", actor, summary, copies: deleted, rows: t.finish(), moves });
    return { edit_id: editId, deleted_copies: deleted, summary, collection_master: collectionMaster(db) };
  });
}

// ---------------------------------------------------------------------------
// Log and undo

const parseChanges = (s) => {
  try {
    const c = JSON.parse(s);
    return {
      rows: Array.isArray(c?.rows) ? c.rows : [], scans: Array.isArray(c?.scans) ? c.scans : [],
      moves: Array.isArray(c?.moves) ? c.moves : [], decks: Array.isArray(c?.decks) ? c.decks : [],
    };
  } catch { return { rows: [], scans: [], moves: [], decks: [] }; }
};

/**
 * Why an entry can't be undone now, or null. Rows (and relanguaged scans) must look exactly
 * as the entry left them, and no newer entry that is not undone may have touched them.
 */
function conflictOf(db, entry) {
  const ch = parseChanges(entry.changes);
  if (ch.moves.some((m) => m?.netted > 0)) return "a ManaBox import already counted this change (ManaBox lists the copies like this now)";
  const keys = new Set(ch.rows.map((r) => keyStr(r.key)));
  const scanIds = new Set(ch.scans.map((s) => s.id));
  for (const later of db.prepare("SELECT id, changes FROM collection_edits WHERE id > ? AND undone_at IS NULL ORDER BY id").all(entry.id)) {
    const lc = parseChanges(later.changes);
    if (lc.rows.some((r) => keys.has(keyStr(r.key))) || lc.scans.some((s) => scanIds.has(s.id))) {
      return `a newer change (#${later.id}) touched the same copies; undo it first`;
    }
  }
  const get = db.prepare(ROW_BY_KEY);
  for (const r of ch.rows) {
    const cur = get.get(...KEY_COLS.map((c) => r.key[c]));
    if ((cur?.quantity ?? 0) !== (r.after?.quantity ?? 0)) return "these copies were changed since (moved, edited, imported or deleted)";
  }
  const scan = db.prepare("SELECT store_printing_id, store_lang FROM scans WHERE id = ?");
  for (const s of ch.scans) {
    const cur = scan.get(s.id);
    if (!cur || cur.store_printing_id !== s.after.store_printing_id || cur.store_lang !== s.after.store_lang) return "the scan was changed since";
  }
  return null;
}

/**
 * Newest first: [{id, at, kind, actor, summary, copies, undone_at, undoable, reason (why not, or null)}].
 */
export function listEdits(db, { limit = 50 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  return db.prepare("SELECT * FROM collection_edits ORDER BY id DESC LIMIT ?").all(n).map((e) => {
    const reason = e.undone_at ? "already undone" : conflictOf(db, e);
    return {
      id: e.id, at: e.at, kind: e.kind, actor: e.actor, summary: e.summary, copies: e.copies,
      undone_at: e.undone_at ?? null, undoable: !reason, reason: e.undone_at ? null : reason,
    };
  });
}

/**
 * Undo one log entry exactly (rows, quantities, sources, purchase prices, row ids when free;
 * relanguaged scans get their stored printing back). 404 unknown, 409 {code:'undone'} twice,
 * 409 {code:'conflict'} when conflictOf says so (nothing changes then). The undo is not a
 * new log entry: it sets undone_at. The collection master stays as it is.
 */
export function undoEdit(db, id) {
  return transaction(db, () => {
    const entry = db.prepare("SELECT * FROM collection_edits WHERE id = ?").get(Number(id));
    if (!entry) throw new BinderError(404, "Edit not found");
    if (entry.undone_at) throw new BinderError(409, "This change was already undone", { code: "undone" });
    const reason = conflictOf(db, entry);
    if (reason) throw new BinderError(409, `Can't undo: ${reason}`, { code: "conflict" });
    const ch = parseChanges(entry.changes);
    const get = db.prepare(ROW_BY_KEY);
    const del = db.prepare("DELETE FROM collection WHERE id = ?");
    // Rows the entry created go first: their ids may be the ids to restore.
    for (const r of ch.rows) {
      if (r.before) continue;
      const cur = get.get(...KEY_COLS.map((c) => r.key[c]));
      if (cur) del.run(cur.id);
    }
    const taken = db.prepare("SELECT 1 FROM collection WHERE id = ?");
    for (const r of ch.rows) {
      if (!r.before) continue;
      const k = r.key;
      const cur = get.get(...KEY_COLS.map((c) => k[c]));
      const b = r.before;
      if (cur) {
        db.prepare("UPDATE collection SET quantity = ?, purchase_price = ?, purchase_currency = ? WHERE id = ?")
          .run(b.quantity, b.purchase_price, b.purchase_currency, cur.id);
      } else {
        const rowId = b.id != null && !taken.get(b.id) ? b.id : null;
        db.prepare(`INSERT INTO collection (id, scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(rowId, k.scryfall_id, k.finish, k.language, k.condition, k.binder, b.quantity, b.purchase_price, b.purchase_currency, k.source);
      }
      if (k.binder) ensureBinder(db, k.binder, k.source === "manabox" ? "manabox" : "app");
    }
    const setScan = db.prepare("UPDATE scans SET store_printing_id = ?, store_lang = ?, updated_at = ? WHERE id = ?");
    for (const s of ch.scans) setScan.run(s.before.store_printing_id, s.before.store_lang, s.before.updated_at ?? nowIso(), s.id);
    // A binder delete cleared the deck box of these decks: the restored binder is their box again
    // (unless the deck got another box meanwhile).
    const setBox = db.prepare("UPDATE decks SET box_binder = ? WHERE id = ? AND box_binder IS NULL");
    for (const d of ch.decks) {
      if (Number.isInteger(d?.id) && typeof d.box_binder === "string" && d.box_binder) {
        ensureBinder(db, d.box_binder, "app");
        setBox.run(d.box_binder, d.id);
      }
    }
    const at = nowIso();
    db.prepare("UPDATE collection_edits SET undone_at = ? WHERE id = ?").run(at, entry.id);
    return {
      undone: true, id: entry.id, kind: entry.kind, summary: entry.summary, copies: entry.copies, undone_at: at,
      collection_master: collectionMaster(db),
    };
  });
}

// ---------------------------------------------------------------------------
// Data fix: committed scans stored in the storage language

/**
 * For COMMITTED scans whose detected printing (printing_id) differs from the stored one
 * (store_printing_id), move exactly the scan's copies (source 'scan', the binder it was
 * committed to) to the detected printing and its language. Scans whose copies are no longer
 * all there (moved, edited, deleted) are skipped, as are deck commits that recorded no binder
 * (deck_cards are not changed). The scan's stored printing/language are
 * updated too, so running it again changes nothing. dry_run (default) only reports.
 * Returns {changes:[{scan_id, name, from:{scryfall_id, language}, to:{scryfall_id, language},
 * copies, binder}], skipped:[{scan_id, reason}], applied, edit_id?}. Logged as kind
 * 'relanguage', actor 'maintenance', undoable.
 */
export async function relanguageScans(db, { scan_ids, dry_run = true } = {}, opts = {}) {
  if (!Array.isArray(scan_ids) || !scan_ids.length) throw new BinderError(400, "scan_ids must be a non-empty array");
  if (scan_ids.length > 2000) throw new BinderError(400, "At most 2000 scans at once");
  const ids = [...new Set(scan_ids.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new BinderError(400, "scan_ids must be scan ids");
  if (typeof dry_run !== "boolean") throw new BinderError(400, "dry_run must be true or false");
  const { getPrinting = null } = opts;

  const scanRow = db.prepare("SELECT * FROM scans WHERE id = ?");
  const rowsOfKey = db.prepare(
    `SELECT * FROM collection WHERE scryfall_id = ? AND finish = ? AND language = ? AND condition = ? AND binder = ? COLLATE NOCASE AND source = 'scan' ORDER BY id`,
  );
  const changes = [];
  const skipped = [];
  const plan = [];
  const used = new Map(); // row id -> copies already planned
  for (const id of ids) {
    const s = scanRow.get(id);
    const skip = (reason) => skipped.push({ scan_id: id, name: s?.name ?? null, reason });
    if (!s) { skip("scan not found"); continue; }
    if (s.status !== "committed") { skip("not committed"); continue; }
    if (!s.printing_id || !s.store_printing_id || s.printing_id === s.store_printing_id) { skip("stored as detected"); continue; }
    let to = null;
    try { to = JSON.parse(s.committed_to || "null"); } catch { to = null; }
    // The binder that received the scan's copies: a binder target, or a deck commit that
    // recorded the binder of its owned copies (lib/scans.js). Older deck commits don't say
    // whether copies were added at all (owned:false adds none), so they are skipped; deck_cards
    // are never changed here.
    const binder = to?.type === "binder" && typeof to.name === "string" ? to.name
      : to?.type === "deck" && typeof to.binder === "string" ? to.binder : null;
    if (binder == null) {
      if (to?.type === "deck") skip(to.owned === false ? "deck commit without owned copies" : "deck commit (binder of its copies not recorded)");
      else skip("unknown commit target");
      continue;
    }
    let lang = null;
    if (getPrinting) { try { lang = (await getPrinting(s.printing_id))?.lang ?? null; } catch { lang = null; } }
    lang = lang ?? cardOf(db, s.printing_id)?.lang ?? s.lang_detected ?? null;
    if (!lang) { skip("language of the detected printing unknown"); continue; }
    const fromLang = s.store_lang || "en";
    const rows = rowsOfKey.all(s.store_printing_id, s.finish, fromLang, s.condition, binder);
    let left = s.quantity;
    const takes = [];
    for (const r of rows) {
      const free = r.quantity - (used.get(r.id) ?? 0);
      const n = Math.min(free, left);
      if (n > 0) { takes.push({ row: r, n }); left -= n; }
      if (!left) break;
    }
    if (left > 0) { skip(`copies no longer in "${binder}" (moved, edited or deleted)`); continue; }
    for (const tk of takes) used.set(tk.row.id, (used.get(tk.row.id) ?? 0) + tk.n);
    changes.push({
      scan_id: id, name: s.name, from: { scryfall_id: s.store_printing_id, language: fromLang },
      to: { scryfall_id: s.printing_id, language: lang }, copies: s.quantity, binder: takes[0].row.binder,
    });
    plan.push({ scan: s, lang, takes });
  }
  if (dry_run || !plan.length) return { changes, skipped, applied: false };

  const { cardRows } = await resolvePrintings(db, [...new Set(plan.map((x) => x.scan.printing_id))], opts);
  return transaction(db, () => {
    upsertCards(db, cardRows);
    const t = tracker(db);
    const byId = db.prepare("SELECT * FROM collection WHERE id = ?");
    const scansLog = [];
    let copies = 0;
    for (const { scan, lang, takes } of plan) {
      const now = scanRow.get(scan.id);
      if (now.store_printing_id !== scan.store_printing_id || (now.store_lang ?? null) !== (scan.store_lang ?? null)) {
        throw new BinderError(409, "The scans changed meanwhile; run it again", { code: "changed" });
      }
      for (const { row, n } of takes) {
        const cur = byId.get(row.id);
        if (!cur || keyStr(cur) !== keyStr(row) || cur.quantity < n) {
          throw new BinderError(409, "The collection changed meanwhile; run it again", { code: "changed" });
        }
        const dest = { ...keyOf(cur), scryfall_id: scan.printing_id, language: lang };
        t.touch(cur);
        t.touch(dest);
        shiftCopies(db, cur, n, dest);
        copies += n;
      }
      const before = { store_printing_id: scan.store_printing_id, store_lang: scan.store_lang ?? null, updated_at: now.updated_at ?? null };
      const after = { store_printing_id: scan.printing_id, store_lang: lang };
      db.prepare("UPDATE scans SET store_printing_id = ?, store_lang = ?, updated_at = ? WHERE id = ?").run(after.store_printing_id, after.store_lang, nowIso(), scan.id);
      scansLog.push({ id: scan.id, before, after });
    }
    const langs = [...new Set(plan.map((x) => x.lang.toUpperCase()))].join("/");
    const summary = `Stored ${plural(copies, "scanned copy", "scanned copies")} (${plural(plan.length, "scan")}) in the scanned language (${langs})`;
    const editId = writeLog(db, { kind: "relanguage", actor: "maintenance", summary, copies, rows: t.finish(), scans: scansLog });
    return { changes, skipped, applied: true, edit_id: editId };
  });
}
