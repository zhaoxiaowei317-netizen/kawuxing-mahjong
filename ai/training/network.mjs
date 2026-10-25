import {seededRandom} from '../random.mjs';

export const NETWORK_VERSION = 'kwx-actor-critic-1';
const PARAMETER_NAMES = ['w1', 'b1', 'policyW', 'policyB', 'valueW', 'valueB'];
const checkFinite = (x, name) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${name} must be finite`);
  return x;
};
function integer(x, name) {
  if (!Number.isSafeInteger(x) || x < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return x;
}
function positive(x, name) {
  checkFinite(x, name);
  if (x <= 0) throw new RangeError(`${name} must be positive`);
  return x;
}
function nonnegative(x, name) {
  checkFinite(x, name);
  if (x < 0) throw new RangeError(`${name} must be nonnegative`);
  return x;
}
function exactKeys(object, keys, name) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      Object.keys(object).sort().join(',') !== [...keys].sort().join(',')) {
    throw new TypeError(`${name} has an invalid schema`);
  }
}
function numericArray(value, length, name) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== length) {
    throw new RangeError(`${name} must have length ${length}`);
  }
  const result = new Float64Array(length);
  for (let i = 0; i < length; i++) result[i] = checkFinite(value[i], `${name}[${i}]`);
  return result;
}
const shapes = ({inputSize, hiddenSize, actionSize}) => ({
  w1: inputSize * hiddenSize, b1: hiddenSize,
  policyW: hiddenSize * actionSize, policyB: actionSize, valueW: hiddenSize, valueB: 1,
});
const zeros = config => Object.fromEntries(Object.entries(shapes(config)).map(([key, size]) => [key, new Float64Array(size)]));
const serialParameters = params => Object.fromEntries(PARAMETER_NAMES.map(name => [name, Array.from(params[name])]));
function legalMask(legalIds, actionSize) {
  if ((!Array.isArray(legalIds) && !ArrayBuffer.isView(legalIds)) || !legalIds.length) {
    throw new RangeError('legalIds must be a nonempty array');
  }
  const ids = [...legalIds];
  if (new Set(ids).size !== ids.length || ids.some(id => !Number.isInteger(id) || id < 0 || id >= actionSize)) {
    throw new RangeError('legalIds must contain unique valid action IDs');
  }
  return ids;
}
function optionsFor(kind, options) {
  if (!['bc', 'ppo'].includes(kind)) throw new RangeError('Unknown loss kind');
  const result = {
    clipRatio: options.clipRatio ?? 0.2,
    entropyCoef: options.entropyCoef ?? (kind === 'ppo' ? 0.01 : 0),
    valueCoef: options.valueCoef ?? 0.5,
  };
  positive(result.clipRatio, 'clipRatio');
  if (result.clipRatio >= 1) throw new RangeError('clipRatio must be less than one');
  nonnegative(result.entropyCoef, 'entropyCoef');
  nonnegative(result.valueCoef, 'valueCoef');
  return result;
}
function gradientNorm(gradients) {
  let largest = 0;
  for (const name of PARAMETER_NAMES) for (const value of gradients[name]) {
    checkFinite(value, `gradient ${name}`); largest = Math.max(largest, Math.abs(value));
  }
  if (!largest) return 0;
  let squares = 0;
  for (const name of PARAMETER_NAMES) for (const value of gradients[name]) squares += (value / largest) ** 2;
  return checkFinite(largest * Math.sqrt(squares), 'gradient norm');
}
const emptyMetrics = () => ({loss:0, policyLoss:0, valueLoss:0, entropy:0, approxKl:0, clipFraction:0, policySaturation:0});

/**
 * CPU reference backend: one shared tanh layer, masked actor and scalar critic.
 * All trainable parameters, gradients and Adam moments use Float64Array.
 * Weight matrices are row-major: hidden×input and action×hidden.
 */
export class ActorCritic {
  constructor({inputSize, hiddenSize=32, actionSize=88, seed='kwx-network-v1'} = {}) {
    integer(inputSize, 'inputSize'); integer(hiddenSize, 'hiddenSize'); integer(actionSize, 'actionSize');
    if (typeof seed !== 'string') throw new TypeError('seed must be a string');
    if (![inputSize * hiddenSize, actionSize * hiddenSize].every(Number.isSafeInteger)) throw new RangeError('Network shape is too large');
    this.config = Object.freeze({inputSize, hiddenSize, actionSize, seed});
    this.parameters = zeros(this.config);
    const random = seededRandom(seed), uniform = () => (random(0x100000000) + 0.5) / 0x100000000 * 2 - 1;
    const initialize = (name, bound) => {
      for (let i = 0; i < this.parameters[name].length; i++) this.parameters[name][i] = uniform() * bound;
    };
    initialize('w1', Math.sqrt(6 / (inputSize + hiddenSize)));
    initialize('policyW', 0.01 * Math.sqrt(6 / (hiddenSize + actionSize)));
    initialize('valueW', Math.sqrt(6 / (hiddenSize + 1)));
    this.optimizer = {step:0, learningRate:0.001, beta1:0.9, beta2:0.999, epsilon:1e-8,
      beta1Power:1, beta2Power:1, m:zeros(this.config), v:zeros(this.config)};
  }

  #forward(features, legalIds) {
    const {inputSize, hiddenSize, actionSize} = this.config, p = this.parameters;
    const hidden = new Float64Array(hiddenSize);
    for (let j = 0; j < hiddenSize; j++) {
      let value = p.b1[j];
      for (let i = 0; i < inputSize; i++) value += p.w1[j * inputSize + i] * features[i];
      hidden[j] = Math.tanh(checkFinite(value, 'hidden preactivation'));
    }
    const logits = new Float64Array(actionSize);
    let maximum = -Infinity;
    for (const a of legalIds) {
      let value = p.policyB[a];
      for (let j = 0; j < hiddenSize; j++) value += p.policyW[a * hiddenSize + j] * hidden[j];
      logits[a] = checkFinite(value, 'policy logit'); maximum = Math.max(maximum, value);
    }
    let sum = 0;
    for (const a of legalIds) sum += Math.exp(logits[a] - maximum);
    const logSum = Math.log(sum), probs = Array(actionSize).fill(0), logProbs = Array(actionSize).fill(-Infinity);
    let entropy = 0;
    for (const a of legalIds) {
      logProbs[a] = checkFinite(logits[a] - maximum - logSum, 'log probability');
      probs[a] = Math.exp(logProbs[a]); entropy -= probs[a] * logProbs[a];
    }
    let value = p.valueB[0];
    for (let j = 0; j < hiddenSize; j++) value += p.valueW[j] * hidden[j];
    return {hidden, probs, logProbs, entropy:checkFinite(entropy, 'entropy'), value:checkFinite(value, 'value')};
  }

  forward(features, legalIds) {
    const x = numericArray(features, this.config.inputSize, 'features');
    const {probs, logProbs, value} = this.#forward(x, legalMask(legalIds, this.config.actionSize));
    return {probs, logProbs, value};
  }

  #prepare(samples, kind) {
    if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
    return samples.map((sample, index) => {
      if (!sample || typeof sample !== 'object') throw new TypeError(`samples[${index}] must be an object`);
      const features = numericArray(sample.features, this.config.inputSize, `samples[${index}].features`);
      const legalIds = legalMask(sample.legalIds, this.config.actionSize), actionId = sample.actionId;
      if (!legalIds.includes(actionId)) throw new RangeError(`samples[${index}].actionId is illegal`);
      const result = {features, legalIds, actionId};
      if (kind === 'ppo') for (const name of ['oldLogProb', 'advantage', 'return']) {
        result[name] = checkFinite(sample[name], `samples[${index}].${name}`);
      }
      if (kind === 'ppo' && result.oldLogProb > 0) throw new RangeError('oldLogProb cannot be positive');
      return result;
    });
  }

  #loss(samples, kind, options) {
    const {inputSize, hiddenSize} = this.config, p = this.parameters;
    const gradients = zeros(this.config), metrics = emptyMetrics(), scale = samples.length ? 1 / samples.length : 0;
    for (const sample of samples) {
      const f = this.#forward(sample.features, sample.legalIds), q = f.logProbs[sample.actionId];
      let policyLoss, dq, valueLoss = 0, dv = 0;
      if (kind === 'bc') { policyLoss = -q; dq = -1; }
      else {
        const logRatio = q - sample.oldLogProb, ratio = checkFinite(Math.exp(logRatio), 'PPO probability ratio');
        const clipped = Math.max(1 - options.clipRatio, Math.min(1 + options.clipRatio, ratio));
        const saturated = sample.advantage > 0 && ratio > 1 + options.clipRatio ||
          sample.advantage < 0 && ratio < 1 - options.clipRatio;
        policyLoss = -Math.min(ratio * sample.advantage, clipped * sample.advantage);
        dq = saturated ? 0 : -sample.advantage * ratio;
        const error = f.value - sample.return;
        valueLoss = 0.5 * error * error; dv = options.valueCoef * error;
        // Nonnegative k3 estimate, evaluated on actions sampled from the old policy.
        metrics.approxKl += checkFinite(Math.expm1(logRatio) - logRatio, 'approximate KL') * scale;
        metrics.clipFraction += Number(ratio < 1 - options.clipRatio || ratio > 1 + options.clipRatio) * scale;
        metrics.policySaturation += Number(saturated) * scale;
      }
      metrics.policyLoss += checkFinite(policyLoss, 'policy loss') * scale;
      metrics.valueLoss += checkFinite(valueLoss, 'value loss') * scale;
      metrics.entropy += f.entropy * scale;
      const hiddenGradient = new Float64Array(hiddenSize);
      for (const a of sample.legalIds) {
        const dz = (dq * (Number(a === sample.actionId) - f.probs[a]) +
          options.entropyCoef * f.probs[a] * (f.logProbs[a] + f.entropy)) * scale;
        gradients.policyB[a] += dz;
        for (let j = 0; j < hiddenSize; j++) {
          gradients.policyW[a * hiddenSize + j] += dz * f.hidden[j];
          hiddenGradient[j] += p.policyW[a * hiddenSize + j] * dz;
        }
      }
      dv *= scale; gradients.valueB[0] += dv;
      for (let j = 0; j < hiddenSize; j++) {
        gradients.valueW[j] += dv * f.hidden[j];
        const dh = (hiddenGradient[j] + p.valueW[j] * dv) * (1 - f.hidden[j] ** 2);
        gradients.b1[j] += dh;
        for (let i = 0; i < inputSize; i++) gradients.w1[j * inputSize + i] += dh * sample.features[i];
      }
    }
    metrics.loss = metrics.policyLoss - options.entropyCoef * metrics.entropy + options.valueCoef * metrics.valueLoss;
    for (const [name, value] of Object.entries(metrics)) checkFinite(value, name);
    return {...metrics, gradients};
  }

  /** Value loss is 0.5*MSE; total loss = policyLoss - entropyCoef*entropy + valueCoef*valueLoss. */
  lossAndGradients(samples, kind, options={}) {
    const settings = optionsFor(kind, options);
    return this.#loss(this.#prepare(samples, kind), kind, settings);
  }

  #adam(gradients, options) {
    const norm = gradientNorm(gradients), clipScale = norm > options.maxGradNorm ? options.maxGradNorm / norm : 1;
    const old = this.optimizer, step = old.step + 1;
    if (!Number.isSafeInteger(step)) throw new RangeError('Adam step overflow');
    const beta1Power = old.beta1Power * options.beta1, beta2Power = old.beta2Power * options.beta2;
    const next = zeros(this.config), m = zeros(this.config), v = zeros(this.config);
    for (const name of PARAMETER_NAMES) for (let i = 0; i < next[name].length; i++) {
      const gradient = gradients[name][i] * clipScale;
      m[name][i] = checkFinite(options.beta1 * old.m[name][i] + (1 - options.beta1) * gradient, 'Adam first moment');
      v[name][i] = checkFinite(options.beta2 * old.v[name][i] + (1 - options.beta2) * gradient ** 2, 'Adam second moment');
      next[name][i] = checkFinite(this.parameters[name][i] - options.learningRate *
        (m[name][i] / (1 - beta1Power)) / (Math.sqrt(v[name][i] / (1 - beta2Power)) + options.adamEpsilon), 'updated parameter');
    }
    // Commit only after all proposed parameters and moments have been validated.
    this.parameters = next;
    this.optimizer = {step, learningRate:options.learningRate, beta1:options.beta1, beta2:options.beta2,
      epsilon:options.adamEpsilon, beta1Power, beta2Power, m, v};
    return {gradNorm:norm, clippedGradNorm:norm * clipScale};
  }

  #update(samples, kind, options) {
    const lossOptions = optionsFor(kind, options), prepared = this.#prepare(samples, kind);
    const settings = {
      learningRate:options.learningRate ?? (kind === 'bc' ? 0.001 : 0.0003),
      batchSize:options.batchSize ?? 64, epochs:options.epochs ?? (kind === 'bc' ? 1 : 4),
      maxGradNorm:options.maxGradNorm ?? 0.5, beta1:options.beta1 ?? this.optimizer.beta1,
      beta2:options.beta2 ?? this.optimizer.beta2, adamEpsilon:options.adamEpsilon ?? this.optimizer.epsilon,
    };
    positive(settings.learningRate, 'learningRate'); positive(settings.maxGradNorm, 'maxGradNorm');
    positive(settings.adamEpsilon, 'adamEpsilon'); integer(settings.batchSize, 'batchSize'); integer(settings.epochs, 'epochs');
    for (const name of ['beta1', 'beta2']) {
      nonnegative(settings[name], name);
      if (settings[name] >= 1) throw new RangeError(`${name} must be less than one`);
    }
    const random = options.rng ?? seededRandom(`${this.config.seed}:${kind}:${this.optimizer.step}`);
    if (typeof random !== 'function') throw new TypeError('rng must be a function returning an integer below max');
    const metrics = {...emptyMetrics(), gradNorm:0, clippedGradNorm:0, maxObservedGradNorm:0, updates:0,
      samples:prepared.length, samplesSeen:0};
    for (let epoch = 0; epoch < settings.epochs && prepared.length; epoch++) {
      const order = prepared.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = random(i + 1);
        if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError('rng returned an invalid shuffle index');
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let start = 0; start < order.length; start += settings.batchSize) {
        const batch = order.slice(start, start + settings.batchSize).map(i => prepared[i]);
        const result = this.#loss(batch, kind, lossOptions), norms = this.#adam(result.gradients, settings);
        const weight = batch.length / (prepared.length * settings.epochs);
        for (const name of Object.keys(emptyMetrics())) metrics[name] += result[name] * weight;
        metrics.gradNorm += norms.gradNorm * weight; metrics.clippedGradNorm += norms.clippedGradNorm * weight;
        metrics.maxObservedGradNorm = Math.max(metrics.maxObservedGradNorm, norms.gradNorm);
        metrics.updates++; metrics.samplesSeen += batch.length;
      }
    }
    for (const [name, value] of Object.entries(metrics)) checkFinite(value, name);
    return metrics;
  }

  bcUpdate(samples, options={}) { return this.#update(samples, 'bc', options); }
  ppoUpdate(samples, options={}) { return this.#update(samples, 'ppo', options); }

  toJSON() {
    const snapshot = {version:NETWORK_VERSION, config:{...this.config}, parameters:serialParameters(this.parameters),
      optimizer:{...this.optimizer, m:serialParameters(this.optimizer.m), v:serialParameters(this.optimizer.v)}};
    // Catch any external mutation of the public parameter arrays before saving.
    ActorCritic.#validateSnapshot(snapshot);
    return snapshot;
  }

  static #validateSnapshot(data) {
    exactKeys(data, ['version', 'config', 'parameters', 'optimizer'], 'network snapshot');
    if (data.version !== NETWORK_VERSION) throw new RangeError('Incompatible network version');
    exactKeys(data.config, ['inputSize', 'hiddenSize', 'actionSize', 'seed'], 'network config');
    integer(data.config.inputSize, 'inputSize'); integer(data.config.hiddenSize, 'hiddenSize'); integer(data.config.actionSize, 'actionSize');
    if (typeof data.config.seed !== 'string') throw new TypeError('seed must be a string');
    const dimensions = shapes(data.config);
    for (const size of Object.values(dimensions)) integer(size, 'parameter shape');
    const readParameters = (value, name, secondMoment=false) => {
      exactKeys(value, PARAMETER_NAMES, name);
      return Object.fromEntries(PARAMETER_NAMES.map(key => {
        const array = numericArray(value[key], dimensions[key], `${name}.${key}`);
        if (secondMoment && array.some(x => x < 0)) throw new RangeError('Adam second moments must be nonnegative');
        return [key, array];
      }));
    };
    const parameters = readParameters(data.parameters, 'parameters'), o = data.optimizer;
    exactKeys(o, ['step', 'learningRate', 'beta1', 'beta2', 'epsilon', 'beta1Power', 'beta2Power', 'm', 'v'], 'Adam state');
    if (!Number.isSafeInteger(o.step) || o.step < 0) throw new RangeError('Adam step must be a nonnegative safe integer');
    positive(o.learningRate, 'Adam learningRate'); positive(o.epsilon, 'Adam epsilon');
    for (const name of ['beta1', 'beta2']) {
      nonnegative(o[name], `Adam ${name}`);
      if (o[name] >= 1) throw new RangeError(`Adam ${name} must be less than one`);
    }
    for (const name of ['beta1Power', 'beta2Power']) {
      nonnegative(o[name], `Adam ${name}`);
      if (o[name] > 1 || o.step > 0 && o[name] === 1 || o.step === 0 && o[name] !== 1) throw new RangeError(`Invalid Adam ${name}`);
    }
    return {parameters, optimizer:{...o, m:readParameters(o.m, 'Adam.m'), v:readParameters(o.v, 'Adam.v', true)}};
  }

  static fromJSON(data) {
    const validated = ActorCritic.#validateSnapshot(data), result = new ActorCritic(data.config);
    result.parameters = validated.parameters; result.optimizer = validated.optimizer;
    return result;
  }
}
