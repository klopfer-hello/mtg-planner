// Card detector (public/det): detection on procedural box and cloth scenes,
// the empty box, 180-degree reading order, the tracker, and the learned,
// persisted scan-box prior. Scenes are drawn in memory (test/helpers/
// detscenes.js), no image files. The parity check against the research copy
// of the detector runs only where that copy exists (DET_RESEARCH_DIR, default
// ../mtg-research/proto/detA2 next to the repo); CI skips it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { detect, refine } from "../public/det/detect.mjs";
import { BoxPrior, PRIOR_STORAGE_KEY, QuadTracker, UNLEARN_AFTER, align, cardAngle, frameThumb, thumbDiff } from "../public/det/track.mjs";
import { addNoise, background, drawCard, emptyBox, makeCard, placeCard, sceneSet } from "./helpers/detscenes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DET_DIR = path.join(ROOT, "public", "det");
const RESEARCH_DIR = path.resolve(process.env.DET_RESEARCH_DIR || path.join(ROOT, "..", "mtg-research", "proto", "detA2"));

const W = 480, H = 853;
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cardW = (q) => Math.min(d2(q[0], q[1]) + d2(q[2], q[3]), d2(q[1], q[2]) + d2(q[3], q[0])) / 2;
/** Max corner distance / card width, corner order ignored. */
const errAny = (q, truth) => align(q, truth).d / cardW(truth);
/** Max corner distance / card width, in reading order (TL must be the card's TL). */
const errExact = (q, truth) => Math.max(...[0, 1, 2, 3].map((i) => d2(q[i], truth[i]))) / cardW(truth);

const scenes = sceneSet(8, W, H);
/** Options that turn off the port's deliberate changes (research behaviour). */
const LEGACY = Object.freeze({ outerEdge: false, priorInnerSlack: 1 });

