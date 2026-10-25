import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {ActorCritic} from '../ai/training/network.mjs';
import {INPUT_SIZE, ACTION_SIZE, actionId, encodeObservation, legalActionIds} from '../ai/training/encoding.mjs';
import {collectImitation, collectRollout, normalizeAdvantages} from '../ai/training/collector.mjs';
import {chooseModelAction, modelPolicyFactory} from '../ai/training/policy.mjs';
import {loadCheckpoint, saveCheckpoint, makeCheckpoint} from '../ai/training/checkpoint.mjs';
import {runTraining} from '../ai/training/trainer.mjs';
import {MahjongEnvironment} from '../ai/environment.mjs';
import {deriveSeed, seededRandom} from '../ai/random.mjs';
import {policyById} from '../ai/policies/index.mjs';
import {runEvaluation} from '../ai/runner.mjs';
import {imitationDiagnostics} from '../ai/training/diagnostics.mjs';

mkdirSync(resolve('.tmp'), {recursive:true});
const root = mkdtempSync(resolve('.tmp', 'kwx-training-tests-'));
const small = {seed:'training-test', hiddenSize:4, bcEpisodes:2, bcEpochs:1, episodesPerIteration:2,
  ppoEpochs:1, batchSize:64, evalEvery:0, selfPlayFraction:0.5};
const network = seed => new ActorCritic({inputSize:INPUT_SIZE, actionSize:ACTION_SIZE, hiddenSize:4, seed});

test('weight initialization copies all weights but resets optimizer and records lineage', async () => {
  const first = await runTraining({out:resolve(root, 'initial-teacher'), config:small, iterations:0});
  const config = {...small, bcEpisodes:0, learningRate:0.0001, seed:'new-experiment'};
  const next = await runTraining({out:resolve(root, 'initialized'), config, iterations:0, initializeFrom:first.finalCheckpoint.path});
  const a = loadCheckpoint(first.finalCheckpoint.path), b = loadCheckpoint(next.finalCheckpoint.path);
  assert.deepEqual(a.model.toJSON().parameters, b.model.toJSON().parameters);
  assert.ok(a.model.optimizer.step > 0); assert.equal(b.model.optimizer.step, 0);
  assert.equal(b.checkpoint.training.initialization.sha256, first.finalCheckpoint.sha256);
  assert.equal(next.counters.imitationSamples, 0);
  await assert.rejects(runTraining({out:resolve(root, 'bad-both'), config, resume:first.finalCheckpoint.path,
    initializeFrom:first.finalCheckpoint.path}), /mutually exclusive/);
  await assert.rejects(runTraining({out:resolve(root, 'bad-init'), config:small,
    initializeFrom:first.finalCheckpoint.path}), /bcEpisodes=0/);
});

test('imitation diagnostics exclude forced decisions from choice accuracy and separate rare actions', () => {
  const model = {forward:(_x, ids) => ({probs:Object.fromEntries(ids.map(id => [id, id === 0 ? 0.8 : 0.2])),
    logProbs:Object.fromEntries(ids.map(id => [id, Math.log(id === 0 ? 0.8 : 0.2)]))})};
  const result = imitationDiagnostics(model, [
    {features:[], legalIds:[87], actionId:87}, {features:[], legalIds:[0, 84], actionId:84},
    {features:[], legalIds:[0, 1], actionId:0}]);
  assert.equal(result.accuracy, 2 / 3); assert.equal(result.choiceAccuracy, 0.5);
  assert.equal(result.categories.hu.accuracy, 0); assert.equal(result.categories.pass.choiceAccuracy, null);
});

test('imitation collects exactly the legal H0 decisions from its own observation', async () => {
  const seed = 'teacher-check', result = await collectImitation({episodes:1, seed});
  const env = new MahjongEnvironment({seed:deriveSeed('training', seed, 'imitation', 0), record:false});
  const teacher = policyById('H0'); let index = 0;
  while (!env.done) {
    const o = env.observation(), legal = env.legalActions(), action = teacher(o, legal);
    assert.deepEqual(result.samples[index++], {features:encodeObservation(o), legalIds:legalActionIds(legal), actionId:actionId(action)});
    env.step(action);
  }
  assert.equal(index, result.samples.length);
});

test('rollouts are on-policy and reward only settled net score, once per learner trajectory', async () => {
  const model = network('reward-check'), episodes = 3, seed = 'reward-check';
  const data = await collectRollout({model, episodes, seed, iteration:1, selfPlayFraction:1, rewardScale:16});
  const targets = new Map();
  for (const sample of data.samples) {
    const out = model.forward(sample.features, sample.legalIds);
    assert.equal(sample.oldLogProb, out.logProbs[sample.actionId]);
    assert.equal(sample.oldValue, out.value);
    assert.equal(sample.advantage, sample.return - sample.oldValue);
    const key = `${sample.episode}-${sample.seat}`;
    if (targets.has(key)) assert.equal(sample.return, targets.get(key)); else targets.set(key, sample.return);
    assert.ok(sample.legalIds.includes(sample.actionId));
  }
  for (let episode = 0; episode < episodes; episode++)
    assert.equal([0, 1, 2].reduce((sum, seat) => sum + targets.get(`${episode}-${seat}`), 0), 0);
  assert.equal(data.stats.learnerHands, 9); assert.equal(data.stats.learnerScore, 0);
  const mixed = await collectRollout({model, episodes:1, seed, iteration:1, selfPlayFraction:0,
    opponents:[{id:'greedy-speed-v1', select:policyById('greedy-speed-v1')}]});
  assert.equal(mixed.stats.learnerHands, 1);
  assert.equal(new Set(mixed.samples.map(s => s.seat)).size, 1);
  const normalized = normalizeAdvantages(data.samples);
  assert.ok(Math.abs(normalized.samples.reduce((sum, s) => sum + s.advantage / data.samples.length, 0)) < 1e-10);
});

