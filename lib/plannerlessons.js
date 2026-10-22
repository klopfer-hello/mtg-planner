// Planner feedback and lessons (#085). The user rates planner answers 👍/👎 (👎 with an optional
// "what was wrong"); a one-shot Claude call later merges the new ratings into at most MAX_LESSONS
// short rules ("lessons") that go into every turn's system prompt next to the profile. The lessons
// are learned, not typed: the user can still edit or clear them in Settings → Planner, and a manual
// edit is the base the next distillation builds on. Ratings stay in the user's DB only.

import { getAppMeta, nowIso, setAppMeta, transaction } from "./db.js";
import { StatusError } from "./errors.js";

export class FeedbackError extends StatusError {}

export const MAX_LESSONS = 6;
export const NOTE_MAX = 300;
export const LESSONS_MAX_CHARS = 1500;
const EXCERPT = 1200; // question/answer chars kept per rating (and sent to the distiller)
const BATCH = 30; // newest undistilled ratings per distillation

/**
 * Rate an assistant message: rating 1 / -1 (with an optional note), 0 removes the rating.
 * Returns {rating, note} (rating null when removed). 404 unknown message, 400 bad input.
 */
export function rateMessage(db, chatId, messageId, { rating, note } = {}) {
  if (![1, -1, 0].includes(rating)) throw new FeedbackError(400, "rating must be 1, -1 or 0");
  if (note != null && typeof note !== "string") throw new FeedbackError(400, "note must be text");
  const text = (note ?? "").replace(/\s+/g, " ").trim();
  if (text.length > NOTE_MAX) throw new FeedbackError(400, `note is at most ${NOTE_MAX} characters`);
  return transaction(db, () => {
    const msg = db.prepare("SELECT id, content FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'").get(messageId, chatId);
    if (!msg) throw new FeedbackError(404, "Answer not found");
    if (rating === 0) {
      db.prepare("DELETE FROM planner_feedback WHERE message_id = ?").run(msg.id);
      return { rating: null, note: null };
    }
    const q = db.prepare("SELECT content FROM messages WHERE chat_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chatId, msg.id);
    db.prepare(`INSERT INTO planner_feedback (message_id, rating, note, question, answer, created_at, distilled) VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(message_id) DO UPDATE SET rating = excluded.rating, note = excluded.note, created_at = excluded.created_at, distilled = 0`)
      .run(msg.id, rating, text || null, q?.content.slice(0, EXCERPT) ?? null, msg.content.slice(0, EXCERPT), nowIso());
    return { rating, note: text || null };
  });
}

/** Counts for Settings: {up, down, pending} (pending = not yet in the lessons). */
export function feedbackCounts(db) {
  const r = db.prepare("SELECT SUM(rating = 1) AS up, SUM(rating = -1) AS down, SUM(distilled = 0) AS pending FROM planner_feedback").get();
  return { up: r.up ?? 0, down: r.down ?? 0, pending: r.pending ?? 0 };
}

/** Stored lessons: {lessons: [string], updated_at, source: 'learned'|'edited'|null}. */
export function getLessons(db) {
  try {
    const s = JSON.parse(getAppMeta(db, "planner_lessons") || "null");
    if (s && Array.isArray(s.lessons)) return { lessons: s.lessons, updated_at: s.updated_at ?? null, source: s.source ?? null };
  } catch { /* broken JSON = none */ }
  return { lessons: [], updated_at: null, source: null };
}

const cleanList = (list) => list.map((x) => (typeof x === "string" ? x.replace(/\s+/g, " ").replace(/^[-*•]\s*/, "").trim() : ""))
  .filter(Boolean).slice(0, MAX_LESSONS);

/** The user's own edit (Settings): one lesson per line, '' clears them. 400 when too long. */
export function setLessons(db, text) {
  if (typeof text !== "string") throw new FeedbackError(400, "planner_lessons must be text");
  if (text.length > LESSONS_MAX_CHARS) throw new FeedbackError(400, `planner_lessons is at most ${LESSONS_MAX_CHARS} characters`);
  const lessons = cleanList(text.split("\n"));
  setAppMeta(db, "planner_lessons", JSON.stringify({ lessons, updated_at: nowIso(), source: "edited" }));
  return getLessons(db);
}

/** The lessons as system-prompt text ("" when there are none). */
export function lessonsText({ lessons }) {
  return lessons.length ? `Lessons from the user's ratings of earlier answers (follow them):\n${lessons.map((l) => `- ${l}`).join("\n")}` : "";
}

export const LESSONS_SYSTEM = `You keep the house rules of "mtg-planner", a Magic: The Gathering deck-building chat assistant for one user.
You get the current rules and new ratings of the assistant's answers (👍 good / 👎 bad, sometimes with the user's note).
Update the rules: keep rules that still hold, merge similar ones, drop rules a newer rating contradicts, add what the
new ratings teach. Write general, actionable rules about how to answer or build decks (e.g. "Commander: build around the
commander's mechanic"), not facts about one card or one deck. A 👍 without a note confirms what that answer did.
At most ${MAX_LESSONS} rules, each at most 25 words, in English. Answer with ONLY one JSON object: {"lessons": ["rule", ...]}`;

/** The distiller prompt: current lessons plus the ratings (oldest first). */
export function lessonsPrompt(current, rows) {
  const lines = ["Current rules:", ...(current.length ? current.map((l) => `- ${l}`) : ["(none yet)"]), "", "New ratings:"];
  for (const r of rows) {
    lines.push(`${r.rating > 0 ? "👍" : "👎"}${r.note ? ` Note: ${r.note}` : ""}`, `  Question: ${(r.question ?? "(none)").replace(/\s+/g, " ")}`,
      `  Answer: ${r.answer.replace(/\s+/g, " ")}`);
  }
  return lines.join("\n");
}

/**
 * Merge the undistilled ratings into the lessons with one Claude call (`runGuide` from lib/claude.js).
 * Resolves {ok, lessons?, error?, count}; nothing to do = {ok: true, count: 0}. Ratings are marked
 * distilled only when the new lessons were stored.
 */
export async function distillLessons(db, runGuide, { signal } = {}) {
  const rows = db.prepare("SELECT id, rating, note, question, answer, created_at FROM planner_feedback WHERE distilled = 0 ORDER BY id DESC LIMIT ?").all(BATCH).reverse();
  if (!rows.length) return { ok: true, count: 0 };
  const r = await runGuide({ prompt: lessonsPrompt(getLessons(db).lessons, rows), system: LESSONS_SYSTEM, signal });
  if (r?.error) return { ok: false, error: r.error, count: rows.length };
  if (!Array.isArray(r?.json?.lessons)) return { ok: false, error: "Claude's answer had no lessons", count: rows.length };
  const lessons = cleanList(r.json.lessons);
  transaction(db, () => {
    setAppMeta(db, "planner_lessons", JSON.stringify({ lessons, updated_at: nowIso(), source: "learned" }));
    // A rating changed while Claude worked (new created_at) stays pending for the next run.
    const mark = db.prepare("UPDATE planner_feedback SET distilled = 1 WHERE id = ? AND created_at = ?");
    for (const row of rows) mark.run(row.id, row.created_at);
  });
  return { ok: true, lessons, count: rows.length };
}
