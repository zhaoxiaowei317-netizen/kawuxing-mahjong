import {readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RULES_VERSION} from '../../src/engine.js';
import {ACTION_VERSION, OBSERVATION_VERSION} from '../environment.mjs';
import {sourceHashes, sha256, projectRoot, verifyFrozenBaseline} from '../provenance.mjs';
import {ENCODING_VERSION, INPUT_SIZE, ACTION_SIZE} from './encoding.mjs';
import {ActorCritic} from './network.mjs';

export const CHECKPOINT_VERSION = 'kwx-checkpoint-1';
export const TRAINING_VERSION = 'kwx-ppo-mc-1';
export function trainingSourceHashes() {
  const files = ['ai/training/encoding.mjs', 'ai/training/network.mjs', 'ai/training/policy.mjs',
    'ai/training/collector.mjs', 'ai/training/checkpoint.mjs', 'ai/training/trainer.mjs', 'ai/train.mjs'];
  return {...sourceHashes(), ...Object.fromEntries(files.map(path => [path, sha256(readFileSync(resolve(projectRoot, path)))]))};
}
export function makeCheckpoint(model, training, {kind='training', iteration=0, codeHashes=trainingSourceHashes()} = {}) {
  const network = model.toJSON();
  return {format:CHECKPOINT_VERSION, trainingVersion:TRAINING_VERSION, kind, iteration,
    modelVersion:network.version, encodingVersion:ENCODING_VERSION, actionVersion:ACTION_VERSION,
    observationVersion:OBSERVATION_VERSION, rulesVersion:RULES_VERSION,
    trainingSteps:training.counters?.learnerDecisions || 0, training,
    provenance:{sourceHashes:codeHashes, baseline:verifyFrozenBaseline(), node:process.version},
    network};
}
export function writeAtomicJson(path, data, {overwrite=true} = {}) {
  path = resolve(path); mkdirSync(dirname(path), {recursive:true});
  if (!overwrite && existsSync(path)) throw Error(`Refusing to overwrite ${path}`);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data) + '\n', {flag:'wx'});
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
  return sha256(readFileSync(path));
}
export function saveCheckpoint(path, checkpoint) { return writeAtomicJson(path, checkpoint, {overwrite:false}); }

export function loadCheckpoint(path, {forResume=false} = {}) {
  const buffer = readFileSync(resolve(path)), checkpoint = JSON.parse(buffer.toString('utf8'));
  if (checkpoint.format !== CHECKPOINT_VERSION || checkpoint.rulesVersion !== RULES_VERSION ||
      checkpoint.encodingVersion !== ENCODING_VERSION || checkpoint.actionVersion !== ACTION_VERSION ||
      checkpoint.observationVersion !== OBSERVATION_VERSION || checkpoint.trainingVersion !== TRAINING_VERSION)
    throw Error('Incompatible checkpoint protocol/rules/encoding');
  if (!['training', 'snapshot'].includes(checkpoint.kind) || !Number.isSafeInteger(checkpoint.iteration) || checkpoint.iteration < 0 ||
      !Number.isSafeInteger(checkpoint.trainingSteps) || checkpoint.trainingSteps < 0)
    throw Error('Invalid checkpoint counters/kind');
  const config = checkpoint.network?.config;
  if (checkpoint.modelVersion !== checkpoint.network?.version) throw Error('Checkpoint model version metadata differs');
  if (config?.inputSize !== INPUT_SIZE || config?.actionSize !== ACTION_SIZE) throw Error('Checkpoint network dimensions differ');
  const pinned = checkpoint.provenance?.sourceHashes;
  if (!pinned) throw Error('Checkpoint is missing provenance');
  for (const file of ['src/engine.js', 'src/wall.js', 'ai/environment.mjs',
    'ai/training/encoding.mjs', 'ai/training/network.mjs', 'ai/training/policy.mjs'])
    if (pinned[file] !== sha256(readFileSync(resolve(projectRoot, file)))) throw Error(`Checkpoint source mismatch: ${file}`);
  verifyFrozenBaseline();
  if (forResume) {
    if (checkpoint.kind !== 'training') throw Error('Only a training checkpoint can resume an optimizer');
    const state = checkpoint.training;
    if (!state || state.bcDone !== true || !Array.isArray(state.league) || !Array.isArray(state.history) || !Array.isArray(state.evaluations) ||
        !state.counters || Object.values(state.counters).some(x => !Number.isSafeInteger(x) || x < 0))
      throw Error('Invalid training resume state');
    if (checkpoint.provenance.node !== process.version) throw Error('Exact resume requires the recorded Node version');
    const current = trainingSourceHashes();
    for (const [file, hash] of Object.entries(current)) if (pinned[file] !== hash) throw Error(`Resume source mismatch: ${file}`);
  }
  return {checkpoint, model:ActorCritic.fromJSON(checkpoint.network), sha256:sha256(buffer)};
}