test('checkpoint reload reproduces legal inference and rejects incompatible metadata/weights', () => {
  const model = network('checkpoint'), env = new MahjongEnvironment({seed:'checkpoint'});
  const training = {config:small, counters:{learnerDecisions:0}}, file = resolve(root, 'model.json');
  const checkpoint = makeCheckpoint(model, training, {kind:'snapshot'});
  saveCheckpoint(file, checkpoint);
  const loaded = loadCheckpoint(file);
  const first = chooseModelAction(model, env.observation(), env.legalActions(), seededRandom('a'));
  const second = chooseModelAction(loaded.model, env.observation(), env.legalActions(), seededRandom('a'));
  assert.deepEqual(first, second);
  assert.throws(() => saveCheckpoint(file, checkpoint), /overwrite/);
  assert.throws(() => loadCheckpoint(file, {forResume:true}), /Only a training/);
  for (const field of ['encodingVersion', 'rulesVersion']) {
    const invalid = structuredClone(checkpoint); invalid[field] = 'wrong';
    const bad = resolve(root, `${field}.json`); writeFileSync(bad, JSON.stringify(invalid));
    assert.throws(() => loadCheckpoint(bad), /Incompatible/);
  }
  for (const dependency of ['ai/environment.mjs', 'ai/training/network.mjs', 'ai/training/policy.mjs']) {
    const invalid = structuredClone(checkpoint); invalid.provenance.sourceHashes[dependency] = 'changed';
    const bad = resolve(root, dependency.replaceAll('/', '-') + '.json'); writeFileSync(bad, JSON.stringify(invalid));
    assert.throws(() => loadCheckpoint(bad), /source mismatch/);
  }
});

test('16-hand training rollouts retain real dealer transitions and assign table return once', async () => {
  const totals = [0, 0, 0]; let nextDealer = null, hands = 0;
  const data = await collectRollout({model:network('table-training'), episodes:1, sessionHands:16,
    seed:'table-training', iteration:1, selfPlayFraction:1, onHand:({hand, dealer, result, totals:actual}) => {
      if (nextDealer !== null) { assert.equal(dealer, nextDealer); assert.equal(result.round, hand + 1); }
      nextDealer = result.next.dealer; hands++;
      result.delta.forEach((v, i) => totals[i] += v);
      assert.deepEqual(actual, totals);
    }});
  assert.equal(hands, 16); assert.equal(data.stats.hands, 16); assert.equal(data.stats.learnerHands, 48);
  assert.equal(data.stats.learnerScore, 0);
  for (const sample of data.samples) assert.equal(sample.return, totals[sample.seat] / 16);
  assert.equal(new Set(data.samples.map(s => s.hand)).size, 16);
});

test('uninterrupted and checkpoint-resumed training produce exactly the same weights and Adam state', async () => {
  const whole = await runTraining({out:resolve(root, 'whole'), config:small, iterations:2});
  const first = await runTraining({out:resolve(root, 'first'), config:small, iterations:1});
  const resumed = await runTraining({out:resolve(root, 'resumed'), resume:first.finalCheckpoint.path, iterations:2});
  const a = loadCheckpoint(whole.finalCheckpoint.path), b = loadCheckpoint(resumed.finalCheckpoint.path);
  assert.deepEqual(a.model.toJSON(), b.model.toJSON());
  assert.deepEqual(whole.counters, resumed.counters);
  assert.deepEqual(whole.history, resumed.history);
  assert.equal(resumed.iteration, 2); assert.equal(resumed.history.filter(x => x.phase === 'imitation').length, 1);
  assert.ok(whole.changedParameters);
  assert.notEqual(whole.history[0].parameterHashBefore, whole.history[0].parameterHashAfter);
  assert.ok(whole.history.filter(h => h.phase === 'ppo').every(h => h.parameterHashBefore !== h.parameterHashAfter));
  assert.equal(JSON.parse(readFileSync(resolve(root, 'whole/latest.json'), 'utf8')).sha256, whole.finalCheckpoint.sha256);
  assert.equal(a.checkpoint.training.league.length, 3);
  const id = 'trained-model';
  const evaluation = await runEvaluation({candidate:id, incumbent:id, policyFactories:{[id]:modelPolicyFactory(a.model)},
    independentGroups:1, sessionGroups:0, bootstrapSamples:20,
    opponentPairs:[{id:'model-evaluation', policies:['greedy-speed-v1', 'greedy-speed-v1']}]});
  assert.equal(evaluation.illegalActions, 0);
  assert.equal(evaluation.statistics.independent.overall.deltaPer100, 0);
  await assert.rejects(runTraining({out:resolve(root, 'whole'), iterations:3}), /empty\/new/);
  await assert.rejects(runTraining({out:resolve(root, 'invalid-resume'), config:{learningRate:0.1},
    iterations:3, resume:first.finalCheckpoint.path}), /Cannot change/);
});
