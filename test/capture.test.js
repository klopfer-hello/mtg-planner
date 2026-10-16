// ProbeController (recognition-driven capture) and UploadQueue (public/capture.js) on procedural
// scenes. The rig in test/helpers/scenes.js stands in for the detector/tracker; the ProbeSession
// below plays the UI and the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UploadQueue, ProbeController, PROBE_DEFAULTS, PROBE_STATES, probeConfig } from '../public/capture.js';
import { Scene, Rig, makeCard, boxQuad, lerpQuad } from './helpers/scenes.js';

test('capture.js is a pure browser module (no imports, no DOM or node APIs)', () => {
  const src = readFileSync(new URL('../public/capture.js', import.meta.url), 'utf8');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]), []);
  assert.ok(!/require\(|process\.|Buffer|node:|document\.|window\./.test(src));
});

// ---------------------------------------------------------------------------
// Upload queue

const err429 = () => Object.assign(new Error('Too many'), { status: 429 });

test('upload queue: FIFO, one at a time, 429 retried with backoff', async () => {
  const sent = [], slept = [];
  let fail = 2, inFlight = 0, maxInFlight = 0;
  const q = new UploadQueue({
    sleep: async (ms) => { slept.push(ms); },
    send: async (item) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      if (item.n === 1 && fail-- > 0) throw err429();
      sent.push(item.n);
      return { scan: { id: item.n * 10 } };
    },
  });
  const results = [];
  q.onResult = (item, res) => results.push([item.n, res.scan.id]);
  q.push({ n: 1 }); q.push({ n: 2 }); q.push(null); q.push({ n: 3 });
  await q.idle();
  assert.deepEqual(sent, [1, 2, 3]);
  assert.deepEqual(slept, [1000, 2000]);
  assert.deepEqual(results, [[1, 10], [2, 20], [3, 30]]);
  assert.equal(maxInFlight, 1);
  assert.equal(q.length, 0);
});

test('upload queue: gives up after the backoff, keeps the item, retry() resumes; other errors drop the item', async () => {
  let block = true;
  const sent = [], gaveUp = [], errors = [];
  const q = new UploadQueue({
    sleep: async () => {},
    send: async (item) => {
      if (item.n === 1 && block) throw err429();
      if (item.n === 2) throw Object.assign(new Error('bad'), { status: 400 });
      sent.push(item.n);
      return {};
    },
    onGiveUp: (item) => gaveUp.push(item.n),
    onError: (item, e) => errors.push([item.n, e.status]),
  });
  q.push({ n: 1 }); q.push({ n: 2 }); q.push({ n: 3 });
  await q.idle();
  assert.deepEqual(gaveUp, [1]);
  assert.equal(q.length, 3, 'nothing lost while stalled');
  assert.deepEqual(sent, []);
  block = false;
  q.retry();
  await q.idle();
  assert.deepEqual(sent, [1, 3]);
  assert.deepEqual(errors, [[2, 400]]);
});

// ---------------------------------------------------------------------------
// ProbeController (beta.2, recognition-driven capture). The ProbeSession plays
// the UI and the server: a probe of the top card is answered `latency` frames
// later (8 fps; ~1.4 s like the measured answer latency), staged when the
// server "identifies" it and it differs from the session's last card, 'same'
// otherwise; anything without an identifiable card is 'unidentified'.

class ProbeSession {
  constructor(scene, { rig = {}, cfg = {}, latency = 11, identify = (c) => c.id, server = null } = {}) {
    this.scene = scene;
    this.rig = new Rig(scene, rig);
    this.ctl = new ProbeController({ cfg });
    Object.assign(this, { latency, identify, server });
    this.pending = [];
    this.probes = [];
    this.staged = [];
    this.outcomes = [];
    this.lastKey = null;
    this.log = [];
    this.extra = {};
  }

  /** The simulated server's answer for a probe of the scene as it is now. */
  answerFor() {
    if (this.server) return this.server(this);
    const top = this.scene.top();
    const key = top && top.detect !== 'none' ? this.identify(top) : null;
    if (key == null) return { outcome: 'unidentified', result: { status: 'review' } };
    if (key === this.lastKey) return { outcome: 'same', result: { status: 'auto' } };
    this.lastKey = key;
    this.staged.push(key);
    return { outcome: 'staged', scan: { id: this.staged.length }, result: { status: 'auto' } };
  }

