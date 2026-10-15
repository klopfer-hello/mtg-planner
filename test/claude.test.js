// lib/claude.js: locating the runtime-installed Claude Code CLI (it is not
// part of the image), the "not installed" error path of chat and vision, and
// the planner prompt's non-negotiable rules.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-cli-"));
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-not-real";
process.env.DB_FILE = path.join(tmp, "db", "mtg-planner.db");

const { PLANNER_PROMPT, claudeCliStatus, cliPrefix, resolveClaudeBin, runTurn, runVision } = await import("../lib/claude.js");

const saved = {};
const setEnv = (vars) => {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
};
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake npm --prefix install: bin/claude plus the package.json carrying the version. */
function fakeInstall(prefix, version) {
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  const pkgDir = path.join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version }));
  const bin = path.join(prefix, "bin", "claude");
  writeFileSync(bin, "#!/bin/sh\necho fake\n");
  chmodSync(bin, 0o755);
  return bin;
}

describe("CLI resolution", () => {
  before(() => setEnv({ CLAUDE_BIN: null, CLAUDE_CONFIG_DIR: null, CLAUDE_CLI_PREFIX: null, CLAUDE_CODE_VERSION: "2.1.296" }));

  test("prefix defaults to <CLAUDE_CONFIG_DIR>/cli", () => {
    setEnv({ CLAUDE_CONFIG_DIR: "/somewhere" });
    assert.equal(cliPrefix(), path.join("/somewhere", "cli"));
    setEnv({ CLAUDE_CONFIG_DIR: null });
    assert.equal(cliPrefix(), path.join("/claude", "cli"));
  });

  test("uses the installed CLI under the prefix and reports its version", () => {
    const prefix = path.join(tmp, "installed");
    const bin = fakeInstall(prefix, "2.1.296");
    setEnv({ CLAUDE_CLI_PREFIX: prefix, CLAUDE_BIN: null });
    assert.equal(resolveClaudeBin(), bin);
    assert.deepEqual(claudeCliStatus(), { status: "installed", version: "2.1.296", wanted: "2.1.296", bin });
  });

  test("falls back to claude on PATH and reports missing when there is none", () => {
    setEnv({ CLAUDE_CLI_PREFIX: path.join(tmp, "empty"), CLAUDE_BIN: null, PATH: path.join(tmp, "nopath") });
    assert.equal(resolveClaudeBin(), "claude");
    const s = claudeCliStatus();
    assert.equal(s.status, "missing");
    assert.equal(s.version, null);
  });

  test("finds claude on PATH", () => {
    const dir = path.join(tmp, "pathbin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n");
    chmodSync(path.join(dir, "claude"), 0o755);
    setEnv({ CLAUDE_CLI_PREFIX: path.join(tmp, "empty"), CLAUDE_BIN: null, PATH: dir });
    assert.equal(claudeCliStatus().status, "installed");
  });

  test("an explicit CLAUDE_BIN wins; a missing one is reported", () => {
    setEnv({ CLAUDE_BIN: path.join(tmp, "does-not-exist", "claude") });
    assert.equal(resolveClaudeBin(), process.env.CLAUDE_BIN);
    assert.equal(claudeCliStatus().status, "missing");
  });
});

describe("missing CLI", () => {
  before(() => setEnv({ CLAUDE_BIN: path.join(tmp, "gone", "claude") }));

  test("a chat turn resolves with a clear error instead of crashing", async () => {
    const r = await runTurn({ prompt: "hi" });
    assert.equal(r.isError, true);
    assert.match(r.error, /Claude Code CLI is not installed/);
    assert.match(r.error, /restart/);
    assert.equal(r.sessionGone, false);
  });

  test("a vision call resolves with the same error", async () => {
    const r = await runVision({ images: [{ media_type: "image/jpeg", data: "AAAA" }] });
    assert.equal(r.json, null);
    assert.match(r.error, /Claude Code CLI is not installed/);
  });
});

