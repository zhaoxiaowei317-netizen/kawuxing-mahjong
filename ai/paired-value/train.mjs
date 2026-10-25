import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256, projectRoot} from '../provenance.mjs';
import {inferenceSources, saveGain, loadGain} from './io.mjs';
import {loadData, dataSources} from './data.mjs';
import {GainRegressor, fitRidge, diagnostics} from './model.mjs';

export function trainingSources() {
  return {...dataSources(), ...Object.fromEntries(['ai/paired-value/train.mjs']
    .map(path => [path, sha256(readFileSync(resolve(projectRoot, path)))]))};
}
export async function trainGain({out, trainingData, validationData, seed = 'paired-regressor-1',
  epochs = 20, hiddenSize = 16, learningRate = 0.002, batchSize = 64, resume = null, onProgress = () => {}}) {
  if (!Number.isInteger(epochs) || epochs < 0) throw Error('Invalid epochs');
  out = resolve(out); if (existsSync(out)) throw Error('Training output exists');
  const train = loadData(trainingData, 'training'), validation = loadData(validationData, 'validation');
  if (!train.rows.length || !validation.rows.length) throw Error('Both datasets need roots');
  if (train.manifest.rowsSha256 === validation.manifest.rowsSha256) throw Error('Training and validation datasets overlap');
  const sources = trainingSources(), config = {seed, hiddenSize, learningRate, batchSize,
    trainingSha256:train.manifest.rowsSha256, validationSha256:validation.manifest.rowsSha256};
  let model, epoch = 0, history = [], selected = null;
  if (resume) {
    const loaded = loadGain(resume), state = loaded.checkpoint.metadata.training;
    if (!(loaded.model instanceof GainRegressor) || !state || JSON.stringify(state.sources) !== JSON.stringify(sources) ||
      JSON.stringify(state.config) !== JSON.stringify(config)) throw Error('Resume source/data/config mismatch');
    model = loaded.model; epoch = state.epoch; history = state.history;
    selected = state.selected;
  } else model = new GainRegressor({seed, hiddenSize});
  if (epochs < epoch) throw Error('Cannot rewind training');
  mkdirSync(out, {recursive:true});
  const resumeEpoch = epoch;
  for (; epoch <= epochs; epoch++) {
    if (resume && epoch === resumeEpoch) continue;
    let update = null;
    if (epoch > 0) update = model.update(train.rows, {epoch, learningRate, batchSize});
    const row = {epoch, training:diagnostics(model, train.rows, train.manifest.hands),
      validation:diagnostics(model, validation.rows, validation.manifest.hands), update};
    history = [...history, row];
    const path = resolve(out, `epoch-${String(epoch).padStart(3, '0')}.json`);
    if (!selected || row.validation.mse < selected.validationMse - 1e-12) selected = {epoch, path, validationMse:row.validation.mse};
    saveGain(path, model, {training:{version:'kwx-paired-value-supervised-1', sources, config, epoch, history, selected}});
    onProgress({epoch, selected: selected.epoch, mse:row.validation.mse, validationGain:row.validation.chosenGainPer100Hands});
    await new Promise(resolve => setImmediate(resolve));
  }
  if (JSON.stringify(trainingSources()) !== JSON.stringify(sources)) throw Error('Training sources changed');
  const summary = {config, sources, selected, history, trainingHands:train.manifest.hands, validationHands:validation.manifest.hands};
  writeFileSync(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); return summary;
}
export function trainRidge({out, trainingData, validationData, lambda = 1}) {
  out = resolve(out); if (existsSync(out)) throw Error('Ridge output exists'); mkdirSync(out, {recursive:true});
  const train = loadData(trainingData, 'training'), val = loadData(validationData, 'validation');
  const model = fitRidge(train.rows, lambda), path = resolve(out, 'ridge.json');
  saveGain(path, model, {training:{kind:'ridge', lambda, trainingSha256:train.manifest.rowsSha256, validationSha256:val.manifest.rowsSha256}});
  return {path, validation:diagnostics(model, val.rows, val.manifest.hands)};
}
