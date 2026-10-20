// The HTTP layer under server/: the table router (params, 405 vs 404,
// notFound messages, JSON answers), the request helpers (body limits,
// content types, the cross-site guard, string fields, download names), the
// lib error → status mapping and the static file handler (SPA fallback,
// traversal, ETags). Runs small in-process servers; no server.js.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "../server/router.js";
import {
  HttpError, attachment, checkSameOrigin, decodeParam, optString, parseJsonField, readBody, readJson, requireContentType, sendJson,
} from "../server/http.js";
import { importError, libHttpError } from "../server/errors.js";
import { createStaticHandler } from "../server/static.js";
import { BinderError } from "../lib/binders.js";
import { DeckError } from "../lib/deckrules.js";
import { ScanError } from "../lib/scanrow.js";

/** Serve `handler(req, res, url)` on a free port; errors answer like server.js. */
async function serve(handler) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      await handler(req, res, url);
    } catch (caught) {
      const err = libHttpError(caught) ?? caught;
      const status = err instanceof HttpError ? err.status : 500;
      req.resume();
      if (!res.headersSent) sendJson(res, status, { ...(err.extra ?? {}), error: err.message });
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((r) => srv.close(r)) };
}

const json = async (res) => ({ status: res.status, body: await res.json() });

describe("Router", () => {
  let s;
  const seen = [];
  before(async () => {
    const r = new Router();
    r.get("/api/things", () => [{ id: 1 }]);
    r.post("/api/things", ({ res }) => sendJson(res, 201, { created: true }));
    r.get("/api/things/:id(\\d+)", ({ params }) => ({ id: Number(params.id) }));
    r.patch("/api/things/:id(\\d+)", ({ params, query }) => ({ id: params.id, q: query.get("q") }));
    r.get("/api/things/:id(\\d+)/file.txt", () => "file");
    r.get("/api/named/:name(.+)", ({ params }) => { seen.push(params.name); return { name: params.name }; });
    r.on(["GET", "HEAD"], "/api/both", ({ method }) => ({ method }));
    r.get("/api/nothing", () => undefined);
    r.notFound("/api/things/:rest(.*)", "Thing not found");
    s = await serve(async (req, res, url) => {
      if (!(await r.handle(req, res, url))) throw new HttpError(404, "Not found");
      if (!res.headersSent) res.end("handler sent nothing");
    });
  });
  after(() => s.close());

  test("returned values are JSON 200, handlers may answer themselves", async () => {
    assert.deepEqual(await json(await fetch(`${s.base}/api/things`)), { status: 200, body: [{ id: 1 }] });
    assert.deepEqual(await json(await fetch(`${s.base}/api/things`, { method: "POST" })), { status: 201, body: { created: true } });
    assert.equal(await (await fetch(`${s.base}/api/nothing`)).text(), "handler sent nothing");
  });

  test("parameters: regex constraints, raw (not decoded), query string", async () => {
    assert.deepEqual((await json(await fetch(`${s.base}/api/things/42`))).body, { id: 42 });
    assert.deepEqual((await json(await fetch(`${s.base}/api/things/7?q=x`, { method: "PATCH" }))).body, { id: "7", q: "x" });
    assert.deepEqual((await json(await fetch(`${s.base}/api/named/a%20b/c`))).body, { name: "a%20b/c" });
  });

  test("a literal dot matches only a dot", async () => {
    assert.equal(await (await fetch(`${s.base}/api/things/1/file.txt`)).text(), '"file"');
    assert.equal((await fetch(`${s.base}/api/things/1/fileXtxt`)).status, 404);
  });

  test("known path + other method = 405; unknown path = 404 with the notFound message", async () => {
    assert.deepEqual(await json(await fetch(`${s.base}/api/things/1`, { method: "DELETE" })), { status: 405, body: { error: "Method not allowed" } });
    assert.deepEqual(await json(await fetch(`${s.base}/api/things/abc`)), { status: 404, body: { error: "Thing not found" } });
    assert.deepEqual(await json(await fetch(`${s.base}/api/other`)), { status: 404, body: { error: "Not found" } });
  });

  test("several methods on one route", async () => {
    assert.deepEqual((await json(await fetch(`${s.base}/api/both`))).body, { method: "GET" });
    const head = await fetch(`${s.base}/api/both`, { method: "HEAD" });
    assert.equal(head.status, 200);
  });
});

