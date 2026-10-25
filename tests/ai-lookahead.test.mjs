import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import * as E from '../src/engine.js';
import {twoDrawPotential, safeDiscardTiles, unseenCounts, analyzeDiscards, lookaheadFactory} from '../ai/lookahead/policy.mjs';
import {MahjongEnvironment, observationFor, legalActionsFor, replayEpisode, actionKey, assertConservation} from '../ai/environment.mjs';
import {seededRandom} from '../ai/random.mjs';
import {selectAction as h0} from '../ai/policies/h0.mjs';

const hand = E.parseHand('p12346s23467z556');
const melds = [];
const visible = {...Object.fromEntries(E.TYPES.map(t => [t, 4])), p5:2, s5:3, s8:3, z6:3};

// An independent physical-copy enumerator uses the canonical winning evaluator,
// rather than the search's shanten function, for the one-away fixture.
function exhaustiveWinPairs(hand, visible, danger = [], melds = []) {
  const pool = E.TYPES.flatMap(t => Array(4 - visible[t]).fill(t));
  let numerator = 0;
  for (let i = 0; i < pool.length; i++) {
    const drawn = [...hand, pool[i]];
    if (E.evaluate(drawn, melds, {self:true, winTile:pool[i]})) { numerator += pool.length - 1; continue; }
    let best = 0;
    for (const out of safeDiscardTiles(drawn, danger)) {
      const after = [...drawn]; after.splice(after.indexOf(out), 1);
      let wins = 0;
      for (let j = 0; j < pool.length; j++) if (j !== i && E.evaluate([...after, pool[j]], melds, {self:true, winTile:pool[j]})) wins++;
      best = Math.max(best, wins);
    }
    numerator += best;
  }
  return {numerator, denominator:pool.length * (pool.length - 1)};
}

test('two-draw probability matches independent copy enumeration without replacement', () => {
  assert.equal(E.distance(hand), 1);
  for (const danger of [[], ['z6'], E.TYPES]) {
    const actual = twoDrawPotential(hand, melds, visible, {dangerousTiles:danger});
    const expected = exhaustiveWinPairs(hand, visible, danger);
    assert.equal(actual.target, -1);
    assert.equal(actual.numerator, expected.numerator);
    assert.equal(actual.denominator, expected.denominator);
  }
  assert.ok(twoDrawPotential(hand, melds, visible).numerator > 0);
  assert.ok(twoDrawPotential(hand, melds, visible, {dangerousTiles:['z6']}).numerator < twoDrawPotential(hand, melds, visible).numerator);
  // Both draws must be the same type: failing to consume the first copy would
  // incorrectly produce 9/6, rather than six ordered physical-copy pairs.
  const sameTileHand = E.parseHand('p123456s123z5567');
  const sameTileVisible = {...Object.fromEntries(E.TYPES.map(t => [t, 4])), z6:1};
  const sameTile = twoDrawPotential(sameTileHand, [], sameTileVisible);
  assert.equal(sameTile.distance, 1);
  assert.equal(sameTile.numerator, 6);
  assert.equal(sameTile.denominator, 6);
  assert.equal(sameTile.firstDraws[0].secondOuts, 2);
  assert.deepEqual(exhaustiveWinPairs(sameTileHand, sameTileVisible), {numerator:6, denominator:6});
});

test('open melds and seven pairs counting a quad as two pairs match canonical exhaustive wins', () => {
  const open = E.parseHand('p46s23467z556'), openMelds = [{kind:'peng', tile:'p1'}];
  const pairs = E.parseHand('p111122s3344z567');
  const v = {...Object.fromEntries(E.TYPES.map(t => [t, 4])), z5:2, z6:2, z7:2};
  for (const [h, m, seen] of [[open, openMelds, visible], [pairs, [], v]]) {
    assert.equal(E.distance(h, m), 1);
    const actual = twoDrawPotential(h, m, seen), expected = exhaustiveWinPairs(h, seen, [], m);
    assert.ok(expected.numerator > 0);
    assert.equal(actual.numerator, expected.numerator);
    assert.equal(actual.denominator, expected.denominator);
  }
});

test('known copies stay exhausted; a winning first draw ends the branch; empty pools are finite', () => {
  const ready = E.parseHand('p123456s23467z55');
  const v = {...Object.fromEntries(E.TYPES.map(t => [t, 4])), s5:3, s8:3};
  const actual = twoDrawPotential(ready, [], v);
  assert.equal(actual.probability, 1);
  assert.ok(actual.firstDraws.every(b => b.immediateWin && b.discard === null));
  assert.equal(twoDrawPotential(ready, [], {...v, s5:4, s8:4}).probability, 0);
  assert.equal(twoDrawPotential(ready, [], {...v, s8:4}).probability, 0);
  assert.deepEqual(safeDiscardTiles(['p1', 'p1', 'z5'], ['p1']), ['z5']);
  assert.deepEqual(safeDiscardTiles(['p1', 'p1'], ['p1']), ['p1']);
  assert.throws(() => unseenCounts({p1:5}), /public tile count/);
  assert.throws(() => twoDrawPotential(hand, [], {}), /Own tiles/);
});

test('search observes public information only and returns canonical actions deterministically', () => {
  const g = E.newGame({mode:'bots'}, {dealer:0}, seededRandom('lookahead-privacy'));
  const first = observationFor(g, 0), legal = legalActionsFor(g, 0);
  const wallIndex = g.wall.findIndex(t => t !== g.players[1].hand[0]);
  [g.players[1].hand[0], g.wall[wallIndex]] = [g.wall[wallIndex], g.players[1].hand[0]];
  g.players[1].hand.reverse(); g.players[2].hand.reverse(); g.wall.reverse();
  g.players[1].passedPeng = ['z5']; g.players[2].dealHand = ['p1'];
  assertConservation(g);
  assert.deepEqual(observationFor(g, 0), first);
  assert.deepEqual(legalActionsFor(g, 0), legal);
  for (const mode of ['ties', 'same-shanten']) {
    const select = lookaheadFactory({mode})();
    const a = select(first, legal), b = select(observationFor(g, 0), legalActionsFor(g, 0));
    assert.deepEqual(a, b);
    assert.ok(legal.some(x => actionKey(x) === actionKey(a)));
    assert.deepEqual(select(first, legal), a);
  }
});

test('complete games preserve legality, H0 special actions, immediate ties and exact replay', () => {
  const started = performance.now(); let searched = 0;
  for (const mode of ['ties', 'same-shanten']) for (let seed = 0; seed < 2; seed++) {
    const env = new MahjongEnvironment({seed:`lookahead-${mode}-${seed}`});
    while (!env.done) {
      const o = env.observation(), legal = env.legalActions(), base = h0(o, legal);
      const analysis = analyzeDiscards(o, legal, {mode});
      if (analysis.searched) {
        searched++;
        assert.ok(analysis.candidates.every(c => c.distance === analysis.candidates[0].distance));
        if (mode === 'ties') assert.ok(analysis.candidates.every(c => c.outs === analysis.candidates[0].outs));
      }
      if (base.type !== 'discard' || base.reveal || o.players[o.seat].liang) assert.deepEqual(analysis.action, base);
      if (o.wallCount < 6) assert.deepEqual(analysis.action, base);
      env.step(analysis.action);
    }
    assert.deepEqual(replayEpisode(env.replay()), env.result());
  }
  assert.ok(searched > 0);
  console.log(`Lookahead full-game fixture: ${searched} searches, ${(performance.now() - started).toFixed(0)}ms`);
});
