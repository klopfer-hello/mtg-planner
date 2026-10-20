// Scanner routes: identify a card photo (normal scan with Claude fallback, or
// a recognition probe without Claude), the staging list (edit, +1, undo,
// truth, images, commit), manual staging, printing lookups for the pickers,
// the card index jobs and the calibration export.

import { claudeConfigured, runVision, visionCap } from "../../lib/claude.js";
import { STORE_AS_SCANNED } from "../../lib/cardindex.js";
import { checkJpegSize } from "../../lib/fingerprint.js";
import { learningReport } from "../../lib/learning.js";
import { decideFinish, identifyOriented, printingSummary, scanPriceEur } from "../../lib/scanner.js";
import {
  CONDITIONS, LABEL_SOURCES, PROBE_SESSION_RE, captureLog, commitScans, deleteScan, exportCalibration, getScan, incrementScan,
  listScans, normFinish, priceScans, probeKey, recordTruth, scanImagePath, scanStripPath, stageScan, undoLast, updateScan,
} from "../../lib/scans.js";
import { throwImportError } from "../errors.js";
import { HttpError, optString, readJson, sendEmpty, sendFile, sendJson } from "../http.js";

const SCAN_LIMIT = 12 * 1024 * 1024;
// /increment body ({capture}): the record is cut to 4 KB by sanitizeCapture;
// the raw body may be a bit larger (a chip record with its evidence).
const INCREMENT_LIMIT = 16 * 1024;
// Declared JPEG size caps for uploads (djpeg writes the full declared raster).
const MAX_CARD_PIXELS = 6_000_000; // the browser sends 1000x1400
const MAX_STRIP_PIXELS = 20_000_000;
// "scanned" (STORE_AS_SCANNED, the default): keep the detected printing and its language.
const STORAGE_LANGS = [STORE_AS_SCANNED, "en", "de", "fr", "it", "es", "pt", "ja", "ko", "ru", "zhs", "zht"];

