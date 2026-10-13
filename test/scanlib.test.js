// Browser capture module (public/scanlib.js): the auto-capture state machine
// is pure, so it runs under node:test without a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoCapture } from "../public/scanlib.js";

const thumb = (v) => ({ w: 64, h: 64, d: new Uint8Array(64 * 64).fill(v) });
const corners = [[100, 100], [400, 100], [400, 520], [100, 520]];
const art = (bit) => Uint8Array.from({ length: 64 }, (_, i) => (i % 2 === bit ? 1 : 0));

function feed(ac, frames, start = 0) {
  const caps = [];
  frames.forEach((f, i) => {
    const r = ac.step({ now: start + i * 125, guideW: 300, sharp: 200, corners: f.found ? corners : null, ...f });
    if (r.capture) caps.push(i);
  });
  return caps;
}

test("a brief detection dropout (weak quad) never re-captures the same card", () => {
  const ac = new AutoCapture();
  const card = { found: true, thumb: thumb(120), artHash: art(0) };
  const caps = feed(ac, [
    ...Array(8).fill(card),
    ...Array(3).fill({ found: false, weak: true, thumb: thumb(118) }),
    ...Array(4).fill({ found: false, weak: false, thumb: thumb(121) }), // card not detected, scene unchanged
    ...Array(8).fill(card),
  ]);
  assert.equal(caps.length, 1);
  assert.equal(ac.state, "cooldown");
});

test("the card leaving the frame (or another card swapped in) re-arms", () => {
  const ac = new AutoCapture();
  const card = { found: true, thumb: thumb(120), artHash: art(0) };
  const empty = { found: false, weak: false, thumb: thumb(30) };
  const next = { found: true, thumb: thumb(160), artHash: art(1) };
  assert.equal(feed(ac, [...Array(8).fill(card), ...Array(8).fill(empty), ...Array(8).fill(card)]).length, 2);
  const swap = new AutoCapture();
  assert.equal(feed(swap, [...Array(8).fill(card), ...Array(8).fill(next)]).length, 2);
});