  step(extra = {}) {
    const o = this.rig.frame({ ...this.extra, ...extra });
    for (const p of this.pending.filter((x) => x.due <= this.rig.n)) {
      this.pending.splice(this.pending.indexOf(p), 1);
      this.outcomes.push(p.res.outcome);
      this.ctl.answer(p.id, p.res, o.now);
    }
    const r = this.ctl.step(o);
    this.log.push(r);
    if (r.probe) {
      this.probes.push({ ...r.probe, n: this.rig.n, top: this.scene.top()?.id ?? null });
      this.pending.push({ id: r.probe.id, due: this.rig.n + this.latency, res: this.answerFor() });
    }
    return r;
  }

  run(n, extra) { const out = []; for (let i = 0; i < n; i++) out.push(this.step(extra)); return out; }

  slideIn(id, card, quad, { frames = 6, detect = 'ok', look = null } = {}) {
    const start = quad.map(([x, y]) => [x, y + this.scene.h * 0.75]);
    const c = this.scene.add(id, card, start, { detect, look });
    for (let i = 1; i <= frames; i++) { this.scene.move(c, lerpQuad(start, quad, i / frames)); this.step(); }
    return c;
  }

  slideOut(frames = 5) {
    const c = this.scene.top(), q0 = c.quad, q1 = q0.map(([x, y]) => [x, y + this.scene.h * 0.8]);
    for (let i = 1; i <= frames; i++) { this.scene.move(c, lerpQuad(q0, q1, i / frames)); this.step(); }
    this.scene.cards.pop();
    this.step();
  }

  handPass(frames = 4) {
    const s = this.scene;
    for (let i = 0; i < frames; i++) {
      s.hand = { cx: s.w * (0.1 + 0.8 * (i / Math.max(1, frames - 1))), cy: s.h * 0.5, rx: s.w * 0.3, ry: s.h * 0.22, color: [196, 150, 120] };
      this.step();
    }
    s.hand = null;
  }

  /** Hand-held: the card shakes by up to `amp` px every frame (detector corners follow it). */
  shake(n, amp = 6, base = null) {
    const c = this.scene.top(), q = base || c.quad;
    for (let i = 0; i < n; i++) {
      const dx = amp * Math.sin(i * 2.1), dy = amp * Math.cos(i * 1.3);
      this.scene.move(c, q.map(([x, y]) => [x + dx, y + dy]));
      this.step({ sharp: 120 }); // a real hand-held strip stays sharp (the rig would report motion blur)
    }
  }
}

test('probe: defaults are frozen and overrides are validated', () => {
  assert.ok(Object.isFrozen(PROBE_DEFAULTS));
  assert.equal(PROBE_DEFAULTS.stillMad, 14); // beta.5 sweep (was 8)
  assert.equal(PROBE_DEFAULTS.holdMad, 10);
  assert.equal(PROBE_DEFAULTS.intervalMs, 1000);
  // holdMad compares with the held card (not a 400 ms older frame), so it may be below stillMad:
  // the beta.5 sweep kept 10 (16+ missed cards sliding over each other in the box)
  const { cfg, ignored } = probeConfig({ stillMad: 10, nope: 1, holdMs: 'x' });
  assert.equal(cfg.stillMad, 10);
  assert.equal(cfg.holdMs, PROBE_DEFAULTS.holdMs);
  assert.deepEqual(ignored.sort(), ['holdMs', 'nope']);
  assert.deepEqual(new ProbeController({ cfg: { bogus: 1 } }).ignored, ['bogus']);
});

test('probe: an empty box sends no probes, also not when a hand passes or the light changes', () => {
  const s = new ProbeSession(new Scene('box', 5));
  s.run(40);
  s.handPass(6);
  s.scene.light = 1.4; s.run(10);
  s.scene.light = 0.7; s.run(30);
  assert.equal(s.probes.length, 0);
  assert.ok(s.log.every((r) => r.state === PROBE_STATES.SEARCHING));
});

test('probe: N cards in a row (each taken away) → each staged once, probes held while the card stays', () => {
  const s = new ProbeSession(new Scene('box', 3));
  s.run(16);
  const ids = ['a', 'b', 'c', 'd'];
  ids.forEach((id, i) => {
    s.slideIn(id, makeCard(60 + i), boxQuad(s.scene));
    s.run(56); // 7 s still
    s.slideOut();
    s.run(8);
  });
  assert.deepEqual(s.staged, ids);
  assert.ok(!s.outcomes.includes('same'), 'held: no re-probe within holdMs');
  assert.equal(s.probes.length, ids.length, JSON.stringify(s.probes.map((p) => [p.n, p.top])));
  assert.ok(s.probes.every((p) => p.rec.kind === 'probe' && p.rec.quad_source === 'track'));
});

