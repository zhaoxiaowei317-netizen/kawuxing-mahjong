import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {RULES_VERSION} from '../../src/engine.js';
import {OBSERVATION_VERSION, ACTION_VERSION} from '../environment.mjs';
import {actionId} from '../training/encoding.mjs';
import {sourceHashes, sha256, projectRoot, verifyFrozenBaseline} from '../provenance.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';
import {encodeCandidates, FEATURE_VERSION} from './features.mjs';
import {ActionScorer} from './model.mjs';
export function scorerSources() {
  return {...sourceHashes(), ...Object.fromEntries(['ai/action-scorer/features.mjs', 'ai/action-scorer/model.mjs', 'ai/action-scorer/io.mjs']
    .map(file => [file, sha256(readFileSync(resolve(projectRoot, file)))]))};
}
export function saveScorer(path, model, metadata={}) {
  verifyFrozenBaseline();
  return writeAtomicJson(path, {format:'kwx-action-scorer-checkpoint-1', rulesVersion:RULES_VERSION,
    featureVersion:FEATURE_VERSION, observationVersion:OBSERVATION_VERSION, actionVersion:ACTION_VERSION,
    network:model.toJSON(), metadata, sourceHashes:scorerSources(), node:process.version}, {overwrite:false});
}
export function loadScorer(path) {
  const bytes = readFileSync(path), data = JSON.parse(bytes);
  if (data.format !== 'kwx-action-scorer-checkpoint-1' || data.rulesVersion !== RULES_VERSION ||
    data.featureVersion !== FEATURE_VERSION || data.observationVersion !== OBSERVATION_VERSION || data.actionVersion !== ACTION_VERSION)
    throw Error('Incompatible action-scorer checkpoint');
  for (const [file, hash] of Object.entries(scorerSources())) if (data.sourceHashes?.[file] !== hash) throw Error(`Scorer source mismatch: ${file}`);
  verifyFrozenBaseline();
  return {model:ActionScorer.fromJSON(data.network), checkpoint:data, sha256:sha256(bytes)};
}
export function scorerChoice(model, observation, legal, rng, deterministic=true) {
  const encoded = encodeCandidates(observation, legal), f = model.forward(encoded);
  let index = f.probs.reduce((best, p, i) => p > f.probs[best] ? i : best, 0);
  if (!deterministic) {
    if (typeof rng !== 'function') throw Error('Stochastic scorer needs RNG');
    const target = rng(0x100000000) / 0x100000000;
    let sum = 0; index = f.probs.length - 1;
    for (let i = 0; i < f.probs.length; i++) { sum += f.probs[i]; if (target < sum) { index = i; break; } }
  }
  const selected = f.ids[index], action = legal.find(a => actionId(a) === selected);
  return {action, ...encoded, actionId:selected, oldLogProb:f.logProbs[index], oldValue:f.value};
}
export const scorerFactory = (model, deterministic=true) => () => (observation, legal, rng) => scorerChoice(model, observation, legal, rng, deterministic).action;
