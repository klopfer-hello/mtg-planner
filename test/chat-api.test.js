// HTTP layer of a chat turn (server/routes/chats.js) with a fake Claude CLI (CLAUDE_BIN): the SSE
// events, the stored answer with its tools and session, and deleting a chat while it answers
// ("Chat was deleted", the run is cleared so the next turn is not refused with 409).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startServer } from "./helpers/server.js";

let srv, call;

// The fake CLI reads the prompt from stdin and replays a stream-json turn. A prompt containing SLOW
// waits 4 s first (the delete test aborts it meanwhile: the route then kills the process).
const TURN = [
  { type: "system", subtype: "init", session_id: "sess-1" },
  { type: "assistant", message: { content: [{ type: "text", text: "Checking." }, { type: "tool_use", name: "mcp__collection__check_owned", input: { names: ["Sol Ring"] } }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "You own **2 Sol Ring**." }] } },
  { type: "result", subtype: "success", is_error: false, result: "You own **2 Sol Ring**.", session_id: "sess-1", total_cost_usd: 0.01 },
];
const FAKE = `#!${process.execPath}
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const out = () => process.stdout.write(${JSON.stringify(TURN.map((l) => JSON.stringify(l)).join("\n") + "\n")});
  if (input.includes("SLOW")) setTimeout(out, 4000); else out();
});
`;

before(async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "test-token" };
  srv = await startServer({
    name: "chat-api",
    env,
    seed: (_dbFile, dir) => {
      const bin = path.join(dir, "fake-claude");
      writeFileSync(bin, FAKE);
      chmodSync(bin, 0o755);
      env.CLAUDE_BIN = bin; // startServer spreads env when it spawns, after seed
    },
  });
  call = srv.call;
});

after(() => srv?.stop());

/** POST a message and read the whole SSE answer: [{type, ...}]. */
async function turn(chatId, text) {
  const res = await fetch(`${srv.base}/api/chats/${chatId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  assert.equal(res.status, 200);
  const raw = await res.text();
  return raw.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
}

describe("chat turn over SSE", { skip: process.platform === "win32" && "needs a shebang fake CLI" }, () => {
  test("start, text, done; the answer is stored with its tools and the session is kept", async () => {
    const chat = (await call("POST", "/api/chats", { title: "t" })).body;
    const events = await turn(chat.id, "Do I own Sol Ring?");
    assert.equal(events[0].type, "start");
    assert.equal(events.at(-1).type, "done", JSON.stringify(events.at(-1)));
    assert.match(events.at(-1).message.content, /2 Sol Ring/);
    const stored = (await call("GET", `/api/chats/${chat.id}`)).body;
    assert.deepEqual(stored.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(stored.messages[1].tools.length, 1);
    assert.equal(stored.busy, false, "the run is cleared");
    assert.equal(stored.chat.title, "Do I own Sol Ring?", "the first message titles the chat");
  });

  test("deleting the chat mid-turn ends the stream with 'Chat was deleted' and frees the run", async () => {
    const chat = (await call("POST", "/api/chats", {})).body;
    const pending = turn(chat.id, "SLOW please");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await call("GET", `/api/chats/${chat.id}`)).body.busy, true);
    assert.equal((await call("POST", `/api/chats/${chat.id}/messages`, { text: "again" })).status, 409, "one turn per chat");
    // A restore waits for the turn (its MCP server has the database open).
    const backup = (await call("POST", "/api/backups")).body;
    const restore = await call("POST", `/api/backups/${backup.name}/restore`, { confirm: true });
    assert.equal(restore.status, 409);
    assert.match(restore.body.error, /planner is answering a chat/);
    assert.equal((await call("DELETE", `/api/chats/${chat.id}`)).status, 204);
    const events = await pending;
    assert.deepEqual(events.at(-1), { type: "error", error: "Chat was deleted" });
    // The next chat answers normally: no run was left behind.
    const next = (await call("POST", "/api/chats", {})).body;
    assert.equal((await turn(next.id, "hello")).at(-1).type, "done");
  });
});