describe("planner prompt", () => {
  test("keeps the tool and deck rules", () => {
    for (const s of ["check_owned", "search_collection", "save_deck", "deck_id", "100 cards", "color identity", "Decks tab", "user's language"]) {
      assert.ok(PLANNER_PROMPT.includes(s), `prompt mentions ${s}`);
    }
  });

  test("knows owned vs free copies and deck status", () => {
    for (const s of ["shopping_list", "Owned is not free", "built decks claim", "without breaking my decks", "avail>=1", "status idea"]) {
      assert.ok(PLANNER_PROMPT.includes(s), `prompt mentions ${s}`);
    }
  });

  test("edits: exact change first, ask when unclear, no deleting", () => {
    for (const s of ["edit_copies", "state the exact change", "from → to", "ask instead", "Never delete", "point the user to the app"]) {
      assert.ok(PLANNER_PROMPT.includes(s), `prompt mentions ${s}`);
    }
  });

  test("asks for short phone-friendly answers", () => {
    assert.match(PLANNER_PROMPT, /1-2 short sentences/);
    assert.match(PLANNER_PROMPT, /3-5 short bullets/);
    assert.match(PLANNER_PROMPT, /No tables/);
    assert.match(PLANNER_PROMPT, /Never list the whole deck/);
    assert.match(PLANNER_PROMPT, /no text before or between tool calls/);
    // 2891 chars measured with the v0.7.0 bracket rule; cap = that + ~50.
    assert.ok(PLANNER_PROMPT.length < 2940, `prompt stays short (${PLANNER_PROMPT.length} chars)`);
  });

  test("brackets: evaluate_deck before save_deck for a target bracket, tutors and B1/B5 rules", () => {
    for (const s of ["evaluate_deck", "get_deck/evaluate_deck", "run evaluate_deck before save_deck", "OVER", "Tutors don't limit brackets", "B1/B5 are the user's call"]) {
      assert.ok(PLANNER_PROMPT.includes(s), `prompt mentions ${s}`);
    }
    assert.match(PLANNER_PROMPT, /get_deck, evaluate_deck, shopping_list/, "evaluate_deck in the Tools line");
  });
});

describe("MCP config", () => {
  test("passes the Spellbook opt-out and the app version to the collection server", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const url = new URL("../lib/claude.js", import.meta.url).href;
    const run = (extra) => {
      const env = { ...process.env, SCRYFALL_MCP_ENTRY: path.join(tmp, "none.js"), ...extra };
      for (const k of Object.keys(env)) if (env[k] == null) delete env[k];
      const file = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e",
        `const m = await import(${JSON.stringify(url)}); process.stdout.write(m.prepareMcpConfig());`],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return JSON.parse(readFileSync(file, "utf8")).mcpServers.collection.env;
    };
    const off = run({ SPELLBOOK_ENABLED: "false", APP_VERSION: "9.9.9+test" });
    assert.equal(off.SPELLBOOK_ENABLED, "false");
    assert.equal(off.APP_VERSION, "9.9.9+test");
    const dflt = run({ SPELLBOOK_ENABLED: null, APP_VERSION: null });
    assert.equal(dflt.SPELLBOOK_ENABLED, undefined, "not set: the meta setting decides");
    assert.equal(dflt.APP_VERSION, "dev");
  });
});

describe("stored answer", () => {
  test("short notes written before a tool call are dropped, the final answer stays", async () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "Let me check your collection." }, { type: "tool_use", name: "mcp__collection__search_collection", input: { q: "t:elf" } }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Query may be too complex; simplify." }, { type: "tool_use", name: "mcp__collection__check_owned", input: { names: ["Sol Ring"] } }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "You own **1 Sol Ring**." }] } },
      { type: "result", subtype: "success", is_error: false, result: "You own **1 Sol Ring**.", session_id: "s1", total_cost_usd: 0.01 },
    ];
    const data = path.join(tmp, "stream.jsonl");
    writeFileSync(data, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const bin = path.join(tmp, "fake-claude");
    // A node script (the CLI's environment has no PATH to rely on).
    writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(require("fs").readFileSync(${JSON.stringify(data)})));\n`);
    chmodSync(bin, 0o755);
    setEnv({ CLAUDE_BIN: bin });
    const r = await runTurn({ prompt: "hi" });
    assert.equal(r.error, null);
    assert.equal(r.text, "You own **1 Sol Ring**.");
    assert.equal(r.tools.length, 2);
  });

  test("the line announcing an edit_copies change stays, and its chip shows the change", async () => {
    const announce = "Changing **2x Counterspell** (7ED #67, binder Blue) from English to German.";
    const lines = [
      { type: "system", subtype: "init", session_id: "s2" },
      { type: "assistant", message: { content: [{ type: "text", text: announce }, {
        type: "tool_use", name: "mcp__collection__edit_copies",
        input: { card: "Counterspell", match: { set: "7ed", binder: "Blue" }, quantity: 2, set: { language: "de" } },
      }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done: **Edit #3**." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "s2", total_cost_usd: 0.01 },
    ];
    const data = path.join(tmp, "stream-edit.jsonl");
    writeFileSync(data, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const bin = path.join(tmp, "fake-claude-edit");
    writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(require("fs").readFileSync(${JSON.stringify(data)})));\n`);
    chmodSync(bin, 0o755);
    setEnv({ CLAUDE_BIN: bin });
    const r = await runTurn({ prompt: "fix it" });
    assert.equal(r.error, null);
    assert.match(r.text, /^Changing \*\*2x Counterspell\*\* \(7ED #67, binder Blue\) from English to German\./);
    assert.match(r.text, /Edit #3/);
    assert.deepEqual(r.tools, [{ name: "collection.edit_copies", input: "2x Counterspell {set:7ed, binder:Blue} → language de" }]);
  });
});
