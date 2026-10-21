// Deck routes: list/create/read/update/delete, cards and commander edits, deck
// power (combos, evaluate), the deck box (to-binder), the build checklist and
// version history, the deck guide (Claude, in the background) + its PDF, and
// the text exports (decklist, To buy, the global shopping list).

import { generateGuide, guideMeta, latestGuide } from "../../lib/deckguide.js";
import { fetchGuideImages, renderGuidePdf } from "../../lib/guidepdf.js";
import { DECK_STATUSES, normalizeFormat, parseDecklist } from "../../lib/deckrules.js";
import { addDeckCard, bulkDeckCards, setCommander, updateDeckCard } from "../../lib/deckedit.js";
import { bracketVerdict, deckComboRequest, evaluateDraft } from "../../lib/deckpower.js";
import { buyListText, exportDeck } from "../../lib/decktext.js";
import { deckDetail, listDecks, saveDeck, shoppingList } from "../../lib/decks.js";
import { deckToBinder } from "../../lib/binders.js";
import { buildChecklist, clearBuildPicks, pickedKeys, setBuildPick } from "../../lib/deckbuild.js";
import { deckVersion, listDeckVersions, recordDeckVersion, restoreDeckVersion } from "../../lib/deckhistory.js";
import { transaction } from "../../lib/db.js";
import { backoffUntil, spellbookSettings } from "../../lib/spellbook.js";
import { claudeConfigured, runGuide } from "../../lib/claude.js";
import { wishlistShopping } from "../../lib/wishlist.js";
import { throwImportError } from "../errors.js";
import { HttpError, attachment, optString, parseJsonField, readJson, sendEmpty, sendJson, sendTextFile } from "../http.js";

const ID = ":id(\\d+)";
// Language of the second card name on the build list (`local_name`); '' turns it off.
const CARD_NAME_LANG = process.env.CARD_NAME_LANG ?? "de";

/** Optional bracket_declared from a body: undefined = not given, null = auto, 1-5. */
function bracketDeclared(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!Number.isInteger(v) || v < 1 || v > 5) throw new HttpError(400, "bracket_declared must be 1-5 or null (auto)");
  return v;
}

/** Optional deck status from a request body: undefined/null = not given. */
function deckStatus(v) {
  if (v == null) return null;
  if (!DECK_STATUSES.includes(v)) throw new HttpError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  return v;
}

