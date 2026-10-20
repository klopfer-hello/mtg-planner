// Collection routes: stats, search and sections, card detail, set completion,
// CSV export, ManaBox import, text card lists, moving/editing/deleting copies
// with the edit log and its undo, price refresh and the import log. Every
// write runs under app.exclusive() (one import or collection change at a time).

import { collectionMaster, defaultImportMode, findBinder, MAX_BINDER_NAME, moveCopies } from "../../lib/binders.js";
import { EXPORT_FORMATS, exportCollection } from "../../lib/collectionexport.js";
import { cardPrice, setAppMeta, stats } from "../../lib/db.js";
import { cardUsage } from "../../lib/allocation.js";
import { eurForFinish } from "../../lib/prices.js";
import { deleteCopies, editCopies, listEdits, relanguageScans, undoEdit } from "../../lib/edits.js";
import { addCardList, resolveCardList } from "../../lib/listimport.js";
import { IMPORT_MODES, importManaBoxCsv, refreshOwnedCards } from "../../lib/manabox.js";
import { QUERY_HELP, SECTION_BYS, collectionSections, searchCollection } from "../../lib/query.js";
import { listSets, setDetail } from "../../lib/sets.js";
import { throwImportError } from "../errors.js";
import { HttpError, attachment, contentType, optString, parseJsonField, readBody, readJson, sendJson } from "../http.js";

const CSV_LIMIT = 25 * 1024 * 1024;

/** ?binder= (exact, case-insensitive; present but empty = Unsorted), null when absent. */
const binderParam = (query) => (query.has("binder") ? query.get("binder").slice(0, 200) : null);

/** Query syntax errors (lib/query.js) are the user's: 400. */
function querying(fn) {
  try { return fn(); } catch (err) { throw new HttpError(400, err.message); }
}

/** HTTP callers may only act as the app (Claude edits through MCP). */
function requireAppActor(body) {
  if (body.actor !== undefined && body.actor !== "app") throw new HttpError(400, 'actor must be "app"');
}

