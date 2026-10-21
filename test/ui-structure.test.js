// Static checks of the single-page app that need no browser: the files
// index.html loads exist, the Babel scripts (classic scripts sharing one
// global scope, run in document order) never declare a top-level name twice,
// every JSX component used is defined, top-level code only reads names of the
// same or an earlier script, and dynamic imports point at real modules. A
// browser run (scripts/ui-smoke.mjs) covers rendering.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { PUBLIC, babelScripts, indexHtml } from "./helpers/ui.js";

const TOP_DECL = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const TOP_DESTRUCT = /^(?:const|let|var)\s+\{([^}]*)\}\s*=/gm;

/** Top-level names a script declares (column-0 declarations, as the UI code is written). */
function topNames(code) {
  const names = [...code.matchAll(TOP_DECL)].map((m) => m[1]);
  for (const m of code.matchAll(TOP_DESTRUCT)) {
    for (const part of m[1].split(",")) {
      const name = part.split(":").pop().split("=")[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Code with string literals, template text, regex-free comments removed (rough, enough for name lookups). */
const stripText = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

describe("public/index.html", () => {
  const html = indexHtml();
  const scripts = babelScripts(html);

  test("every local file it loads exists", () => {
    const page = html.replace(/<script\b[^>]*type="text\/babel"[^>]*>[\s\S]*?<\/script>/g, "");
    const refs = [...page.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1])
      .filter((u) => !/^(?:https?:|data:|#|mailto:)/.test(u));
    assert.ok(refs.length > 0);
    for (const ref of refs) assert.ok(existsSync(path.join(PUBLIC, ref.replace(/[?#].*$/, ""))), `missing ${ref}`);
  });

  test("every Babel script compiles with the react preset and no default plugins", () => {
    // Babel standalone's default plugins hoist helper constants (const _excluded = ...) into each
    // file; in one shared global scope the second file then fails with "already been declared".
    const tags = [...html.matchAll(/<script\b[^>]*type="text\/babel"[^>]*>/g)].map((m) => m[0]);
    assert.equal(tags.length, scripts.length);
    for (const t of tags) {
      assert.match(t, /data-presets="react"/, t);
      assert.match(t, /data-plugins=""/, t);
    }
  });

  test("React is set up before any app script and the app mounts once", () => {
    const first = scripts[0].code;
    assert.match(first, /^\s*"use strict";\s*\nconst \{ useState,[^}]*\} = React;/, "hooks come first");
    const mounts = scripts.filter((s) => /ReactDOM\.createRoot\(/.test(s.code));
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0], scripts.at(-1), "the app mounts in the last script");
  });

  test("no top-level name is declared twice across the Babel scripts", () => {
    const seen = new Map();
    for (const s of scripts) {
      for (const name of topNames(s.code)) {
        assert.ok(!seen.has(name), `${name} is declared in ${seen.get(name)} and ${s.file}`);
        seen.set(name, s.file);
      }
    }
    assert.ok(seen.size > 300, `found ${seen.size} top-level names`);
  });

  test("every JSX component used is defined", () => {
    const code = stripText(scripts.map((s) => s.code).join("\n"));
    const declared = new Set([...code.matchAll(/\b(?:function|const|let|class)\s+([A-Z][\w$]*)/g)].map((m) => m[1]));
    // Destructured props: ({ Icon }) or ({ icon: I }).
    for (const m of code.matchAll(/[{,]\s*(?:[\w$]+\s*:\s*)?([A-Z][\w$]*)\s*(?:=[^,}]*)?[,}]/g)) declared.add(m[1]);
    const builtins = new Set(["React"]);
    const missing = new Set();
    for (const m of code.matchAll(/<([A-Z][\w$]*)(?:\.[\w$]+)?[\s/>]/g)) {
      if (!declared.has(m[1]) && !builtins.has(m[1])) missing.add(m[1]);
    }
    assert.deepEqual([...missing], []);
  });

  test("top-level code of a script only uses names of the same or an earlier script", () => {
    const owner = new Map();
    scripts.forEach((s, i) => { for (const n of topNames(s.code)) owner.set(n, i); });
    scripts.forEach((s, i) => {
      // Top-level statements that run at load: const/let initialisers that are not functions, and bare calls.
      const lines = stripText(s.code).split("\n");
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        const init = /^(?:const|let)\s+[\w${},\s:]+=\s*(.*)$/.exec(line);
        // Bare statements at column 0 run at load too: `if (x) Later.y()`, `register(Later)`, `ReactDOM.createRoot(…)`.
        const bare = init ? null : /^((?:if\s*\(|[A-Za-z_$][\w$.]*\s*\().*)$/.exec(line);
        if (!init && !bare) continue;
        const code = init ? init[1] : bare[1];
        if (init && /^(?:\(?[\w$,\s{}=[\]]*\)?\s*=>|async\s|function\b|class\b)/.test(code)) continue; // runs later
        for (const ref of code.match(/[A-Za-z_$][\w$]*/g) ?? []) {
          const at = owner.get(ref);
          assert.ok(at == null || at <= i, `${s.file}:${j + 1} uses ${ref} from the later script ${scripts[at]?.file}`);
        }
      }
    });
  });

  test("dynamic imports point at modules in public/", () => {
    const code = scripts.map((s) => s.code).join("\n");
    const targets = [...code.matchAll(/\bimport\(\s*"(\.\/[^"]+)"\s*\)/g)].map((m) => m[1]);
    assert.ok(targets.includes("./scanlib.js"));
    for (const t of targets) assert.ok(existsSync(path.join(PUBLIC, t)), `missing ${t}`);
  });
});
