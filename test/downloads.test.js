// Phone app downloads: lib/downloads.js (listing, names, sidecar, hash) and
// the HTTP routes (list, download headers, HEAD, 400/404). Real server on a
// free port, temp DB.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadPath, listDownloads } from "../lib/downloads.js";
import { startServer } from "./helpers/server.js";

const APK = Buffer.from("PK\u0003\u0004 not really an apk");
const sha = (b) => createHash("sha256").update(b).digest("hex");

let dir, dl;
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-downloads-"));
  dl = path.join(dir, "downloads");
  mkdirSync(dl);
  writeFileSync(path.join(dl, "scanner-1.0.0.apk"), APK);
  writeFileSync(path.join(dl, "scanner-1.0.0.apk.json"), JSON.stringify({ title: "Scanner", version: "1.0.0", notes: 7 }));
  writeFileSync(path.join(dl, "readme.txt"), "not offered");
  writeFileSync(path.join(dl, ".hidden.apk"), "not offered");
  mkdirSync(path.join(dl, "dir.apk"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("lib/downloads", () => {
  test("lists only plain .apk files with sidecar and hash", async () => {
    const list = await listDownloads(dl);
    assert.equal(list.length, 1);
    const [f] = list;
    assert.equal(f.name, "scanner-1.0.0.apk");
    assert.equal(f.title, "Scanner");
    assert.equal(f.version, "1.0.0");
    assert.equal(f.notes, null); // not a string
    assert.equal(f.size, APK.length);
    assert.equal(f.sha256, sha(APK));
  });
  test("missing dir is an empty list", async () => {
    assert.deepEqual(await listDownloads(path.join(dir, "nope")), []);
  });
  test("downloadPath refuses bad names and missing files", async () => {
    assert.equal(await downloadPath(dl, "scanner-1.0.0.apk"), path.join(dl, "scanner-1.0.0.apk"));
    for (const bad of ["../x.apk", "readme.txt", ".hidden.apk", "a/b.apk"]) {
      await assert.rejects(downloadPath(dl, bad), (e) => e.status === 400, bad);
    }
    await assert.rejects(downloadPath(dl, "gone.apk"), (e) => e.status === 404);
    await assert.rejects(downloadPath(dl, "dir.apk"), (e) => e.status === 404);
  });
});

describe("HTTP /api/downloads", () => {
  let srv, base;
  before(async () => {
    srv = await startServer({ name: "downloads-api", env: { DOWNLOAD_DIR: dl, APP_VERSION: "9.9.9-test" } });
    base = srv.base;
  });
  after(() => srv?.stop());

  test("list", async () => {
    const r = await fetch(`${base}/api/downloads`);
    assert.equal(r.status, 200);
    const { downloads } = await r.json();
    assert.deepEqual(downloads.map((d) => d.name), ["scanner-1.0.0.apk"]);
  });
  test("download and HEAD", async () => {
    const r = await fetch(`${base}/api/downloads/scanner-1.0.0.apk`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.match(r.headers.get("content-disposition"), /attachment; filename="scanner-1\.0\.0\.apk"/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), APK);
    const h = await fetch(`${base}/api/downloads/scanner-1.0.0.apk`, { method: "HEAD" });
    assert.equal(h.status, 200);
    assert.equal(h.headers.get("content-length"), String(APK.length));
  });
  test("bad name 400, missing 404", async () => {
    assert.equal((await fetch(`${base}/api/downloads/readme.txt`)).status, 400);
    assert.equal((await fetch(`${base}/api/downloads/%2e%2e%2fx.apk`)).status, 400);
    assert.equal((await fetch(`${base}/api/downloads/gone.apk`)).status, 404);
  });
});