describe("module hygiene", () => {
  test("the browser modules import only each other (no node: modules, no Node-only globals)", () => {
    const files = readdirSync(DET_DIR).filter((f) => f.endsWith(".mjs"));
    assert.deepEqual(files.sort(), ["detect.mjs", "orientfeat.mjs", "orientw.mjs", "template.mjs", "track.mjs"]);
    for (const f of files) {
      const src = readFileSync(path.join(DET_DIR, f), "utf8");
      for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) assert.match(m[1], /^\.\/[a-z]+\.mjs$/, `${f} imports ${m[1]}`);
      assert.doesNotMatch(src, /\brequire\(|\bprocess\.|\bBuffer\b|['"]node:|\bimport\(/, f);
    }
  });
});

describe("detect", () => {
  test("finds the card within 10% (corners) on at least 75% of box and cloth scenes", () => {
    for (const kind of ["box", "cloth"]) {
      const set = scenes.filter((s) => s.kind === kind);
      const hits = set.filter((s) => { const r = detect(s.img); return r.found && errAny(r.corners, s.corners) <= 0.1; }).length;
      assert.ok(hits >= Math.ceil(0.75 * set.length), `${kind}: ${hits}/${set.length}`);
    }
  });

  test("free mode finds the outer edge of a black-bordered card on a black box, not its inner frame", () => {
    // the research detector settles on the inner frame (~8.5% corner error) on these scenes; the port
    // anchors the outline one border width outside it when the surround is dark
    const set = scenes.filter((s) => s.kind === "box");
    const hits = set.filter((s) => { const r = detect(s.img); return r.found && errAny(r.corners, s.corners) <= 0.03; }).length;
    assert.ok(hits >= set.length - 1, `${hits}/${set.length}`);
    for (const s of set) {
      const r = detect(s.img);
      assert.ok(errAny(refine(s.img, r.corners).corners, s.corners) <= 0.03, `refine keeps the outer edge, seed ${s.seed}`);
    }
  });

  test("the outer-edge anchor never fires on a bright surround (cloth scenes are unchanged)", () => {
    for (const s of scenes.filter((x) => x.kind === "cloth")) {
      const r = detect(s.img), r0 = detect(s.img, LEGACY);
      assert.deepEqual({ ...r, ms: 0 }, { ...r0, ms: 0 }, `seed ${s.seed}`);
      assert.deepEqual(refine(s.img, r.corners).corners, refine(s.img, r.corners, LEGACY).corners, `refine, seed ${s.seed}`);
    }
  });

  test("box mode places a black-bordered card on a black box from its inner frame", () => {
    const set = scenes.filter((s) => s.kind === "box");
    const hits = set.filter((s) => {
      const r = detect(s.img, { mode: "box" });
      return r.found && r.mode === "box" && errAny(r.corners, s.corners) <= 0.05;
    }).length;
    assert.ok(hits >= Math.ceil(0.75 * set.length), `${hits}/${set.length}`);
  });

  test("no lock on an empty box, in free and in box mode", () => {
    for (let seed = 70; seed < 74; seed++) {
      const img = emptyBox(seed, W, H);
      assert.equal(detect(img).found, false, `free, seed ${seed}`);
      assert.equal(detect(img, { mode: "box" }).found, false, `box, seed ${seed}`);
    }
  });

  test("upright cards are not read rotated by 180 degrees", () => {
    // free mode: the classifier decides; a flip is only acceptable as a low-confidence call (the research
    // classifier is ~99% accurate, the server's 180-degree retry covers the rest), and at most one in the set
    let lowFlips = 0;
    for (const s of scenes) {
      const r = detect(s.img);
      if (!r.found || errAny(r.corners, s.corners) > 0.1) continue;
      if (errExact(r.corners, s.corners) <= 0.1) continue;
      assert.ok(r.orientConf < 0.5, `${s.kind} ${s.seed}: flipped with confidence ${r.orientConf.toFixed(2)}`);
      lowFlips++;
    }
    assert.ok(lowFlips <= 1, `${lowFlips} low-confidence flips`);
    // box mode: an unsure classifier defers to the box's up direction, so no flips at all
    for (const s of scenes.filter((x) => x.kind === "box")) {
      const r = detect(s.img, { mode: "box" });
      if (r.found) assert.ok(errExact(r.corners, s.corners) <= 0.1, `box mode ${s.seed}: corner order flipped`);
    }
  });

  test("a card lying upside down is reported in its own reading order", () => {
    let checked = 0;
    for (let i = 0; i < 4; i++) {
      const img = background("cloth", W, H, 300 + i);
      const truth = placeCard(W * 0.5, H * 0.5, W * 0.5, 180 + (i - 1.5) * 12);
      drawCard(img, makeCard(300 + i), truth);
      const r = detect(addNoise(img, 300 + i));
      if (!r.found || errAny(r.corners, truth) > 0.1) continue;
      checked++;
      assert.ok(errExact(r.corners, truth) <= 0.1, `scene ${i}: read upright`);
    }
    assert.ok(checked >= 3, `only ${checked} detected`);
  });

  test("refine keeps a free-mode detection in place and is a no-op in box mode", () => {
    const s = scenes.find((x) => x.kind === "cloth");
    const r = detect(s.img);
    const f = refine(s.img, r.corners);
    assert.ok(errAny(f.corners, s.corners) <= 0.1);
    const b = scenes.find((x) => x.kind === "box"), rb = detect(b.img, { mode: "box" });
    assert.deepEqual(refine(b.img, rb.corners, { mode: "box" }).corners, rb.corners);
  });
});

describe("QuadTracker", () => {
  const truth = placeCard(240, 420, 280, 2);
  const jittered = (r, amp) => truth.map(([x, y]) => [x + (r() - 0.5) * 2 * amp, y + (r() - 0.5) * 2 * amp]);
  const prng = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

  test("smooths corner jitter and settles", () => {
    const t = new QuadTracker(), r = prng(5);
    const meanErr = (q) => q.reduce((s, p, i) => s + d2(p, truth[i]), 0) / 4;
    let rawErr = 0, smErr = 0, st;
    for (let i = 0; i < 24; i++) {
      const q = jittered(r, 2);
      st = t.update({ found: true, corners: q });
      if (i >= 8) { rawErr += meanErr(q); smErr += meanErr(st.corners); }
    }
    assert.ok(smErr < 0.7 * rawErr, `smoothed ${smErr.toFixed(3)} vs raw ${rawErr.toFixed(3)}`);
    assert.equal(st.stable, true);
    assert.equal(st.accepted, true);
  });

  test("a single-frame jump to another outline does not move the track", () => {
    const t = new QuadTracker(), r = prng(9);
    for (let i = 0; i < 10; i++) t.update({ found: true, corners: jittered(r, 1) });
    const before = t.update({ found: true, corners: jittered(r, 1) }).corners;
    const st = t.update({ found: true, corners: placeCard(120, 200, 150, 30) });
    assert.ok(errExact(st.corners, before) < 0.01);
    assert.equal(st.rejected, true);
  });

  test("keeps the reading order when the detections' corner order rotates", () => {
    const t = new QuadTracker(), r = prng(11);
    let st;
    for (let i = 0; i < 6; i++) st = t.update({ found: true, corners: jittered(r, 1) });
    const rot = (q) => [q[1], q[2], q[3], q[0]];
    st = t.update({ found: true, corners: rot(jittered(r, 1)) });
    assert.ok(errExact(st.corners, truth) < 0.02);
  });

  test("frameThumb/thumbDiff see motion but not noise", () => {
    const a = scenes[8].img, b = addNoise({ w: a.w, h: a.h, d: Uint8ClampedArray.from(a.d) }, 3, 4);
    assert.ok(thumbDiff(frameThumb(a), frameThumb(b)) < 2);
    assert.ok(thumbDiff(frameThumb(a), frameThumb(scenes[9].img)) > 6);
  });
});

describe("BoxPrior", () => {
  const boxQ = (i) => placeCard(240 + (i % 3) * 4 - 4, 426 + (i % 2) * 6 - 3, 300 + i * 0.5, (i % 2) - 0.5);
  const tableQ = (i) => placeCard(130 + i * 40, 250 + i * 70, 200, 25 + i * 9);
  const learned = () => { const p = new BoxPrior({ now: () => Date.UTC(2026, 0, 2) }); for (let i = 0; i < 3; i++) p.add(boxQ(i), W, H, true); return p; };

  test("learns the box after 3 consistent captures, not before", () => {
    const p = new BoxPrior();
    p.add(boxQ(0), W, H, true);
    p.add(boxQ(1), W, H, true);
    assert.equal(p.active, false);
    assert.deepEqual(p.opts(W, H), {});
    p.add(boxQ(2), W, H, true);
    assert.equal(p.active, true);
    const o = p.opts(W, H);
    assert.equal(o.mode, "box");
    assert.ok(d2(o.prior.center, [240, 426]) < 8);
    assert.ok(o.prior.angle === 0, "near-axis angle snaps to the axis");
    assert.ok(o.prior.quad);
  });

  test("off-centre or rotated captures do not enable box mode", () => {
    const p = new BoxPrior();
    for (let i = 0; i < 3; i++) p.add(tableQ(i), W, H);
    assert.equal(p.active, false);
  });

  test("learns from detections of box scenes and then finds the next card in box mode", () => {
    // a free-mode capture read upside down (low confidence) breaks the angle consistency, so learning may
    // take one or two more cards than the 3 it needs
    const p = new BoxPrior(), box = scenes.filter((s) => s.kind === "box");
    let used = 0;
    while (!p.active && used < 5) {
      const s = box[used++], r = detect(s.img, p.opts(W, H));
      assert.ok(r.found);
      p.add(r.corners, W, H, r.mode === "box");
    }
    assert.equal(p.active, true, `not learned after ${used} captures`);
    for (const s of box.slice(used)) {
      const r = detect(s.img, p.opts(W, H));
      assert.equal(r.mode, "box");
      assert.ok(r.found && errAny(r.corners, s.corners) <= 0.05, `seed ${s.seed}`);
    }
  });

  test("toJSON/restore round-trips the learned box (through JSON, as in localStorage)", () => {
    const p = learned();
    const saved = JSON.parse(JSON.stringify(p.toJSON()));
    assert.equal(PRIOR_STORAGE_KEY, "mtg.scan.prior");
    assert.equal(saved.learned_at, "2026-01-02T00:00:00.000Z");
    assert.ok(saved.confidence >= 3);
    assert.ok(saved.size > 0.5 && saved.size < 0.8);
    assert.equal(saved.quad.length, 4);

    const q = new BoxPrior();
    assert.equal(q.restore(saved), true);
    assert.equal(q.active, true);
    assert.equal(q.source, "learned");
    const a = p.opts(W, H).prior, b = q.opts(W, H).prior;
    assert.ok(d2(a.center, b.center) < 1e-6);
    assert.equal(a.angle, b.angle);
    assert.ok(Math.abs(a.scaleRange[0] - b.scaleRange[0]) < 1e-9 && Math.abs(a.scaleRange[1] - b.scaleRange[1]) < 1e-9);
    assert.ok(errExact(a.quad, b.quad) < 1e-6);
    assert.deepEqual(JSON.parse(JSON.stringify(q.toJSON())), saved);
  });

  test("a restored box scales to the frame size and is ignored for a rotated frame", () => {
    const q = new BoxPrior();
    q.restore(learned().toJSON());
    const o = q.opts(W * 2, H * 2).prior;
    assert.ok(d2(o.center, [480, 852]) < 16);
    assert.deepEqual(q.opts(H, W), {});
    assert.equal(q.learnedQuad(H, W), null);
    assert.equal(q.learnedQuad(W, H).length, 4);
  });

  test("restore ignores invalid or foreign data", () => {
    const q = new BoxPrior();
    for (const bad of [null, "x", {}, { v: 2 }, { ...learned().toJSON(), center: [2, 0.5] }, { ...learned().toJSON(), size: -1 },
      { ...learned().toJSON(), quad: [[0, 0]] }, { ...learned().toJSON(), aspect: "wide" }]) assert.equal(q.restore(bad), false);
    assert.equal(q.toJSON(), null);
    assert.equal(q.active, false);
  });

  test("a restored box serves the session until it has 3 captures of its own", () => {
    const q = new BoxPrior();
    q.restore(learned().toJSON());
    q.add(boxQ(3), W, H, true);
    assert.equal(q.source, "learned");
    assert.equal(q.confirmed, true);
    q.add(boxQ(4), W, H, true);
    q.add(boxQ(5), W, H, true);
    assert.equal(q.source, "caps");
    assert.equal(q.active, true);
  });

  test(`unlearns after ${UNLEARN_AFTER} accepted captures in a row outside the box`, () => {
    const q = new BoxPrior();
    q.restore(learned().toJSON());
    const rev = q.revision;
    q.add(tableQ(0), W, H);
    q.add(tableQ(1), W, H);
    q.add(boxQ(1), W, H, true); // back in the box: the count restarts
    assert.ok(q.toJSON());
    for (let i = 2; i < 2 + UNLEARN_AFTER - 1; i++) q.add(tableQ(i), W, H);
    assert.ok(q.toJSON(), "not yet");
    q.add(tableQ(9), W, H);
    assert.equal(q.toJSON(), null);
    assert.ok(q.revision > rev, "revision bump tells the caller to persist");
    assert.equal(q.active, false);
  });

  test("an unconfirmed restored box goes dormant (free mode) when nothing shows up in it", () => {
    const q = new BoxPrior({ probeAfter: 5 });
    q.restore(learned().toJSON());
    for (let i = 0; i < 4; i++) q.noteFrame({ found: false });
    assert.equal(q.active, true);
    q.noteFrame({ found: false });
    assert.equal(q.active, false);
    assert.deepEqual(q.opts(W, H), {});
    q.add(boxQ(2), W, H, true); // a card shows up where the box was: confirmed again
    assert.equal(q.active, true);
    for (let i = 0; i < 10; i++) q.noteFrame(null);
    assert.equal(q.active, true, "a confirmed box never goes dormant");
  });

  test("in-session auto behaviour is the research one: a stray capture switches to free mode", () => {
    const p = learned();
    p.add(tableQ(0), W, H);
    assert.equal(p.active, false);
    assert.ok(p.toJSON(), "the saved box is kept until it is unlearned");
    assert.ok(Math.abs(cardAngle(boxQ(0))) < 1);
  });
});

describe("parity with the research detector", { skip: !existsSync(path.join(RESEARCH_DIR, "detect.mjs")) && "research copy not present" }, () => {
  const pick = (r) => ({ found: r.found, weak: r.weak, mode: r.mode, score: r.score, corners: r.corners, orientConf: r.orientConf });
  const PARITY_OPTS = [{}, { mode: "box" }, { mode: "box", prior: { center: [240, 426], angle: 0, scaleRange: [0.5, 0.75], weight: 1 } }];

  test("same results on the procedural scenes with LEGACY options (free mode, box mode, empty box)", async () => {
    const ref = await import(pathToFileURL(path.join(RESEARCH_DIR, "detect.mjs")).href);
    for (const [i, img] of [...scenes.map((s) => s.img), emptyBox(70, W, H)].entries()) {
      for (const o of PARITY_OPTS) assert.deepEqual(pick(detect(img, { ...o, ...LEGACY })), pick(ref.detect(img, o)), `scene ${i} ${JSON.stringify(o)}`);
    }
    const s = scenes.find((x) => x.kind === "cloth"), r = detect(s.img, LEGACY);
    assert.deepEqual(refine(s.img, r.corners, LEGACY).corners, ref.refine(s.img, r.corners).corners);
  });

  test("with the defaults only the recorded outer-edge cases differ, each closer to the truth", async () => {
    // recorded 2026-10-14: free mode on 7 of the 8 box scenes (inner frame -> outer edge); box mode, cloth
    // scenes and the empty box are unchanged
    const EXPECTED = ["box 1 free", "box 2 free", "box 4 free", "box 5 free", "box 6 free", "box 7 free", "box 8 free"];
    const ref = await import(pathToFileURL(path.join(RESEARCH_DIR, "detect.mjs")).href);
    const differ = [];
    for (const s of [...scenes, { kind: "empty", seed: 70, img: emptyBox(70, W, H) }]) {
      for (const o of PARITY_OPTS) {
        const a = detect(s.img, o), b = ref.detect(s.img, o);
        if (isDeepStrictEqual(pick(a), pick(b))) continue;
        differ.push(`${s.kind} ${s.seed} ${o.mode || "free"}${o.prior ? "+prior" : ""}`);
        assert.ok(a.found && errAny(a.corners, s.corners) < errAny(b.corners, s.corners), `${s.kind} ${s.seed}: not closer to the truth`);
      }
    }
    assert.deepEqual(differ, EXPECTED);
  });

  test("the research tracker and prior give the same tracks (LEGACY options)", async () => {
    const ref = await import(pathToFileURL(path.join(RESEARCH_DIR, "track.mjs")).href);
    const refDet = await import(pathToFileURL(path.join(RESEARCH_DIR, "detect.mjs")).href);
    const box = scenes.filter((s) => s.kind === "box");
    const mine = { t: new QuadTracker(), p: new BoxPrior(), det: (img, o) => detect(img, { ...o, ...LEGACY }) }, theirs = { t: new ref.QuadTracker(), p: new ref.BoxPrior(), det: refDet.detect };
    for (const side of [mine, theirs]) side.out = [];
    // every card lies still for 6 frames; one capture per stable run feeds the prior
    for (const s of [...box, ...box]) {
      for (const side of [mine, theirs]) side.added = false;
      for (let f = 0; f < 6; f++) {
        for (const side of [mine, theirs]) {
          const o = side.p.opts(W, H), r = side.det(s.img, o), st = side.t.update(r);
          side.out.push({ mode: o.mode || "free", stable: st.stable, corners: st.corners });
          if (st.stable && st.accepted && !side.added) { side.p.add(st.corners, W, H, r.mode === "box"); side.added = true; }
        }
      }
    }
    assert.ok(mine.out.some((x) => x.mode === "box"), "the prior learned the box during the run");
    assert.deepEqual(mine.out, theirs.out);
  });
});
