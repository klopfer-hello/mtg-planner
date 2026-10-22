// Offline web for tests of the v1.3.0 knowledge sources (Scryfall search/rulings, EDHREC, Spellbook,
// MTGO, the Comprehensive Rules): routes are [RegExp on the full URL, handler(url, init) → body | Response]
// tried in order; anything else answers 404. The Scryfall throttle is turned off while stubbed.

import { setThrottle } from "../../lib/scryfall.js";

/** Replace globalThis.fetch; returns {calls: [url], restore()}. A string body is sent as text, anything else as JSON. */
export function stubWeb(routes) {
  const original = globalThis.fetch;
  const calls = [];
  setThrottle({ minMs: 0, limitedMs: 0, retryMs: 0, lockoutMs: 0 });
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push(href);
    for (const [re, handler] of routes) {
      if (!re.test(href)) continue;
      const body = await handler(new URL(href), init);
      if (body instanceof Response) return body;
      return typeof body === "string"
        ? new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } })
        : new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ object: "error", details: "not stubbed" }), { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = original; setThrottle(); } };
}
