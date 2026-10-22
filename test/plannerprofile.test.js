// Planner profile and model (lib/plannerprofile.js) and their GET/PATCH /api/settings round trip.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getProfile, plannerModel, profileText, setPlannerModel, setProfile } from "../lib/plannerprofile.js";
import { tempDb } from "./fixtures.js";
import { startServer } from "./helpers/server.js";

describe("lib/plannerprofile.js", () => {
  let ctx;
  before(() => { ctx = tempDb(); });
  after(() => ctx.cleanup());

  test("empty by default; patches merge, trim and validate", () => {
    assert.deepEqual(getProfile(ctx.db), { formats: [], bracket: null, budget_eur: null, dislikes: "", about: "" });
    assert.equal(profileText(getProfile(ctx.db)), "");
    const p = setProfile(ctx.db, { formats: ["commander", "pauper", "pauper"], bracket: 3, budget_eur: 25.555, about: "  I have ADHD:\nshort answers " });
    assert.deepEqual(p, { formats: ["commander", "pauper"], bracket: 3, budget_eur: 25.56, dislikes: "", about: "I have ADHD: short answers" });
    setProfile(ctx.db, { dislikes: "stax" });
    assert.equal(getProfile(ctx.db).bracket, 3, "other fields kept");
    assert.equal(profileText(getProfile(ctx.db)),
      "User profile (set by the user in Settings; follow it): plays Commander and Pauper; usual Commander table: bracket 3 (build for it unless asked otherwise); " +
      "budget per upgrade about €25.56 unless the user says otherwise; avoid: stax; about the user: I have ADHD: short answers.");
    for (const bad of [{ formats: ["chess"] }, { bracket: 7 }, { budget_eur: -1 }, { about: "x".repeat(301) }, { mood: "happy" }]) {
      assert.throws(() => setProfile(ctx.db, bad), (err) => err.status === 400, JSON.stringify(bad));
    }
  });

  test("model: default, sonnet or opus", () => {
    assert.equal(plannerModel(ctx.db), "");
    setPlannerModel(ctx.db, "opus");
    assert.equal(plannerModel(ctx.db), "opus");
    assert.throws(() => setPlannerModel(ctx.db, "gpt"), (err) => err.status === 400);
  });
});

describe("GET/PATCH /api/settings planner", () => {
  let srv;
  before(async () => { srv = await startServer({ name: "planner-settings" }); });
  after(() => srv?.stop());

  test("round trip, validation, last turn cost", async () => {
    let r = await srv.call("GET", "/api/settings");
    assert.equal(r.status, 200);
    assert.deepEqual({ ...r.body.planner, formats: undefined, models: undefined }, {
      model: "", model_env: null, formats: undefined, models: undefined, last_turn: null,
      profile: { formats: [], bracket: null, budget_eur: null, dislikes: "", about: "" },
    });
    r = await srv.call("PATCH", "/api/settings", { planner_model: "sonnet", planner_profile: { formats: ["pauper"], budget_eur: 10 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.planner.model, "sonnet");
    assert.deepEqual(r.body.planner.profile.formats, ["pauper"]);
    assert.equal((await srv.call("PATCH", "/api/settings", { planner_profile: { bracket: 9 } })).status, 400);
    assert.equal((await srv.call("PATCH", "/api/settings", { planner_profile: [] })).status, 400);
    assert.equal((await srv.call("PATCH", "/api/settings", { planner_model: "gpt" })).status, 400);
    // A bad field leaves the others untouched (validated before anything is written).
    assert.equal((await srv.call("PATCH", "/api/settings", { planner_model: "opus", collection_master: "app", planner_profile: { bracket: 9 } })).status, 400);
    r = await srv.call("GET", "/api/settings");
    assert.equal(r.body.planner.model, "sonnet");
    assert.equal(r.body.collection_master, "manabox");
  });
});
