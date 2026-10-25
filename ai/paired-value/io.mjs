import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {sourceHashes, projectRoot, sha256} from '../provenance.mjs';
import {FEATURE_VERSION, FEATURE_SIZE} from './features.mjs';
import {GainRegressor, MODEL_VERSION, predictModel} from './model.mjs';

export const CHECKPOINT_VERSION = 'kwx-paired-value-checkpoint-1';
export function inferenceSources() {
  return {...sourceHashes(), ...Object.fromEntries(['ai/lookahead/policy.mjs', 'ai/public-rollout/sampler.mjs',
    'ai/public-rollout/policy.mjs', 'ai/paired-value/features.mjs', 'ai/paired-value/model.mjs',
    'ai/paired-value/policy.mjs', 'ai/paired-value/io.mjs'].map(path => [path, sha256(readFileSync(resolve(projectRoot, path)))]))};
}
export function saveGain(path, model, metadata = {}) {
  path = resolve(path); if (existsSync(path)) throw Error('Checkpoint exists'); mkdirSync(dirname(path), {recursive:true});
  const checkpoint = {version:CHECKPOINT_VERSION, modelVersion:MODEL_VERSION, featureVersion:FEATURE_VERSION,
    sources:inferenceSources(), model:model instanceof GainRegressor ? model.toJSON() : model, metadata};
  writeFileSync(path, JSON.stringify(checkpoint) + '\n'); return sha256(readFileSync(path));
}
export function loadGain(path) {
  const bytes = readFileSync(resolve(path)), checkpoint = JSON.parse(bytes.toString('utf8'));
  if (checkpoint.version !== CHECKPOINT_VERSION || checkpoint.featureVersion !== FEATURE_VERSION || checkpoint.modelVersion !== MODEL_VERSION ||
    JSON.stringify(checkpoint.sources) !== JSON.stringify(inferenceSources())) throw Error('Checkpoint source/version mismatch');
  const model = checkpoint.model.kind === 'ridge' ? checkpoint.model : GainRegressor.fromJSON(checkpoint.model);
  predictModel(model, Array(FEATURE_SIZE).fill(0));
  return {model, checkpoint, sha256:sha256(bytes)};
}
