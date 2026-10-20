// Settings (Settings tab): the collection master (ManaBox or the app) and the
// online combo check (Commander Spellbook; env SPELLBOOK_ENABLED=false wins).

import { collectionMaster, setCollectionMaster } from "../../lib/binders.js";
import { setSpellbookSettings, spellbookSettings } from "../../lib/spellbook.js";
import { HttpError, readJson } from "../http.js";

export function settingsRoutes(router, app) {
  /** GET/PATCH /api/settings answer. */
  const settingsView = () => {
    const s = spellbookSettings(app.db);
    return { collection_master: collectionMaster(app.db), spellbook_enabled: s.enabled, spellbook: { enabled: s.enabled, env_disabled: s.env_disabled, url: s.url } };
  };
  router.get("/api/settings", settingsView);
  router.patch("/api/settings", async ({ req }) => {
    const body = await readJson(req);
    const patch = {};
    if (body.spellbook_enabled !== undefined) {
      if (typeof body.spellbook_enabled !== "boolean") throw new HttpError(400, "spellbook_enabled must be true or false");
      if (body.spellbook_enabled && spellbookSettings(app.db).env_disabled) {
        throw new HttpError(409, "The combo check is turned off on the server (SPELLBOOK_ENABLED=false)");
      }
      patch.enabled = body.spellbook_enabled;
    }
    // Where the card names go is a server setting only (env SPELLBOOK_URL), never a LAN request.
    if (body.spellbook_url !== undefined) throw new HttpError(400, "The Commander Spellbook URL can only be set on the server (SPELLBOOK_URL)");
    if (body.collection_master !== undefined) setCollectionMaster(app.db, body.collection_master);
    if (Object.keys(patch).length) setSpellbookSettings(app.db, patch);
    return settingsView();
  });
}
