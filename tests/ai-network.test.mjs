import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorCritic, NETWORK_VERSION} from '../ai/training/network.mjs';
import {seededRandom} from '../ai/random.mjs';

const make = (options={}) => new ActorCritic({inputSize:2, hiddenSize:3, actionSize:3, seed:'network-test', ...options});
const sample = (options={}) => ({features:[0.3, -0.4], legalIds:[0, 1], actionId:0, ...options});
function close(actual, expected, tolerance=1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(actual), Math.abs(expected)), `${actual} != ${expected}`);
}
function finiteMetrics(metrics) {
  for (const [key, value] of Object.entries(metrics)) assert.ok(Number.isFinite(value), `${key} must be finite`);
}
function checkGradients(model, samples, kind, options={}) {
  const analytical = model.lossAndGradients(samples, kind, options), epsilon = 1e-6;
  for (const [name, parameters] of Object.entries(model.parameters)) for (let index = 0; index < parameters.length; index++) {
    const original = parameters[index];
    parameters[index] = original + epsilon;
    const plus = model.lossAndGradients(samples, kind, options).loss;
    parameters[index] = original - epsilon;
    const minus = model.lossAndGradients(samples, kind, options).loss;
    parameters[index] = original;
    const numerical = (plus - minus) / (2 * epsilon);
    assert.ok(Math.abs(analytical.gradients[name][index] - numerical) < 2e-6,
      `${kind} ${name}[${index}]: gradient=${analytical.gradients[name][index]}, numerical=${numerical}`);
  }
}
function binaryBiasModel(probability) {
  const model = make({actionSize:88});
  for (const values of Object.values(model.parameters)) values.fill(0);
  model.parameters.policyB[0] = Math.log(probability / (1 - probability));
  return model;
}

test('network initialization is deterministic and parameters are Float64', () => {
  const model = make();
  assert.deepEqual(model.toJSON(), make().toJSON());
  assert.notDeepEqual(model.toJSON().parameters, make({seed:'another-seed'}).toJSON().parameters);
  for (const values of Object.values(model.parameters)) assert.ok(values instanceof Float64Array);
  assert.equal(model.toJSON().version, NETWORK_VERSION);
});

test('masked softmax keeps all illegal actions exactly zero and is numerically stable', () => {
  const model = make({actionSize:88});
  model.parameters.policyB[2] = 10000; model.parameters.policyB[13] = 9999;
  model.parameters.policyB[87] = -10000;
  const result = model.forward(new Float32Array([0.2, 0.4]), [2, 13, 87]);
  assert.equal(result.probs.length, 88); assert.equal(result.logProbs.length, 88);
  close(result.probs.reduce((sum, p) => sum + p, 0), 1);
  assert.ok(Number.isFinite(result.value));
  for (let i = 0; i < 88; i++) {
    if ([2, 13, 87].includes(i)) assert.ok(Number.isFinite(result.logProbs[i]));
    else { assert.equal(result.probs[i], 0); assert.equal(result.logProbs[i], -Infinity); }
  }
});

test('BC backward pass agrees with central differences across every parameter', () => {
  const model = make();
  checkGradients(model, [sample(), sample({features:[-0.2, 0.7], legalIds:[1, 2], actionId:2})], 'bc', {entropyCoef:0.13});
});

test('PPO backward pass includes actor, critic and entropy gradients in the shared layer', () => {
  const model = make();
  const samples = [sample({oldLogProb:Math.log(0.5), advantage:0.8, return:1.3}),
    sample({features:[-0.6, 0.2], legalIds:[0, 1, 2], actionId:2, oldLogProb:Math.log(1 / 3), advantage:-0.6, return:-0.4})];
  checkGradients(model, samples, 'ppo', {entropyCoef:0.07, valueCoef:0.4});
});

test('PPO positive and negative advantages use the correct clipped branches', () => {
  for (const [advantage, ratio, expectedDq] of [[2, 0.7, -1.4], [2, 1, -2], [2, 1.3, 0],
    [-2, 0.7, 0], [-2, 1, 2], [-2, 1.3, 2.6]]) {
    const probability = ratio * 0.5, model = binaryBiasModel(probability);
    const samples = [sample({oldLogProb:Math.log(0.5), advantage, return:0})];
    const options = {clipRatio:0.2, entropyCoef:0, valueCoef:0};
    const result = model.lossAndGradients(samples, 'ppo', options);
    close(result.gradients.policyB[0], expectedDq * (1 - probability));
    close(result.gradients.policyB[1], -expectedDq * (1 - probability));
    close(result.clipFraction, ratio === 1 ? 0 : 1);
    close(result.policySaturation, expectedDq === 0 ? 1 : 0);
    checkGradients(model, samples, 'ppo', options);
  }
});

