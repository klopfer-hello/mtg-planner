// edit_copies: correct language / printing / finish / condition of owned
// copies (lib/edits.js, actor 'claude', logged and undoable in the app). No
// deleting: that is app-only.

import { randomBytes } from "node:crypto";
import { getAppMeta, setAppMeta } from "../../lib/db.js";
import { BinderError } from "../../lib/binders.js";
import { EDIT_CONDITIONS, editCopies } from "../../lib/edits.js";
import { fetchCollection } from "../../lib/scryfall.js";
import { getDb, getIndex, indexPrinting, log } from "../context.js";
import { likeEsc, setNum, ToolError } from "../format.js";

export const TOOLS = [
  {
    name: "edit_copies",
    description:
      "Correct facts about copies the user OWNS: language, printing (another set/collector number of the SAME card), " +
      "finish (normal/foil/etched) or condition. Copies keep their binder; total copies never change (no deleting: " +
      "deleting is only possible in the app, point the user there). Every edit is logged and the user can undo it in the app.\n" +
      "BEFORE calling it, tell the user the exact change in one line (card, number of copies, which copies, from → to), " +
      "e.g. \"Changing **2× Counterspell** (7ED #67, binder Blue) from English to German.\" Never guess: if the user's " +
      "request or the owned copies leave it unclear which copies or what target is meant, ask instead of calling. " +
      "The tool refuses ambiguous requests too: when several different copies match, narrow them down with match " +
      "(set, collector_number, language, finish, condition, binder) or give quantity = all matching copies; quantity is " +
      "required when more than one copy matches. Copies imported from ManaBox: the first such edit makes mtg-planner " +
      "the master of the collection (ManaBox imports then add cards instead of replacing them); the tool then answers " +
      "with a confirmation request and a token: explain it and end your answer with the question. Only when the user " +
      "agrees in their NEXT message, call again with confirm_master set to that token (it only works in a later turn).",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "Card name (exact English name or front face) or oracle_id." },
        match: {
          type: "object",
          description: "Which owned copies (all fields optional, combined with AND; see get_card for the owned copies).",
          properties: {
            set: { type: "string", description: "Set code of the owned printing, e.g. \"7ed\"." },
            collector_number: { type: "string" },
            language: { type: "string", description: "Language code, e.g. en, de, it, ja." },
            finish: { type: "string", enum: ["normal", "foil", "etched"] },
            condition: { type: "string", enum: EDIT_CONDITIONS },
            binder: { type: "string", description: "Binder name (\"\" = Unsorted)." },
          },
          additionalProperties: false,
        },
        set: {
          type: "object",
          description: "The change (at least one field).",
          properties: {
            language: { type: "string", description: "New language code (en, de, fr, it, es, pt, ja, ko, ru, zhs, zht)." },
            printing: {
              type: "object",
              description: "New printing of the same card.",
              properties: { set: { type: "string" }, collector_number: { type: "string" } },
              required: ["set", "collector_number"],
              additionalProperties: false,
            },
            finish: { type: "string", enum: ["normal", "foil", "etched"] },
            condition: { type: "string", enum: EDIT_CONDITIONS },
          },
          additionalProperties: false,
        },
        quantity: { type: "integer", minimum: 1, description: "How many of the matching copies to change (required when more than one copy matches)." },
        confirm_master: { type: "string", description: "The token from an earlier confirmation request, only after the user agreed (in a later message) that editing ManaBox copies makes mtg-planner the collection master." },
      },
      required: ["card", "set"],
      additionalProperties: false,
    },
    annotations: { title: "Edit owned copies", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: editCopiesTool,
  },
];

// Making the app the collection master needs the user's OK, not just the model's word: a
// confirm_master refusal stores a one-time token (app meta), and the token is only accepted
// by ANOTHER server process, i.e. a later chat turn (the CLI spawns this server per turn),
// so the user has answered in between. A token is bound to the copies it was issued for
// (oracle card + the matched rows and quantity): it can't flip the master for another edit.
// The new values (set) may differ, so a retry after a refused finish still works. 1 h, single
// use, consumed only when the edit succeeds; up to 10 open tokens (one per question).
const PROCESS_ID = randomBytes(8).toString("hex");
const MASTER_TOKEN_KEY = "claude_master_token";
const MASTER_TOKEN_TTL_MS = 3600 * 1000;
const MASTER_TOKENS_MAX = 10;

