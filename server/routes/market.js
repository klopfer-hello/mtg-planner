// Market tab: the wishlist (lib/wishlist.js) and the value history
// (lib/finance.js). Wishlist writes are not inside exclusive(): no collection
// rows change (a missing card row is fetched); they refresh today's value
// snapshot.

import { cardHistory, financeHistory, financeMovers, financeSummary, financeTop } from "../../lib/finance.js";
import {
  addWishlistItem, deleteWishlistItem, deleteWishlistItems, getWishlistItem, listWishlist, updateWishlistItem, wishlistText,
} from "../../lib/wishlist.js";
import { throwImportError } from "../errors.js";
import { HttpError, readJson, sendEmpty, sendJson, sendTextFile } from "../http.js";

export function marketRoutes(router, app) {
  const { background } = app;

  // GET /api/wishlist → {items, totals}; POST {scryfall_id|oracle_id|name, set?, collector_number?, any_printing?, finish?,
  // language?, quantity?, max_price_eur?, note?, priority?} → 201 {item, merged} (200 when merged into an existing item).
  router.get("/api/wishlist", () => listWishlist(app.db));
  router.post("/api/wishlist", async ({ req, res }) => {
    const body = await readJson(req);
    if (body.source !== undefined && body.source !== "app") throw new HttpError(400, 'source must be "app"');
    const out = await addWishlistItem(app.db, body, { source: "app" }).catch(throwImportError);
    background.scheduleSnapshot();
    sendJson(res, out.merged ? 200 : 201, out);
  });
  // The items still to buy as a text list.
  router.get("/api/wishlist/export", ({ res }) => sendTextFile(res, "Wishlist", wishlistText(app.db)));
  // POST {ids} → {removed}.
  router.post("/api/wishlist/delete", async ({ req }) => {
    const body = await readJson(req);
    const removed = await deleteWishlistItems(app.db, body.ids);
    if (removed) background.scheduleSnapshot();
    return { removed };
  });
  router.get("/api/wishlist/:id(\\d+)", ({ params }) => {
    const item = getWishlistItem(app.db, Number(params.id));
    if (!item) throw new HttpError(404, "Wishlist item not found");
    return item;
  });
  // PATCH {quantity?, max_price_eur?, note?, priority?, finish?, language?, any_printing?} → item.
  router.patch("/api/wishlist/:id(\\d+)", async ({ req, params }) => {
    const body = await readJson(req);
    const item = await updateWishlistItem(app.db, Number(params.id), body);
    background.scheduleSnapshot();
    return item;
  });
  router.delete("/api/wishlist/:id(\\d+)", ({ res, params }) => {
    if (!deleteWishlistItem(app.db, Number(params.id))) throw new HttpError(404, "Wishlist item not found");
    background.scheduleSnapshot();
    sendEmpty(res);
  });
  router.notFound("/api/wishlist/:rest(.*)", "Wishlist item not found");

  // Value history, all GET: summary (live totals, today/7d/30d change split into added / removed / price changes,
  // per binder + rarity), history?days=90 (daily totals), movers?days=7&limit=10 (risers and fallers among cards held
  // throughout), top?limit=20 (most valuable printings + binders), card/:scryfall_id?finish= (one printing's history).
  router.get("/api/finance/summary", () => financeSummary(app.db));
  router.get("/api/finance/history", ({ query }) => financeHistory(app.db, { days: query.get("days") || 90 }));
  router.get("/api/finance/movers", ({ query }) => financeMovers(app.db, { days: query.get("days") || 7, limit: query.get("limit") || 10 }));
  router.get("/api/finance/top", ({ query }) => financeTop(app.db, { limit: query.get("limit") || 20 }));
  router.get("/api/finance/card/:id([0-9a-fA-F-]{36})", ({ params, query }) => {
    const finish = query.get("finish") || "normal";
    if (!["normal", "foil", "etched"].includes(finish)) throw new HttpError(400, "finish must be normal, foil or etched");
    const id = params.id.toLowerCase();
    return { scryfall_id: id, finish, points: cardHistory(app.db, id, finish) };
  });
}