test('entropy gradient has the correct sign away from the uniform distribution', () => {
  const beta = 0.17;
  for (const probability of [0.2, 0.5, 0.8]) {
    const model = binaryBiasModel(probability), samples = [sample({oldLogProb:Math.log(probability), advantage:0, return:0})];
    const options = {entropyCoef:beta, valueCoef:0};
    const result = model.lossAndGradients(samples, 'ppo', options);
    close(result.gradients.policyB[0], beta * probability * (1 - probability) * Math.log(probability / (1 - probability)));
    close(result.gradients.policyB[1], -result.gradients.policyB[0]);
    checkGradients(model, samples, 'ppo', options);
  }
});

test('one legal action has no actor or entropy gradient', () => {
  const model = make(), result = model.forward([0.2, -0.3], [2]);
  assert.equal(result.probs[2], 1); assert.equal(result.logProbs[2], 0);
  const loss = model.lossAndGradients([sample({legalIds:[2], actionId:2, oldLogProb:0, advantage:3, return:result.value})],
    'ppo', {entropyCoef:1, valueCoef:0});
  assert.equal(loss.entropy, 0);
  for (const values of Object.values(loss.gradients)) assert.ok(values.every(value => value === 0));
});

test('BC optimization learns a separable toy decision task', () => {
  const model = make({hiddenSize:8, actionSize:2});
  const examples = [[1, 0], [0, 1], [-1, 0], [0, -1]].map((features, i) =>
    sample({features, actionId:i < 2 ? 0 : 1}));
  const training = Array.from({length:8}, () => examples).flat();
  const before = model.lossAndGradients(examples, 'bc').loss;
  const metrics = model.bcUpdate(training, {learningRate:0.02, epochs:40, batchSize:8, rng:seededRandom('bc-toy')});
  const after = model.lossAndGradients(examples, 'bc').loss;
  assert.ok(after < before * 0.1, `${before} -> ${after}`);
  for (const example of examples) {
    const probabilities = model.forward(example.features, example.legalIds).probs;
    assert.ok(probabilities[example.actionId] > 0.9);
  }
  assert.equal(metrics.updates, 160); assert.equal(metrics.samplesSeen, 1280);
  finiteMetrics(metrics);
});

test('PPO single-sample updates preserve advantage direction without renormalizing it', () => {
  for (const advantage of [1, -1]) {
    const model = make({actionSize:2}), before = model.forward([0.3, -0.4], [0, 1]);
    const metrics = model.ppoUpdate([sample({oldLogProb:before.logProbs[0], advantage, return:before.value})],
      {learningRate:0.01, epochs:1, entropyCoef:0, valueCoef:0});
    const after = model.forward([0.3, -0.4], [0, 1]);
    assert.ok((after.logProbs[0] - before.logProbs[0]) * advantage > 0);
    finiteMetrics(metrics);
  }
});

test('PPO saturated positive surrogate is constant while entropy can still update it', () => {
  const model = binaryBiasModel(0.8), samples = [sample({oldLogProb:Math.log(0.5), advantage:1, return:0})];
  const before = model.toJSON().parameters;
  model.ppoUpdate(samples, {epochs:1, entropyCoef:0, valueCoef:0});
  assert.deepEqual(model.toJSON().parameters, before);
  model.ppoUpdate(samples, {epochs:1, entropyCoef:0.1, valueCoef:0});
  assert.ok(model.forward([0.3, -0.4], [0, 1]).probs[0] < 0.8);
});

test('critic MSE gradient and update move value toward the specified return', () => {
  const model = binaryBiasModel(0.5); model.parameters.valueB[0] = 0.4;
  const samples = [sample({oldLogProb:Math.log(0.5), advantage:0, return:-0.7})];
  const result = model.lossAndGradients(samples, 'ppo', {entropyCoef:0, valueCoef:0.5});
  close(result.valueLoss, 0.5 * 1.1 ** 2); close(result.gradients.valueB[0], 0.55);
  model.ppoUpdate(samples, {learningRate:0.02, epochs:10, entropyCoef:0, valueCoef:0.5});
  const value = model.forward([0.3, -0.4], [0, 1]).value;
  assert.ok(Math.abs(value + 0.7) < 1.1);
});

