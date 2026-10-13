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

  test("asks for short phone-friendly answers", () => {
    assert.match(PLANNER_PROMPT, /1-2 short sentences/);
    assert.match(PLANNER_PROMPT, /3-5 short bullets/);
    assert.match(PLANNER_PROMPT, /No tables/);
    assert.match(PLANNER_PROMPT, /Never list the whole deck/);
    assert.match(PLANNER_PROMPT, /no text before or between tool calls/);
    assert.ok(PLANNER_PROMPT.length < 2500, `prompt stays short (${PLANNER_PROMPT.length} chars)`);
  });
});
