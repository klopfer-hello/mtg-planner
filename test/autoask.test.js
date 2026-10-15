// AutoAsk (public/autoask.js): one Claude scan per hard card track, never more,
// paused by the hourly cap, one retry when Claude was busy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoAsk, AUTO_ASK_DEFAULTS, CLAUDE_LIMIT_HINT } from '../public/autoask.js';

const thumb = (v, n = 192) => new Float32Array(n).fill(v);
const CARD_A = thumb(100);
const CARD_B = thumb(160);

// frames of a still card; returns the step outputs
function frames(aa, card, n, extra = {}, t0 = 0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(aa.step({ found: true, cardThumb: card, still: true, sharp: 200, now: t0 + i * 125, ...extra }));
  return out;
}
const asks = (outs) => outs.filter((o) => o.ask).length;
const unidentified = (aa, card, n, t = 0) => { for (let i = 0; i < n; i++) aa.answer('unidentified', card, t); };

test('asks once after askAfter unidentified answers on a still card', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, AUTO_ASK_DEFAULTS.askAfter - 1);
  assert.equal(asks(frames(aa, CARD_A, 20)), 0, 'not yet');
  aa.answer('unidentified', CARD_A);
  const out = frames(aa, CARD_A, 20);
  assert.equal(asks(out), 1, 'exactly one ask');
  assert.ok(out[0].ask, 'on the first still frame');
  aa.scanned({ status: 'failed', claude: { skipped: null } });
  unidentified(aa, CARD_A, 10);
  assert.equal(asks(frames(aa, CARD_A, 40)), 0, 'never again on the same track');
  assert.equal(aa.stats.asked, 1);
});

test('drift of a hand-held card stays one track (counts accumulate)', () => {
  const aa = new AutoAsk();
  for (let i = 0; i < 4; i++) aa.answer('unidentified', thumb(100 + i * 12)); // each step 12 < changeMad
  assert.equal(asks(frames(aa, thumb(136), 3)), 1);
});

test('waits for a still, sharp, unblocked frame', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, 4);
  assert.equal(asks(frames(aa, CARD_A, 5, { still: false })), 0);
  assert.equal(asks(frames(aa, CARD_A, 5, { sharp: 20 })), 0);
  assert.equal(asks(frames(aa, CARD_A, 5, { blocked: true })), 0);
  assert.equal(asks(frames(aa, CARD_A, 5)), 1);
});

test('the setting (enabled) is read on every frame', () => {
  let on = false;
  const aa = new AutoAsk({ enabled: () => on });
  unidentified(aa, CARD_A, 4);
  assert.equal(asks(frames(aa, CARD_A, 5)), 0);
  on = true;
  assert.equal(asks(frames(aa, CARD_A, 5)), 1);
});

test('a staged/same answer, a lost quad or another card end the track', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, 3);
  aa.answer('same', CARD_A);
  aa.answer('unidentified', CARD_A);
  assert.equal(asks(frames(aa, CARD_A, 5)), 0, 'count restarted after the identified answer');

  const b = new AutoAsk();
  unidentified(b, CARD_A, 3, 0);
  b.step({ found: false, now: 100 });
  b.step({ found: false, now: AUTO_ASK_DEFAULTS.lostMs + 1 });
  b.answer('unidentified', CARD_A, AUTO_ASK_DEFAULTS.lostMs + 2);
  assert.equal(asks(frames(b, CARD_A, 5, {}, AUTO_ASK_DEFAULTS.lostMs + 3)), 0, 'no card for lostMs: a new track');

  const c = new AutoAsk();
  unidentified(c, CARD_A, 3);
  c.answer('unidentified', CARD_B);
  assert.equal(asks(frames(c, CARD_B, 5)), 0, 'another card: its own count');
  unidentified(c, CARD_B, 3);
  assert.equal(asks(frames(c, CARD_B, 5)), 1);
});

test('free hand: short quad losses and moving frames keep the track; the ask waits for the card', () => {
  const aa = new AutoAsk();
  let t = 0;
  for (let i = 0; i < 4; i++) {
    aa.answer('unidentified', thumb(100 + (i % 2) * 10), t);
    aa.step({ found: false, now: t + 500 });                       // the quad drops out
    aa.step({ found: false, now: t + 2500 });                      // ... for 2.5 s
    aa.step({ found: true, cardThumb: thumb(140), still: false, now: t + 2600 }); // moving: MAD 40
    t += 3000;
  }
  assert.equal(asks(frames(aa, thumb(140), 3, {}, t)), 0, 'another-looking card region: no ask');
  assert.equal(asks(frames(aa, thumb(105), 3, {}, t)), 1, 'the tracked card back still: ask');
});

test('busy/error answers do not count', () => {
  const aa = new AutoAsk();
  for (const o of ['busy', 'error', null]) aa.answer(o, CARD_A);
  unidentified(aa, CARD_A, 3);
  assert.equal(asks(frames(aa, CARD_A, 5)), 0);
});