export function collectionRoutes(router, app) {
  const { scanner } = app;

  function cardDetail(id) {
    const db = app.db;
    const card = db.prepare("SELECT * FROM cards WHERE scryfall_id = ?").get(id);
    if (!card) throw new HttpError(404, "Card not found");
    card.prices = parseJsonField(card.prices, {});
    card.legalities = parseJsonField(card.legalities, {});
    card.keywords = parseJsonField(card.keywords, []);
    card.price = cardPrice(card);
    const owned = db.prepare(
      `SELECT col.id, c.scryfall_id, c.set_code, c.set_name, c.collector_number, col.finish, col.language,
              col.condition, col.binder, col.source, col.quantity, c.image_small, c.prices
         FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
        WHERE c.oracle_id = ?
        ORDER BY c.set_code, c.collector_number, col.finish, col.binder COLLATE NOCASE, col.source`,
    ).all(card.oracle_id).map(({ prices, ...r }) => ({ ...r, price_eur: eurForFinish(prices, r.finish) })); // EUR per copy (English twin fallback)
    const decks = db.prepare(
      `SELECT d.id, d.name, d.status, dc.board, SUM(dc.quantity) AS quantity
         FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
         LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
        WHERE c.oracle_id = ? OR (dc.scryfall_id IS NULL AND dc.name = ? COLLATE NOCASE)
        GROUP BY d.id, dc.board
        ORDER BY d.updated_at DESC`,
    ).all(card.oracle_id, card.name);
    return { card, owned, decks, usage: cardUsage(db, { oracle_id: card.oracle_id, name: card.name }) };
  }

  router.get("/api/stats", ({ query }) => stats(app.db, { binder: binderParam(query) }));
  router.get("/api/query-help", () => ({ help: QUERY_HELP }));

  router.get("/api/collection", ({ query }) => {
    const group = query.get("group") === "printing" ? "printing" : "card";
    const limit = Math.min(Math.max(parseInt(query.get("limit"), 10) || 60, 1), 500);
    const offset = Math.max(parseInt(query.get("offset"), 10) || 0, 0);
    const dir = query.get("dir") === "asc" || query.get("dir") === "desc" ? query.get("dir") : undefined;
    // ?section_by=set|color|rarity|type&section=<key>: one section of GET /api/collection/sections.
    const section = query.has("section_by") ? { by: query.get("section_by"), key: (query.get("section") || "").slice(0, 200) } : null;
    const result = querying(() => searchCollection(app.db, {
      q: query.get("q") || "", group, sort: query.get("sort") || "name", dir, limit, offset, binder: binderParam(query), section,
    }));
    for (const row of result.rows) {
      row.prices = parseJsonField(row.prices, {});
      // Price of the row's representative (most valuable) owned printing+finish.
      row.price = cardPrice(row, row.finish || "normal");
    }
    return result;
  });

  // Section headers (binder detail page): ?by=set|color|rarity|type plus the q/group/binder of /api/collection.
  router.get("/api/collection/sections", ({ query }) => {
    const by = query.get("by") || "set";
    if (!SECTION_BYS.includes(by)) throw new HttpError(400, `by must be one of ${SECTION_BYS.join(", ")}`);
    const group = query.get("group") === "printing" ? "printing" : "card";
    return querying(() => collectionSections(app.db, { q: query.get("q") || "", group, binder: binderParam(query), by }));
  });

  // The owned copies as CSV: ?format=manabox (ManaBox's export layout, default) | csv (plain sheet), ?binder= ('' = Unsorted).
  router.get("/api/collection/export", ({ res, query }) => {
    const format = query.get("format") || "manabox";
    if (!EXPORT_FORMATS.includes(format)) throw new HttpError(400, `format must be ${EXPORT_FORMATS.join(" or ")}`);
    const binder = query.has("binder") ? query.get("binder") : null;
    const { text } = exportCollection(app.db, { format, binder });
    const base = binder == null ? "mtg-planner collection" : `mtg-planner ${binder || "Unsorted"}`;
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": attachment(base, "csv", "collection") });
    res.end(text);
  });

  // Set completion (lib/sets.js; the set lists come from the card index through the worker).
  const requireSetIndex = () => { if (!scanner.idx) throw new HttpError(503, "The card index is not ready yet"); };
  router.get("/api/sets", ({ query }) => {
    requireSetIndex();
    return listSets(app.db, scanner.indexLookup, { all: query.get("all") === "1" });
  });
  router.get("/api/sets/:code([a-zA-Z0-9]{2,8})", async ({ params }) => {
    requireSetIndex();
    const detail = await setDetail(app.db, scanner.indexLookup, params.code);
    if (!detail) throw new HttpError(404, "Unknown set");
    return detail;
  });

  router.get("/api/cards/:id([0-9a-fA-F-]{36})", ({ params }) => cardDetail(params.id.toLowerCase()));
  router.notFound("/api/cards/:rest(.*)", "Card not found");

  router.post("/api/import/manabox", async ({ req, query }) => {
    const db = app.db;
    const mode = query.get("mode") || defaultImportMode(db);
    if (!IMPORT_MODES.includes(mode)) throw new HttpError(400, 'mode must be "replace", "delta" or "add"');
    // Once the app is the collection master, a replace would undo nothing the
    // app manages (source app/scan) but still wipes every ManaBox row: ask first.
    if (mode === "replace" && collectionMaster(db) === "app" && query.get("confirm_replace") !== "1") {
      req.resume();
      throw new HttpError(409, "mtg-planner is the master of your collection: a replace import deletes every card imported from ManaBox " +
        "and loads the file instead (cards you scanned or moved in the app stay, and moved copies are not loaded a second time). Confirm with confirm_replace=1, or import with mode=delta.",
        { code: "confirm_replace" });
    }
    const filename = (query.get("filename") || "").slice(0, 255) || null;
    // binder (optional): put every card of this import into one binder; present but empty =
    // Unsorted. A binder that doesn't exist yet needs create_binder=1 (a typo shouldn't make one).
    let targetBinder = null;
    if (query.has("binder")) {
      const name = String(query.get("binder")).trim();
      if (name.length > MAX_BINDER_NAME) throw new HttpError(400, `Binder name is too long (max ${MAX_BINDER_NAME})`);
      targetBinder = name ? findBinder(db, name) : "";
      if (targetBinder == null) {
        if (query.get("create_binder") !== "1") { req.resume(); throw new HttpError(404, `Binder "${name}" not found (send create_binder=1 to create it)`); }
        targetBinder = name;
      }
    }
    // text/csv is not a CORS-safelisted type; text/plain is accepted only with
    // the SPA's X-Requested-With header (which also forces a preflight).
    const type = contentType(req);
    if (!(type === "text/csv" || (type === "text/plain" && req.headers["x-requested-with"]))) {
      throw new HttpError(415, "Content-Type must be text/csv");
    }
    const text = (await readBody(req, CSV_LIMIT)).toString("utf8");
    if (!text.trim()) throw new HttpError(400, "The CSV file is empty.");
    const since = app.sqlNow();
    const summary = await app.exclusive(() => importManaBoxCsv(app.db, text, { mode, filename, targetBinder }).catch(throwImportError));
    app.scheduleChangedDecks(since); // rebuilt ManaBox decks
    return summary;
  });

  router.post("/api/collection/move", async ({ req }) => {
    const body = await readJson(req);
    return app.exclusive(async () => moveCopies(app.db, body));
  });

  // Edit / delete owned copies, the edit log and its undo (lib/edits.js). Like moves they wait
  // for imports and price refreshes (exclusive) and run in one transaction each.
  router.post("/api/collection/edit", async ({ req }) => {
    const body = await readJson(req);
    requireAppActor(body);
    return app.exclusive(() => editCopies(app.db, {
      items: body.items, set: body.set, confirm_master: body.confirm_master === true, actor: "app",
    }, { getPrinting: scanner.printingLookup() }));
  });

  // A text card list (e.g. a bought precon) into the collection, optionally also as a built deck
  // (lib/listimport.js). Printings are looked up first (Scryfall), then written under the lock.
  router.post("/api/collection/import-list", async ({ req, res }) => {
    const body = await readJson(req);
    const text = optString(body.text, "text", 200000) || "";
    if (!text.trim()) throw new HttpError(400, "The list is empty");
    const deck = body.deck && typeof body.deck === "object" ? { name: optString(body.deck.name, "deck name", 200), format: optString(body.deck.format, "format", 50) } : null;
    const resolved = await resolveCardList(app.db, text);
    const out = await app.exclusive(async () => addCardList(app.db, resolved, {
      binder: typeof body.binder === "string" ? body.binder.slice(0, 100) : "", create: body.create !== false,
      language: body.language || "en", condition: body.condition || "near_mint", deck,
    }));
    if (out.deck_id) app.scheduleSpellbook(out.deck_id);
    sendJson(res, 201, out);
  });

  router.post("/api/collection/delete", async ({ req }) => {
    const body = await readJson(req);
    requireAppActor(body);
    return app.exclusive(async () => deleteCopies(app.db, {
      items: body.items, confirm: body.confirm, expected_copies: body.expected_copies ?? null,
      confirm_master: body.confirm_master === true, actor: "app",
    }));
  });
  router.get("/api/collection/edits", ({ query }) => ({ edits: listEdits(app.db, { limit: query.get("limit") || 50 }) }));
  router.post("/api/collection/edits/:id(\\d+)/undo", ({ params }) => app.exclusive(async () => undoEdit(app.db, Number(params.id))));

  router.post("/api/maintenance/relanguage-scans", async ({ req }) => {
    const body = await readJson(req);
    const dryRun = body.dry_run === undefined ? true : body.dry_run;
    return app.exclusive(() => relanguageScans(app.db, { scan_ids: body.scan_ids, dry_run: dryRun }, { getPrinting: scanner.printingLookup() }));
  });

  router.post("/api/refresh-prices", async () => {
    const result = await app.exclusive(() => refreshOwnedCards(app.db).catch(throwImportError));
    setAppMeta(app.db, "last_price_refresh", new Date().toISOString());
    return result;
  });

  router.get("/api/imports", () => {
    const rows = app.db.prepare("SELECT id, kind, filename, mode, summary, created_at FROM imports ORDER BY id DESC LIMIT 20").all();
    return rows.map((r) => ({ ...r, summary: parseJsonField(r.summary, {}) }));
  });
}
