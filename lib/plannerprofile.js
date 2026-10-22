// The user's planner profile and model choice (plan v1.3.0 #077, #078), set in
// Settings → Planner and stored in meta. The profile is a few fields, not a
// memory the model writes: formats played, the usual table bracket, a budget
// per upgrade, strategies to avoid and one free line about the user (e.g.
// "ADHD: keep answers short"). It goes to the system prompt of every turn, so
// "upgrade X" respects them without being told; it stays in the user's DB only.
// The model choice is "" (CLI default), sonnet or opus; env CLAUDE_MODEL wins.

import { getAppMeta, setAppMeta } from "./db.js";
import { StatusError } from "./errors.js";

export class ProfileError extends StatusError {}

export const PROFILE_FORMATS = Object.freeze(["commander", "pauper", "standard", "pioneer", "modern", "legacy", "vintage"]);
export const PLANNER_MODELS = Object.freeze(["", "sonnet", "opus"]);
const EMPTY = Object.freeze({ formats: [], bracket: null, budget_eur: null, dislikes: "", about: "" });
const MAX = { dislikes: 200, about: 300 };

/** Stored profile (all fields, defaults filled). */
export function getProfile(db) {
  let stored = {};
  try { stored = JSON.parse(getAppMeta(db, "planner_profile") || "{}"); } catch { /* broken JSON = empty */ }
  return { ...EMPTY, ...stored };
}

/** The profile with a validated patch merged in, not stored (400 ProfileError on bad input). */
export function mergeProfile(current, patch = {}) {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === "formats") {
      if (!Array.isArray(v) || v.some((f) => !PROFILE_FORMATS.includes(f))) throw new ProfileError(400, `formats must be a list of ${PROFILE_FORMATS.join(", ")}`);
      next.formats = [...new Set(v)];
    } else if (k === "bracket") {
      if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 5)) throw new ProfileError(400, "bracket must be 1-5 or null");
      next.bracket = v;
    } else if (k === "budget_eur") {
      if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000)) throw new ProfileError(400, "budget_eur must be a number ≥ 0 or null");
      next.budget_eur = v === null ? null : Math.round(v * 100) / 100;
    } else if (k === "dislikes" || k === "about") {
      if (typeof v !== "string") throw new ProfileError(400, `${k} must be text`);
      const t = v.replace(/\s+/g, " ").trim();
      if (t.length > MAX[k]) throw new ProfileError(400, `${k} is at most ${MAX[k]} characters`);
      next[k] = t;
    } else throw new ProfileError(400, `Unknown profile field "${k}"`);
  }
  return next;
}

/** Merge a validated patch into the stored profile; returns the new profile. */
export function setProfile(db, patch = {}) {
  const next = mergeProfile(getProfile(db), patch);
  setAppMeta(db, "planner_profile", JSON.stringify(next));
  return next;
}

const LABEL = { commander: "Commander", pauper: "Pauper" };

/** The profile as system-prompt text ("" when nothing is set). */
export function profileText(p) {
  const parts = [];
  if (p.formats?.length) parts.push(`plays ${p.formats.map((f) => LABEL[f] ?? f[0].toUpperCase() + f.slice(1)).join(" and ")}`);
  if (p.bracket) parts.push(`usual Commander table: bracket ${p.bracket} (build for it unless asked otherwise)`);
  if (p.budget_eur != null) parts.push(`budget per upgrade about €${p.budget_eur} unless the user says otherwise`);
  if (p.dislikes) parts.push(`avoid: ${p.dislikes}`);
  if (p.about) parts.push(`about the user: ${p.about}`);
  return parts.length ? `User profile (set by the user in Settings; follow it): ${parts.join("; ")}.` : "";
}

/** Planner model from Settings ("" = CLI default). */
export const plannerModel = (db) => {
  const m = getAppMeta(db, "planner_model") || "";
  return PLANNER_MODELS.includes(m) ? m : "";
};

/** Throws 400 for a model that is not in PLANNER_MODELS. */
export function checkPlannerModel(model) {
  if (!PLANNER_MODELS.includes(model)) throw new ProfileError(400, `planner_model must be one of: default (""), ${PLANNER_MODELS.slice(1).join(", ")}`);
}

/** Store the model choice (400 on an unknown one). */
export function setPlannerModel(db, model) {
  checkPlannerModel(model);
  setAppMeta(db, "planner_model", model);
}
