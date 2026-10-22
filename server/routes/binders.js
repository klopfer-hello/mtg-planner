// Binder routes (lib/binders.js): list, search, create, rename/merge and
// properties (type, cover, deck box link, lock, favourite), delete.

import { binderMatches } from "../../lib/query.js";
import { ensureOtags, otagsIn } from "../../lib/cardtags.js";
import { createBinder, deleteBinder, listBinders, renameBinder, setBinderProps } from "../../lib/binders.js";
import { HttpError, decodeParam, readJson, sendJson } from "../http.js";

export function binderRoutes(router, app) {
  router.get("/api/binders", () => listBinders(app.db));
  // Binders holding cards that match ?q= (collection query syntax): {q, cards, binders[{name, cards, copies}]}.
  router.get("/api/binders/search", async ({ query }) => {
    const q = (query.get("q") || "").slice(0, 500);
    await ensureOtags(app.db, otagsIn(q));
    try { return { q, ...binderMatches(app.db, { q }) }; } catch (err) { throw new HttpError(400, err.message); }
  });
  router.post("/api/binders", async ({ req, res }) => {
    const body = await readJson(req);
    sendJson(res, 201, await app.exclusive(async () => createBinder(app.db, body.name)));
  });
  // {name?} renames (merge); {type?, cover_scryfall_id?} set the type / cover (null = auto), {deck_id?} links the
  // deck that owns this deck box (decks.box_binder; null = none), {locked?} true/false/null (auto), after a rename.
  router.patch("/api/binders/:name(.+)", async ({ req, params }) => {
    const name = decodeParam(params.name, "Bad binder name");
    const body = await readJson(req);
    const props = body.type !== undefined || body.cover_scryfall_id !== undefined || body.deck_id !== undefined || body.locked !== undefined
      || body.favorite !== undefined;
    return app.exclusive(async () => {
      if (body.name === undefined && props) return setBinderProps(app.db, name, body);
      const r = renameBinder(app.db, name, body.name, { confirm_master: body.confirm_master === true });
      return props ? { ...setBinderProps(app.db, r.name, body), renamed: r.renamed, merged: r.merged, converted_copies: r.converted_copies } : r;
    });
  });
  // ?cards=unsort|delete.
  router.delete("/api/binders/:name(.+)", ({ params, query }) => {
    const name = decodeParam(params.name, "Bad binder name");
    const opts = { cards: query.get("cards") || "unsort", confirm_master: query.get("confirm_master") === "1" };
    return app.exclusive(async () => deleteBinder(app.db, name, opts));
  });
}