test('a recently asked card is not asked again after it left and came back', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, 4);
  assert.equal(asks(frames(aa, CARD_A, 2)), 1);
  aa.scanned({ status: 'review', claude: { skipped: null } });
  for (let i = 0; i < 5; i++) aa.step({ found: false });
  unidentified(aa, CARD_A, 4);
  assert.equal(asks(frames(aa, CARD_A, 10)), 0);
  // a different hard card is still asked
  for (let i = 0; i < 5; i++) aa.step({ found: false });
  unidentified(aa, CARD_B, 4);
  assert.equal(asks(frames(aa, CARD_B, 2)), 1);
});

test('only one ask in flight', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, 4);
  assert.equal(asks(frames(aa, CARD_A, 2)), 1);
  for (let i = 0; i < 5; i++) aa.step({ found: false });
  unidentified(aa, CARD_B, 4);
  assert.equal(asks(frames(aa, CARD_B, 5)), 0, 'card A is still being identified');
  aa.scanned({ status: 'suggest' }); // Claude found card A: staged
  assert.equal(asks(frames(aa, CARD_B, 5)), 1);
});

test('one physical card, many tracks: after an ask that staged nothing, no more asks until a card is found or the view is empty for quietMs', () => {
  // a held card nobody can identify: its probe thumbnails jump by MAD 30 between positions, so each
  // position is a new track (and more positions than the asked-thumbnail memory holds)
  const aa = new AutoAsk();
  let t = 0, n = 0;
  for (let round = 0; round < 6; round++) {
    for (const v of [100, 130, 160, 190]) {
      for (let i = 0; i < 4; i++) { aa.answer('unidentified', thumb(v), t); t += 600; }
      const out = frames(aa, thumb(v), 2, {}, t);
      t += 2000;
      if (asks(out)) { n++; aa.scanned({ status: n === 1 ? 'review' : 'failed', claude: { skipped: null } }, t); }
      aa.step({ found: false, now: t }); // short quad losses while moving (< quietMs)
      t += 1500;
    }
  }
  assert.equal(n, 1, 'asked once');
  // a probe stages a card: the next hard card is asked again
  aa.answer('staged', thumb(50), t);
  unidentified(aa, thumb(220), 4, t);
  assert.equal(asks(frames(aa, thumb(220), 2, {}, t)), 1);
  aa.scanned({ status: 'review' }, t);
  // no card for quietMs: on again
  unidentified(aa, thumb(10), 4, t);
  assert.equal(asks(frames(aa, thumb(10), 2, {}, t)), 0, 'hushed');
  aa.step({ found: false, now: t + 100 });
  aa.step({ found: false, now: t + 1000 + AUTO_ASK_DEFAULTS.quietMs });
  t += AUTO_ASK_DEFAULTS.quietMs + 2000;
  unidentified(aa, thumb(10), 4, t);
  assert.equal(asks(frames(aa, thumb(10), 2, {}, t)), 1);
});

test('ask budget: at most maxAsks per budgetMs, even for cards Claude identifies', () => {
  const aa = new AutoAsk();
  let t = 0, n = 0;
  for (let i = 0; i < 10; i++) {
    unidentified(aa, thumb(i * 25), 4, t);
    if (asks(frames(aa, thumb(i * 25), 2, {}, t))) { n++; aa.scanned({ status: 'suggest' }, t); }
    aa.answer('staged', thumb(i * 25), t);
    t += 5000;
  }
  assert.equal(n, AUTO_ASK_DEFAULTS.maxAsks);
  t = AUTO_ASK_DEFAULTS.budgetMs + 1;
  unidentified(aa, thumb(240), 4, t);
  assert.equal(asks(frames(aa, thumb(240), 2, {}, t)), 1, 'a new window');
});

test('hourly cap: pauses until resets_at and shows the limit hint', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, 4);
  assert.equal(asks(frames(aa, CARD_A, 1, {}, 1000)), 1);
  const resets = new Date(1000 + 30 * 60000).toISOString();
  assert.equal(aa.scanned({ status: 'review', claude: { skipped: 'hourly cap reached', resets_at: resets } }, 1000), 'hourly cap reached');
  assert.ok(aa.capped(2000));
  const out = frames(aa, CARD_A, 3, {}, 2000);
  assert.equal(asks(out), 0);
  assert.equal(out[0].hint, CLAUDE_LIMIT_HINT);
  for (let i = 0; i < 5; i++) aa.step({ found: false, now: 3000 });
  unidentified(aa, CARD_B, 4);
  assert.equal(asks(frames(aa, CARD_B, 3, {}, 4000)), 0, 'no asks while capped');
  assert.equal(asks(frames(aa, CARD_B, 3, {}, 1000 + 30 * 60000)), 1, 'asks again after the reset');
});