describe("request helpers", () => {
  let s;
  before(async () => {
    s = await serve(async (req, res, url) => {
      if (url.pathname === "/json") return sendJson(res, 200, await readJson(req, 64));
      if (url.pathname === "/body") return sendJson(res, 200, { bytes: (await readBody(req, 16)).length });
      if (url.pathname === "/csv") { requireContentType(req, "text/csv"); return sendJson(res, 200, { ok: true }); }
      if (url.pathname === "/guard") { checkSameOrigin(req); return sendJson(res, 200, { ok: true }); }
      throw new HttpError(404, "Not found");
    });
  });
  after(() => s.close());

  const post = (p, body, headers = {}) => fetch(`${s.base}${p}`, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });

  test("readJson: object bodies only, empty body = {}, content type and size checked", async () => {
    assert.deepEqual(await json(await post("/json", '{"a":1}')), { status: 200, body: { a: 1 } });
    assert.deepEqual((await json(await post("/json", ""))).body, {});
    assert.equal((await post("/json", "[1]")).status, 400);
    assert.equal((await post("/json", "{oops")).status, 400);
    assert.equal((await post("/json", '{"a":1}', { "Content-Type": "text/plain" })).status, 415);
    const big = await post("/json", JSON.stringify({ a: "x".repeat(100) }));
    assert.equal(big.status, 413);
    assert.match((await big.json()).error, /max 0 KB|max \d+ KB/);
  });

  test("readBody: limit on streamed bodies too", async () => {
    assert.deepEqual((await json(await post("/body", "0123456789"))).body, { bytes: 10 });
    assert.equal((await post("/body", "x".repeat(17))).status, 413);
  });

  test("requireContentType only checks requests with a body", async () => {
    assert.equal((await fetch(`${s.base}/csv`, { method: "POST" })).status, 200);
    assert.equal((await post("/csv", "a,b", { "Content-Type": "text/csv; charset=utf-8" })).status, 200);
    assert.equal((await post("/csv", "a,b")).status, 415);
  });

  test("checkSameOrigin: GET always, cross-site and foreign origins refused", async () => {
    assert.equal((await fetch(`${s.base}/guard`)).status, 200);
    assert.equal((await post("/guard", "{}")).status, 200);
    assert.equal((await post("/guard", "{}", { "Sec-Fetch-Site": "same-origin" })).status, 200);
    assert.equal((await post("/guard", "{}", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post("/guard", "{}", { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post("/guard", "{}", { Origin: "null" })).status, 403);
    assert.equal((await post("/guard", "{}", { Origin: s.base })).status, 200);
  });

  test("optString, parseJsonField, decodeParam, attachment", () => {
    assert.equal(optString(undefined, "x"), null);
    assert.equal(optString("  hi  ", "x"), "hi");
    assert.throws(() => optString(5, "name"), (e) => e.status === 400 && /name must be a string/.test(e.message));
    assert.throws(() => optString("abcdef", "name", 3), (e) => e.status === 400 && /max 3/.test(e.message));
    assert.deepEqual(parseJsonField('{"a":1}', null), { a: 1 });
    assert.equal(parseJsonField("{bad", "fb"), "fb");
    assert.equal(parseJsonField("", "fb"), "fb");
    assert.equal(decodeParam("a%20b", "bad"), "a b");
    assert.throws(() => decodeParam("%E0%A4%A", "Bad name"), (e) => e.status === 400 && e.message === "Bad name");
    assert.equal(attachment("Deck: Ür", "txt", "deck"), "attachment; filename=\"Deck_ _r.txt\"; filename*=UTF-8''Deck%3A%20%C3%9Cr.txt");
    assert.equal(attachment("日本", "pdf", "guide"), "attachment; filename=\"_.pdf\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf");
    assert.equal(attachment("", "csv", "collection"), "attachment; filename=\"collection.csv\"; filename*=UTF-8''.csv");
  });
});

describe("lib errors → HTTP", () => {
  test("libHttpError keeps status and extra; unknown errors stay null", () => {
    const b = libHttpError(new BinderError(409, "confirm", { code: "confirm_master", manabox_copies: 2 }));
    assert.equal(b.status, 409);
    assert.deepEqual(b.extra, { code: "confirm_master", manabox_copies: 2 });
    assert.equal(libHttpError(new DeckError(404, "Deck not found")).status, 404);
    assert.equal(libHttpError(new ScanError(409, "committed")).message, "committed");
    const h = new HttpError(418, "teapot");
    assert.equal(libHttpError(h), h);
    assert.equal(libHttpError(new Error("boom")), null);
  });

  test("importError: lib errors pass, Scryfall 4xx = 400, outages = 502, the rest 400", () => {
    assert.equal(importError(new DeckError(404, "x")).status, 404);
    const rejected = Object.assign(new Error("bad identifier"), { status: 422 });
    assert.deepEqual([importError(rejected).status, importError(rejected).message], [400, "Scryfall rejected the request: bad identifier"]);
    assert.equal(importError(Object.assign(new Error("slow down"), { status: 429 })).status, 502);
    assert.equal(importError(Object.assign(new Error("down"), { status: 503 })).status, 502);
    assert.equal(importError(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") })).status, 502);
    assert.equal(importError(new Error("Missing column Name")).status, 400);
  });
});

describe("static files", () => {
  let s, dir;
  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-static-"));
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><p>app</p>");
    writeFileSync(path.join(dir, "app.js"), "export const x = 1;");
    writeFileSync(path.join(dir, "sub", "page.css"), "body{}");
    writeFileSync(path.join(path.dirname(dir), "secret.txt"), "nope");
    const handler = createStaticHandler(dir);
    s = await serve(handler);
  });
  after(async () => { await s.close(); rmSync(dir, { recursive: true, force: true }); });

  test("files with their MIME type; / and route-like paths get index.html", async () => {
    let r = await fetch(`${s.base}/app.js`);
    assert.equal(r.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await r.text(), "export const x = 1;");
    r = await fetch(`${s.base}/sub/page.css`);
    assert.equal(r.headers.get("content-type"), "text/css; charset=utf-8");
    for (const p of ["/", "/decks/12", "/collection/binder/Box"]) {
      r = await fetch(`${s.base}${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(await r.text(), "<!doctype html><p>app</p>", p);
    }
  });

  test("missing assets 404, traversal never leaves the dir, bad encodings 400", async () => {
    assert.equal((await fetch(`${s.base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/..%2fsecret.txt`)).status, 404);
    assert.equal((await fetch(`${s.base}/%2e%2e/secret.txt`)).status, 404);
    assert.equal((await fetch(`${s.base}/%E0%A4%A`)).status, 400);
    assert.equal((await fetch(`${s.base}/a%00b`)).status, 400);
  });

  test("ETag revalidation and HEAD", async () => {
    const r = await fetch(`${s.base}/app.js`);
    const etag = r.headers.get("etag");
    assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    assert.equal(r.headers.get("cache-control"), "no-cache");
    assert.equal((await fetch(`${s.base}/app.js`, { headers: { "If-None-Match": etag } })).status, 304);
    const head = await fetch(`${s.base}/app.js`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "19");
    assert.equal(await head.text(), "");
  });
});
