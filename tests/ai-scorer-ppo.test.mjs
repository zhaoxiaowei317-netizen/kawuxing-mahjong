import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {AnchoredScorer} from '../ai/action-scorer/anchored.mjs';
import {ActionScorer} from '../ai/action-scorer/model.mjs';
import {FEATURE_SIZE, CONTEXT_SIZE} from '../ai/action-scorer/features.mjs';
import {saveScorer, loadScorer} from '../ai/action-scorer/io.mjs';
import {collectScorerRollout} from '../ai/action-scorer/rollout.mjs';
import {trainScorer, normalizeConfig} from '../ai/action-scorer/train.mjs';
import {comparePolicy} from '../ai/action-scorer/policy-shift.mjs';

const sample = () => ({context:Array.from({length:CONTEXT_SIZE}, (_, i) => i / 10),
  candidates:[0, 3, 87].map((id, a) => ({id, values:Array.from({length:FEATURE_SIZE}, (_, j) => Math.cos((a + 1) * (j + 1)))})),
  actionId:3, teacherActionId:87, oldLogProb:Math.log(1 / 3), advantage:0.7, return:1.2});
test('policy-shift diagnosis computes categorical KL and excludes forced decisions', () => {
  const a = new ActionScorer(), b = new ActionScorer(); a.parameters.fill(0); b.parameters.fill(0);
  b.parameters[0] = Math.log(3); b.parameters[FEATURE_SIZE] = 2;
  const s = {context:Array(CONTEXT_SIZE).fill(0), candidates:[0, 1].map(id => ({id,
    values:Array.from({length:FEATURE_SIZE}, (_, i) => i === 0 ? id : 0)}))};
  const r = comparePolicy(a, b, [s, {...s, candidates:[s.candidates[0]]}]);
  assert.equal(r.choices, 1); assert.equal(r.changes, 1); assert.equal(r.changedChoiceRate, 1);
  assert.ok(Math.abs(r.meanParentToCandidateKl - 0.5 * Math.log(4 / 3)) < 1e-12);
  assert.equal(r.valueWeightChangeNorm, 2);
  assert.equal(comparePolicy(a, a, [s]).meanParentToCandidateKl, 0);
});
test('anchored PPO combined gradient agrees with central differences for all parameters', () => {
  const model = new AnchoredScorer('anchor-gradient'), samples = [sample()], options = {bcCoef:0.3, entropyCoef:0.07, valueCoef:0.2};
  const exact = model.lossAndGradients(samples, 'ppo', options).gradients;
  for (let i = 0; i < model.parameters.length; i++) {
    const old = model.parameters[i], eps = 1e-6;
    model.parameters[i] = old + eps; const plus = model.lossAndGradients(samples, 'ppo', options).loss;
    model.parameters[i] = old - eps; const minus = model.lossAndGradients(samples, 'ppo', options).loss;
    model.parameters[i] = old;
    assert.ok(Math.abs(exact[i] - (plus - minus) / (2 * eps)) < 2e-6, `gradient ${i}`);
  }
});
test('zero anchor exactly preserves original PPO and positive anchor still trains a clipped actor', () => {
  const model = new AnchoredScorer('anchor-zero'), base = ActionScorer.fromJSON(model.toJSON()), s = sample();
  assert.deepEqual(model.lossAndGradients([s], 'ppo', {bcCoef:0}).gradients, base.lossAndGradients([s], 'ppo').gradients);
  s.oldLogProb = model.forward(s).logProbs[1] - Math.log(1.4); s.return = 0;
  const clipped = model.lossAndGradients([s], 'ppo', {valueCoef:0});
  assert.ok(clipped.gradients.every(x => x === 0));
  assert.ok(model.lossAndGradients([s], 'ppo', {bcCoef:0.2, valueCoef:0}).gradients.some(x => x !== 0));
  assert.throws(() => model.lossAndGradients([{...s, teacherActionId:88}], 'ppo', {bcCoef:0.2}), /Illegal target/);
});
test('PPO rollout records only learner actions and uses each terminal net reward exactly once', async () => {
  const model = new AnchoredScorer('rollout'), results = [];
  const data = await collectScorerRollout({model, hands:3, seed:'rollout-targets', iteration:1, selfPlayFraction:0,
    rewardScale:16, onHand:h => results.push(h)});
  assert.equal(data.stats.learnerHands, 3); assert.equal(data.stats.H0Hands, 3); assert.equal(data.stats.selfPlayHands, 0);
  assert.ok(data.samples.length > 0 && data.samples.length < data.stats.environmentDecisions);
  for (const s of data.samples) {
    assert.equal(s.seat, results[s.hand].learnerSeat);
    assert.equal(s.return, results[s.hand].result.delta[s.seat] / 16);
    assert.equal(s.advantage, s.return - s.oldValue);
    assert.ok(s.candidates.some(c => c.id === s.teacherActionId));
    assert.equal(s.oldLogProb, model.forward(s).logProbs[s.candidates.findIndex(c => c.id === s.actionId)]);
  }
  const self = await collectScorerRollout({model, hands:2, seed:'rollout-self', iteration:1, selfPlayFraction:1});
  assert.equal(self.stats.learnerHands, 6); assert.equal(self.stats.learnerScore, 0);
  assert.equal(self.stats.learnerDecisions, self.stats.environmentDecisions);
});
test('scorer trainer validates config and preserves exact resumed parameters, Adam and history', async () => {
  for (const c of [{unknown:1}, {clipRatio:1}, {selfPlayFraction:2}, {bcCoef:-1}, {targetKl:0}]) assert.throws(() => normalizeConfig(c));
  mkdirSync('.tmp', {recursive:true}); const dir = mkdtempSync(join('.tmp', 'scorer-ppo-'));
  const parent = join(dir, 'parent.json'); saveScorer(parent, new ActionScorer('parent'));
  const config = {seed:'resume-scorer-test', handsPerIteration:3, batchSize:8, epochs:2};
  const whole = await trainScorer({out:join(dir, 'whole'), initializeFrom:parent, iterations:2, config});
  const first = await trainScorer({out:join(dir, 'first'), initializeFrom:parent, iterations:1, config});
  const resumed = await trainScorer({out:join(dir, 'resumed'), resume:first.finalCheckpoint.path, iterations:2, config});
  assert.deepEqual(loadScorer(whole.finalCheckpoint.path).model.toJSON(), loadScorer(resumed.finalCheckpoint.path).model.toJSON());
  assert.deepEqual(whole.history, resumed.history); assert.deepEqual(whole.counters, resumed.counters);
  assert.equal(whole.counters.hands, 6);
  await assert.rejects(() => trainScorer({out:join(dir, 'invalid'), resume:first.finalCheckpoint.path, iterations:2, config:{...config, bcCoef:0}}), /Incompatible exact/);
  const corrupt = JSON.parse(readFileSync(first.finalCheckpoint.path)); corrupt.metadata.training.counters.hands = 999;
  const corruptPath = join(dir, 'corrupt.json'); writeFileSync(corruptPath, JSON.stringify(corrupt));
  await assert.rejects(() => trainScorer({out:join(dir, 'invalid-counter'), resume:corruptPath, iterations:2, config}), /Incompatible exact/);
});
