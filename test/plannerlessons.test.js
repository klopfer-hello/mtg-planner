// Planner feedback and lessons (lib/plannerlessons.js, #085): rating answers, distilling the ratings
// into lessons with a fake Claude, the lessons in the system prompt, and the HTTP round trip.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  distillLessons, feedbackCounts, getLessons, LESSONS_SYSTEM, lessonsPrompt, lessonsText, MAX_LESSONS, rateMessage, setLessons,
} from "../lib/plannerlessons.js";
import { openDb } from "../lib/db.js";
import { tempDb } from "./fixtures.js";
import { startServer } from "./helpers/server.js";

const CHAT = "11111111-2222-3333-4444-555555555555";

/** A chat with two question/answer pairs; returns the answer ids. */
function seedChat(db) {
  db.prepare("INSERT INTO chats (id, title) VALUES (?, 'Yennett')").run(CHAT);
  const ins = db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)");
  ins.run(CHAT, "user", "What should I upgrade?");
  const a1 = Number(ins.run(CHAT, "assistant", "Cut the 7-drops for cheap plays.").lastInsertRowid);
  ins.run(CHAT, "user", "And for more power?");
  const a2 = Number(ins.run(CHAT, "assistant", "Add Mana Crypt and tutors.").lastInsertRowid);
  return [a1, a2];
}

