// CaptureController (public/capture.js) on procedural scenes: every case ends
// in the expected number of uploads. The rig in test/helpers/scenes.js stands
// in for the detector/tracker and renders the hash crops analytically; the
// Session below plays the UI (shoot → captured → upload, flush before capture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CaptureController, CAPTURE_DEFAULTS, STATES, UploadQueue, captureConfig, defaultQuad, minScore } from '../public/capture.js';
import { Scene, Rig, makeCard, boxQuad, lerpQuad, placeCard } from './helpers/scenes.js';

// a second copy of a card: other lighting, a little glare, re-slid slightly off (d lands in the chip band)
const COPY = { gain: 0.94, bias: 3, glare: { gu: 0.7, gv: 0.3, gr: 0.2, ga: 0.2 } };

class Session {
  constructor(scene, { cfg = {}, calibration, rig = {} } = {}) {
    this.scene = scene;
    this.rig = new Rig(scene, rig);
    this.ctl = new CaptureController({ crop: this.rig.crop, cfg, calibration });
    this.uploads = [];
    this.held = 0;
    this.busy = false;
    this.nextScan = 1;
    this.log = [];
    this.extra = {};
  }

  step(extra = {}) {
    const o = this.rig.frame({ busy: this.busy, ...this.extra, ...extra });
    const r = this.ctl.step(o);
    this.log.push(r);
    if (r.flush) this.upload(r.flush);
    if (r.capture) {
      const top = this.scene.top();
      const item = this.ctl.captured(r.capture, { card: top ? top.id : null, frame: this.rig.n });
      if (r.capture.hold) this.held++;
      if (item) this.upload(item);
    }
    return r;
  }

  run(n, extra) { const out = []; for (let i = 0; i < n; i++) out.push(this.step(extra)); return out; }

  /** The simulated server: every upload gets a row id. */
  upload(item) {
    const scanId = this.nextScan++;
    this.uploads.push({ ...item, scanId, card: item.payload.card });
    this.ctl.uploaded(item.id, scanId);
  }

  /** Slide a card in from below the frame onto the stack/table over `frames` frames. */
  slideIn(id, card, quad, { frames = 6, look = null, detect = 'ok', from = null } = {}) {
    const start = from || quad.map(([x, y]) => [x, y + this.scene.h * 0.75]);
    const c = this.scene.add(id, card, start, { look, detect });
    for (let i = 1; i <= frames; i++) { this.scene.move(c, lerpQuad(start, quad, i / frames)); this.step(); }
    return c;
  }

  /** Slide the top card out of view. */
  slideOut(frames = 5) {
    const c = this.scene.top(), q0 = c.quad, q1 = q0.map(([x, y]) => [x, y + this.scene.h * 0.8]);
    for (let i = 1; i <= frames; i++) { this.scene.move(c, lerpQuad(q0, q1, i / frames)); this.step(); }
    this.scene.cards.pop();
    this.step();
  }

  /** A hand passing over the frame (moving every frame). */
  handPass(frames = 4) {
    const s = this.scene;
    for (let i = 0; i < frames; i++) {
      s.hand = { cx: s.w * (0.1 + 0.8 * (i / Math.max(1, frames - 1))), cy: s.h * 0.5, rx: s.w * 0.3, ry: s.h * 0.22, color: [196, 150, 120] };
      this.step();
    }
    s.hand = null;
  }

  get chips() { return this.log.filter((r) => r.capture?.hold).length; }
}

const decisions = (s) => s.log.filter((r) => r.rec).map((r) => r.rec);

/** A box session that starts on an empty box (the empty reference gets learned) and holds still. */
function boxSession(opts) {
  const s = new Session(new Scene('box', 3), opts);
  s.run(32); // 4 s of empty box
  return s;
}

