import {ActorCritic} from '../training/network.mjs';
import {seededRandom} from '../random.mjs';
import {FEATURE_SIZE} from './features.mjs';

export const MODEL_VERSION = 'kwx-paired-net-gain-regressor-1';
export const TARGET_SCALE = 16;
function vector(x) {
  if (!Array.isArray(x) || x.length !== FEATURE_SIZE || x.some(v => !Number.isFinite(v))) throw Error('Invalid feature vector');
}
export class GainRegressor {
  constructor({seed = 'paired-gain-1', hiddenSize = 16} = {}) {
    this.network = new ActorCritic({inputSize:FEATURE_SIZE, hiddenSize, actionSize:1, seed});
    // Exact H0 behavior before training: predicted alternative gain is zero.
    this.network.parameters.valueW.fill(0); this.network.parameters.valueB.fill(0);
  }
  predict(x) { vector(x); return this.network.forward(x, [0]).value * TARGET_SCALE; }
  update(rows, {epoch = 1, learningRate = 0.002, batchSize = 64, maxGradNorm = 1} = {}) {
    if (!Array.isArray(rows) || !rows.length) throw Error('Training rows required');
    const samples = rows.map(r => {
      vector(r.features); if (!Number.isFinite(r.gain)) throw Error('Invalid gain target');
      return {features:r.features, legalIds:[0], actionId:0, oldLogProb:0, advantage:0, return:r.gain / TARGET_SCALE};
    });
    // Supervised value regression only. A singleton actor and zero advantage
    // give exactly zero policy gradient; no PPO policy optimization is used.
    return this.network.ppoUpdate(samples, {epochs:1, learningRate, batchSize, maxGradNorm,
      valueCoef:1, entropyCoef:0, rng:seededRandom(`${this.network.config.seed}:epoch:${epoch}`)});
  }
  toJSON() { return {version:MODEL_VERSION, network:this.network.toJSON()}; }
  static fromJSON(data) {
    if (data.version !== MODEL_VERSION) throw Error('Model version mismatch');
    const result = Object.create(GainRegressor.prototype); result.network = ActorCritic.fromJSON(data.network);
    if (result.network.config.inputSize !== FEATURE_SIZE || result.network.config.actionSize !== 1) throw Error('Model dimensions differ');
    return result;
  }
}

export function fitRidge(rows, lambda = 1) {
  if (!Number.isFinite(lambda) || lambda <= 0 || !Array.isArray(rows) || !rows.length) throw Error('Invalid ridge fit');
  const d = FEATURE_SIZE, a = Array.from({length:d}, () => new Float64Array(d + 1));
  for (const r of rows) {
    vector(r.features); if (!Number.isFinite(r.gain)) throw Error('Invalid target');
    for (let i = 0; i < d; i++) {
      a[i][d] += r.features[i] * r.gain;
      for (let j = 0; j < d; j++) a[i][j] += r.features[i] * r.features[j];
    }
  }
  for (let i = 0; i < d; i++) a[i][i] += lambda;
  for (let col = 0; col < d; col++) {
    let pivot = col;
    for (let row = col + 1; row < d; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col]; if (Math.abs(scale) < 1e-12) throw Error('Singular ridge system');
    for (let j = col; j <= d; j++) a[col][j] /= scale;
    for (let row = 0; row < d; row++) if (row !== col) {
      const factor = a[row][col]; for (let j = col; j <= d; j++) a[row][j] -= factor * a[col][j];
    }
  }
  const weights = a.map(row => row[d]);
  if (weights.some(x => !Number.isFinite(x))) throw Error('Nonfinite ridge weights');
  return {version:MODEL_VERSION, kind:'ridge', lambda, weights};
}
export function predictModel(model, x) {
  vector(x);
  if (model instanceof GainRegressor) return model.predict(x);
  if (model.kind !== 'ridge' || model.version !== MODEL_VERSION || model.weights.length !== FEATURE_SIZE || model.weights.some(v => !Number.isFinite(v))) throw Error('Invalid ridge model');
  return x.reduce((s, v, i) => s + v * model.weights[i], 0);
}
export function diagnostics(model, rows, hands) {
  let squared = 0, chosen = 0, choices = 0, allProposal = 0;
  for (const r of rows) {
    const prediction = predictModel(model, r.features); squared += (prediction - r.gain) ** 2;
    if (prediction > 1e-9) { chosen += r.gain; choices++; }
    allProposal += r.gain;
  }
  return {rows:rows.length, hands, mse:rows.length ? squared / rows.length : 0,
    conditionalChosenGain:chosen, chosenGainPer100Hands:chosen / hands * 100,
    proposalGainPer100Hands:allProposal / hands * 100, accepted:choices};
}