export function deckRoutes(router, app) {
  const { scanner } = app;
  // Deck guides (lib/deckguide.js): one generation per deck at a time, in the background (Claude takes
  // 30-90 s). The facts-only guide (no Claude token, or {facts_only: true}) is made at once.
  const { guideJobs } = app; // deck id -> {started_at}; a restore waits while one runs
  const guideErrors = new Map(); // deck id -> {at, error} of the last failed Claude part

  const requireDeck = (id) => {
    if (!app.db.prepare("SELECT 1 FROM decks WHERE id = ?").get(id)) throw new HttpError(404, "Deck not found");
  };

  /** The deck detail the UI shows; starts the background fetches it misses (combos, tokens). */
  function getDeckOr404(id) {
    const detail = deckDetail(app.db, id);
    if (!detail) throw new HttpError(404, "Deck not found");
    for (const c of detail.cards) c.prices = parseJsonField(c.prices, null);
    // The deck guide shown on the deck page (Open / Download PDF); pending while Claude writes one.
    const gm = guideMeta(app.db, id);
    detail.guide = gm || guideJobs.has(id) ? { ...(gm ?? {}), pending: guideJobs.has(id) } : null;
    // Missing or stale combos: fetch in the background (the UI re-reads once after a few seconds).
    if (detail.combos?.needs_fetch && detail.spellbook_request) app.spellbook.ensure(detail.spellbook_request);
    // Tokens & extras whose card/token rows are missing: same pattern.
    const acc = detail.accessories;
    if (acc?.fetch_ids.length) {
      app.tokenFetcher.ensure(acc.fetch_ids);
      acc.status = app.tokenFetcher.status(acc.fetch_ids);
    }
    return detail;
  }

  /** A deck write's answer: the fresh detail plus `extra`; the combos follow a few seconds later. */
  const changed = (id, extra) => {
    app.scheduleSpellbook(id);
    return { ...getDeckOr404(id), ...extra };
  };

  router.get("/api/decks", () => {
    const decks = listDecks(app.db);
    for (const d of decks) if (d.spellbook_request) app.spellbook.ensure(d.spellbook_request);
    return decks;
  });

  router.post("/api/decks", async ({ req, res }) => {
    const body = await readJson(req);
    const name = optString(body.name, "name", 200);
    if (!name) throw new HttpError(400, "name is required");
    const text = optString(body.text, "text", 200000) || "";
    const { items, errors } = parseDecklist(text);
    if (items.length === 0) throw new HttpError(400, errors.length ? `No cards recognised (e.g. "${errors[0]}")` : "The decklist is empty");
    const saved = await saveDeck(app.db, {
      name,
      format: normalizeFormat(optString(body.format, "format", 50)),
      description: optString(body.description, "description", 5000) || null,
      source: "manual",
      status: deckStatus(body.status),
      items,
    }).catch(throwImportError);
    app.scheduleSpellbook(saved.id);
    sendJson(res, 201, { id: saved.id, unresolved: saved.unresolved, parse_errors: errors });
  });

  /**
   * POST /api/decks/evaluate {text, format?, commander?, target_bracket?}: stats and power of a
   * decklist without saving it. Waits up to 8 s for the combos, else answers with them pending.
   */
  router.post("/api/decks/evaluate", async ({ req }) => {
    const body = await readJson(req);
    const text = optString(body.text, "text", 200000) || "";
    const format = normalizeFormat(optString(body.format, "format", 50));
    const commander = Array.isArray(body.commander)
      ? body.commander.slice(0, 4).map((c, i) => optString(c, `commander[${i}]`, 300)).filter(Boolean)
      : optString(body.commander, "commander", 300) || null;
    const target = body.target_bracket == null ? null : bracketDeclared(body.target_bracket);
    if (!parseDecklist(text).items.length) throw new HttpError(400, "The decklist is empty");
    // Tokens & extras: what the draft's cards miss is fetched for ≤4 s (errors → card text only).
    const { draft, ...p } = await evaluateDraft(app.db, { text, format, commander }, {
      evaluate: (request, opts) => app.spellbook.evaluate(request, opts), waitMs: 8000, accessoryTimeoutMs: 4000,
    }).catch(throwImportError);
    return {
      stats: p.stats, power: p.power, combos: p.combos, accessories: p.accessories, unresolved: draft.unresolved, parse_errors: draft.parse_errors,
      ...(target != null ? { verdict: bracketVerdict(p.power, target) } : {}),
    };
  });

  // Global shopping list: built decks' shortage + per deck (lib/decks.js) + the wishlist's open items.
  router.get("/api/shopping-list", () => ({ ...shoppingList(app.db), wishlist: wishlistShopping(app.db) }));
  // The built decks' shortage as a text list (Market → To buy → Export list).
  router.get("/api/shopping-list/export", ({ res }) => sendTextFile(res, "To buy", buyListText(shoppingList(app.db).built.items, "short")));
  // One deck's To buy list as text (copies not owned at all; the "buy instead" in-use cards are not in it).
  router.get(`/api/decks/${ID}/to-buy`, ({ res, params }) => {
    const detail = getDeckOr404(Number(params.id));
    return sendTextFile(res, `${detail.name} - to buy`, buyListText(detail.shopping?.items, "need"));
  });

  // Build checklist (lib/deckbuild.js). The build list's second card name comes from the card index.
  async function localizeBuild(list) {
    if (!scanner.idx || !CARD_NAME_LANG || !list?.groups) return list;
    const lines = list.groups.flatMap((g) => g.lines).filter((l) => l.oracle_id);
    if (!lines.length) return list;
    try {
      const names = await scanner.indexLookup("localizedNames", [...new Set(lines.map((l) => l.oracle_id))], CARD_NAME_LANG);
      for (const l of lines) if (names[l.oracle_id]) l.local_name = names[l.oracle_id];
    } catch (err) {
      console.warn(`[build] local names unavailable: ${err.message}`);
    }
    return list;
  }
  router.get(`/api/decks/${ID}/build`, ({ params }) => localizeBuild(buildChecklist(app.db, Number(params.id))));
  router.put(`/api/decks/${ID}/build/picks`, async ({ req, params }) => {
    const body = await readJson(req);
    return localizeBuild(setBuildPick(app.db, Number(params.id), { key: body.key, source: body.source, quantity: body.quantity }));
  });
  router.delete(`/api/decks/${ID}/build/picks`, ({ params }) => localizeBuild(clearBuildPicks(app.db, Number(params.id))));

  // Version history (lib/deckhistory.js); a restore is a new version.
  router.get(`/api/decks/${ID}/history`, ({ params }) => listDeckVersions(app.db, Number(params.id)));
  router.get(`/api/decks/${ID}/history/:vid(\\d+)`, ({ params }) => deckVersion(app.db, Number(params.id), Number(params.vid)));
  router.post(`/api/decks/${ID}/history/:vid(\\d+)/restore`, async ({ req, params }) => {
    const id = Number(params.id);
    const body = await readJson(req);
    if (body.confirm !== true) throw new HttpError(400, "Send confirm: true to restore this version");
    const restored = restoreDeckVersion(app.db, id, Number(params.vid), { actor: "app" });
    return changed(id, { restored });
  });

  // The newest guide as a PDF (lib/guidepdf.js; card pictures fetched from Scryfall's image CDN, skipped offline).
  router.get(`/api/decks/${ID}/guide.pdf`, async ({ res, params }) => {
    const latest = latestGuide(app.db, Number(params.id));
    if (!latest?.guide) throw new HttpError(404, "This deck has no guide yet");
    const images = await fetchGuideImages(latest.guide);
    const pdf = renderGuidePdf(latest.guide, { images, date: new Date(latest.created_at) });
    res.writeHead(200, {
      "Content-Type": "application/pdf", "Content-Length": pdf.length, "Cache-Control": "no-store",
      "Content-Disposition": attachment(`${latest.guide.deck.name} - guide`, "pdf", "guide"),
    });
    res.end(pdf);
  });

  function guideState(id) {
    requireDeck(id);
    const latest = latestGuide(app.db, id);
    const err = guideErrors.get(id);
    return {
      status: guideJobs.has(id) ? "pending" : latest ? "ready" : "none",
      started_at: guideJobs.get(id)?.started_at ?? null,
      error: err && (!latest || err.at > latest.created_at) ? err.error : null,
      claude: claudeConfigured(),
      guide: latest,
    };
  }
  router.get(`/api/decks/${ID}/guide`, ({ params }) => guideState(Number(params.id)));
  /** POST /api/decks/:id/guide {facts_only?} → 201 ready (facts only) | 202 pending | 409 already running. */
  router.post(`/api/decks/${ID}/guide`, async ({ req, res, params }) => {
    const id = Number(params.id);
    const body = await readJson(req);
    requireDeck(id);
    if (guideJobs.has(id)) throw new HttpError(409, "A guide for this deck is already being written");
    if (body.facts_only === true || !claudeConfigured()) {
      const { row } = await generateGuide(app.db, id);
      guideErrors.delete(id);
      return sendJson(res, 201, { ...guideState(id), guide: row ? latestGuide(app.db, id) : null });
    }
    if (app.claudeBusy()) throw new HttpError(429, "Claude is busy right now; try again in a minute");
    guideJobs.set(id, { started_at: new Date().toISOString() });
    guideErrors.delete(id);
    generateGuide(app.db, id, { runGuide, model: process.env.CLAUDE_GUIDE_MODEL || "sonnet" })
      .then(({ error }) => { if (error) guideErrors.set(id, { at: new Date().toISOString(), error }); })
      .catch((err) => { guideErrors.set(id, { at: new Date().toISOString(), error: err.message }); console.warn(`[guide] deck ${id}: ${err.message}`); })
      .finally(() => guideJobs.delete(id));
    sendJson(res, 202, guideState(id));
  });

  /** POST /api/decks/:id/cards/bulk {items[{name, board}], action remove|move, to_board?} -> deck detail + change. */
  router.post(`/api/decks/${ID}/cards/bulk`, async ({ req, params }) => {
    const id = Number(params.id);
    const body = await readJson(req);
    const change = bulkDeckCards(app.db, id, { items: body.items, action: body.action, to_board: body.to_board ?? null });
    return changed(id, { change });
  });
  /** POST /api/decks/:id/cards {scryfall_id | name, board?, quantity?} -> deck detail + change (added). */
  router.post(`/api/decks/${ID}/cards`, async ({ req, params }) => {
    const id = Number(params.id);
    const body = await readJson(req);
    const change = await addDeckCard(app.db, id, {
      scryfall_id: body.scryfall_id ?? null, name: optString(body.name, "name", 300) || null,
      board: body.board ?? "main", quantity: body.quantity ?? 1,
    }).catch(throwImportError);
    return changed(id, { change });
  });
  /** PATCH /api/decks/:id/cards {name, board, to_board?, quantity?} -> deck detail + change. */
  router.patch(`/api/decks/${ID}/cards`, async ({ req, params }) => {
    const id = Number(params.id);
    const body = await readJson(req);
    const change = updateDeckCard(app.db, id, {
      name: optString(body.name, "name", 300), board: body.board, to_board: body.to_board ?? null, quantity: body.quantity ?? null,
    });
    return changed(id, { change });
  });
  /** POST /api/decks/:id/commander {name, replace?} -> deck detail + change. */
  router.post(`/api/decks/${ID}/commander`, async ({ req, params }) => {
    const id = Number(params.id);
    const body = await readJson(req);
    const change = setCommander(app.db, id, { name: optString(body.name, "name", 300), replace: optString(body.replace, "replace", 300) });
    return changed(id, { change });
  });

  /** POST /api/decks/:id/combos: refetch the deck's combos now (202), refused while backing off / disabled. */
  router.post(`/api/decks/${ID}/combos`, ({ res, params }) => {
    const id = Number(params.id);
    requireDeck(id);
    const settings = spellbookSettings(app.db);
    if (!settings.enabled) {
      throw new HttpError(503, settings.env_disabled ? "The combo check is turned off (SPELLBOOK_ENABLED=false)" : "The combo check is turned off in Settings");
    }
    const request = deckComboRequest(app.db, id);
    if (!request) throw new HttpError(400, "Combos are only checked for Commander decks");
    const until = backoffUntil(app.db);
    if (until > Date.now()) {
      throw new HttpError(409, "The combo check is paused (Commander Spellbook was unreachable or asked us to wait); try again later", { retry_at: new Date(until).toISOString() });
    }
    app.spellbook.refresh(request);
    sendJson(res, 202, { status: "pending", deck_id: id });
  });

  /**
   * POST /api/decks/:id/to-binder {binder?, confirm_master?, picked_only?} -> moved/missing summary + deck detail.
   * picked_only: only the cards ticked in the build checklist (binder groups) move.
   */
  router.post(`/api/decks/${ID}/to-binder`, async ({ req, params }) => {
    const id = Number(params.id);
    const body = await readJson(req);
    const binder = optString(body.binder, "binder", 200);
    const result = await app.exclusive(async () => {
      const keys = body.picked_only === true ? pickedKeys(app.db, id) : null;
      if (keys && !keys.length) throw new HttpError(400, "No picked cards to put into the deck box");
      return deckToBinder(app.db, id, { binder, confirm_master: body.confirm_master === true, keys });
    });
    return { ...result, deck: getDeckOr404(id) };
  });

  router.get(`/api/decks/${ID}/export`, ({ res, params }) => {
    const detail = getDeckOr404(Number(params.id));
    return sendTextFile(res, detail.name, exportDeck(detail));
  });

  router.get(`/api/decks/${ID}`, ({ params }) => getDeckOr404(Number(params.id)));

  /**
   * PATCH /api/decks/:id {name?, format?, description?, status?, bracket_declared?, favorite?} -> the deck row.
   * favorite alone is not a deck change: no updated_at, no history version.
   */
  router.patch(`/api/decks/${ID}`, async ({ req, params }) => {
    const id = Number(params.id);
    const db = app.db;
    const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
    if (!deck) throw new HttpError(404, "Deck not found");
    const body = await readJson(req);
    if (body.favorite !== undefined && typeof body.favorite !== "boolean") throw new HttpError(400, "favorite must be true or false");
    const setFavorite = () => {
      if (body.favorite === undefined) return;
      db.prepare("UPDATE decks SET favorite = ? WHERE id = ?").run(body.favorite ? 1 : 0, id);
      deck.favorite = body.favorite ? 1 : 0;
    };
    if (body.favorite !== undefined && Object.keys(body).every((k) => k === "favorite")) {
      setFavorite();
      return { ...deck, favorite: Boolean(deck.favorite) };
    }
    // Every field is validated before anything is written: a 400 leaves the deck unchanged.
    const name = body.name === undefined ? deck.name : optString(body.name, "name", 200);
    if (!name) throw new HttpError(400, "name must not be empty");
    const format = body.format === undefined ? deck.format : normalizeFormat(optString(body.format, "format", 50));
    const description = body.description === undefined ? deck.description : optString(body.description, "description", 5000) || null;
    const status = deckStatus(body.status) ?? deck.status;
    const declared = bracketDeclared(body.bracket_declared);
    const bracket = declared === undefined ? deck.bracket_declared : declared;
    // Idea -> built: the cards this deck now shares with other built decks (they were "in use" while it was an idea).
    const before = status === "built" && deck.status !== "built" ? deckDetail(db, id) : null;
    transaction(db, () => {
      setFavorite();
      db.prepare("UPDATE decks SET name = ?, format = ?, description = ?, status = ?, bracket_declared = ?, updated_at = datetime('now') WHERE id = ?")
        .run(name, format, description, status, bracket, id);
      recordDeckVersion(db, id, { actor: "app" });
    });
    // A format change can make it a commander deck (or not).
    if (format !== deck.format) app.scheduleSpellbook(id);
    const row = db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
    if (status === deck.status) return row;
    const after = deckDetail(db, id);
    return {
      ...row,
      status_change: {
        from: deck.status, to: status,
        in_use_count: before?.in_use_count ?? 0,
        in_use: before?.shopping.in_use ?? [],
        conflict_count: after.conflict_count,
      },
    };
  });

  router.delete(`/api/decks/${ID}`, ({ res, params }) => {
    const info = app.db.prepare("DELETE FROM decks WHERE id = ?").run(Number(params.id));
    if (!info.changes) throw new HttpError(404, "Deck not found");
    sendEmpty(res);
  });
}
