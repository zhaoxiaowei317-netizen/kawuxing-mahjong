import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {FEATURE_SIZE, CONTEXT_SIZE, FEATURE_NAMES, encodeCandidates, handEfficiency} from '../ai/action-scorer/features.mjs';
import {ActionScorer} from '../ai/action-scorer/model.mjs';
import {saveScorer, loadScorer, scorerChoice} from '../ai/action-scorer/io.mjs';
import {MahjongEnvironment, observationFor, replayEpisode} from '../ai/environment.mjs';
import {parseHand, counts, distance, newGame} from '../src/engine.js';
import {selectAction as h0} from '../ai/policies/h0.mjs';
import {seededRandom} from '../ai/random.mjs';
import {actionId} from '../ai/training/encoding.mjs';

const sample = (extra={}) => ({context:Array.from({length:CONTEXT_SIZE}, (_, i) => (i - 3) / 10),
  candidates:[0, 5, 87].map((id, a) => ({id, values:Array.from({length:FEATURE_SIZE}, (_, j) => Math.sin((a + 1) * (j + 1)))})),
  actionId:5, ...extra});
function gradients(kind, extra={}, options={}) {
  const model = new ActionScorer('gradient'), data = [sample(extra)];
  const exact = model.lossAndGradients(data, kind, options).gradients;
  for (let i = 0; i < model.parameters.length; i++) {
    const old = model.parameters[i], eps = 1e-6;
    model.parameters[i] = old + eps; const plus = model.lossAndGradients(data, kind, options).loss;
    model.parameters[i] = old - eps; const minus = model.lossAndGradients(data, kind, options).loss;
    model.parameters[i] = old;
    assert.ok(Math.abs(exact[i] - (plus - minus) / (2 * eps)) < 2e-6, `${kind} gradient ${i}`);
  }
}
test('shared scorer BC and entropy gradients agree with finite differences', () => gradients('bc', {}, {entropyCoef:0.13}));
test('shared scorer PPO actor, entropy and critic gradients agree with finite differences', () => {
  gradients('ppo', {oldLogProb:Math.log(1 / 3), advantage:0.8, return:1.2}, {entropyCoef:0.07, valueCoef:0.4});
  gradients('ppo', {oldLogProb:Math.log(1 / 3), advantage:-0.8, return:-0.4}, {entropyCoef:0.07});
});
test('shared scorer PPO clips positive and negative advantages on the correct side', () => {
  const model = new ActionScorer(), s = sample();
  const q = model.forward(s).logProbs[1];
  for (const [advantage, ratio, clipped] of [[2, 1.4, true], [-2, 0.7, true], [2, 0.7, false], [-2, 1.4, false]]) {
    const loss = model.lossAndGradients([{...s, oldLogProb:q - Math.log(ratio), advantage, return:0}], 'ppo', {valueCoef:0});
    assert.equal(loss.gradients.every(x => x === 0), clipped);
  }
});
test('shared scorer exact Adam resume and gradient clipping', () => {
  const model = new ActionScorer('resume'), samples = [sample(), sample({actionId:0})];
  model.update(samples, {maxGradNorm:0.0001});
  assert.ok(Math.abs(Math.hypot(...model.optimizer.m) - 0.00001) < 1e-12);
  const restored = ActionScorer.fromJSON(JSON.parse(JSON.stringify(model)));
  model.update(samples, {epochs:3}); restored.update(samples, {epochs:3});
  assert.deepEqual(restored.toJSON(), model.toJSON());
});
test('shared scorer rejects illegal target, duplicate IDs and nonfinite data before changing weights', () => {
  const model = new ActionScorer(), before = model.toJSON(), s = sample();
  assert.throws(() => model.update([s, {...s, actionId:88}], {batchSize:1}), /Illegal target/);
  assert.deepEqual(model.toJSON(), before);
  assert.throws(() => model.forward({...s, candidates:[s.candidates[0], s.candidates[0]]}), /candidate ID/);
  s.context[0] = Infinity; assert.throws(() => model.forward(s), /numeric vector/);
  before.optimizer.v[0] = -1; assert.throws(() => ActionScorer.fromJSON(before), /variance/);
});
test('shared scorer learns a toy choice and singleton actions have no policy gradient', () => {
  const model = new ActionScorer(), s = sample(), before = model.lossAndGradients([s]).loss;
  model.update([s], {epochs:80, learningRate:0.03});
  assert.ok(model.lossAndGradients([s]).loss < before * 0.03);
  const only = {...s, candidates:[s.candidates[1]]};
  assert.equal(model.forward(only).probs[0], 1);
  assert.ok(model.lossAndGradients([only], 'bc', {entropyCoef:1}).gradients.every(x => x === 0));
});
test('candidate features ignore hidden opponents and wall ordering', () => {
  const state = newGame({mode:'bots'}, {dealer:0}, seededRandom('candidate-privacy'));
  const env = new MahjongEnvironment({initialState:state}), legal = env.legalActions();
  const first = encodeCandidates(observationFor(state, 0), legal);
  [state.players[1].hand[0], state.wall[0]] = [state.wall[0], state.players[1].hand[0]];
  state.players[2].hand.reverse(); state.wall.reverse();
  assert.deepEqual(encodeCandidates(observationFor(state, 0), legal), first);
});
test('efficiency counts public unseen waits without reading the wall', () => {
  const hand = parseHand('p123456789s123z5'), visible = counts(hand);
  const first = handEfficiency(hand, [], visible);
  assert.equal(first.distance, 0); assert.equal(first.readyOuts, 3); assert.equal(first.waitKinds, 1);
  assert.equal(handEfficiency(hand, [], {...visible, z5:4}).readyOuts, 0);
});
test('peng features include the best structural post-peng discard', () => {
  const env = new MahjongEnvironment({seed:'peng-structural'}), o = structuredClone(env.observation());
  o.players[o.seat].hand = parseHand('p1123456s123z556'); o.players[o.seat].melds = [];
  o.pending = {tile:'p1'}; o.visibleCounts = counts(o.players[o.seat].hand); o.visibleCounts.p1++;
  const encoded = encodeCandidates(o, [{type:'peng'}, {type:'pass'}]);
  const hand = parseHand('p23456s123z556'), melds = [{kind:'peng', tile:'p1'}];
  const best = Math.min(...hand.map((_, i) => distance(hand.filter((_, j) => i !== j), melds)));
  const peng = encoded.candidates.find(c => c.id === 85);
  assert.equal(peng.values[FEATURE_NAMES.indexOf('negativeDistance')], -best / 6);
});
test('candidate action IDs and features remain finite over complete legal games with replay', () => {
  const model = new ActionScorer('legal-smoke'); let decisions = 0;
  for (let i = 0; i < 5; i++) {
    const env = new MahjongEnvironment({seed:`candidate-game-${i}`}), rng = seededRandom(`policy-${i}`);
    while (!env.done) {
      const o = env.observation(), legal = env.legalActions(), encoded = encodeCandidates(o, legal);
      assert.deepEqual(encoded.candidates.map(c => c.id), legal.map(actionId).sort((a, b) => a - b));
      assert.ok(encoded.candidates.every(c => c.values.length === FEATURE_SIZE && c.values.every(Number.isFinite)));
      env.step(i < 3 ? h0(o, legal) : scorerChoice(model, o, legal, rng, false).action); decisions++;
    }
    assert.deepEqual(replayEpisode(env.replay()), env.result());
  }
  assert.ok(decisions > 100);
});
test('scorer checkpoints reload identical decisions and reject mismatched features', () => {
  mkdirSync('.tmp', {recursive:true});
  const dir = mkdtempSync(join('.tmp', 'kwx-scorer-')), path = join(dir, 'model.json'), model = new ActionScorer();
  model.update([sample()], {epochs:2}); saveScorer(path, model, {test:true});
  assert.deepEqual(loadScorer(path).model.toJSON(), model.toJSON());
  const data = JSON.parse(readFileSync(path)); data.sourceHashes['ai/action-scorer/features.mjs'] = 'corrupt';
  writeFileSync(path, JSON.stringify(data)); assert.throws(() => loadScorer(path), /source mismatch/);
});