test('probe: cards slid onto the stack (the old one never leaves) → each staged once', () => {
  const s = new ProbeSession(new Scene('box', 4));
  s.run(10);
  const ids = ['a', 'b', 'c'];
  ids.forEach((id, i) => { s.slideIn(id, makeCard(70 + i), boxQuad(s.scene, i * 3, -i * 2)); s.run(40); });
  assert.deepEqual(s.staged, ids);
});

test('probe: a card left lying → one more probe after holdMs, answered "same", then held again', () => {
  const s = new ProbeSession(new Scene('table', 6));
  s.slideIn('a', makeCard(80), boxQuad(s.scene));
  s.run(8 * 20); // 20 s
  assert.deepEqual(s.staged, ['a']);
  const same = s.outcomes.filter((x) => x === 'same').length;
  assert.ok(same >= 1 && same <= 2, `same answers: ${same}`);
  assert.ok(s.probes.length <= 3, `probes: ${s.probes.length}`);
  assert.ok(s.log.some((r) => r.state === PROBE_STATES.HOLD && /Same card/.test(r.hint)));
});

test('probe: "same" with no staged row to +1 (after a commit) points to the shutter', () => {
  const s = new ProbeSession(new Scene('table', 6));
  s.slideIn('a', makeCard(80), boxQuad(s.scene));
  s.run(8 * 20, { plusOne: false });
  const held = s.log.filter((r) => r.state === PROBE_STATES.HOLD && /Same card/.test(r.hint));
  assert.ok(held.length > 0);
  assert.ok(held.every((r) => /tap the shutter/.test(r.hint) && !/\+1/.test(r.hint)));
});

test('probe: no probes while the card moves; hand-held shake still probes (card-relative stillness)', () => {
  const s = new ProbeSession(new Scene('table', 7));
  const c = s.scene.add('a', makeCard(81), boxQuad(s.scene));
  // slid around by hand: the tracked quad lags a frame behind the card (corners = the last frame's
  // position), so with an uneven motion the card region keeps changing → never still. Amplitude
  // 60/45 px since stillMad 14 (beta.5): the old 40/30 px slide had two frames at cmad 13.5-13.8
  // (min 15.0 now); the real recordings, not this rig, set the threshold (0 false stages at 14)
  const base = boxQuad(s.scene);
  let prev = base;
  for (let i = 0; i < 32; i++) {
    const q = base.map(([x, y]) => [x + 60 * Math.sin(i * 0.9) * Math.sin(i * 0.37), y + 45 * Math.cos(i * 1.7)]);
    s.scene.move(c, q);
    const r = s.step({ sharp: 120, corners: prev });
    if (r.cmad !== null) assert.equal(r.still, false, `frame ${i}: cmad ${r.cmad}`);
    prev = q;
  }
  // a steady slide: the rig reports a motion-blurred strip (sharpness below the floor)
  const q0 = boxQuad(s.scene, -120, 0), q1 = boxQuad(s.scene, 120, 0);
  for (let i = 0; i <= 24; i++) { s.scene.move(c, lerpQuad(q0, q1, i / 24)); s.step(); }
  assert.equal(s.probes.length, 0, `moving card: no probe (${JSON.stringify(s.probes.map((x) => [x.n, x.rec.mad, x.rec.sharp]))})`);
  // hand-held over the table: the frame shakes, the card region does not change
  s.shake(40, 6, boxQuad(s.scene));
  assert.deepEqual(s.staged, ['a']);
  assert.ok(s.log.some((r) => r.still && r.cmad !== null && r.cmad <= PROBE_DEFAULTS.stillMad));
});

test('probe: a weak (never accepted) quad is probed too; an undetected card is not', () => {
  const s = new ProbeSession(new Scene('table', 8));
  s.slideIn('w', makeCard(82), boxQuad(s.scene), { detect: 'weak' });
  s.run(24);
  assert.deepEqual(s.staged, ['w']);
  assert.equal(s.probes[0].rec.quad_source, 'weak');
  const t = new ProbeSession(new Scene('table', 9));
  t.slideIn('n', makeCard(83), boxQuad(t.scene), { detect: 'none' });
  t.run(40);
  assert.equal(t.probes.length, 0);
});

