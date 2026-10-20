// Scanner staging list ("scans"), binders, and committing scans to the
// collection or a deck, the way ManaBox does it: every scan lands in a list
// first, the user fixes printing / finish / quantity / condition there, then
// adds a selection to a binder or a deck.
//
// Guards against ManaBox's classic failure (the same card counted again and
// again): a scan of the same stored printing + finish right after itself is
// NOT staged; the caller gets {duplicate: true} and offers "+1" instead.
// Committed rows go into `collection` with source 'scan', so a ManaBox
// "replace" import (source 'manabox') never deletes them.
//
// Calibration: scans can carry the user's confirmed truth next to the raw
// features of the identification, so thresholds can be re-fit from real photos.
// Since 0.7.0 every confirmation is such a labelled example too (implicit:
// scanning on past a SUGGEST row confirms it; see "Confirmations" below).
//
// Pieces in their own modules: lib/scanrow.js (row view, lookups, image
// paths), lib/scancapture.js (capture records), lib/scanlabels.js
// (confirmations, labels, calibration export) and lib/scancommit.js (commit).
// The recognition probes (ProbeRunner) stay here: they stage through stageScan.

import path from "node:path";
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { eurOf } from "./db.js";
import { STORE_AS_SCANNED } from "./cardindex.js";
import { finishFromLine } from "./scanner.js";
import {
  CONDITIONS, defaultImageDir, featuresOf, FINISH_OF, FINISHES, finishesOf, getRow, getScan, isPlain, normFinish, nowIso, parse,
  removeFiles, requireStaged, ScanError, scanRow,
} from "./scanrow.js";
import { appendCaptureEvent, recordDropped, sanitizeCapture } from "./scancapture.js";
import { SESSION_ID_RE } from "./debugsessions.js";
import { atomic, confirmImplicitly, isCalibrationTruth, labelOf, revertImplicit, sessionOf, userSource } from "./scanlabels.js";
import * as indexModule from "./cardindex.js";

export const SCAN_DUPLICATE_WINDOW_MS = Number(process.env.SCAN_DUPLICATE_WINDOW_MS) || 20000;

// Action clock. undoLast takes the staged row with the newest updated_at (ties:
// the higher id), and created_at tells a row from a later one under a reused id.
// Wall-clock ms can tie (a +1 or an edit of an older row in the same ms as a
// stage) or step back (NTP / VM clock sync), and undo then hit the wrong row.
// So every stage, +1 and edit is stamped strictly after the newest staged row
// and the last stamp this process issued for the connection.
const lastStamp = new WeakMap();
function actionStamp(db, now = Date.now()) {
  const top = db.prepare("SELECT MAX(updated_at) AS t FROM scans WHERE status = 'staged'").get()?.t;
  const floor = Math.max(lastStamp.get(db) ?? -Infinity, top ? Date.parse(top) || -Infinity : -Infinity);
  const t = floor >= now ? floor + 1 : now;
  lastStamp.set(db, t);
  return new Date(t).toISOString();
}

// The staged row of the last action (stage, +1 or edit): newest updated_at, ties the higher id.
const newestStaged = (db) => db.prepare("SELECT * FROM scans WHERE status = 'staged' ORDER BY updated_at DESC, id DESC LIMIT 1").get();
// A finish as stored: nonfoil -> normal, anything unknown -> normal.
const clampFinish = (f) => (FINISHES.includes(normFinish(f)) ? normFinish(f) : "normal");
// A row's finishes column (JSON) in scan terms (nonfoil -> normal).
const storedFinishes = (json) => parse(json, []).map(FINISH_OF);