function openTokens(d) {
  let saved = null;
  try { saved = JSON.parse(getAppMeta(d, MASTER_TOKEN_KEY) || "null"); } catch { saved = null; }
  const list = Array.isArray(saved?.tokens) ? saved.tokens : [];
  return list.filter((t) => t && typeof t.token === "string" && Date.now() - t.at < MASTER_TOKEN_TTL_MS);
}

function issueMasterToken(d, scope) {
  const token = randomBytes(6).toString("hex");
  const tokens = [...openTokens(d), { token, process: PROCESS_ID, at: Date.now(), scope }].slice(-MASTER_TOKENS_MAX);
  setAppMeta(d, MASTER_TOKEN_KEY, JSON.stringify({ tokens }));
  return token;
}

/**
 * true when `value` is a valid token from an earlier turn for these copies (`scope`); false when
 * absent; ToolError when wrong. Does not consume it: consumeMasterToken after the edit worked.
 */
function masterConfirmed(d, value, scope) {
  if (value == null || value === false) return false;
  const saved = typeof value === "string" ? openTokens(d).find((t) => t.token === value) : null;
  if (saved && saved.process !== PROCESS_ID && saved.scope === scope) return true;
  throw new ToolError(saved?.process === PROCESS_ID
    ? "Not changed: the user has not answered yet. Ask them first; the token works only after their reply."
    : saved
      ? "Not changed: that confirm_master token was issued for other copies. Call without it to ask the user about these."
      : "Not changed: confirm_master must be the token from an earlier confirmation request (call without it to get one).");
}

function consumeMasterToken(d, value) {
  if (typeof value !== "string") return;
  setAppMeta(d, MASTER_TOKEN_KEY, JSON.stringify({ tokens: openTokens(d).filter((t) => t.token !== value) }));
}

const normFinish = (f) => { const v = String(f).trim().toLowerCase(); return v === "nonfoil" ? "normal" : v; };
const normCondition = (c) => String(c).trim().toLowerCase().replace(/[\s-]+/g, "_");
const rowLabel = (r) => `${setNum(r)} ${r.finish} ${r.language} ${r.condition}${r.binder ? ` [binder: ${r.binder}]` : " [Unsorted]"}`;

/** The one oracle card `card` names (oracle_id, exact name or front face); ToolError otherwise. */
function resolveOwnedCard(d, card) {
  const ref = String(card ?? "").trim();
  if (!ref) throw new ToolError("card is required (name or oracle_id).");
  const byOracle = d.prepare("SELECT oracle_id, name FROM cards WHERE oracle_id = ? LIMIT 1").get(ref);
  if (byOracle) return byOracle;
  const hits = d.prepare(
    `SELECT DISTINCT c.oracle_id, c.name FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' ESCAPE '\\'`,
  ).all(ref, likeEsc(ref));
  const oracles = [...new Map(hits.map((h) => [h.oracle_id, h])).values()];
  if (oracles.length > 1) {
    throw new ToolError(`"${ref}" names ${oracles.length} different cards (${oracles.map((o) => `${o.name}: oracle_id ${o.oracle_id}`).join("; ")}). ` +
      "Ask the user which one and pass its oracle_id as card.");
  }
  if (!oracles.length) throw new ToolError(`The user owns no "${ref}" (check the name with search_collection or check_owned).`);
  return oracles[0];
}

/**
 * The new printing for `set.printing` {set, collector_number}: a printing of the same oracle card,
 * in the wanted language when it exists (else English, else the only one). Sources: the cards
 * table, the card index, then Scryfall (/cards/collection gives the English printing).
 */