test('probe: unidentified → keeps probing, backs off after 3 answers, then "Not recognised – tap to capture"', () => {
  const s = new ProbeSession(new Scene('box', 10), { identify: () => null });
  s.slideIn('x', makeCard(84), boxQuad(s.scene));
  s.run(8 * 16);
  assert.equal(s.staged.length, 0);
  const ns = s.probes.map((p) => p.n);
  const gaps = ns.slice(1).map((n, i) => n - ns[i]);
  assert.ok(ns.length >= 4, `probes ${ns}`);
  // one in flight: never closer than the answer latency; after 3 unidentified answers >= slowMs (24 frames)
  assert.ok(gaps.every((g) => g >= s.latency), `gaps ${gaps}`);
  assert.ok(gaps.slice(2).every((g) => g >= 24), `gaps ${gaps}`);
  const hint = s.log.findIndex((r) => r.state === PROBE_STATES.UNRECOGNISED);
  assert.ok(hint > 0 && /Not recognised/.test(s.log[hint].hint));
  // the shutter (a normal scan) holds the card: no more probes of it
  const before = s.probes.length;
  s.ctl.manual({ ...s.rig.frame(), now: s.rig.t });
  s.run(40);
  assert.equal(s.probes.length, before);
  // a new card is probed (and the unidentified streak is gone)
  s.slideOut(); s.run(4);
  s.identify = (c) => c.id;
  s.slideIn('y', makeCard(85), boxQuad(s.scene));
  s.run(30);
  assert.deepEqual(s.staged, ['y']);
});

test('probe: busy → next interval; warming up → waits longer; a failed probe backs off', () => {
  let answer = { outcome: 'busy', reason: 'slots' };
  const s = new ProbeSession(new Scene('box', 11), { latency: 1, server: () => answer });
  s.slideIn('a', makeCard(86), boxQuad(s.scene));
  s.run(30);
  const gaps = (from) => s.probes.slice(from).map((p, i, a) => (i ? p.n - a[i - 1].n : null)).slice(1);
  assert.ok(s.probes.length >= 3 && gaps(0).every((g) => g === 8), `slots: every interval (${gaps(0)})`);
  const k = s.probes.length;
  answer = { outcome: 'busy', reason: 'warming_up' };
  s.run(40);
  assert.ok(gaps(k).every((g) => g >= 20), `warming: ${gaps(k)}`);
  assert.ok(s.log.some((r) => /Warming up/.test(r.hint)));
  // a crop/network failure: back off errorMs; one probe in flight at a time
  const c = new ProbeController();
  const base = { found: true, corners: [[0, 0], [1, 0], [1, 1], [0, 1]], accepted: true, sharp: 100 };
  const th = new Float32Array(192).fill(100);
  let p = null, t = 0;
  for (; t < 2000 && !p; t += 125) p = c.step({ ...base, cardThumb: th, now: t }).probe;
  assert.ok(p);
  assert.equal(c.step({ ...base, cardThumb: th, now: t }).probe, null, 'one in flight');
  c.failed(p.id, t);
  let next = null;
  for (t += 125; t < 10000 && next === null; t += 125) if (c.step({ ...base, cardThumb: th, now: t }).probe) next = t;
  assert.ok(next >= p.rec.t + PROBE_DEFAULTS.errorMs, `next probe at ${next}`);
  assert.equal(c.answer(999, { outcome: 'staged' }), null, 'unknown id ignored');
});

