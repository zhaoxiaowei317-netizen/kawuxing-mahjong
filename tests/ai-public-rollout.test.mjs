import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import {seededRandom} from '../ai/random.mjs';
import {MahjongEnvironment, observationFor, legalActionsFor, replayEpisode, actionKey, assertConservation} from '../ai/environment.mjs';
import {selectAction as h0} from '../ai/policies/h0.mjs';
import {analyzeDiscards} from '../ai/lookahead/policy.mjs';
import {sampleWorld, samplingSupport} from '../ai/public-rollout/sampler.mjs';
import {simulateToEnd, analyzeNetScore, comparePairedScores, netScoreFactory, normalizeSearchConfig} from '../ai/public-rollout/policy.mjs';

function revealedFixture(hand) {
  const g = E.newGame({mode:'bots'}, {dealer:0}, seededRandom('public-world-revealed'));
  const exposed = E.parseHand(hand), used = E.counts(exposed);
  const pool = E.TYPES.flatMap(t => Array(4 - (used[t] || 0)).fill(t));
  g.players[1].hand = exposed; g.players[1].liang = true;
  g.players[1].liangWaits = E.waits(exposed, [], true);
  assert.ok(g.players[1].liangWaits.length);
  g.players[1].liangKongTiles = E.reservedKongTiles(g.players[1]);
  g.players[0].hand = pool.splice(0, 14); g.players[2].hand = pool.splice(0, 13); g.wall = pool;
  g.drawTile = g.players[0].hand.at(-1); assertConservation(g); return g;
}
let cached;
function disagreementFixture() {
  if (cached) return cached;
  for (let seed = 0; seed < 30; seed++) {
    const env = new MahjongEnvironment({seed:`public-rollout-disagreement-${seed}`});
    while (!env.done) {
      const o = env.observation(), legal = env.legalActions();
      if (samplingSupport(o).supported && o.wallCount >= 4 && o.wallCount <= 40) {
        const shape = analyzeDiscards(o, legal, {mode:'same-shanten'});
        if (shape.searched && actionKey(shape.action) !== actionKey(shape.baseline)) return cached = {o, legal};
      }
      env.step(h0(o, legal));
    }
  }
  throw Error('No disagreement fixture');
}

test('sampled worlds conserve all copies, exactly preserve public views and vary only unseen tiles', () => {
  for (let seed = 0; seed < 4; seed++) {
    const g = E.newGame({mode:'bots'}, {dealer:0}, seededRandom(`public-sample-${seed}`));
    const o = observationFor(g, 0), legal = legalActionsFor(g, 0);
    const a = sampleWorld(o, 'world-a'), b = sampleWorld(o, 'world-b');
    assertConservation(a); assertConservation(b);
    assert.deepEqual(observationFor(a, 0), o); assert.deepEqual(observationFor(b, 0), o);
    assert.deepEqual(legalActionsFor(a, 0), legal);
    assert.notDeepEqual(a.wall, b.wall);
    const index = g.wall.findIndex(t => t !== g.players[1].hand[0]);
    [g.wall[index], g.players[1].hand[0]] = [g.players[1].hand[0], g.wall[index]];
    assertConservation(g);
    assert.deepEqual(sampleWorld(observationFor(g, 0), 'world-a'), a);
    const broken = structuredClone(o); broken.visibleCounts.p1 = (broken.visibleCounts.p1 || 0) + 1;
    assert.throws(() => sampleWorld(broken, 'bad'), /public counts/);
  }
});

test('fully revealed hands and waits stay fixed; unknown reserved triplets are explicitly unsupported', () => {
  const known = observationFor(revealedFixture('p123456s23467z55'), 0);
  assert.equal(known.players[1].hiddenTileCount, 0);
  assert.equal(samplingSupport(known).supported, true);
  const sample = sampleWorld(known, 'known-revealed');
  assert.deepEqual(E.sorted(sample.players[1].hand), known.players[1].revealedTiles);
  assert.deepEqual(E.revealedWaits(sample, 1).map(w => w.tile), known.players[1].publicWaits);
  const reserved = observationFor(revealedFixture('p111s234567789z5'), 0);
  assert.equal(reserved.players[1].hiddenTileCount, 3);
  assert.equal(samplingSupport(reserved).supported, false);
  assert.throws(() => sampleWorld(reserved, 'reserved'), /reserved-triplet/);
});

