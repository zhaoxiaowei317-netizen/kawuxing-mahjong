import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import {MahjongEnvironment, observationFor, legalActionsFor, replayEpisode, actingSeat,
  assertConservation, actionKey} from '../ai/environment.mjs';
import {selectAction as h0} from '../ai/policies/h0.mjs';
import {seededRandom, deriveSeed} from '../ai/random.mjs';
import {runEvaluation, playEpisode, SEAT_PERMUTATIONS} from '../ai/runner.mjs';
import {verifyFrozenBaseline} from '../ai/provenance.mjs';

const stable = value => JSON.parse(JSON.stringify(value, (key, v) => ['id', 'endedAt'].includes(key) ? undefined : v));
function fixture(hands, melds=[[], [], []]) {
  const g = E.newGame({mode:'bots'}, {dealer:0}, seededRandom('fixture'));
  g.players.forEach((p, i) => { p.hand = E.parseHand(hands[i]); p.melds = melds[i]; });
  const used = E.counts(g.players.flatMap(p => [...p.hand,
    ...p.melds.flatMap(m => Array(m.kind === 'peng' ? 3 : 4).fill(m.tile))]));
  assert.ok(Object.values(used).every(n => n <= 4));
  g.wall = E.TYPES.flatMap(t => Array(4 - (used[t] || 0)).fill(t));
  g.drawTile = g.players[0].hand.at(-1);
  assertConservation(g); return g;
}

test('frozen H0 rule helpers and dependency hashes match registered snapshot', () => {
  assert.equal(verifyFrozenBaseline().id, 'H0');
});

test('H0 adapter matches existing companion action for action across full games', () => {
  for (let seed = 0; seed < 12; seed++) {
    const env = new MahjongEnvironment({seed:`h0-equivalence-${seed}`});
    let decisions = 0;
    while (!env.done) {
      assert.ok(++decisions < 500);
      const original = env.auditState(), seat = env.actor;
      const action = h0(env.observation(), env.legalActions());
      E.botStep(original, seat); env.step(action);
      assert.deepEqual(stable(env.auditState()), stable(original), `seed ${seed}, decision ${decisions}`);
    }
  }
});

test('observation excludes hidden identities, state, sorted positions and pending intentions', () => {
  const g = E.newGame({mode:'bots'}, {dealer:0}, seededRandom('privacy'));
  g.lastDiscard = {seat:2, tile:'z5', serial:1, index:0, handIndex:7};
  g.players[1].hand = E.parseHand('p111s123456789z5');
  Object.assign(g.players[1], {liang:true, liangKongTiles:['p1'], publicWaits:[{tile:'z5'}]});
  g.phase = 'react'; g.pending = {tile:'p5', source:2, responses:{1:'hu'}};
  const first = observationFor(g, 0), legal = legalActionsFor(g, 0);
  g.players[1].hand = E.parseHand('p222s123456789z5').reverse(); g.players[1].liangKongTiles = ['p2'];
  g.players[1].dealHand = ['p9']; g.players[1].passedHu = ['s1']; g.players[1].passedPeng = ['s2'];
  g.players[1].buOpportunities = ['z6']; g.players[2].hand.reverse(); g.wall.reverse();
  g.wallState = {front:999}; g.lastDiscard.handIndex = 1; g.pending.responses = {1:'pass'};
  assert.deepEqual(observationFor(g, 0), first);
  assert.deepEqual(legalActionsFor(g, 0), legal);
  assert.equal(first.players[1].hiddenTileCount, 3);
  assert.equal(first.players[1].hand, undefined);
  for (const key of ['wall', 'wallState', 'dealHand', 'responses', 'handIndex', 'liangKongTiles'])
    assert.ok(!JSON.stringify(first).includes(`"${key}"`), key);
  assert.deepEqual(h0(first, legal), h0(observationFor(g, 0), legalActionsFor(g, 0)));
  assert.throws(() => { first.players[0].hand.pop(); }, TypeError);
});

test('legal discards merge equal tiles; public danger restriction and forced reveal draw remain binding', () => {
  const g = E.newGame({mode:'bots'}, {dealer:0}, seededRandom('danger'));
  g.players[0].hand = E.parseHand('p1123456s123z5567'); g.drawTile = 'z7';
  g.players[1].liang = true; g.players[1].publicWaits = [{tile:'p1'}];
  const legal = legalActionsFor(g, 0);
  assert.ok(legal.every(a => a.type !== 'discard' || a.tile !== 'p1'));
  assert.equal(new Set(legal.map(actionKey)).size, legal.length);
  g.players[0].liang = true;
  assert.deepEqual(legalActionsFor(g, 0).filter(a => a.type === 'discard'), [{type:'discard', tile:'z7', reveal:false}]);
});

test('illegal or extra-field actions cannot mutate environment; property order does not matter', () => {
  const env = new MahjongEnvironment({seed:'invalid-action'}), before = env.auditState();
  assert.throws(() => env.step({type:'discard', tile:'?', reveal:false}), /Illegal action/);
  assert.deepEqual(env.auditState(), before);
  const legal = env.legalActions().find(a => a.type === 'discard');
  assert.throws(() => env.step({...legal, leaked:true}), /Illegal action/);
  assert.deepEqual(env.auditState(), before);
  env.step({reveal:legal.reveal, tile:legal.tile, type:'discard'});
});