function decodeImage(v, field, { required = true, maxPixels } = {}) {
  if (v == null || v === "") {
    if (required) throw new HttpError(400, `${field} is required (base64 JPEG)`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a base64 string`);
  const buf = Buffer.from(v.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new HttpError(400, `${field} is not a JPEG image`);
  try {
    checkJpegSize(buf, maxPixels);
  } catch (err) {
    throw new HttpError(400, `${field}: ${err.message}`);
  }
  return buf;
}

function scanSettings(raw = {}) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "settings must be an object");
  const storageLang = raw.storageLang ?? STORE_AS_SCANNED;
  if (!STORAGE_LANGS.includes(storageLang)) throw new HttpError(400, `settings.storageLang must be one of ${STORAGE_LANGS.join(", ")}`);
  const foil = raw.foil ?? "auto";
  if (!["auto", "foil", "nonfoil"].includes(foil)) throw new HttpError(400, "settings.foil must be auto, foil or nonfoil");
  const setHint = raw.setHint ? String(raw.setHint).trim().toLowerCase() : null;
  if (setHint && !/^[a-z0-9]{2,8}$/.test(setHint)) throw new HttpError(400, "settings.setHint must be a set code");
  const condition = raw.condition ?? "near_mint";
  if (!CONDITIONS.includes(condition)) throw new HttpError(400, `settings.condition must be one of ${CONDITIONS.join(", ")}`);
  // precise: the client tracked a stable quad (not a fallback crop); the scanner then hashes 9 query variants, not 27.
  if (raw.precise != null && typeof raw.precise !== "boolean") throw new HttpError(400, "settings.precise must be a boolean");
  return { storageLang, foil, setHint, condition, precise: raw.precise === true };
}

/** ?source=a,b of the calibration export: label sources to include (null = all; unknown names 400). */
function calibrationSources(query) {
  const raw = query.get("source");
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !LABEL_SOURCES.includes(s));
  if (bad.length) throw new HttpError(400, `source must be one of ${LABEL_SOURCES.join(", ")}`);
  return list;
}

/** Optional capture-controller fields of a scan request: {capture, dupOf}. */
function captureFields(body) {
  const capture = body.capture ?? null;
  if (capture !== null && (typeof capture !== "object" || Array.isArray(capture))) throw new HttpError(400, "capture must be an object");
  const dupOf = body.dup_of == null ? null : Number(body.dup_of);
  if (dupOf != null && !(Number.isInteger(dupOf) && dupOf > 0)) throw new HttpError(400, "dup_of must be a scan id");
  return { capture, dupOf };
}

/** body.probe_session: optional client-generated id ([A-Za-z0-9-]{1,40}). */
function probeSession(body) {
  const v = body.probe_session;
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !PROBE_SESSION_RE.test(v)) throw new HttpError(400, "probe_session must be 1-40 letters, digits or dashes");
  return v;
}

/** identify() result without the bulky calibration features. */
function resultSummary(r) {
  return {
    status: r.status,
    method: r.method,
    confidence: r.confidence,
    finish: r.finish,
    finishSource: r.finishSource,
    lang_detected: r.lang_detected,
    printing: printingSummary(r.printing),
    store: printingSummary(r.store),
    candidates: r.candidates,
    variants: r.variants,
    claude_used: r.claude_used,
    claude: r.features?.claude ? { skipped: r.features.claude.skipped ?? null, resets_at: r.features.claude.resets_at ?? null, verdict: r.features.claude.verdict ?? null } : null,
    reasons: r.features?.local?.reasons ?? [],
    errors: r.features?.errors ?? [],
    timings: r.timings,
  };
}

export function scanRoutes(router, app) {
  const { scanner } = app;
  const { indexLookup, prober, scanSlots } = scanner;

  /** The uploaded photo + strip and settings, after the index checks every identify needs. */
  function scanInput(body) {
    scanner.requireIndex();
    if (!scanner.indexReady()) throw new HttpError(503, "The card index is still being built; try again when it is ready");
    return {
      card: decodeImage(body.card, "card", { maxPixels: MAX_CARD_PIXELS }),
      strip: decodeImage(body.strip, "strip", { required: false, maxPixels: MAX_STRIP_PIXELS }),
    };
  }

  /** identifyOriented with the scanner's index and matcher; Claude only with `vision` (and allowClaude). */
  async function identify({ card, strip, settings, signal, vision, allowClaude }) {
    await scanner.loadSetCodes().catch(() => null);
    return identifyOriented(
      { db: app.db, idx: scanner.idx, index: scanner.scanIndex, matcher: scanner.readyMatcher(), signal, claude: { runVision: vision ? runVision : null, cap: visionCap } },
      { card, strip, settings: { ...settings, allowClaude } },
    );
  }

  const priceOf = (result) => scanPriceEur(result, { db: app.db, lookupEn: (p) => indexLookup("storagePrinting", p, "en").catch(() => null) });

  async function postScan(req, res) {
    // A client that gives up (UI timeout/cancel, closed tab) cancels the scan:
    // no Claude call is started or kept running, and nothing is staged, so a
    // Retry can never stage the same card twice.
    const gone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) gone.abort(new Error("client closed the request")); });
    const body = await readJson(req, SCAN_LIMIT);
    if (body.mode != null && !["scan", "probe"].includes(body.mode)) throw new HttpError(400, "mode must be scan or probe");
    const session = probeSession(body);
    const { capture, dupOf } = captureFields(body);
    if (body.mode === "probe") return postProbe(body, { gone, session, capture });
    const { card, strip } = scanInput(body);
    const replaceId = body.replace_id == null ? null : Number(body.replace_id);
    if (replaceId != null && !(Number.isInteger(replaceId) && replaceId > 0)) throw new HttpError(400, "replace_id must be a scan id");
    const settings = scanSettings(body.settings ?? {});
    if (!scanSlots.tryAcquire()) throw new HttpError(429, "Still identifying the previous scans; try again shortly");
    let result;
    try {
      // Upside-down cards are retried turned by 180° (the stored photo is then upright).
      result = await identify({ card, strip, settings, signal: gone.signal, vision: claudeConfigured(), allowClaude: body.allowClaude !== false });
    } finally {
      scanSlots.release();
    }
    if (gone.signal.aborted) throw new HttpError(499, "Scan cancelled: the client closed the request");
    const staged = stageScan(app.db, result, {
      image: result.upright?.card ?? card, strip: result.upright?.strip ?? strip, force: body.force === true, condition: settings.condition,
      calibration: body.calibration === true, replaceId, dupOf, capture, session,
    });
    // A shutter scan inside a probe session: the next probe compares against it.
    prober.noteScan(session, result, staged.scan);
    // EUR price of the stored printing + finish: the UI picks the scan sound by it.
    const price = await priceOf(result);
    // implicitly_confirmed: the session's SUGGEST rows this new card settled (lib/scans.js confirmImplicitly).
    return { scan: staged.scan, duplicate: staged.duplicate, implicitly_confirmed: staged.confirmed ?? [], result: { ...resultSummary(result), ...price } };
  }

  /**
   * Recognition probe (body.mode 'probe'): local identification only (never
   * Claude), staged only when identified and not the session's last card; see
   * ProbeRunner in lib/scans.js. Always 200: {probe, outcome, reason?, scan?,
   * finish_upgraded?, result}. 'busy' answers at once (no queueing behind slow scans).
   */
  async function postProbe(body, { gone, session, capture }) {
    const { card, strip } = scanInput(body);
    const settings = scanSettings(body.settings ?? {});
    const out = await prober.run(app.db, () => identify({ card, strip, settings, signal: gone.signal, vision: false, allowClaude: false }), {
      session, image: card, strip, condition: settings.condition, calibration: body.calibration === true, capture, signal: gone.signal,
    });
    if (out.outcome === "cancelled") throw new HttpError(499, "Probe cancelled: the client closed the request");
    const response = {
      probe: true, outcome: out.outcome, ...(out.reason ? { reason: out.reason } : {}), ...(out.scan ? { scan: out.scan } : {}),
      ...(out.finish_upgraded ? { finish_upgraded: true } : {}),
      ...(out.confirmed?.length ? { implicitly_confirmed: out.confirmed } : {}),
    };
    const r = out.result;
    if (!r) return { ...response, result: null };
    const status = r.printing ? r.status ?? "failed" : "failed";
    // Unidentified: only the status (a REVIEW guess is not something to show).
    if (out.outcome === "unidentified") return { ...response, result: { status, timings: r.timings ?? null } };
    const p = r.store || r.printing;
    const price = await priceOf(r);
    return {
      ...response,
      result: {
        status, name: p.name ?? null, printing_id: r.printing.id, store_printing_id: p.id, finish: probeKey(r)?.finish ?? null,
        confidence: r.confidence ?? null, price_eur: price.price_eur ?? null, timings: r.timings ?? null,
      },
    };
  }

  /** POST /api/scans/manual {printing_id, finish?, quantity?, storageLang?, condition?}: stage a picked printing. */
  async function postManualScan(req) {
    const body = await readJson(req);
    scanner.requireIndex();
    const printingId = optString(body.printing_id, "printing_id", 64);
    if (!printingId) throw new HttpError(400, "printing_id is required");
    const printing = await indexLookup("getPrinting", printingId);
    if (!printing) throw new HttpError(404, "Printing not found");
    const wanted = normFinish(body.finish);
    const settings = scanSettings({ storageLang: body.storageLang, condition: body.condition, foil: wanted === "foil" ? "foil" : "auto" });
    const store = (await indexLookup("storagePrinting", printing, settings.storageLang)) || printing;
    let finish = decideFinish(store, { foilMode: settings.foil }).finish;
    if (wanted != null) {
      if (!["normal", "foil", "etched"].includes(wanted)) throw new HttpError(400, "finish must be normal, foil or etched");
      finish = wanted;
    }
    const quantity = body.quantity == null ? 1 : Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new HttpError(400, "quantity must be 1-999");
    let variants = [];
    try { variants = (await indexLookup("variantsOf", printing)).map((p) => printingSummary(p)); } catch { variants = []; }
    const result = {
      status: "manual", printing, store, finish, finishSource: "user", method: "manual", confidence: 1,
      candidates: [], variants, quantity, features: { manual: true, settings: { storageLang: settings.storageLang } },
    };
    const staged = stageScan(app.db, result, { force: true, condition: settings.condition });
    // Keep the chosen finish even when it is not listed (the row is the user's call).
    if (staged.scan && staged.scan.finish !== finish) app.db.prepare("UPDATE scans SET finish = ? WHERE id = ?").run(finish, staged.scan.id);
    return getScan(app.db, staged.scan.id);
  }

  async function sendScanImage(req, res, id, kind) {
    const file = kind === "strip" ? scanStripPath(app.db, id) : scanImagePath(app.db, id);
    if (!file) throw new HttpError(404, `No ${kind} stored for this scan`);
    try {
      return await sendFile(req, res, file, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
    } catch (err) {
      if (res.headersSent) throw err;
      throw new HttpError(404, `No ${kind} stored for this scan`);
    }
  }

  router.post("/api/scan", ({ req, res }) => postScan(req, res));
  router.get("/api/scans", async ({ query }) => {
    const status = query.get("status") || "staged";
    if (!["staged", "committed", "all"].includes(status)) throw new HttpError(400, "status must be staged, committed or all");
    // Rows carry price_eur; the staged list also its totals (the scanner's running value).
    const scans = listScans(app.db, { status });
    const totals = await priceScans(app.db, scans, { indexPrices: scanner.indexPrices() });
    return status === "staged" ? { scans, totals: { staged: totals } } : { scans };
  });
  router.post("/api/scans/undo", () => undoLast(app.db));
  router.get("/api/scans/capture-log", () => captureLog(app.db));
  router.get("/api/scans/learning", () => learningReport(app.db));
  router.post("/api/scans/manual", async ({ req, res }) => sendJson(res, 201, await postManualScan(req)));
  router.post("/api/scans/commit", async ({ req }) => {
    const body = await readJson(req);
    const since = app.sqlNow();
    const result = await app.exclusive(() => commitScans(app.db, body.ids, body.target, { idx: scanner.idx }).catch(throwImportError));
    if (body.target?.type === "deck") app.scheduleChangedDecks(since);
    return result;
  });

  const SCAN = "/api/scans/:id(\\d+)";
  router.get(`${SCAN}/image`, ({ req, res, params }) => sendScanImage(req, res, Number(params.id), "image"));
  router.get(`${SCAN}/strip`, ({ req, res, params }) => sendScanImage(req, res, Number(params.id), "strip"));
  router.post(`${SCAN}/increment`, async ({ req, params }) => {
    const body = await readJson(req, INCREMENT_LIMIT);
    const { capture } = captureFields({ capture: body.capture });
    return incrementScan(app.db, Number(params.id), { capture });
  });
  router.post(`${SCAN}/truth`, async ({ req, params }) => {
    const body = await readJson(req);
    return recordTruth(app.db, Number(params.id), { printing_id: body.printing_id, finish: body.finish }, { idx: scanner.idx });
  });
  router.get(SCAN, ({ params, query }) => {
    const scan = getScan(app.db, Number(params.id), { features: query.get("features") === "1" });
    if (!scan) throw new HttpError(404, "Scan not found");
    return scan;
  });
  router.patch(SCAN, async ({ req, params }) => {
    const body = await readJson(req);
    const patch = {};
    for (const k of ["printing_id", "finish", "quantity", "condition", "store_lang", "confirm"]) if (body[k] !== undefined) patch[k] = body[k];
    return updateScan(app.db, Number(params.id), patch, { idx: scanner.idx });
  });
  router.delete(SCAN, ({ res, params, query }) => {
    deleteScan(app.db, Number(params.id), { createdAt: query.get("created_at") || null });
    sendEmpty(res);
  });

  // Printing pickers (card index).
  router.get("/api/printings", async ({ query }) => {
    scanner.requireIndex();
    const oracleId = query.get("oracle_id");
    if (!oracleId) throw new HttpError(400, "oracle_id is required");
    const lang = query.get("lang") || undefined;
    return (await indexLookup("printingsOf", oracleId, { lang })).slice(0, 400).map((p) => printingSummary(p));
  });
  router.get("/api/printings/search", async ({ query }) => {
    scanner.requireIndex();
    const q = (query.get("q") || "").trim().slice(0, 200);
    if (q.length < 2) return [];
    const lang = query.get("lang") || undefined;
    const hits = await indexLookup("searchTitle", q, { lang, limit: 12 });
    const printings = await Promise.all(hits.map((h) => indexLookup("getPrinting", h.id)));
    return hits.map((h, i) => ({ ...h, printing: printingSummary(printings[i]) }));
  });

  // Card index jobs.
  router.get("/api/index/status", async () => {
    scanner.requireIndex();
    const { indexJob } = scanner;
    return {
      ...(await indexLookup("indexStatus")),
      job: indexJob.running,
      last_job: indexJob.last,
      refresh_job: indexJob.running?.kind === "refresh" ? indexJob.running : indexJob.last?.kind === "refresh" ? indexJob.last : null,
      claude: { configured: claudeConfigured(), per_hour: visionCap.limit, remaining: visionCap.remaining() },
      scheduler: app.scheduler.status(),
    };
  });
  router.post("/api/index/refresh", ({ res }) => sendJson(res, 202, { started: scanner.startIndexJob("refresh") }));
  router.post("/api/index/fingerprints", ({ res }) => sendJson(res, 202, { started: scanner.startIndexJob("fingerprints") }));

  router.get("/api/calibration/export", ({ res, query }) => {
    const scans = exportCalibration(app.db, { sources: calibrationSources(query) });
    const data = JSON.stringify({ exported_at: new Date().toISOString(), version: app.version, scans }, null, 1);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="scanner-calibration.json"',
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}