test('probe: a failed probe with a reflection shows the glare hint until a probe comes back clean', () => {
  const c = new ProbeController();
  const base = { found: true, corners: [[0, 0], [1, 0], [1, 1], [0, 1]], accepted: true, sharp: 100 };
  const th = new Float32Array(192).fill(100);
  const art = { code: 'glare-art', advice: 'Reflection on the picture: tilt slightly' };
  let t = 0;
  const next = () => { for (; t < 60000; t += 125) { const r = c.step({ ...base, cardThumb: th, now: t }); if (r.probe) return r.probe; } return null; };
  const hintAt = (dt = 125) => { t += dt; return c.step({ ...base, cardThumb: th, now: t }); };
  // an auto stage with glare: no hint (the reflection didn't hurt)
  let p = next();
  c.answer(p.id, { outcome: 'staged', result: { status: 'auto' } }, t, { glare: art });
  assert.equal(c.glare, null);
  c.rearm();
  // unidentified with glare → hint while waiting for the next probe
  p = next();
  c.answer(p.id, { outcome: 'unidentified' }, t, { glare: art });
  let r = hintAt();
  assert.equal(r.state, PROBE_STATES.WAITING);
  assert.equal(r.hint, art.advice);
  // unmeasured glare keeps it; after hintAfterMs the shutter hint carries it
  p = next();
  c.answer(p.id, { outcome: 'unidentified' }, t, { glare: null });
  assert.ok(c.glare);
  const unrec = [];
  for (let i = 0; i < 40; i++) {
    r = hintAt();
    if (r.probe) c.answer(r.probe.id, { outcome: 'unidentified' }, t, { glare: null });
    else if (r.state === PROBE_STATES.UNRECOGNISED) unrec.push(r.hint);
  }
  assert.ok(unrec.length > 0);
  assert.ok(unrec.every((h) => h === `${art.advice} – or tap to capture`), JSON.stringify(unrec));
  // a clean unidentified probe clears it
  p = next();
  c.answer(p.id, { outcome: 'unidentified' }, t, { glare: { code: 'ok', advice: null } });
  assert.equal(c.glare, null);
  // a staged card is done: a suggest stage with glare sets no hint (it would land on the next card)
  c.unk = null;
  p = next();
  c.answer(p.id, { outcome: 'staged', result: { status: 'suggest' } }, t, { glare: art });
  assert.equal(c.glare, null);
  c.rearm();
  // set again by an unidentified answer; not forever: glareHintMs without a new answer
  p = next();
  c.answer(p.id, { outcome: 'unidentified' }, t, { glare: art });
  assert.equal(c.glare?.advice, art.advice);
  t += PROBE_DEFAULTS.glareHintMs + 1;
  c.flight = null;
  c.step({ ...base, cardThumb: th, now: t });
  assert.equal(c.glare, null);
  // too-blurry is no reflection
  p = next();
  c.answer(p.id, { outcome: 'unidentified' }, t, { glare: { code: 'too-blurry', advice: 'x' } });
  assert.equal(c.glare, null);
});

test('probe: the reflection hint belongs to its card: it ends when the card leaves or changes', () => {
  const art = { code: 'glare-art', advice: 'Reflection on the picture: tilt slightly' };
  const base = { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], accepted: true, sharp: 100 };
  const A = new Float32Array(192).fill(100);
  for (const how of ['leaves', 'changes']) {
    const c = new ProbeController();
    let t = 0, p = null;
    for (; t < 5000 && !p; t += 125) p = c.step({ ...base, found: true, cardThumb: A, now: t }).probe;
    c.answer(p.id, { outcome: 'unidentified' }, t, { glare: art });
    t += 125;
    assert.equal(c.step({ ...base, found: true, cardThumb: A, now: t }).hint, art.advice);
    // drift of the same card within glareMad keeps it
    t += 125;
    assert.equal(c.step({ ...base, found: true, cardThumb: new Float32Array(192).fill(118), now: t }).hint, art.advice);
    if (how === 'leaves') for (let i = 0; i < PROBE_DEFAULTS.lostFrames; i++) { t += 125; c.step({ ...base, found: false, cardThumb: null, now: t }); }
    const hints = [];
    for (let i = 0; i < 8; i++) { t += 125; hints.push(c.step({ ...base, found: true, cardThumb: new Float32Array(192).fill(160 + (i % 2) * 30), now: t }).hint); }
    assert.equal(c.glare, null, how);
    assert.ok(!hints.includes(art.advice), `${how}: ${JSON.stringify(hints)}`);
  }
});

test('probe: paused (sheet open / auto off) or busy (shutter scan running) → no probes', () => {
  const s = new ProbeSession(new Scene('box', 12));
  s.extra = { paused: true };
  s.slideIn('a', makeCard(87), boxQuad(s.scene));
  s.run(30);
  s.extra = { busy: true };
  s.run(30);
  assert.equal(s.probes.length, 0);
  assert.ok(s.log.some((r) => r.state === PROBE_STATES.PAUSED));
  s.extra = {};
  s.run(20);
  assert.deepEqual(s.staged, ['a']);
});

