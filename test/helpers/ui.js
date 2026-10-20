// The single-page app's sources as the browser loads them: public/index.html
// and its Babel scripts (inline or `src`, in document order), for static
// checks that need no browser.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./server.js";

export const PUBLIC = path.join(ROOT, "public");
export const indexHtml = () => readFileSync(path.join(PUBLIC, "index.html"), "utf8");

/** [{file, code}] of every `<script type="text/babel">` (file = the src, or "index.html" for an inline one). */
export function babelScripts(html = indexHtml()) {
  return [...html.matchAll(/<script\b([^>]*)type="text\/babel"([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => {
    const src = /\bsrc="([^"]+)"/.exec(`${m[1]} ${m[2]}`)?.[1] ?? null;
    return src ? { file: src, code: readFileSync(path.join(PUBLIC, src), "utf8") } : { file: "index.html", code: m[3] };
  });
}

/** All UI code (every Babel script, in order) as one string. */
export const uiCode = () => babelScripts().map((s) => s.code).join("\n");