/** Scans by list state: staged (default), committed or all; newest first. */
export function listScans(db, { status = "staged", limit = 500 } = {}) {
  const where = status === "all" ? "" : "WHERE status = ?";
  const args = status === "all" ? [] : [status === "committed" ? "committed" : "staged"];
  return db.prepare(`SELECT * FROM scans ${where} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(Math.max(1, limit), 5000))
    .map((r) => scanRow(r));
}

/**
 * Adds `price_eur` (number|null) to scan rows (store printing + finish) and
 * returns the list totals {cards, copies, value_eur, unpriced}: the scanner's
 * running value of the staged list. Same order as scanner.js scanPriceEur:
 * index price, the app `cards` row, then the English twin (index, cards).
 * `indexPrices(items)` is cardindex printingPricesEur run off the main thread
 * (async; a failure only drops to the cards table). One cards query per call.
 */
export async function priceScans(db, rows, { indexPrices = null } = {}) {
  const priced = rows.filter((r) => r.store_printing_id && r.match_status !== "failed");
  const items = priced.map((r) => ({ id: r.store_printing_id, finish: FINISH_OF(r.finish || "normal") }));
  let fromIndex = [];
  if (indexPrices && items.length) {
    try { fromIndex = (await indexPrices(items)) || []; } catch { fromIndex = []; }
  }
  const ids = new Set(items.map((i) => i.id));
  for (const x of fromIndex) if (x?.en_id) ids.add(x.en_id);
  const cardPrices = new Map();
  if (ids.size) {
    const q = db.prepare("SELECT scryfall_id, prices FROM cards WHERE scryfall_id IN (SELECT value FROM json_each(?))");
    for (const r of q.all(JSON.stringify([...ids]))) {
      try { cardPrices.set(r.scryfall_id, JSON.parse(r.prices || "{}")); } catch { /* bad JSON: unpriced */ }
    }
  }
  // A cards row's own price, else the English twin's copied into it (lib/prices.js).
  const fromCards = (id, finish) => {
    const p = cardPrices.get(id);
    return p ? eurOf(p, finish === "etched" ? "eur_etched" : finish === "foil" ? "eur_foil" : "eur") : null;
  };
  const price = new Map();
  priced.forEach((r, i) => {
    const { id, finish } = items[i];
    const x = fromIndex[i]?.id === id ? fromIndex[i] : null;
    const v = x?.eur ?? fromCards(id, finish) ?? x?.en_eur ?? (x?.en_id ? fromCards(x.en_id, finish) : null);
    price.set(r, v ?? null);
  });
  let copies = 0;
  let value = 0;
  let unpriced = 0;
  for (const r of rows) {
    r.price_eur = price.get(r) ?? null;
    const qty = Number(r.quantity) || 0;
    copies += qty;
    if (r.price_eur == null) unpriced += 1;
    else value += qty * r.price_eur;
  }
  return { cards: rows.length, copies, value_eur: Math.round(value * 100) / 100, unpriced };
}

// Columns derived from the detected printing and its storage-language twin.
function printingColumns(printing, store) {
  const s = store || printing;
  return {
    printing_id: printing.id,
    store_printing_id: s.id,
    oracle_id: s.oracle_id ?? printing.oracle_id ?? null,
    name: s.name ?? printing.name,
    printed_name: s.printed_name ?? null,
    set_code: s.set_code,
    set_name: s.set_name ?? null,
    collector_number: s.collector_number,
    rarity: s.rarity ?? null,
    image_small: s.image_small ?? s.faces?.[0]?.image_small ?? printing.image_small ?? null,
    image_normal: s.image_normal ?? s.faces?.[0]?.image_normal ?? printing.image_normal ?? null,
    finishes: JSON.stringify(s.finishes?.length ? s.finishes : printing.finishes || []),
    lang_detected: printing.lang ?? null,
    store_lang: s.lang ?? null,
  };
}

/**
 * Stage an identify() result. Returns {scan, duplicate}. A failed result (no
 * printing) is not staged ({scan: null}), except in calibration mode, where it
 * becomes an uncommittable 'failed' row so the truth attaches to the real
 * attempt. Same stored printing + finish as the most recent scan within
 * SCAN_DUPLICATE_WINDOW_MS (and no `force`) is not staged either:
 * {duplicate: true, scan: <that scan>}; for REVIEW results the key is the
 * detected printing of the most recent REVIEW scan. `replaceId` names a staged
 * review/failed scan that this one replaces (the UI's "Rescan").
 * `capture` (raw client record, sanitized here) goes
 * into features.capture, on a duplicate answer into that row's
 * capture_events, for a failed result into meta capture_dropped.
 * `probe` ({session}) marks a row staged by a recognition probe (features.probe).
 * `session` (the probe session of a probe or a shutter scan) goes into
 * features.session; a new row of a session implicitly confirms the session's
 * untouched SUGGEST rows (confirmImplicitly): returned as `confirmed`.
 * opts: {image, strip, force, condition, calibration, replaceId, capture, probe, session, imageDir, windowMs, now}
 */
export function stageScan(db, result, opts = {}) {
  const { image = null, strip = null, force = false, calibration = false, imageDir = defaultImageDir(), windowMs = SCAN_DUPLICATE_WINDOW_MS } = opts;
  const now = opts.now ?? Date.now();
  const failed = !result?.printing || result.status === "failed";
  const capture = opts.capture == null ? null : sanitizeCapture(opts.capture);
  if (failed && !(calibration && result)) {
    if (capture) recordDropped(db, { reason: "failed", result_status: "failed", capture });
    return { scan: null, duplicate: false, confirmed: [] };
  }
  const store = failed ? null : result.store || result.printing;
  const finish = clampFinish(result.finish);
  const condition = CONDITIONS.includes(opts.condition) ? opts.condition : "near_mint";

  if (opts.replaceId != null) {
    const old = getRow(db, opts.replaceId);
    if (old && old.status === "staged" && ["review", "failed"].includes(old.match_status)) {
      db.prepare("DELETE FROM scans WHERE id = ?").run(old.id);
      removeFiles(old, imageDir);
    }
  }

  const dupAnswer = (row, rule) => {
    if (capture) appendCaptureEvent(db, row, { at: new Date(now).toISOString(), event: "duplicate", rule, capture });
    return { scan: scanRow(getRow(db, row.id)), duplicate: true, confirmed: [] };
  };
  if (!force && !failed) {
    const last = newestStaged(db);
    const recent = last && now - Date.parse(last.updated_at) < windowMs;
    const same = result.status === "review"
      ? last?.match_status === "review" && last.printing_id === result.printing.id
      : last?.store_printing_id === store.id && last?.finish === finish;
    if (recent && same) return dupAnswer(last, "window");
  }

  const features = {
    ...(result.features || {}),
    result: {
      status: failed ? "failed" : result.status, printing_id: result.printing?.id ?? null, store_printing_id: store?.id ?? null, finish,
      finish_source: result.finishSource ?? null, method: result.method ?? null, confidence: result.confidence ?? null,
      claude_used: Boolean(result.claude_used), timings: result.timings ?? null,
    },
  };
  if (capture) features.capture = capture;
  if (opts.probe) features.probe = { session: opts.probe.session ?? null };
  const session = opts.session ?? opts.probe?.session ?? null;
  if (session) features.session = session;
  const ts = actionStamp(db, now);
  const cols = {
    created_at: ts,
    updated_at: ts,
    status: "staged",
    match_status: failed ? "failed" : result.status === "manual" ? "manual" : result.status,
    ...(failed ? {} : printingColumns(result.printing, store)),
    finish,
    finish_source: result.finishSource ?? null,
    condition,
    quantity: Math.max(1, Math.min(999, parseInt(result.quantity, 10) || 1)),
    confidence: result.confidence ?? null,
    method: result.method ?? null,
    candidates: JSON.stringify(result.candidates || []),
    variants: JSON.stringify(result.variants || []),
    features: JSON.stringify(features),
    calibration: calibration ? 1 : 0,
    last_action: "stage",
  };
  const keys = Object.keys(cols);
  // The new row and the implicit confirmation of the session's earlier SUGGEST rows land together.
  let confirmed = [];
  const id = atomic(db, () => {
    const newId = Number(db.prepare(`INSERT INTO scans (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((k) => cols[k])).lastInsertRowid);
    confirmed = confirmImplicitly(db, {
      session, except: newId, oracleId: cols.oracle_id ?? null, now, by: { scan: newId, created_at: ts, action: "stage" },
    });
    return newId;
  });

  if (image || strip) {
    try {
      mkdirSync(imageDir, { recursive: true });
      let imagePath = null, stripPath = null;
      // A random token in the name: scan ids are reused (a restore of an older
      // backup lowers max(id)), and a new scan must never overwrite or later
      // delete the photo of a scan that a (safety) backup still points to.
      const base = `scan-${id}-${crypto.randomBytes(6).toString("hex")}`;
      if (image) { imagePath = `${base}.jpg`; writeFileSync(path.join(imageDir, imagePath), image, { flag: "wx" }); }
      // The strip is the user's own collector line: the printing picker shows it
      // zoomed in, and calibration re-runs OCR on it.
      if (strip) { stripPath = `${base}-strip.jpg`; writeFileSync(path.join(imageDir, stripPath), strip, { flag: "wx" }); }
      db.prepare("UPDATE scans SET image_path = ?, strip_path = ? WHERE id = ?").run(imagePath, stripPath, id);
    } catch (err) {
      console.warn(`[scans] could not store the image of scan ${id}: ${err.message}`);
    }
  }
  return { scan: getScan(db, id), duplicate: false, confirmed };
}