test('defaults are frozen and overrides are validated', () => {
  assert.ok(Object.isFrozen(CAPTURE_DEFAULTS));
  assert.ok(CAPTURE_DEFAULTS.stillThr < CAPTURE_DEFAULTS.watchThr && CAPTURE_DEFAULTS.watchThr < CAPTURE_DEFAULTS.sameThr);
  assert.ok(CAPTURE_DEFAULTS.sameThr < CAPTURE_DEFAULTS.newThr);
  const { cfg, ignored } = captureConfig({ sameThr: 0.08, nope: 1, newThr: 'x', variants: 12, calibration: true, watchThr: NaN });
  assert.equal(cfg.sameThr, 0.08);
  assert.equal(cfg.calibration, true);
  assert.equal(cfg.newThr, CAPTURE_DEFAULTS.newThr);
  assert.deepEqual(ignored.sort(), ['newThr', 'nope', 'variants', 'watchThr']);
  assert.equal(captureConfig({ variants: 9 }).cfg.variants, 9);
  const ctl = new CaptureController({ cfg: { bogus: true } });
  assert.deepEqual(ctl.ignored, ['bogus']);
});

test('capture.js is a pure browser module (only imports ./fphash.js)', () => {
  const src = readFileSync(new URL('../public/capture.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./fphash.js']);
  assert.ok(!/require\(|process\.|Buffer|node:|document\.|window\./.test(src));
});

test('defaultQuad is a centred 63:88 quad inside the frame', () => {
  for (const [w, h] of [[480, 853], [853, 480], [1000, 1000]]) {
    const q = defaultQuad(w, h);
    const qw = q[1][0] - q[0][0], qh = q[3][1] - q[0][1];
    assert.ok(Math.abs(qw / qh - 63 / 88) < 1e-9);
    assert.ok(q.every(([x, y]) => x >= 0 && x <= w && y >= 0 && y <= h));
    assert.ok(Math.abs((q[0][0] + q[2][0]) / 2 - w / 2) < 1e-9 && Math.abs((q[0][1] + q[2][1]) / 2 - h / 2) < 1e-9);
  }
});

test('empty box: no capture, also not after a hand passes', () => {
  const s = new Session(new Scene('box', 5));
  s.run(40);
  s.handPass(4);
  s.run(40);
  assert.equal(s.uploads.length, 0);
  assert.equal(s.held, 0);
  assert.ok(s.log.every((r) => !r.capture));
});

test('N distinct cards slid onto the stack → N uploads, in order', () => {
  const s = boxSession();
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  ids.forEach((id, i) => { s.slideIn(id, makeCard(11 + i), boxQuad(s.scene, (i % 3) * 4 - 4, (i % 2) * 6 - 3)); s.run(16); });
  assert.deepEqual(s.uploads.map((u) => u.card), ids);
  assert.equal(s.held, 0);
  assert.ok(s.uploads.every((u) => u.capture.kind === 'new' && u.allowClaude === true && u.dup_of === null && !u.capture.fallback));
  // every capture was armed by motion and decided on a clearly different card
  assert.ok(s.uploads.slice(1).every((u) => u.capture.d > CAPTURE_DEFAULTS.newThr));
});

test('a card already in view at start is captured once', () => {
  const s = new Session(new Scene('box', 4));
  s.scene.add('a', makeCard(40), boxQuad(s.scene));
  s.run(40);
  assert.deepEqual(s.uploads.map((u) => u.card), ['a']);
});

test('duplicate → chip; ignored chip → held photo uploaded with dup_of before the next card', () => {
  const s = boxSession();
  const card = makeCard(21);
  s.slideIn('a', card, boxQuad(s.scene));
  s.run(16);
  assert.equal(s.uploads.length, 1);
  const aScan = s.uploads[0].scanId;
  // the same card again (a second copy, other light, slightly off)
  s.slideIn('a2', card, boxQuad(s.scene, 8, 6, 1.5), { look: COPY });
  s.run(16);
  assert.equal(s.uploads.length, 1, 'nothing uploaded while the chip shows');
  assert.equal(s.held, 1);
  const chip = s.log[s.log.length - 1].sameChip;
  assert.equal(chip.scanId, aScan);
  assert.ok(chip.d > CAPTURE_DEFAULTS.stillThr && chip.d <= CAPTURE_DEFAULTS.sameThr, `chip d ${chip.d}`);
  // the next card: the held photo goes first, with dup_of, in the same step as the new capture
  s.slideIn('b', makeCard(22), boxQuad(s.scene));
  s.run(16);
  const both = s.log.find((r) => r.flush && r.capture);
  assert.ok(both, 'flush and capture in one step');
  assert.deepEqual(s.uploads.map((u) => u.card), ['a', 'a2', 'b']);
  assert.equal(s.uploads[1].dup_of, aScan);
  assert.equal(s.uploads[1].allowClaude, false);
  assert.equal(s.uploads[1].capture.chip.label, 'ignored');
  assert.equal(s.uploads[2].dup_of, null);
});

test('chip answers: +1 increments the target row, "Scan as new" uploads with force', () => {
  for (const answer of ['plus', 'new']) {
    const s = boxSession();
    const card = makeCard(23);
    s.slideIn('a', card, boxQuad(s.scene));
    s.run(16);
    s.slideIn('a2', card, boxQuad(s.scene, -7, 5, -1.5), { look: COPY });
    s.run(16);
    assert.equal(s.held, 1);
    const res = s.ctl.chipAnswer(answer);
    if (answer === 'plus') {
      assert.equal(res.action, 'increment');
      assert.equal(res.scanId, s.uploads[0].scanId);
      assert.equal(res.event.label, 'same');
      assert.ok(res.payload && res.payload.card === 'a2');
    } else {
      assert.equal(res.action, 'upload');
      assert.equal(res.item.force, true);
      assert.equal(res.event.label, 'different');
      s.upload(res.item);
    }
    assert.equal(s.ctl.chipAnswer('plus'), null, 'one answer per chip');
    assert.equal(s.ctl.takeHeld(), null);
    s.run(4);
    assert.equal(s.log[s.log.length - 1].sameChip, null);
    // a later new card uploads normally (no flush)
    s.slideIn('b', makeCard(24), boxQuad(s.scene));
    s.run(16);
    assert.deepEqual(s.uploads.map((u) => u.card), answer === 'plus' ? ['a', 'b'] : ['a', 'a2', 'b']);
  }
});

test('takeHeld flushes the chip photo on stop/tab change/commit', () => {
  const s = boxSession();
  const card = makeCard(25);
  s.slideIn('a', card, boxQuad(s.scene));
  s.run(16);
  s.slideIn('a2', card, boxQuad(s.scene, 6, -6, 1), { look: COPY });
  s.run(16);
  const item = s.ctl.takeHeld();
  assert.equal(item.dup_of, s.uploads[0].scanId);
  assert.equal(item.payload.card, 'a2');
  assert.equal(s.ctl.takeHeld(), null);
});

test('nudge → silent, and the silent records ride along in prev[] (cap 10)', () => {
  const s = boxSession();
  const c = s.slideIn('a', makeCard(26), boxQuad(s.scene));
  s.run(16);
  const q0 = c.quad;
  for (let k = 0; k < 12; k++) {
    const q1 = boxQuad(s.scene, (k % 2 ? 5 : -4), (k % 3) * 3 - 3, (k % 2 ? 0.4 : -0.3));
    s.scene.move(c, lerpQuad(q0, q1, 0.5)); s.step();
    s.scene.move(c, q1); s.step();
    s.run(12);
  }
  assert.equal(s.uploads.length, 1);
  assert.equal(s.held, 0);
  const silent = decisions(s).filter((r) => r.kind === 'silent');
  assert.ok(silent.length >= 10, `silent decisions ${silent.length}`);
  assert.ok(silent.every((r) => r.d <= CAPTURE_DEFAULTS.stillThr));
  s.slideIn('b', makeCard(27), boxQuad(s.scene));
  s.run(16);
  const prev = s.uploads[1].capture.prev;
  assert.equal(prev.length, CAPTURE_DEFAULTS.prevMax);
  assert.ok(prev.every((r) => r.kind === 'silent' && typeof r.d === 'number'));
});

test('a hand passing over the card → no upload', () => {
  const s = boxSession();
  s.slideIn('a', makeCard(28), boxQuad(s.scene));
  s.run(16);
  for (let k = 0; k < 3; k++) { s.handPass(4); s.run(14); }
  assert.equal(s.uploads.length, 1);
  assert.equal(s.held, 0);
  assert.ok(decisions(s).filter((r) => r.kind === 'silent').length >= 1);
});

test('slow drift → upload only after the watcher agrees, never during the drift', () => {
  // a small card on a table (the frame thumbnail hardly changes); its content cross-fades into another
  const s = new Session(new Scene('table', 6));
  s.run(4);
  const q = placeCard(250, 420, 120, 12);
  const c = s.slideIn('a', makeCard(31), q);
  s.run(16);
  assert.equal(s.uploads.length, 1);
  c.morph = { card: makeCard(32), t: 0 };
  const DRIFT = 32;
  for (let i = 1; i <= DRIFT; i++) {
    c.morph.t = i / DRIFT;
    const r = s.step();
    assert.ok(!r.capture, `no capture during the drift (frame ${i}, armed ${r.armed})`);
  }
  s.scene.cards[0] = { ...c, card: makeCard(32), morph: null, id: 'b', inv: null };
  s.run(30);
  assert.equal(s.uploads.length, 2);
  const up = s.uploads[1];
  assert.equal(up.capture.watch, true);
  assert.deepEqual(up.capture.armed, []);
  assert.equal(up.capture.watch_checks.length, CAPTURE_DEFAULTS.watchAgree);
  assert.equal(up.allowClaude, false);
  s.run(30);
  assert.equal(s.uploads.length, 2, 'decided: no repeat');
});

test('glare drifting over a still card never uploads', () => {
  const s = new Session(new Scene('table', 8));
  const c = s.slideIn('a', makeCard(33), placeCard(240, 430, 130, -8));
  s.run(16);
  c.look = { glare: { gu: 0.2, gv: 0.2, gr: 0.3, ga: 0.5 } };
  for (let i = 0; i < 60; i++) { c.look.glare.gu = 0.2 + 0.6 * (i / 60); c.look.glare.gv = 0.2 + 0.5 * (i / 60); s.step(); }
  assert.equal(s.uploads.length, 1);
});

test('weak track (never accepted) → fallback capture on the weak quad, no Claude', () => {
  const s = boxSession();
  s.slideIn('w', makeCard(34), boxQuad(s.scene, 3, -2), { detect: 'weak' });
  const rs = s.run(40);
  assert.equal(s.uploads.length, 1);
  const u = s.uploads[0];
  assert.equal(u.card, 'w');
  assert.equal(u.capture.fallback, true);
  assert.equal(u.capture.quad_source, 'weak');
  assert.equal(u.allowClaude, false);
  assert.ok(rs.some((r) => r.capture && r.hint === 'Check the edges'));
});

test('no lock but a card in view → fallback capture (prior quad, else default), no Claude', () => {
  for (const prior of [true, false]) {
    const s = boxSession();
    if (prior) s.extra.priorQuad = boxQuad(s.scene);
    s.slideIn('r', makeCard(35), boxQuad(s.scene, 2, 3), { detect: 'none' });
    s.run(40);
    assert.equal(s.uploads.length, 1, `prior ${prior}`);
    const u = s.uploads[0];
    assert.equal(u.capture.fallback, true);
    assert.equal(u.capture.quad_source, prior ? 'prior' : 'default');
    assert.equal(u.allowClaude, false);
    assert.ok(u.capture.evidence.d_empty > CAPTURE_DEFAULTS.emptyMad);
    // once decided, the same unlocked card is not captured again
    s.run(40);
    assert.equal(s.uploads.length, 1);
  }
});

test('unlocked new card on top of a decided one → fallback still fires (persist arm keeps its clock)', () => {
  const s = boxSession();
  s.slideIn('a', makeCard(36), boxQuad(s.scene));
  s.run(20);
  assert.equal(s.uploads.length, 1);
  // the next card is never detected: its thumbnail differs from topRef on every frame
  s.slideIn('b', makeCard(37), boxQuad(s.scene, 2, -2), { detect: 'none' });
  s.run(60);
  assert.equal(s.uploads.length, 2);
  assert.equal(s.uploads[1].card, 'b');
  assert.equal(s.uploads[1].capture.fallback, true);
  assert.equal(s.uploads[1].allowClaude, false);
});

test('card removed → empty box again: no capture', () => {
  const s = boxSession();
  s.slideIn('a', makeCard(36), boxQuad(s.scene));
  s.run(16);
  s.slideOut();
  s.run(48);
  assert.equal(s.uploads.length, 1);
});

test('card slid in during an upload → pending → shot after busy clears', () => {
  const s = boxSession();
  s.slideIn('a', makeCard(37), boxQuad(s.scene));
  s.run(16);
  s.busy = true;
  s.slideIn('b', makeCard(38), boxQuad(s.scene, 4, 4));
  const during = s.run(12);
  assert.ok(during.some((r) => r.pendingCapture && r.state === STATES.PENDING));
  assert.ok(during.every((r) => !r.capture));
  assert.equal(s.ctl.pending().kind, 'new');
  s.busy = false;
  s.run(4);
  assert.deepEqual(s.uploads.map((u) => u.card), ['a', 'b']);
  assert.equal(s.ctl.pending(), null);
  assert.ok(s.uploads[1].capture.pending.waited_ms > 0);
});

test('pending card covered by the next one before busy clears: dropped and logged, the next card uploads', () => {
  const s = boxSession();
  s.slideIn('a', makeCard(41), boxQuad(s.scene));
  s.run(16);
  s.busy = true;
  s.slideIn('b', makeCard(42), boxQuad(s.scene));
  s.run(10);
  s.slideIn('c', makeCard(43), boxQuad(s.scene));
  s.run(10);
  s.busy = false;
  s.run(16);
  assert.deepEqual(s.uploads.map((u) => u.card), ['a', 'c']);
  assert.ok(s.uploads[1].capture.prev.some((r) => r.pending && (r.pending.replaced || r.pending.dropped)));
});

test('table: pick up and put back → no upload; swapped for another card → upload', () => {
  const s = new Session(new Scene('table', 9));
  s.run(4);
  const card = makeCard(44);
  s.slideIn('a', card, placeCard(220, 400, 190, 15));
  s.run(16);
  s.slideOut();
  s.run(10);
  s.slideIn('a', card, placeCard(270, 470, 200, -20));
  s.run(20);
  assert.equal(s.uploads.length, 1);
  assert.equal(s.held, 0);
  s.slideOut();
  s.run(10);
  s.slideIn('b', makeCard(45), placeCard(250, 430, 190, 5));
  s.run(20);
  assert.deepEqual(s.uploads.map((u) => u.card), ['a', 'b']);
});

test('forgetCapture (review/failed result): the card in view is uploaded again after it is adjusted', () => {
  const s = boxSession();
  const c = s.slideIn('a', makeCard(46), boxQuad(s.scene));
  s.run(16);
  assert.equal(s.ctl.forgetCapture(999), null, 'another row: no-op');
  assert.equal(s.ctl.forgetCapture(), null);
  s.run(20);
  assert.equal(s.uploads.length, 1, 'no re-upload while untouched');
  s.scene.move(c, boxQuad(s.scene, 4, -3, 0.7)); s.step();
  s.scene.move(c, boxQuad(s.scene, 6, -4, 1)); s.step();
  s.run(16);
  assert.equal(s.uploads.length, 2);
  assert.equal(s.uploads[1].capture.kind, 'retry');
  assert.equal(s.uploads[1].allowClaude, false);
  assert.equal(s.held, 0);
});

test('chip target undone/committed → the held photo falls back to a plain upload, no further chips', () => {
  const s = boxSession();
  const card = makeCard(47);
  s.slideIn('a', card, boxQuad(s.scene));
  s.run(16);
  s.slideIn('a2', card, boxQuad(s.scene, 7, 7, 1.2), { look: COPY });
  s.run(16);
  assert.equal(s.held, 1);
  const item = s.ctl.forgetCapture(s.uploads[0].scanId);
  assert.ok(item);
  assert.equal(item.dup_of, null);
  assert.equal(item.capture.chip.label, 'forgotten');
  s.upload(item);
  assert.equal(s.log.length && s.ctl.takeHeld(), null);
  // the target was undone before a re-slide: the copy uploads instead of chipping
  const t = boxSession();
  t.slideIn('a', card, boxQuad(t.scene));
  t.run(16);
  t.ctl.forgetCapture(t.uploads[0].scanId);
  t.slideIn('a2', card, boxQuad(t.scene, -6, 6, -1), { look: COPY });
  t.run(16);
  assert.equal(t.held, 0);
  assert.deepEqual(t.uploads.map((u) => u.card), ['a', 'a2']);
  assert.equal(t.uploads[1].capture.kind, 'retry');
});

test('calibration mode: the chip shows on every armed decision, labels and d are logged', () => {
  const s = new Session(new Scene('box', 3), { calibration: true });
  s.run(32);
  const c = s.slideIn('a', makeCard(48), boxQuad(s.scene));
  s.run(16);
  assert.equal(s.uploads.length, 1, 'the first card has no chip target: uploaded');
  // a nudge would be silent: in calibration it asks
  s.scene.move(c, boxQuad(s.scene, 5, -4, 0.8)); s.step();
  s.run(16);
  assert.equal(s.held, 1);
  const r1 = s.ctl.chipAnswer('plus');
  assert.equal(r1.action, 'increment');
  assert.equal(r1.event.label, 'same');
  assert.equal(r1.event.calibration, true);
  assert.ok(typeof r1.event.d === 'number');
  // a different card asks too; "Scan as new" uploads it
  s.slideIn('b', makeCard(49), boxQuad(s.scene));
  s.run(16);
  assert.equal(s.held, 2);
  const r2 = s.ctl.chipAnswer('new');
  assert.equal(r2.event.label, 'different');
  assert.ok(r2.event.d > CAPTURE_DEFAULTS.newThr);
  s.upload(r2.item);
  const armedSilent = decisions(s).filter((r) => r.kind === 'silent' && r.armed.length);
  assert.equal(armedSilent.length, 0, 'no silent result applied on an armed decision');
  assert.ok(decisions(s).every((r) => r.calibration === true));
  // a hand pass: chip again (ignored), its record ends up flushed with dup_of
  s.handPass(4);
  s.run(16);
  s.slideIn('c', makeCard(50), boxQuad(s.scene));
  s.run(16);
  const flushed = s.uploads.filter((u) => u.capture.chip?.label === 'ignored');
  assert.ok(flushed.length >= 1);
  assert.ok(flushed.every((u) => u.dup_of === s.uploads[1].scanId || u.dup_of === s.uploads.find((x) => x.card === 'b').scanId));
});

test('manual shutter: tracked quad, else the fallback chain', () => {
  const s = boxSession();
  const o = s.rig.frame();
  const c = s.ctl.forceCapture(o);
  assert.equal(c.kind, 'manual');
  assert.equal(c.rec.quad_source, 'default');
  assert.equal(c.allowClaude, true);
  const item = s.ctl.captured(c, { card: null });
  assert.equal(item.allowClaude, true);
  s.scene.add('a', makeCard(51), boxQuad(s.scene));
  s.run(6);
  const c2 = s.ctl.forceCapture(s.rig.frame());
  assert.equal(c2.rec.quad_source, 'track');
});

test('slow shots: a second chip photo uploads the older held one (dup_of), manual shutter flushes the held one', () => {
  const ctl = new CaptureController();
  const rec = (d) => ({ kind: 'chip', d });
  assert.ok(ctl.captured({ id: 1, hold: false, h: new Uint32Array(22), rec: { kind: 'new' }, allowClaude: true }, { n: 1 }));
  ctl.uploaded(1, 41);
  assert.equal(ctl.captured({ id: 2, hold: true, rec: rec(0.05) }, { n: 2 }), null);
  const older = ctl.captured({ id: 3, hold: true, rec: rec(0.06) }, { n: 3 });
  assert.equal(older.payload.n, 2);
  assert.equal(older.dup_of, 41);
  const m = ctl.forceCapture({ now: 1, vw: 480, vh: 853 });
  assert.equal(m.flush.payload.n, 3);
  assert.equal(m.flush.dup_of, 41);
  assert.equal(ctl.takeHeld(), null);
});

test('rearm(): the card in view is captured again', () => {
  const s = boxSession();
  s.slideIn('a', makeCard(52), boxQuad(s.scene));
  s.run(16);
  s.ctl.rearm();
  s.run(16);
  assert.equal(s.uploads.length, 2);
  assert.equal(s.uploads[1].capture.kind, 'retry');
});

test('paused: no decision, but the change is remembered (arm only)', () => {
  const s = boxSession();
  s.slideIn('a', makeCard(53), boxQuad(s.scene));
  s.run(16);
  s.extra.paused = true;
  s.slideIn('b', makeCard(54), boxQuad(s.scene));
  const rs = s.run(16);
  assert.ok(rs.every((r) => r.state === STATES.PAUSED && !r.capture));
  s.extra.paused = false;
  s.run(16);
  assert.deepEqual(s.uploads.map((u) => u.card), ['a', 'b']);
});

test('minScore is the variant minimum', () => {
  const a = new Uint32Array(22), b = new Uint32Array(22).fill(0xffffffff), c = new Uint32Array(22);
  c[0] = 1;
  assert.equal(minScore([b, c], a), 3 / 2304);
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

test('upload queue: a held photo flushed before the next card keeps the order', async () => {
  const sent = [];
  const q = new UploadQueue({ sleep: async () => {}, send: async (item) => { sent.push(item.payload.card); return {}; } });
  const s = boxSession();
  const card = makeCard(55);
  const push = (r) => { if (r.flush) q.push(r.flush); if (r.capture) q.push(s.ctl.captured(r.capture, { card: s.scene.top().id })); };
  const drive = (n) => { for (let i = 0; i < n; i++) push(s.ctl.step(s.rig.frame())); };
  const slide = (id, cd, quad, look) => {
    const start = quad.map(([x, y]) => [x, y + s.scene.h * 0.75]);
    const c = s.scene.add(id, cd, start, { look });
    for (let i = 1; i <= 6; i++) { s.scene.move(c, lerpQuad(start, quad, i / 6)); push(s.ctl.step(s.rig.frame())); }
  };
  slide('a', card, boxQuad(s.scene)); drive(16);
  slide('a2', card, boxQuad(s.scene, 6, 6, 1), COPY); drive(16);
  slide('b', makeCard(56), boxQuad(s.scene)); drive(16);
  await q.idle();
  assert.deepEqual(sent, ['a', 'a2', 'b']);
});

test('"+1" before the first copy has a row id: deferred, then an increment of that row (never a window duplicate)', () => {
  const s = boxSession();
  const card = makeCard(23);
  // the first copy's upload is still being identified: the simulated server answers later
  const pending = [];
  s.upload = (item) => { pending.push(item); s.uploads.push({ ...item, scanId: null, card: item.payload.card }); };
  s.slideIn('a', card, boxQuad(s.scene));
  s.run(16);
  s.slideIn('a2', card, boxQuad(s.scene, -7, 5, -1.5), { look: COPY });
  s.run(16);
  assert.equal(s.held, 1);
  const res = s.ctl.chipAnswer('plus');
  assert.equal(res.action, 'deferred');
  assert.equal(res.capId, pending[0].id);
  assert.equal(s.ctl.uploaded(999, 5).length, 0, 'another upload: nothing');
  const inc = s.ctl.uploaded(pending[0].id, 41);
  assert.equal(inc.length, 1);
  assert.equal(inc[0].action, 'increment');
  assert.equal(inc[0].scanId, 41);
  assert.equal(inc[0].event.label, 'same');
  assert.equal(inc[0].payload.card, 'a2');
  assert.equal(s.ctl.uploaded(pending[0].id, 41).length, 0, 'once');

  // the first copy came back review/failed/error: the +1 photo is uploaded as a counted row of its own
  const t = boxSession();
  const tp = [];
  t.upload = (item) => { tp.push(item); t.uploads.push({ ...item, scanId: null, card: item.payload.card }); };
  t.slideIn('a', card, boxQuad(t.scene));
  t.run(16);
  t.slideIn('a2', card, boxQuad(t.scene, -7, 5, -1.5), { look: COPY });
  t.run(16);
  assert.equal(t.ctl.chipAnswer('plus').action, 'deferred');
  const lost = t.ctl.uploadLost(tp[0].id);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].force, true);
  assert.equal(lost[0].dup_of, null);
  assert.equal(lost[0].capture.chip.label, 'same');
  assert.equal(t.ctl.uploaded(tp[0].id, 7).length, 0);

  // no target upload at all: counted as a forced upload
  const ctl = new CaptureController();
  ctl.captured({ id: 5, hold: true, rec: { kind: 'chip', d: 0.05 } }, { n: 1 });
  const r = ctl.chipAnswer('plus');
  assert.equal(r.action, 'upload');
  assert.equal(r.item.force, true);
});

test('adopt after a review pick: the card in view is decided again (no re-upload, no second picker)', () => {
  for (const pick of [true, false]) {
    const s = boxSession();
    const c = s.slideIn('a', makeCard(46), boxQuad(s.scene));
    s.run(16);
    const capId = s.uploads[0].id;
    s.ctl.forgetCapture(); // review result
    if (pick) {
      assert.equal(s.ctl.adopt(capId + 1, 77), false, 'another upload: no-op');
      assert.equal(s.ctl.adopt(capId, 77), true);
      assert.equal(s.ctl.cap.scanId, 77);
    }
    // a hand on the phone while the picker was open: the card moves a little
    s.scene.move(c, boxQuad(s.scene, 4, -3, 0.7)); s.step();
    s.scene.move(c, boxQuad(s.scene, 6, -4, 1)); s.step();
    s.run(16);
    assert.equal(s.uploads.length, pick ? 1 : 2, pick ? 'picked: silent' : 'dismissed: uploaded again');
  }
  // adopt is a no-op once another card was captured
  const t = boxSession();
  t.slideIn('a', makeCard(46), boxQuad(t.scene));
  t.run(16);
  const capId = t.uploads[0].id;
  t.ctl.forgetCapture();
  t.slideIn('b', makeCard(47), boxQuad(t.scene));
  t.run(16);
  assert.equal(t.uploads.length, 2);
  assert.equal(t.ctl.adopt(capId, 77), false);
  assert.notEqual(t.ctl.cap.scanId, 77);
});
