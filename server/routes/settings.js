// Settings (Settings tab): the collection master (ManaBox or the app), the
// online combo check (Commander Spellbook; env SPELLBOOK_ENABLED=false wins)
// and the planner (model choice, env CLAUDE_MODEL wins; the user's profile).

import { collectionMaster, setCollectionMaster } from "../../lib/binders.js";
import { checkPlannerModel, getProfile, mergeProfile, plannerModel, PLANNER_MODELS, PROFILE_FORMATS, setPlannerModel, setProfile } from "../../lib/plannerprofile.js";
import { setSpellbookSettings, spellbookSettings } from "../../lib/spellbook.js";
import { HttpError, readJson } from "../http.js";

export function settingsRoutes(router, app) {
  /** GET/PATCH /api/settings answer. */
  const settingsView = () => {
    const s = spellbookSettings(app.db);
    const last = app.db.prepare("SELECT cost_usd, created_at FROM messages WHERE role = 'assistant' AND cost_usd IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    return {
      collection_master: collectionMaster(app.db), spellbook_enabled: s.enabled, spellbook: { enabled: s.enabled, env_disabled: s.env_disabled, url: s.url },
      planner: {
        model: plannerModel(app.db), model_env: process.env.CLAUDE_MODEL || null, models: PLANNER_MODELS, formats: PROFILE_FORMATS,
        profile: getProfile(app.db), last_turn: last ? { cost_usd: last.cost_usd, at: last.created_at } : null,
      },
    };
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
    // Validate everything first: a bad field must not leave the others half applied.
    if (body.planner_model !== undefined) checkPlannerModel(body.planner_model);
    if (body.planner_profile !== undefined) {
      if (!body.planner_profile || typeof body.planner_profile !== "object" || Array.isArray(body.planner_profile)) throw new HttpError(400, "planner_profile must be an object");
      mergeProfile(getProfile(app.db), body.planner_profile);
    }
    if (body.collection_master !== undefined) setCollectionMaster(app.db, body.collection_master); // validates, writes nothing else
    if (body.planner_model !== undefined) setPlannerModel(app.db, body.planner_model);
    if (body.planner_profile !== undefined) setProfile(app.db, body.planner_profile);
    if (Object.keys(patch).length) setSpellbookSettings(app.db, patch);
    return settingsView();
  });
}