test('hourly cap without a reset time pauses capPauseMs', () => {
  const aa = new AutoAsk({ cfg: { capPauseMs: 5000 } });
  unidentified(aa, CARD_A, 4);
  frames(aa, CARD_A, 1);
  aa.scanned({ claude: { skipped: 'hourly cap reached' } }, 0);
  assert.ok(aa.capped(4999));
  assert.ok(!aa.capped(5000));
});

test('Claude busy: one retry after busyRetryMs, then never again', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, 4);
  assert.equal(asks(frames(aa, CARD_A, 1, {}, 0)), 1);
  aa.scanned({ status: 'review', claude: { skipped: 'busy' } }, 0);
  assert.equal(asks(frames(aa, CARD_A, 3, {}, 1000)), 0, 'not before busyRetryMs');
  assert.equal(asks(frames(aa, CARD_A, 3, {}, AUTO_ASK_DEFAULTS.busyRetryMs)), 1, 'one retry');
  aa.scanned({ status: 'review', claude: { skipped: 'busy' } }, AUTO_ASK_DEFAULTS.busyRetryMs);
  assert.equal(asks(frames(aa, CARD_A, 3, {}, 60000)), 0, 'no second retry');
});

test('cancel (could not shoot): the card may be asked again', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, 4);
  assert.equal(asks(frames(aa, CARD_A, 1)), 1);
  aa.cancel();
  assert.equal(aa.stats.asked, 0);
  assert.equal(asks(frames(aa, CARD_A, 1)), 1);
});

test('cancel keeps the asked-card memory (no eviction by asks that never went out)', () => {
  const aa = new AutoAsk({ cfg: { maxAsks: 100 } });
  let t = 0;
  for (const v of [0, 100, 200]) {
    unidentified(aa, thumb(v), 4, t);
    assert.equal(asks(frames(aa, thumb(v), 1, {}, t)), 1);
    aa.scanned({ status: 'suggest' }, t);
    aa.answer('staged', thumb(v), t);
    t += 1000;
  }
  unidentified(aa, thumb(50), 4, t);
  for (let i = 0; i < 4; i++) { assert.equal(asks(frames(aa, thumb(50), 1, {}, t)), 1); aa.cancel(); }
  assert.equal(aa.recent.length, 3);
  aa.answer('same', thumb(50), t);
  unidentified(aa, thumb(0), 4, t);
  assert.equal(asks(frames(aa, thumb(0), 3, {}, t)), 0, 'card 0 is still remembered');
});

test('reset forgets tracks and the in-flight ask, keeps the cap pause', () => {
  const aa = new AutoAsk();
  unidentified(aa, CARD_A, 4);
  frames(aa, CARD_A, 1);
  aa.scanned({ claude: { skipped: 'hourly cap reached', resets_at: new Date(Date.now() + 60000).toISOString() } });
  aa.reset();
  assert.equal(aa.pending, null);
  assert.equal(aa.track, null);
  assert.ok(aa.capped());
});

test('cfg overrides: only known non-negative numbers', () => {
  const aa = new AutoAsk({ cfg: { askAfter: 2, changeMad: 'x', bogus: 1 } });
  assert.equal(aa.cfg.askAfter, 2);
  assert.equal(aa.cfg.changeMad, AUTO_ASK_DEFAULTS.changeMad);
  assert.equal('bogus' in aa.cfg, false);
});

test('wants: a card due for an ask holds new probes; not before askAfter, after the ask, or while hushed', () => {
  const aa = new AutoAsk();
  const o = (card, now = 0) => ({ found: true, cardThumb: card, now });
  unidentified(aa, CARD_A, 3);
  assert.equal(aa.wants(o(CARD_A)), false, 'not yet');
  aa.answer('unidentified', CARD_A);
  assert.equal(aa.wants(o(CARD_A)), true);
  // Not while the ask could not go out anyway: the probe loop keeps its own hints then.
  assert.equal(aa.wants({ ...o(CARD_A), still: false }), false, 'moving');
  assert.equal(aa.wants({ ...o(CARD_A), sharp: 40 }), false, 'blurry strip');
  assert.equal(aa.wants({ ...o(CARD_A), blocked: true }), false, 'queue stalled / scan running');
  assert.equal(aa.wants({ ...o(CARD_A), still: true, sharp: 200 }), true);
  assert.equal(aa.wants(o(CARD_B)), false, 'another card in view');
  assert.equal(aa.wants({ found: false }), false);
  assert.equal(asks(frames(aa, CARD_A, 1)), 1);
  assert.equal(aa.wants(o(CARD_A)), false, 'asked');
  aa.scanned({ status: 'review' }, 0);
  for (let i = 0; i < 5; i++) aa.step({ found: false, now: 100 });
  unidentified(aa, CARD_B, 4, 200);
  assert.equal(aa.wants(o(CARD_B, 300)), false, 'hushed after a review');
  aa.answer('staged', CARD_B, 400);
  unidentified(aa, CARD_B, 4, 500);
  assert.equal(aa.wants(o(CARD_B, 600)), true);
});