test('probe: rearm() releases the hold; reset() drops the probe in flight', () => {
  const s = new ProbeSession(new Scene('box', 13));
  s.slideIn('a', makeCard(88), boxQuad(s.scene));
  s.run(24);
  assert.equal(s.probes.length, 1);
  s.ctl.rearm();
  s.run(20);
  assert.equal(s.probes.length, 2);
  assert.equal(s.outcomes.at(-1), 'same');
  s.ctl.rearm();
  s.run(8);
  const inFlight = s.probes.at(-1);
  assert.equal(s.probes.length, 3);
  s.ctl.reset();
  assert.equal(s.ctl.answer(inFlight.id, { outcome: 'staged' }), null);
});

test('probe: rearm({rescan}) tracks the card in view; a probe of the next card is not the rescan', () => {
  // card a stays unidentified (a review row waits), the user taps Rescan, gives up and slides in b
  const s = new ProbeSession(new Scene('box', 14), { identify: (c) => (c.id === 'a' ? null : c.id) });
  s.slideIn('a', makeCard(89), boxQuad(s.scene));
  s.run(24);
  s.ctl.rearm({ rescan: true });
  const id = s.ctl.rescan?.id;
  assert.ok(id, 'rescan track started');
  s.run(24);
  const during = s.probes.filter((p) => p.top === 'a' && p.rescan === id);
  assert.ok(during.length >= 1, 'probes of the rescanned card carry the rescan id');
  assert.equal(s.ctl.rescan?.id, id, 'unidentified answers keep the track');
  s.slideOut();
  s.run(4);
  assert.equal(s.ctl.rescan, null, 'card left → rescan track ended');
  s.slideIn('b', makeCard(90), boxQuad(s.scene));
  s.run(30);
  assert.deepEqual(s.staged, ['b']);
  assert.ok(s.probes.filter((p) => p.top === 'b').every((p) => p.rescan === null), 'the next card never carries it');

  // a card swapped on top (the quad never lost): the region change ends the track too
  const t = new ProbeSession(new Scene('box', 15), { identify: () => null });
  t.slideIn('a', makeCard(91), boxQuad(t.scene));
  t.run(20);
  t.ctl.rearm({ rescan: true });
  t.run(4);
  assert.ok(t.ctl.rescan);
  t.slideIn('b', makeCard(92), boxQuad(t.scene, 3, -2));
  t.run(4);
  assert.equal(t.ctl.rescan, null, 'another card on top → ended');

  // the rescanned card staged (or 'same') ends it; a plain rearm() / endRescan() / reset() starts none
  const u = new ProbeSession(new Scene('box', 16));
  u.slideIn('c', makeCard(93), boxQuad(u.scene));
  u.ctl.rearm({ rescan: true });
  const rid = u.ctl.rescan.id;
  u.run(30);
  assert.deepEqual(u.staged, ['c']);
  assert.equal(u.probes[0].rescan, rid);
  assert.equal(u.ctl.rescan, null, 'answered → ended');
  u.ctl.rearm({ rescan: true });
  assert.ok(u.ctl.rescan.id > rid && u.ctl.rescan.thumb, 'a new id, the card in view as its thumb');
  u.ctl.endRescan();
  assert.equal(u.ctl.rescan, null);
  u.ctl.rearm({ rescan: true });
  u.ctl.rearm();
  assert.equal(u.ctl.rescan, null);
  u.ctl.rearm({ rescan: true });
  u.ctl.reset();
  assert.equal(u.ctl.rescan, null);
});

test('probe: never on a stale quad (fresh false: the tracker kept the old corners on a jump frame)', () => {
  const c = new ProbeController();
  const base = { found: true, corners: [[0, 0], [1, 0], [1, 1], [0, 1]], accepted: true, sharp: 100 };
  const th = new Float32Array(192).fill(100);
  let t = 0, r = null;
  for (; t < 3000; t += 125) {
    r = c.step({ ...base, accepted: false, fresh: false, cardThumb: th, now: t });
    assert.equal(r.probe, null, `stale quad probed at ${t}`);
  }
  assert.equal(r.state, PROBE_STATES.TRACKING);
  assert.equal(r.hint, 'Hold steady');
  assert.equal(r.still, true, 'the card region is still; only the quad is stale');
  // the next fresh frame probes (and an analysis without `fresh` keeps the old behaviour)
  assert.ok(c.step({ ...base, fresh: true, cardThumb: th, now: t }).probe);
  const d = new ProbeController();
  let p = null;
  for (t = 0; t < 2000 && !p; t += 125) p = d.step({ ...base, cardThumb: th, now: t }).probe;
  assert.ok(p);
});