describe("lib/plannerlessons.js", () => {
  let ctx, a1, a2;
  before(() => { ctx = tempDb(); [a1, a2] = seedChat(ctx.db); });
  after(() => ctx.cleanup());

  test("rateMessage: stores question + answer, updates, removes, validates", () => {
    assert.deepEqual(rateMessage(ctx.db, CHAT, a1, { rating: -1, note: "  ignored  Yennett's odd\nmana values " }), { rating: -1, note: "ignored Yennett's odd mana values" });
    const row = ctx.db.prepare("SELECT * FROM planner_feedback WHERE message_id = ?").get(a1);
    assert.equal(row.question, "What should I upgrade?");
    assert.equal(row.answer, "Cut the 7-drops for cheap plays.");
    rateMessage(ctx.db, CHAT, a2, { rating: 1 });
    rateMessage(ctx.db, CHAT, a2, { rating: -1 });
    assert.deepEqual(feedbackCounts(ctx.db), { up: 0, down: 2, pending: 2 });
    assert.deepEqual(rateMessage(ctx.db, CHAT, a2, { rating: 0 }), { rating: null, note: null });
    rateMessage(ctx.db, CHAT, a2, { rating: 1 });
    for (const [id, body, status] of [[a1, { rating: 2 }, 400], [a1, { rating: 1, note: "x".repeat(301) }, 400], [a1 - 1, { rating: 1 }, 404], [9999, { rating: 1 }, 404]]) {
      assert.throws(() => rateMessage(ctx.db, CHAT, id, body), (err) => err.status === status, JSON.stringify(body));
    }
    assert.throws(() => rateMessage(ctx.db, "other-chat", a1, { rating: 1 }), (err) => err.status === 404, "answer of another chat");
  });

  test("distillLessons: one Claude call with the ratings, lessons stored, ratings marked; errors keep them pending", async () => {
    let seen = null;
    const r = await distillLessons(ctx.db, async (o) => { seen = o; return { json: { lessons: ["- Commander: build around the commander's mechanic.", "", ...Array(9).fill("Extra")] } }; });
    assert.equal(r.ok, true);
    assert.equal(r.count, 2);
    assert.equal(seen.system, LESSONS_SYSTEM);
    assert.match(seen.prompt, /^Current rules:\n\(none yet\)\n\nNew ratings:\n👎 Note: ignored Yennett's odd mana values\n {2}Question: What should I upgrade\?\n {2}Answer: Cut the 7-drops/);
    assert.match(seen.prompt, /\n👍\n {2}Question: And for more power\?/);
    const l = getLessons(ctx.db);
    assert.equal(l.lessons.length, MAX_LESSONS);
    assert.equal(l.lessons[0], "Commander: build around the commander's mechanic.");
    assert.equal(l.source, "learned");
    assert.equal(feedbackCounts(ctx.db).pending, 0);
    assert.deepEqual(await distillLessons(ctx.db, async () => assert.fail("nothing to do")), { ok: true, count: 0 });
    rateMessage(ctx.db, CHAT, a2, { rating: -1, note: "too expensive" });
    assert.deepEqual(await distillLessons(ctx.db, async () => ({ error: "Claude is busy" })), { ok: false, error: "Claude is busy", count: 1 });
    assert.match((await distillLessons(ctx.db, async () => ({ json: { nope: 1 } }))).error, /no lessons/);
    assert.equal(feedbackCounts(ctx.db).pending, 1, "still pending");
    // The next call builds on the current lessons.
    await distillLessons(ctx.db, async (o) => { seen = o; return { json: { lessons: ["Stay within the budget."] } }; });
    assert.match(seen.prompt, /^Current rules:\n- Commander: build around/);
    assert.deepEqual(getLessons(ctx.db).lessons, ["Stay within the budget."]);
  });

  test("a rating changed while Claude worked stays pending", async () => {
    rateMessage(ctx.db, CHAT, a1, { rating: 1 });
    await distillLessons(ctx.db, async () => {
      await new Promise((r) => setTimeout(r, 5));
      rateMessage(ctx.db, CHAT, a1, { rating: -1, note: "changed my mind" });
      return { json: { lessons: ["x"] } };
    });
    assert.equal(feedbackCounts(ctx.db).pending, 1);
  });

  test("setLessons (the user's edit) and lessonsText", () => {
    assert.deepEqual(setLessons(ctx.db, "  Short answers.\n\n* Build around the commander\n").lessons, ["Short answers.", "Build around the commander"]);
    assert.equal(getLessons(ctx.db).source, "edited");
    assert.equal(lessonsText(getLessons(ctx.db)), "Lessons from the user's ratings of earlier answers (follow them):\n- Short answers.\n- Build around the commander");
    assert.deepEqual(setLessons(ctx.db, "").lessons, []);
    assert.equal(lessonsText(getLessons(ctx.db)), "");
    assert.throws(() => setLessons(ctx.db, 5), (err) => err.status === 400);
    assert.equal(lessonsPrompt([], []), "Current rules:\n(none yet)\n\nNew ratings:");
  });
});

describe("feedback over HTTP", () => {
  let srv, a1;
  before(async () => {
    srv = await startServer({ name: "planner-feedback", seed: (file) => { const db = openDb(file); [a1] = seedChat(db); db.close(); } });
  });
  after(() => srv?.stop());

  test("PUT feedback → GET chat shows it, settings count it; lessons can be edited; deleting the chat keeps the rating", async () => {
    let r = await srv.call("PUT", `/api/chats/${CHAT}/messages/${a1}/feedback`, { rating: -1, note: "ignored the mechanic" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { rating: -1, note: "ignored the mechanic" });
    assert.equal((await srv.call("PUT", `/api/chats/${CHAT}/messages/${a1}/feedback`, { rating: 3 })).status, 400);
    assert.equal((await srv.call("PUT", `/api/chats/${CHAT}/messages/${a1 - 1}/feedback`, { rating: 1 })).status, 404, "a user message");
    r = await srv.call("GET", `/api/chats/${CHAT}`);
    const msg = r.body.messages.find((m) => m.id === a1);
    assert.equal(msg.rating, -1);
    assert.equal(msg.feedback_note, "ignored the mechanic");
    assert.equal(r.body.messages[0].rating, null);
    r = await srv.call("GET", "/api/settings");
    assert.deepEqual(r.body.planner.lessons, { lessons: [], updated_at: null, source: null, feedback: { up: 0, down: 1, pending: 1 }, running: false, last_error: null });
    r = await srv.call("PATCH", "/api/settings", { planner_lessons: "Build around the commander." });
    assert.deepEqual(r.body.planner.lessons.lessons, ["Build around the commander."]);
    assert.equal((await srv.call("PATCH", "/api/settings", { planner_lessons: ["x"], planner_model: "opus" })).status, 400);
    assert.equal((await srv.call("GET", "/api/settings")).body.planner.model, "", "nothing written on a bad field");
    assert.equal((await srv.call("DELETE", `/api/chats/${CHAT}`)).status, 204);
    assert.equal((await srv.call("GET", "/api/settings")).body.planner.lessons.feedback.down, 1, "the rating outlives its chat");
  });
});