test('global gradient clipping scales the complete gradient before Adam', () => {
  const model = make({actionSize:2}), threshold = 0.0001;
  const metrics = model.bcUpdate([sample()], {epochs:1, maxGradNorm:threshold, beta1:0, beta2:0});
  const momentNorm = Math.sqrt(Object.values(model.optimizer.m).flatMap(values => [...values]).reduce((sum, x) => sum + x * x, 0));
  assert.ok(metrics.maxObservedGradNorm > threshold);
  close(momentNorm, threshold, 1e-10); close(metrics.clippedGradNorm, threshold, 1e-10);
});

test('JSON saves complete Adam state and restores subsequent updates exactly', () => {
  const model = make(), training = [sample(), sample({features:[-0.5, 0.8], actionId:1})];
  model.bcUpdate(training, {epochs:3, batchSize:1, beta1:0.8, beta2:0.95, adamEpsilon:1e-7, rng:seededRandom('warmup')});
  const restored = ActorCritic.fromJSON(JSON.parse(JSON.stringify(model.toJSON())));
  assert.deepEqual(model.toJSON(), restored.toJSON());
  const ppo = training.map((example, i) => ({...example, oldLogProb:model.forward(example.features, example.legalIds).logProbs[example.actionId],
    advantage:i ? -0.6 : 0.8, return:i ? -1 : 2}));
  const first = model.ppoUpdate(ppo, {epochs:3, batchSize:1, rng:seededRandom('resume')});
  const second = restored.ppoUpdate(ppo, {epochs:3, batchSize:1, rng:seededRandom('resume')});
  assert.deepEqual(first, second); assert.deepEqual(model.toJSON(), restored.toJSON());
  model.bcUpdate(training); restored.bcUpdate(training);
  assert.deepEqual(model.toJSON(), restored.toJSON(), 'default shuffle stream also resumes exactly');
});

test('invalid observations, masks and actions are rejected before changing weights', () => {
  const model = make(), before = model.toJSON();
  for (const features of [[NaN, 1], [Infinity, 1], [1], ['1', 0]]) assert.throws(() => model.forward(features, [0, 1]));
  for (const legalIds of [[], [0, 0], [-1], [3], [0.1]]) assert.throws(() => model.forward([0, 1], legalIds));
  assert.throws(() => model.bcUpdate([sample({actionId:2})]), /illegal/);
  assert.throws(() => model.bcUpdate([sample(), sample({features:[0, NaN]})]), /finite/);
  for (const name of ['oldLogProb', 'advantage', 'return']) {
    assert.throws(() => model.ppoUpdate([sample({oldLogProb:-0.7, advantage:1, return:0, [name]:NaN})]), /finite/);
  }
  assert.deepEqual(model.toJSON(), before);
});

test('malformed snapshots and invalid Adam moments cannot be restored', () => {
  for (const corrupt of [
    state => { state.parameters.w1.pop(); },
    state => { state.parameters.policyW[0] = NaN; },
    state => { state.optimizer.v.valueB[0] = -1; },
    state => { state.optimizer.m.b1 = []; },
    state => { state.optimizer.step = -1; },
    state => { state.optimizer.beta1 = 1; },
    state => { state.optimizer.beta2Power = 0; },
    state => { state.extra = true; },
    state => { state.config.hiddenSize = 0; },
  ]) {
    const state = make().toJSON(); corrupt(state); assert.throws(() => ActorCritic.fromJSON(state));
  }
});

test('invalid optimization settings fail and empty batches are finite no-ops', () => {
  const model = make(), before = model.toJSON();
  for (const options of [{learningRate:0}, {batchSize:0}, {epochs:0}, {maxGradNorm:Infinity},
    {entropyCoef:-1}, {valueCoef:NaN}, {clipRatio:1}, {beta1:1}, {adamEpsilon:0}, {rng:2}]) {
    assert.throws(() => model.ppoUpdate([sample({oldLogProb:-0.7, advantage:1, return:0})], options));
  }
  assert.throws(() => model.bcUpdate([sample(), sample()], {rng:() => 3}), /shuffle index/);
  const metrics = model.bcUpdate([]);
  finiteMetrics(metrics); assert.equal(metrics.updates, 0); assert.equal(metrics.loss, 0);
  assert.deepEqual(model.toJSON(), before);
});
