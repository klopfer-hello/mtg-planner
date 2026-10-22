// 60-card format legality (lib/formatlegal.js): size, sideboard, copies, banned / not legal, restricted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSTRUCTED_FORMATS, constructedLegality, formatLabel } from "../lib/formatlegal.js";

const row = (name, quantity, { board = "main", pauper = "legal", vintage = "legal", text = "" } = {}) => ({
  name, quantity, board, type_line: /Mountain|Island/.test(name) ? "Basic Land" : "Instant", oracle_text: text,
  legalities: JSON.stringify({ pauper, vintage }),
});

test("a legal 60 + 15 Pauper deck; the maybe board is ignored", () => {
  const rows = [row("Lightning Bolt", 4), row("Mountain", 56), row("Pyroblast", 4, { board: "side" }), row("Hydroblast", 4, { board: "side" }),
    row("Island", 7, { board: "side" }), row("Thoughtseize", 9, { board: "maybe", pauper: "not_legal" })];
  assert.deepEqual(constructedLegality("pauper", rows), { ok: true, format: "pauper", problems: [], unchecked: 0, notes: [] });
});

test("problems: size, sideboard, copies (basics and any-number cards excepted), banned, not legal, unknown rows", () => {
  const rows = [
    row("Lightning Bolt", 5), row("Mountain", 30), row("Relentless Rats", 10, { text: "A deck can have any number of cards named Relentless Rats." }),
    row("Cranial Plating", 1, { pauper: "banned" }), row("Thoughtseize", 2, { pauper: "not_legal" }),
    row("Pyroblast", 16, { board: "side" }), { name: "Unknown Card", quantity: 1, board: "main" },
  ];
  const r = constructedLegality("pauper", rows);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.map((p) => p.rule), ["banned", "not_legal", "copies", "size", "sideboard"]);
  assert.match(r.problems[2].text, /5x Lightning Bolt, 16x Pyroblast/);
  assert.equal(r.problems[3].text, "49 main deck cards, at least 60");
  assert.equal(r.unchecked, 1);
  assert.deepEqual(r.notes, ["1 unknown cards not checked"]);
});

test("vintage restricted cards may appear once", () => {
  const rows = [row("Mountain", 58), row("Black Lotus", 2, { vintage: "restricted" })];
  assert.match(constructedLegality("vintage", rows).problems[0].text, /2x Black Lotus/);
  rows[1].quantity = 1; rows[0].quantity = 59;
  assert.equal(constructedLegality("vintage", rows).ok, true);
});

test("labels and the format list", () => {
  assert.equal(formatLabel("pauper"), "Pauper");
  assert.equal(formatLabel(null), "Commander");
  assert.ok(CONSTRUCTED_FORMATS.has("pauper") && !CONSTRUCTED_FORMATS.has("commander"));
});