test('pending supplement and double ron replay with all 84 tiles and one terminal reward', () => {
  const g = fixture(['p3789s23467z55', 'p12s123456789z77', 'p12s123456789z77'],
    [[{kind:'peng', tile:'p3'}], [], []]);
  g.drawTile = 'p3';
  const env = new MahjongEnvironment({initialState:g});
  assert.ok(env.legalActions().some(a => a.type === 'kong' && a.kind === 'bu'));
  assert.deepEqual(env.step({type:'kong', tile:'p3', kind:'bu'}).reward, [0, 0, 0]);
  assert.equal(env.observation().pending.kind, 'robKong');
  assert.deepEqual(env.step({type:'hu'}).reward, [0, 0, 0]);
  const terminal = env.step({type:'hu'});
  assert.equal(terminal.done, true); assert.deepEqual(terminal.reward, [-4, 2, 2]);
  assert.deepEqual(env.result().winners, [1, 2]);
  assert.deepEqual(replayEpisode(env.replay()), env.result());
  const tampered = env.replay(); tampered.result.delta[0] = 999;
  assert.throws(() => replayEpisode(tampered), /Replay result mismatch/);
  assert.throws(() => env.step({type:'hu'}), /already ended/);
});

test('full audit replay reproduces settlement and seed streams are independent', () => {
  const env = new MahjongEnvironment({seed:'replay-test'});
  playEpisode({env, policyIds:['H0', 'random-legal-v1', 'greedy-speed-v1'],
    policySeeds:['a', 'b', 'c']});
  assert.deepEqual(replayEpisode(env.replay()), env.result());
  const a = seededRandom(deriveSeed('group', 'policy', 'P')), b = seededRandom(deriveSeed('group', 'policy', 'P'));
  const c = seededRandom(deriveSeed('group', 'policy', 'C'));
  for (let i = 0; i < 20; i++) { c(200); c(200); assert.equal(a(84), b(84)); }
  const first = new MahjongEnvironment({seed:'same'}), second = new MahjongEnvironment({seed:'same'});
  assert.deepEqual(first.auditState(), second.auditState());
});

test('all six seats balance each role; same policy has exact zero paired difference in both suites', async () => {
  assert.equal(new Set(SEAT_PERMUTATIONS.map(x => x.join(''))).size, 6);
  for (const role of ['C', 'P', 'Q']) for (const seat of [0, 1, 2])
    assert.equal(SEAT_PERMUTATIONS.filter(p => p[seat] === role).length, 2);
  const openings = new Map(); let replayCount = 0;
  const report = await runEvaluation({candidate:'random-legal-v1', incumbent:'random-legal-v1', seed:'paired-control',
    independentGroups:2, sessionGroups:1, sessionHands:3, bootstrapSamples:100,
    opponentPairs:[{id:'test-H0-greedy', policies:['H0', 'greedy-speed-v1']}],
    onEpisode:episode => {
      replayCount++;
      const {replay, suite, group, permutation, arm, hand} = episode;
      const key = JSON.stringify([suite, group, permutation, hand]);
      if (arm === 'candidate') openings.set(key, stable(replay.initialState));
      else assert.deepEqual(stable(replay.initialState), openings.get(key));
      if (hand > 0) assert.equal(replay.initialState.round, hand + 1);
    }});
  assert.equal(report.totalGames, 60); assert.equal(replayCount, 60);
  for (const suite of ['independent', 'session']) {
    assert.equal(report.statistics[suite].overall.deltaPer100, 0);
    assert.deepEqual(report.statistics[suite].overall.ci95, [0, 0]);
  }
  for (const record of report.records) assert.deepEqual(record.candidate, record.incumbent);
  assert.equal(report.illegalActions, 0);
});

test('continuous sessions use actual next dealer and keyed hand random streams', async () => {
  const preceding = new Map();
  await runEvaluation({seed:'dealer-continuation', independentGroups:0, sessionGroups:1, sessionHands:4,
    bootstrapSamples:20, opponentPairs:[{id:'smoke', policies:['random-legal-v1', 'random-legal-v1']}],
    onEpisode:({arm, permutation, hand, replay}) => {
      const key = `${arm}-${permutation}`, previous = preceding.get(key);
      if (hand > 0) {
        assert.equal(replay.initialState.dealer, previous.result.next.dealer);
        assert.deepEqual(replay.initialState.totals, previous.totals);
      }
      const totals = replay.initialState.totals.map((v, i) => v + replay.result.delta[i]);
      preceding.set(key, {result:replay.result, totals});
      assert.equal(actingSeat(replay.initialState), replay.initialState.dealer);
    }});
});

test('stateful policy factories isolate seats and paired arms', async () => {
  const instances = [];
  const factory = () => {
    const instance = {calls:0}; instances.push(instance);
    return (_o, actions) => actions[instance.calls++ % actions.length];
  };
  const report = await runEvaluation({candidate:'stateful-test', incumbent:'stateful-test',
    policyFactories:{'stateful-test':factory}, independentGroups:1, sessionGroups:0,
    opponentPairs:[{id:'stateful', policies:['stateful-test', 'stateful-test']}], bootstrapSamples:20});
  assert.equal(instances.length, 36); assert.ok(instances.every(i => i.calls > 0));
  assert.equal(report.statistics.independent.overall.deltaPer100, 0);
  assert.deepEqual(report.records[0].candidate, report.records[0].incumbent);
});

test('invalid evaluation budget is rejected before any episode runs', async () => {
  let played = 0;
  await assert.rejects(runEvaluation({bootstrapSamples:0, onEpisode:() => played++}), /bootstrapSamples/);
  assert.equal(played, 0);
});