async function resolveNewPrinting(d, oracle, spec, wantLang) {
  const set = String(spec?.set ?? "").trim().toLowerCase();
  const cn = String(spec?.collector_number ?? "").trim();
  if (!set || !cn) throw new ToolError("set.printing needs set and collector_number.");
  const label = `${set.toUpperCase()} #${cn}`;
  const found = new Map(); // id -> {id, lang, oracle_id, name}
  for (const r of d.prepare("SELECT scryfall_id AS id, lang, oracle_id, name FROM cards WHERE set_code = ? COLLATE NOCASE AND collector_number = ? COLLATE NOCASE").all(set, cn)) {
    found.set(r.id, r);
  }
  const i = getIndex();
  if (i) {
    try {
      for (const r of i.prepare("SELECT id, lang, oracle_id, name FROM printings WHERE set_code = ? AND collector_number = ? COLLATE NOCASE").all(set, cn)) {
        if (!found.has(r.id)) found.set(r.id, r);
      }
    } catch { /* index not built yet */ }
  }
  if (!found.size) {
    try {
      const { cards } = await fetchCollection([{ set, collector_number: cn }]);
      for (const c of cards) found.set(c.id, { id: c.id, lang: c.lang, oracle_id: c.oracle_id, name: c.name });
    } catch (err) { log(`Scryfall printing lookup failed: ${err.message}`); }
  }
  if (!found.size) throw new ToolError(`No printing ${label} found (check the set code and collector number, e.g. with the scryfall tools).`);
  const same = [...found.values()].filter((p) => p.oracle_id === oracle.oracle_id);
  if (!same.length) {
    throw new ToolError(`${label} is ${[...found.values()][0].name}, not ${oracle.name}: a printing can only change to another printing of the same card.`);
  }
  return same.find((p) => p.lang === wantLang) ?? same.find((p) => p.lang === "en") ??
    (same.length === 1 ? same[0] : (() => {
      throw new ToolError(`${label} of ${oracle.name} exists in ${same.map((p) => p.lang).join(", ")}: set language to pick one.`);
    })());
}

