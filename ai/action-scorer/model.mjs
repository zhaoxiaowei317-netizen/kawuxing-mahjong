import {seededRandom} from '../random.mjs';
import {FEATURE_SIZE, CONTEXT_SIZE} from './features.mjs';
export const MODEL_VERSION = 'kwx-shared-linear-actor-critic-1';
const SIZE = FEATURE_SIZE + CONTEXT_SIZE;
const finite = x => typeof x === 'number' && Number.isFinite(x);
function vector(x, length) {
  if ((!Array.isArray(x) && !ArrayBuffer.isView(x)) || x.length !== length || !Array.from(x).every(finite))
    throw Error('Invalid numeric vector');
  return x;
}
function validate(sample) {
  vector(sample.context, CONTEXT_SIZE);
  if (!Array.isArray(sample.candidates) || !sample.candidates.length) throw Error('Candidates required');
  const ids = new Set();
  for (const c of sample.candidates) {
    if (!Number.isInteger(c.id) || c.id < 0 || c.id >= 88 || ids.has(c.id)) throw Error('Invalid candidate ID');
    ids.add(c.id); vector(c.values, FEATURE_SIZE);
  }
}
export class ActionScorer {
  constructor(seed='shared-scorer-v1') {
    if (typeof seed !== 'string') throw Error('Seed required');
    this.seed = seed; this.parameters = new Float64Array(SIZE);
    const rng = seededRandom(seed);
    for (let i = 0; i < FEATURE_SIZE; i++) this.parameters[i] = (rng(1000000) / 1000000 - 0.5) * 0.02;
    this.optimizer = {step:0, m:new Float64Array(SIZE), v:new Float64Array(SIZE)};
  }
  forward(sample) {
    validate(sample); vector(this.parameters, SIZE);
    const logits = sample.candidates.map(c => c.values.reduce((sum, x, i) => sum + x * this.parameters[i], 0));
    const max = Math.max(...logits), logZ = Math.log(logits.reduce((sum, x) => sum + Math.exp(x - max), 0));
    const logProbs = logits.map(x => x - max - logZ), probs = logProbs.map(Math.exp);
    const value = sample.context.reduce((sum, x, i) => sum + x * this.parameters[FEATURE_SIZE + i], 0);
    if (![...logProbs, ...probs, value].every(finite)) throw Error('Nonfinite forward result');
    return {ids:sample.candidates.map(c => c.id), probs, logProbs, value};
  }
  lossAndGradients(samples, kind='bc', {clipRatio=0.2, entropyCoef=0, valueCoef=0.5}={}) {
    if (!['bc', 'ppo'].includes(kind) || !Array.isArray(samples) || !samples.length ||
      !finite(clipRatio) || clipRatio <= 0 || clipRatio >= 1 || !finite(entropyCoef) || entropyCoef < 0 || !finite(valueCoef) || valueCoef < 0)
      throw Error('Invalid loss configuration');
    const gradients = new Float64Array(SIZE), n = samples.length;
    let policyLoss = 0, valueLoss = 0, entropy = 0, approxKl = 0;
    for (const sample of samples) {
      const f = this.forward(sample), index = f.ids.indexOf(sample.actionId);
      if (index < 0) throw Error('Illegal target action');
      const q = f.logProbs[index], h = -f.probs.reduce((sum, p, i) => sum + p * f.logProbs[i], 0);
      let dq = -1, pl = -q, dv = 0;
      if (kind === 'ppo') {
        if (![sample.oldLogProb, sample.advantage, sample.return].every(finite) || sample.oldLogProb > 0) throw Error('Invalid PPO target');
        const logRatio = q - sample.oldLogProb, ratio = Math.exp(logRatio);
        const clipped = Math.max(1 - clipRatio, Math.min(1 + clipRatio, ratio));
        const saturated = sample.advantage > 0 && ratio > 1 + clipRatio || sample.advantage < 0 && ratio < 1 - clipRatio;
        dq = saturated ? 0 : -sample.advantage * ratio;
        pl = -Math.min(ratio * sample.advantage, clipped * sample.advantage);
        approxKl += (Math.expm1(logRatio) - logRatio) / n;
        const error = f.value - sample.return; valueLoss += 0.5 * error * error / n; dv = valueCoef * error;
      }
      policyLoss += pl / n; entropy += h / n;
      for (let a = 0; a < f.ids.length; a++) {
        const dz = (dq * (Number(a === index) - f.probs[a]) + entropyCoef * f.probs[a] * (f.logProbs[a] + h)) / n;
        for (let j = 0; j < FEATURE_SIZE; j++) gradients[j] += dz * sample.candidates[a].values[j];
      }
      for (let j = 0; j < CONTEXT_SIZE; j++) gradients[FEATURE_SIZE + j] += dv * sample.context[j] / n;
    }
    const loss = policyLoss + valueCoef * valueLoss - entropyCoef * entropy;
    if (![loss, policyLoss, valueLoss, entropy, approxKl, ...gradients].every(finite)) throw Error('Nonfinite loss/gradient');
    return {loss, policyLoss, valueLoss, entropy, approxKl, gradients};
  }
  update(samples, {kind='bc', epochs=1, batchSize=128, learningRate=0.02, maxGradNorm=1,
    rng=seededRandom(`${this.seed}:${this.optimizer.step}`), ...lossOptions}={}) {
    if (!Number.isSafeInteger(epochs) || epochs < 1 || !Number.isSafeInteger(batchSize) || batchSize < 1 ||
      !finite(learningRate) || learningRate <= 0 || !finite(maxGradNorm) || maxGradNorm <= 0 ||
      typeof rng !== 'function' || !Array.isArray(samples) || !samples.length) throw Error('Invalid update configuration');
    // Validate every target before starting an update, so malformed later samples cannot cause a partial update.
    this.lossAndGradients(samples, kind, lossOptions);
    const result = {loss:0, policyLoss:0, valueLoss:0, entropy:0, approxKl:0, updates:0, samples:samples.length};
    for (let epoch = 0; epoch < epochs; epoch++) {
      const order = samples.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng(i + 1); if (!Number.isInteger(j) || j < 0 || j > i) throw Error('Invalid shuffle RNG');
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let start = 0; start < order.length; start += batchSize) {
        const batch = order.slice(start, start + batchSize).map(i => samples[i]);
        const g = this.lossAndGradients(batch, kind, lossOptions), step = this.optimizer.step + 1;
        const norm = Math.hypot(...g.gradients), scale = Math.min(1, maxGradNorm / (norm || 1));
        const parameters = new Float64Array(SIZE), m = new Float64Array(SIZE), v = new Float64Array(SIZE);
        for (let j = 0; j < SIZE; j++) {
          const gradient = g.gradients[j] * scale;
          m[j] = 0.9 * this.optimizer.m[j] + 0.1 * gradient;
          v[j] = 0.999 * this.optimizer.v[j] + 0.001 * gradient ** 2;
          parameters[j] = this.parameters[j] - learningRate * (m[j] / (1 - 0.9 ** step)) / (Math.sqrt(v[j] / (1 - 0.999 ** step)) + 1e-8);
        }
        if (![...parameters, ...m, ...v].every(finite) || !Number.isSafeInteger(step)) throw Error('Invalid Adam update');
        this.parameters = parameters; this.optimizer = {step, m, v};
        const weight = batch.length / samples.length / epochs;
        for (const key of ['loss', 'policyLoss', 'valueLoss', 'entropy', 'approxKl']) result[key] += g[key] * weight;
        result.updates++;
      }
    }
    return result;
  }
  toJSON() {
    const snapshot = {version:MODEL_VERSION, seed:this.seed, parameters:Array.from(this.parameters),
      optimizer:{step:this.optimizer.step, m:Array.from(this.optimizer.m), v:Array.from(this.optimizer.v)}};
    ActionScorer.fromJSON(snapshot); return snapshot;
  }
  static fromJSON(data) {
    if (data.version !== MODEL_VERSION || typeof data.seed !== 'string' ||
      !Number.isSafeInteger(data.optimizer?.step) || data.optimizer.step < 0) throw Error('Invalid scorer snapshot');
    vector(data.parameters, SIZE); vector(data.optimizer.m, SIZE); vector(data.optimizer.v, SIZE);
    if (data.optimizer.v.some(x => x < 0)) throw Error('Invalid Adam variance');
    const model = new ActionScorer(data.seed); model.parameters.set(data.parameters);
    model.optimizer = {step:data.optimizer.step, m:Float64Array.from(data.optimizer.m), v:Float64Array.from(data.optimizer.v)};
    return model;
  }
}