/**
 * Edit a staged scan. A new printing_id or store_lang re-derives the stored
 * printing from the local index (ctx.idx); the scan then counts as confirmed.
 * A scan staged with the storage language "scanned" (STORE_AS_SCANNED, the
 * default) stores the picked printing itself; store_lang may also be "scanned".
 */
export function updateScan(db, id, patch = {}, { idx, index = indexModule, now = Date.now() } = {}) {
  const row = requireStaged(db, id);
  const set = {};
  let confirmSource = null; // a printing pick or Confirm: a labelled example (user | correction)
  if (patch.printing_id != null || patch.store_lang != null) {
    if (!idx) throw new ScanError(503, "The card index is not available");
    const asScanned = featuresOf(row).settings?.storageLang === STORE_AS_SCANNED;
    const storeLang = patch.store_lang != null ? String(patch.store_lang).toLowerCase() : asScanned ? STORE_AS_SCANNED : row.store_lang || "en";
    if (storeLang !== STORE_AS_SCANNED && !/^[a-z]{2,3}$/.test(storeLang)) throw new ScanError(400, "store_lang must be a language code or \"scanned\"");
    const printing = index.getPrinting(idx, patch.printing_id != null ? String(patch.printing_id) : row.printing_id);
    if (!printing) throw new ScanError(400, "Unknown printing");
    const store = storeLang === STORE_AS_SCANNED ? printing : index.storagePrinting(idx, printing, storeLang) || printing;
    Object.assign(set, printingColumns(printing, store));
    set.store_lang = store.lang;
    if (patch.printing_id != null) {
      set.match_status = "confirmed";
      confirmSource = userSource(row, printing.id);
    }
    const fins = finishesOf(store);
    if (patch.finish == null && patch.printing_id != null && row.finish_source !== "user") {
      // A new printing re-decides the finish from the stored ★/• read (beta.1 kept the old
      // printing's finish, so a ★ on a card first matched to a non-foil-only printing stayed normal).
      const f = featuresOf(row);
      const fin = finishFromLine(printing, f.collector ?? null, { foilMode: f.settings?.foil ?? "auto" });
      if (fins.includes(fin.finish) && (fin.finish !== row.finish || fin.source !== row.finish_source)) {
        set.finish = fin.finish;
        set.finish_source = fin.source;
      }
    }
    // Keep the finish if the new printing has it; else its only finish / normal.
    if (patch.finish == null && !fins.includes(set.finish ?? row.finish)) set.finish = fins.includes("normal") ? "normal" : fins[0];
  }
  if (patch.finish != null) {
    const f = normFinish(patch.finish);
    if (!FINISHES.includes(f)) throw new ScanError(400, `finish must be one of ${FINISHES.join(", ")}`);
    const fins = storedFinishes(set.finishes ?? row.finishes);
    if (fins.length && !fins.includes(f)) throw new ScanError(400, `This printing has no ${f} finish`);
    set.finish = f;
    set.finish_source = "user";
  }
  if (patch.quantity != null) {
    const q = Number(patch.quantity);
    if (!Number.isInteger(q) || q < 1 || q > 999) throw new ScanError(400, "quantity must be 1-999");
    set.quantity = q;
  }
  if (patch.condition != null) {
    if (!CONDITIONS.includes(patch.condition)) throw new ScanError(400, `condition must be one of ${CONDITIONS.join(", ")}`);
    set.condition = patch.condition;
  }
  const f0 = featuresOf(row);
  // Confirm on a SUGGEST row, or on one confirmed only implicitly (the user's word counts more).
  if (patch.confirm === true && (row.match_status !== "confirmed" || f0.confirm?.source === "implicit")) {
    if (row.match_status !== "confirmed") set.match_status = "confirmed";
    confirmSource ??= "user";
  }
  if (!(set.printing_id ?? row.printing_id)) confirmSource = null;
  const at = actionStamp(db, now);
  if (confirmSource && !isCalibrationTruth(parse(row.calibration_truth, null))) {
    set.calibration_truth = JSON.stringify(labelOf({ ...row, ...set }, confirmSource, at));
  }
  const keys = Object.keys(set);
  if (keys.length) {
    // The edit becomes the last action; undo restores exactly these columns
    // (and features.confirm, kept under the pseudo key _confirm).
    const prev = Object.fromEntries([...keys, "last_action", "updated_at"].map((k) => [k, row[k]]));
    if (confirmSource) prev._confirm = f0.confirm ?? null;
    set.undo = JSON.stringify(prev);
    set.last_action = "edit";
    set.updated_at = at;
    const all = Object.keys(set);
    atomic(db, () => {
      db.prepare(`UPDATE scans SET ${all.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...all.map((k) => set[k]), row.id);
      if (confirmSource) {
        const f = featuresOf(getRow(db, row.id));
        // after: an implicit confirmation the user overrode (learning: how often it was wrong)
        f.confirm = { source: confirmSource, at, ...(f0.confirm?.source === "implicit" ? { after: "implicit" } : {}) };
        db.prepare("UPDATE scans SET features = ? WHERE id = ?").run(JSON.stringify(f), row.id);
      }
    });
  }
  return getScan(db, row.id);
}

/**
 * Delete a scan (and its images). createdAt (the client's copy of the row's created_at): scan ids
 * are reused, so a deferred delete (the UI's Discard with Undo) names the row it means; another
 * row under that id is refused with 409.
 */
export function deleteScan(db, id, { imageDir = defaultImageDir(), createdAt = null } = {}) {
  const row = getRow(db, id);
  if (!row) throw new ScanError(404, "Scan not found");
  if (createdAt != null && row.created_at !== createdAt) throw new ScanError(409, "This scan was replaced by a newer one; nothing deleted");
  db.prepare("DELETE FROM scans WHERE id = ?").run(row.id);
  removeFiles(row, imageDir);
  return { deleted: row.id };
}

/**
 * +1 copy of a staged scan (the "scan again" / duplicate path). An optional
 * `capture` record (the +1's capture record) is appended to features.capture_events
 * with the quantity it led to, so undoing this +1 drops it again. A +1 on a
 * row of a scan session implicitly confirms the session's other untouched
 * SUGGEST rows (the answer then carries `implicitly_confirmed`).
 */
export function incrementScan(db, id, { capture = null, now = Date.now() } = {}) {
  const row = requireStaged(db, id);
  const ts = actionStamp(db, now);
  const confirmed = atomic(db, () => {
    db.prepare("UPDATE scans SET quantity = MIN(999, quantity + 1), last_action = 'increment', undo = NULL, updated_at = ? WHERE id = ?").run(ts, row.id);
    const fresh = getRow(db, row.id);
    const c = capture == null ? null : sanitizeCapture(capture);
    if (c) appendCaptureEvent(db, fresh, { at: ts, event: "increment", q: fresh.quantity, capture: c });
    return confirmImplicitly(db, {
      session: sessionOf(row), except: row.id, oracleId: row.oracle_id ?? null, now,
      by: { scan: row.id, created_at: row.created_at, action: "increment", q: fresh.quantity },
    });
  });
  const scan = getScan(db, row.id);
  return confirmed.length ? { ...scan, implicitly_confirmed: confirmed } : scan;
}

// Undo of a +1 down to quantity q: the increment events above q go too.
function dropIncrementEvents(db, row, q) {
  const f = featuresOf(row);
  if (!Array.isArray(f.capture_events)) return;
  const keep = f.capture_events.filter((e) => !(e?.event === "increment" && Number(e.q) > q));
  if (keep.length === f.capture_events.length) return;
  f.capture_events = keep;
  db.prepare("UPDATE scans SET features = ? WHERE id = ?").run(JSON.stringify(f), row.id);
}

/**
 * Undo the last scan action: a +1 is taken back (quantity - 1), an edit
 * (quantity, finish, printing, condition) is reverted, a fresh scan is
 * removed. Returns {undone: 'decrement'|'revert'|'delete'|null, scan,
 * unconfirmed}: undoing a stage or a +1 also takes back the implicit
 * confirmations it caused (`unconfirmed` = those scan ids, SUGGEST again).
 */
export function undoLast(db, { imageDir = defaultImageDir() } = {}) {
  const last = newestStaged(db);
  if (!last) return { undone: null, scan: null, unconfirmed: [] };
  if (last.last_action === "edit") {
    const prev = parse(last.undo, null);
    if (!prev || typeof prev !== "object") {
      // Nothing to restore: never delete a scan the user just edited.
      db.prepare("UPDATE scans SET last_action = 'stage' WHERE id = ?").run(last.id);
      return { undone: null, scan: getScan(db, last.id), unconfirmed: [] };
    }
    const cols = Object.keys(prev).filter((k) => /^[a-z][a-z_]*$/.test(k) && k !== "id" && k !== "undo");
    atomic(db, () => {
      db.prepare(`UPDATE scans SET ${cols.map((k) => `${k} = ?`).join(", ")}, undo = NULL WHERE id = ?`)
        .run(...cols.map((k) => prev[k] ?? null), last.id);
      if ("_confirm" in prev) {
        const f = featuresOf(getRow(db, last.id));
        if (isPlain(prev._confirm)) f.confirm = prev._confirm;
        else delete f.confirm;
        db.prepare("UPDATE scans SET features = ? WHERE id = ?").run(JSON.stringify(f), last.id);
      }
    });
    return { undone: "revert", scan: getScan(db, last.id), unconfirmed: [] };
  }
  if (last.last_action === "increment" && last.quantity > 1) {
    const q = last.quantity - 1;
    const unconfirmed = atomic(db, () => {
      db.prepare("UPDATE scans SET quantity = ?, last_action = ?, undo = NULL WHERE id = ?").run(q, q > 1 ? "increment" : "stage", last.id);
      dropIncrementEvents(db, last, q);
      return revertImplicit(db, (by) => by.action === "increment" && by.scan === last.id && by.created_at === last.created_at && Number(by.q) > q);
    });
    return { undone: "decrement", scan: getScan(db, last.id), unconfirmed };
  }
  // The capture record outlives the row (an undone "new card" is a label too).
  const f = featuresOf(last);
  if (f.capture) {
    recordDropped(db, {
      reason: "undo", scan_id: last.id, result_status: last.match_status, printing_id: last.printing_id ?? null,
      store_printing_id: last.store_printing_id ?? null, capture: f.capture, capture_events: f.capture_events ?? [],
    });
  }
  const unconfirmed = atomic(db, () => {
    db.prepare("DELETE FROM scans WHERE id = ?").run(last.id);
    // what the stage and every +1 of the removed row confirmed
    return revertImplicit(db, (by) => by.scan === last.id && by.created_at === last.created_at);
  });
  removeFiles(last, imageDir);
  return { undone: "delete", scan: scanRow(last), unconfirmed };
}

// ---------------------------------------------------------------------------
// Recognition probes (v0.5.0 beta.2, "recognition-driven capture")
//
// While a card-like thing is in view the browser sends a probe (~1/s); the
// server identifies it locally (OCR + fingerprint, never Claude) and stages
// it only when it is identified (auto/suggest) AND differs from the card this
// probe session staged last (store printing; the finish only upgrades that
// row, see finishUpgrade). The same card again is
// ignored silently (decision 12: the user taps +1); an unidentified probe
// leaves nothing behind but a counter. The "last card" is the detected key,
// remembered per session in memory, so a Discard (DELETE), an undo or a
// printing fix of that row never makes the card still lying in the box come
// back a second later; after a restart it comes from the newest row of that
// session (features.probe.session + features.result). Probes never queue: a
// full identify slot answers 'busy' at once and the client simply probes
// again. They skip the duplicate window (they have their own rule) and never
// touch the last row's updated_at, so the window of normal scans stays as is.

/** Probe session ids: client-generated, [A-Za-z0-9-]{1,40} (the record-session id rule). */
export const PROBE_SESSION_RE = SESSION_ID_RE;
/** Identified statuses a probe stages. */
export const PROBE_STAGE_STATUSES = ["auto", "suggest"];
/** Counted outcomes of a probe. */
export const PROBE_OUTCOMES = ["staged", "same", "unidentified", "busy", "error"];
const PROBE_SESSIONS_MAX = 64;
const PROBE_MINUTES = 10;

/**
 * Shared identify slots (SCAN_MAX_CONCURRENT): normal scans and probes take
 * one each; tryAcquire() never waits.
 */
export function createScanSlots(max) {
  let used = 0;
  return {
    max,
    get used() { return used; },
    tryAcquire() { if (used >= max) return false; used++; return true; },
    release() { used = Math.max(0, used - 1); },
  };
}

/** Store printing + finish key of an identified result (null when nothing was identified). */
export function probeKey(result) {
  const store = result?.store || result?.printing;
  if (!store?.id || result.status === "failed") return null;
  return { store_printing_id: store.id, finish: clampFinish(result.finish) };
}

/**
 * A 'same' probe with a confident ★/• read (finish source 'star') fixes the
 * finish of the staged row it repeats when that row's finish was only a guess
 * (session toggle / unknown) and the user hasn't set it: finish voting across
 * probes of one card. The row's undo/last_action stay as they are. Returns
 * the updated scan, or null when nothing changed.
 */
export function finishUpgrade(db, scanId, result, key) {
  if (scanId == null || result?.finishSource !== "star") return null;
  const row = getRow(db, scanId);
  if (!row || row.status !== "staged" || row.store_printing_id !== key.store_printing_id) return null;
  if (row.finish_source === "user" || row.finish_source === "star" || row.finish_source === "finishes") return null;
  if (!storedFinishes(row.finishes).includes(key.finish)) return null;
  db.prepare("UPDATE scans SET finish = ?, finish_source = 'star' WHERE id = ?").run(key.finish, row.id);
  return getScan(db, row.id);
}

/**
 * Probe runner: session memory, the busy rule and per-minute outcome
 * counters (/healthz). `slots` = createScanSlots() shared with normal scans;
 * `warming()` true answers 'busy' while the fingerprint matcher is still
 * loading (a probe must not hold a slot for SCAN_MATCHER_WAIT_MS).
 */
export class ProbeRunner {
  constructor({ slots, warming = () => false, now = () => Date.now() } = {}) {
    this.slots = slots;
    this.warming = warming;
    this.now = now;
    this.sessions = new Map(); // session -> {store_printing_id, finish, scan_id, at}; LRU order
    this.inFlight = new Set(); // sessions with a probe running
    this.minutes = []; // [{t (minute start, ms), staged, same, unidentified, busy, error}]
    this.totals = Object.fromEntries(PROBE_OUTCOMES.map((k) => [k, 0]));
  }

  count(outcome) {
    const t = Math.floor(this.now() / 60000) * 60000;
    let m = this.minutes.at(-1);
    if (!m || m.t !== t) {
      m = { t, ...Object.fromEntries(PROBE_OUTCOMES.map((k) => [k, 0])) };
      this.minutes.push(m);
      while (this.minutes[0].t <= t - PROBE_MINUTES * 60000) this.minutes.shift();
    }
    m[outcome]++;
    this.totals[outcome]++;
  }

  /** Compact counters for /healthz: totals since start + the last 10 minutes (oldest first, idle minutes left out). */
  stats() {
    const since = Math.floor(this.now() / 60000) * 60000 - (PROBE_MINUTES - 1) * 60000;
    return {
      totals: { ...this.totals },
      per_minute: this.minutes.filter((m) => m.t >= since).map((m) => ({ ...m, t: new Date(m.t).toISOString() })),
      sessions: this.sessions.size,
      in_flight: this.inFlight.size,
    };
  }

  remember(session, key, scanId) {
    if (!session || !key) return;
    this.sessions.delete(session);
    this.sessions.set(session, { store_printing_id: key.store_printing_id, finish: key.finish, scan_id: scanId ?? null, at: this.now() });
    while (this.sessions.size > PROBE_SESSIONS_MAX) this.sessions.delete(this.sessions.keys().next().value);
  }

  /**
   * A normal scan (shutter, Rescan, Ask Claude) that carried the probe
   * session: its identified card (staged or a duplicate answer) becomes the
   * session's last card, so the next probe doesn't stage it a second time.
   */
  noteScan(session, result, scan) {
    if (!session || !scan) return;
    const key = probeKey(result);
    if (key && PROBE_STAGE_STATUSES.includes(result.status)) this.remember(session, key, scan.id);
  }

  // The card to compare against: the session's memory, else the newest row
  // of the session (after a restart), else the newest staged scan.
  lastKey(db, session) {
    if (session) {
      const mem = this.sessions.get(session);
      if (mem) return mem;
      const row = db.prepare(`SELECT id, features FROM scans WHERE json_extract(features, '$.probe.session') = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(session);
      const r = row ? featuresOf(row).result : null;
      if (r?.store_printing_id) return { store_printing_id: r.store_printing_id, finish: r.finish ?? "normal", scan_id: row.id };
    }
    const last = newestStaged(db);
    return last?.store_printing_id ? { store_printing_id: last.store_printing_id, finish: last.finish, scan_id: last.id } : null;
  }

  /**
   * Run one probe. `identify()` is the local identification (the caller makes
   * sure it cannot reach Claude); it only starts when a slot is free.
   * Returns {outcome, reason?, scan, result}: 'staged' (scan = the new row; confirmed = the session's SUGGEST rows it implicitly confirmed),
   * 'same' (nothing staged; scan = the repeated row when a ★/• read upgraded
   * its finish, + finish_upgraded), 'unidentified' (nothing stored), 'busy' (identify not run;
   * reason 'warming_up' | 'session' (this session's previous probe still
   * runs) | 'slots'), 'cancelled' (signal aborted during identify: nothing
   * staged, not counted). identify() errors are counted and rethrown.
   * opts: {session, image, strip, condition, capture, imageDir, signal, now}
   */
  async run(db, identify, opts = {}) {
    const session = opts.session ?? null;
    const busy = (reason) => { this.count("busy"); return { outcome: "busy", reason, scan: null, result: null }; };
    if (this.warming()) return busy("warming_up");
    if (session && this.inFlight.has(session)) return busy("session");
    if (!this.slots.tryAcquire()) return busy("slots");
    if (session) this.inFlight.add(session);
    let result;
    try {
      result = await identify();
    } catch (err) {
      this.count("error");
      throw err;
    } finally {
      this.slots.release();
      if (session) this.inFlight.delete(session);
    }
    if (opts.signal?.aborted) return { outcome: "cancelled", scan: null, result };
    const key = PROBE_STAGE_STATUSES.includes(result?.status) ? probeKey(result) : null;
    if (!key) {
      this.count("unidentified");
      return { outcome: "unidentified", scan: null, result };
    }
    // Synchronous from here on: two probes finishing together can't both stage.
    // Same card = same store printing; the finish is NOT part of the key (★/• reads vary between
    // probes of one card: with it a replay of recorded sessions staged 14-56 duplicates). A confident ★/• read
    // upgrades the staged row's finish instead (finishUpgrade).
    const last = this.lastKey(db, session);
    if (last && last.store_printing_id === key.store_printing_id) {
      const upgraded = finishUpgrade(db, last.scan_id, result, key);
      this.remember(session, key, last.scan_id);
      this.count("same");
      return { outcome: "same", scan: upgraded, result, ...(upgraded ? { finish_upgraded: true } : {}) };
    }
    const staged = stageScan(db, result, {
      // A card found upside down is stored turned upright (identifyOriented's re-encode).
      image: result.upright?.card ?? opts.image ?? null, strip: result.upright?.strip ?? opts.strip ?? null, force: true, condition: opts.condition, capture: opts.capture ?? null,
      calibration: opts.calibration === true, probe: { session }, imageDir: opts.imageDir ?? defaultImageDir(), now: opts.now,
    });
    this.remember(session, key, staged.scan?.id);
    this.count("staged");
    return { outcome: "staged", scan: staged.scan, result, confirmed: staged.confirmed ?? [] };
  }
}


// Calibration

/**
 * Record the true printing + finish of a scan (calibration). For a staged scan
 * the scan itself is corrected too.
 */
export function recordTruth(db, id, { printing_id, finish } = {}, { idx, index = indexModule } = {}) {
  finish = normFinish(finish);
  const row = getRow(db, id);
  if (!row) throw new ScanError(404, "Scan not found");
  if (!printing_id) throw new ScanError(400, "printing_id is required");
  if (finish != null && !FINISHES.includes(finish)) throw new ScanError(400, `finish must be one of ${FINISHES.join(", ")}`);
  const p = idx ? index.getPrinting(idx, String(printing_id)) : null;
  if (idx && !p) throw new ScanError(400, "Unknown printing");
  const truth = {
    printing_id: String(printing_id), finish: finish ?? row.finish,
    oracle_id: p?.oracle_id ?? null, name: p?.name ?? null, set_code: p?.set_code ?? null,
    collector_number: p?.collector_number ?? null, lang: p?.lang ?? null, recorded_at: nowIso(), source: "calibration",
    detected_status: featuresOf(row).result?.status ?? null,
  };
  db.prepare("UPDATE scans SET calibration_truth = ?, calibration = 1 WHERE id = ?").run(JSON.stringify(truth), row.id);
  if (row.status === "staged" && p) {
    const patch = {};
    if (p.id !== row.printing_id) patch.printing_id = p.id;
    if (finish != null && finish !== row.finish) patch.finish = finish;
    try {
      if (Object.keys(patch).length) updateScan(db, row.id, patch, { idx, index });
      else updateScan(db, row.id, { confirm: true }, { idx, index });
    } catch (err) {
      if (!(err instanceof ScanError)) throw err;
      // e.g. the truth's finish is not in the stored printing: keep the truth anyway.
    }
  }
  return getScan(db, row.id);
}