async function editCopiesTool(args) {
  const d = getDb();
  const oracle = resolveOwnedCard(d, args.card);
  const match = args.match ?? {};
  if (typeof match !== "object" || Array.isArray(match)) throw new ToolError("match must be an object.");
  const set = args.set;
  if (!set || typeof set !== "object" || Array.isArray(set)) throw new ToolError("set is required: {language?, printing?, finish?, condition?}.");
  const unknown = [...Object.keys(match).filter((k) => !["set", "collector_number", "language", "finish", "condition", "binder"].includes(k)),
    ...Object.keys(set).filter((k) => !["language", "printing", "finish", "condition"].includes(k))];
  if (unknown.length) throw new ToolError(`Unknown field(s): ${unknown.join(", ")}.`);
  if (!["language", "printing", "finish", "condition"].some((k) => set[k] != null)) {
    throw new ToolError("set needs at least one of language, printing, finish, condition.");
  }

  // The owned copies of the card that `match` selects.
  const owned = d.prepare(
    `SELECT col.*, c.name, c.set_code, c.collector_number FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id = ? ORDER BY c.set_code, c.collector_number, col.binder, col.id`,
  ).all(oracle.oracle_id);
  const eq = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").trim().toLowerCase();
  const rows = owned.filter((r) =>
    (match.set == null || eq(r.set_code, match.set)) &&
    (match.collector_number == null || eq(r.collector_number, match.collector_number)) &&
    (match.language == null || eq(r.language, match.language)) &&
    (match.finish == null || r.finish === normFinish(match.finish)) &&
    (match.condition == null || r.condition === normCondition(match.condition)) &&
    (match.binder == null || eq(r.binder, match.binder)));
  const groups = groupRows(rows);
  const total = rows.reduce((a, r) => a + r.quantity, 0);
  const list = (gs) => gs.map((g) => `  ${g.quantity}x ${rowLabel(g.row)}`).join("\n");
  if (!total) {
    throw new ToolError(`No owned copies of ${oracle.name} match ${JSON.stringify(match)}. The user owns:\n${list(groupRows(owned))}`);
  }
  if (args.quantity != null && (!Number.isInteger(args.quantity) || args.quantity < 1)) throw new ToolError("quantity must be a positive integer.");
  const quantity = args.quantity ?? (total === 1 ? 1 : null);
  if (quantity == null) {
    throw new ToolError(`${total} copies of ${oracle.name} match:\n${list(groups)}\n` +
      "Ask the user how many (and which) copies to change, then pass quantity (and match).");
  }
  if (quantity > total) throw new ToolError(`Only ${total} matching copies of ${oracle.name}:\n${list(groups)}`);
  if (groups.length > 1 && quantity !== total) {
    throw new ToolError(`${quantity} of ${total} copies is ambiguous: the matching copies differ:\n${list(groups)}\n` +
      "Ask the user which ones, then narrow match (set, collector_number, language, finish, condition, binder).");
  }

  // The new printing (same card) and the edit itself.
  const out = {};
  if (set.language != null) out.language = String(set.language);
  if (set.finish != null) out.finish = normFinish(set.finish);
  if (set.condition != null) out.condition = normCondition(set.condition);
  if (set.printing != null) {
    const langs = new Set(groups.map((g) => g.row.language));
    const wantLang = out.language?.trim().toLowerCase() ?? (langs.size === 1 ? [...langs][0] : "en");
    out.printing_id = (await resolveNewPrinting(d, oracle, set.printing, wantLang)).id;
  }
  const items = groups.map(({ row, quantity: q }) => ({
    scryfall_id: row.scryfall_id, finish: row.finish, language: row.language, condition: row.condition, binder: row.binder,
    quantity: groups.length === 1 ? quantity : q,
  }));
  // The copies a confirm_master token covers (see masterConfirmed).
  const scope = JSON.stringify([oracle.oracle_id, items.map((i) => [i.scryfall_id, i.finish, i.language, i.condition, i.binder.toLowerCase(), i.quantity])]);
  let res;
  try {
    const confirmed = masterConfirmed(d, args.confirm_master, scope);
    res = await editCopies(d, { items, set: out, confirm_master: confirmed, actor: "claude" }, { getPrinting: indexPrinting });
    if (confirmed) consumeMasterToken(d, args.confirm_master);
  } catch (err) {
    if (!(err instanceof BinderError)) throw err;
    if (err.extra?.code === "confirm_master") {
      const token = issueMasterToken(d, scope);
      throw new ToolError(`Not changed yet: ${err.extra.manabox_copies} of these copies were imported from ManaBox. Editing them makes ` +
        "mtg-planner the master of the collection (ManaBox imports then add new cards instead of replacing the collection). " +
        "Explain this to the user and ask; end your answer there. Only if they agree in their next message, call edit_copies " +
        `again with confirm_master: "${token}" (the token is refused in this same turn).`);
    }
    throw new ToolError(err.message);
  }
  if (!res.edit_id) return `Nothing changed: the ${quantity === 1 ? "copy already has" : "copies already have"} these values.`;
  const cards = d.prepare("SELECT set_code, collector_number FROM cards WHERE scryfall_id = ?");
  const now = res.rows.map((r) => `  ${r.quantity}x ${oracle.name} ${rowLabel({ ...r, ...cards.get(r.scryfall_id) })}${r.source === "app" ? " (kept by the app)" : r.source === "scan" ? " (scanned)" : ""}`);
  const lines = [`Edit #${res.edit_id}: ${res.summary}. The user can undo it in the app's edit log.`];
  if (now.length) lines.push("Rows with the edited copies now:", ...now);
  if (res.converted_copies) lines.push(`${res.converted_copies} ManaBox ${res.converted_copies === 1 ? "copy is" : "copies are"} now kept by the app; mtg-planner is the collection master.`);
  return lines.join("\n");
}

/** Owned rows grouped by key without source: copies from ManaBox / scan / app are the same copies to the user. */
function groupRows(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = JSON.stringify([r.scryfall_id, r.finish, r.language, r.condition, r.binder.toLowerCase()]);
    const g = m.get(k) ?? { row: r, quantity: 0 };
    g.quantity += r.quantity;
    m.set(k, g);
  }
  return [...m.values()];
}