test('rollouts finish through the canonical engine and count kong, win and draw scores exactly once', () => {
  const g = E.newGame({mode:'bots'}, {dealer:0}, seededRandom('public-rollout-terminal'));
  g.kongs.push({from:2, to:0, amount:2, why:'historical kong fixture'});
  const o = observationFor(g, 0), world = sampleWorld(o, 'terminal-world');
  const action = h0(o, legalActionsFor(g, 0)), snapshot = structuredClone(world);
  const actual = simulateToEnd(world, action, 0);
  assert.equal(actual.score, actual.kongScore + actual.huScore + actual.drawScore);
  assert.ok(actual.decisions > 0 && actual.decisions < 500);
  assert.deepEqual(simulateToEnd(world, action, 0), actual);
  assert.deepEqual(world, snapshot);
  const withoutLedger = structuredClone(world); withoutLedger.kongs = [];
  assert.equal(actual.score - simulateToEnd(withoutLedger, action, 0).score, 2);
  assert.throws(() => simulateToEnd(world, action, 0, {maxActions:1}), /action limit/);
});

test('paired score rule requires positive net gain, preserves H0 on ties and can penalize noisy estimates', () => {
  const worlds = [{baseline:{score:0}, alternative:{score:4}}, {baseline:{score:0}, alternative:{score:-2}}];
  assert.equal(comparePairedScores(worlds, 0).chooseAlternative, true);
  assert.equal(comparePairedScores(worlds, 1).chooseAlternative, false);
  assert.deepEqual(comparePairedScores(worlds, 1), {mean:1, standardError:3, margin:-2, chooseAlternative:false});
  assert.equal(comparePairedScores([{baseline:{score:1}, alternative:{score:1}}, {baseline:{score:2}, alternative:{score:2}}]).chooseAlternative, false);
  assert.throws(() => normalizeSearchConfig({worlds:1}), /Invalid/);
  assert.throws(() => normalizeSearchConfig({unknown:true}), /Unknown/);
});

test('net-score search is public, deterministic, paired and limited to one search per policy hand', () => {
  const {o, legal} = disagreementFixture(), config = {worlds:2};
  const a = analyzeNetScore(o, legal, config), b = analyzeNetScore(o, legal, config);
  assert.equal(a.searched, true); assert.deepEqual(a, b);
  assert.equal(a.worlds.length, 2);
  assert.ok(legal.some(action => actionKey(action) === actionKey(a.action)));
  assert.equal(a.comparison.mean, a.worlds.reduce((s, w) => s + w.alternative.score - w.baseline.score, 0) / 2);
  for (const w of a.worlds) {
    const world = sampleWorld(o, w.seed);
    assert.deepEqual(simulateToEnd(world, a.baseline, o.seat, {opponentIds:w.opponentIds}), w.baseline);
    assert.deepEqual(simulateToEnd(world, a.alternative, o.seat, {opponentIds:w.opponentIds}), w.alternative);
  }
  const mixed = analyzeNetScore(o, legal, {worlds:4, opponentModel:'mixed'});
  assert.deepEqual(mixed.worlds.map(w => w.opponentIds), [['H0', 'H0'], ['H0', 'greedy-speed-v1'], ['H0', 'H0'], ['greedy-speed-v1', 'H0']]);
  assert.deepEqual(mixed.worlds.slice(0, 2).map(w => w.seed), a.worlds.map(w => w.seed));
  for (const w of mixed.worlds) assert.deepEqual(simulateToEnd(sampleWorld(o, w.seed), mixed.alternative, o.seat,
    {opponentIds:w.opponentIds}), w.alternative);
  let searched = 0;
  const select = netScoreFactory(config, r => searched += Number(r.searched))();
  assert.deepEqual(select(o, legal), a.action);
  assert.deepEqual(select(o, legal), h0(o, legal)); assert.equal(searched, 1);
});

test('complete games with sampled-net policies produce legal reproducible settlements', () => {
  let searches = 0;
  for (let seed = 0; seed < 4; seed++) {
    const env = new MahjongEnvironment({seed:`public-rollout-full-${seed}`});
    const count = [0, 0, 0];
    const policies = [0, 1, 2].map(seat => netScoreFactory({worlds:2}, r => {
      if (r.searched) { searches++; count[seat]++; }
    })());
    while (!env.done) env.step(policies[env.actor](env.observation(), env.legalActions()));
    assert.ok(count.every(n => n <= 1));
    assert.deepEqual(replayEpisode(env.replay()), env.result());
  }
  assert.ok(searches > 0);
});
