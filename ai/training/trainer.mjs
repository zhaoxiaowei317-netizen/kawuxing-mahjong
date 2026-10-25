import {mkdirSync, existsSync, readdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {ActorCritic} from './network.mjs';
import {INPUT_SIZE, ACTION_SIZE} from './encoding.mjs';
import {collectImitation, collectRollout, normalizeAdvantages} from './collector.mjs';
import {modelPolicyFactory} from './policy.mjs';
import {makeCheckpoint, saveCheckpoint, loadCheckpoint, writeAtomicJson, trainingSourceHashes} from './checkpoint.mjs';
import {deriveSeed, seededRandom} from '../random.mjs';
import {policyById} from '../policies/index.mjs';
import {runEvaluation} from '../runner.mjs';
import {sha256} from '../provenance.mjs';

export const DEFAULT_TRAINING_CONFIG = Object.freeze({seed:'kwx-training-v1', hiddenSize:32,
  bcEpisodes:24, bcEpochs:3, bcLearningRate:0.001,
  episodesPerIteration:24, trainingHands:1, ppoEpochs:3, learningRate:0.0003, batchSize:64,
  clipRatio:0.2, entropyCoef:0.01, valueCoef:0.5, maxGradNorm:0.5,
  rewardScale:16, selfPlayFraction:0.5, leagueSize:4,
  evalEvery:4, evalGroups:4, evalSessionGroups:2, evalSessionHands:16, bootstrapSamples:1000});

export function normalizeTrainingConfig(input={}) {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_TRAINING_CONFIG, key)) throw Error(`Unknown training option: ${key}`);
  const config = {...DEFAULT_TRAINING_CONFIG, ...input};
  if (typeof config.seed !== 'string' || !config.seed.length) throw Error('Training seed must be nonempty');
  for (const key of ['hiddenSize', 'bcEpochs', 'episodesPerIteration', 'trainingHands', 'ppoEpochs', 'batchSize', 'leagueSize',
    'evalSessionHands', 'bootstrapSamples'])
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw Error(`Invalid positive integer: ${key}`);
  for (const key of ['bcEpisodes', 'evalEvery', 'evalGroups', 'evalSessionGroups'])
    if (!Number.isSafeInteger(config[key]) || config[key] < 0) throw Error(`Invalid nonnegative integer: ${key}`);
  if (config.hiddenSize > 1024 || config.evalSessionHands > 1000 || config.trainingHands > 1000) throw Error('Training dimensions exceed CPU reference limits');
  for (const key of ['bcLearningRate', 'learningRate', 'clipRatio', 'maxGradNorm', 'rewardScale'])
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw Error(`Invalid positive training scalar: ${key}`);
  for (const key of ['entropyCoef', 'valueCoef'])
    if (!Number.isFinite(config[key]) || config[key] < 0) throw Error(`Invalid nonnegative training scalar: ${key}`);
  if (config.clipRatio >= 1 || !Number.isFinite(config.selfPlayFraction) || config.selfPlayFraction < 0 || config.selfPlayFraction > 1)
    throw Error('Invalid clipping/self-play probability');
  if (config.evalEvery && !config.evalGroups && !config.evalSessionGroups) throw Error('Enabled evaluation needs a nonempty suite');
  return config;
}
const hashNetwork = model => sha256(JSON.stringify(model.toJSON().parameters));
function historyOpponents(league) {
  return league.map(entry => {
    const loaded = loadCheckpoint(entry.path);
    if (loaded.sha256 !== entry.sha256) throw Error(`Historical opponent checksum mismatch: ${entry.path}`);
    return {id:entry.id, select:modelPolicyFactory(loaded.model, {deterministic:false})()};
  });
}

export async function runTraining({out, config:input={}, iterations=8, resume=null, initializeFrom=null, onProgress=null} = {}) {
  if (!out) throw Error('Training output directory required');
  if (resume && initializeFrom) throw Error('Exact resume and weight initialization are mutually exclusive');
  if (!Number.isSafeInteger(iterations) || iterations < 0) throw Error('Invalid target iteration');
  const folder = resolve(out);
  if (existsSync(folder) && readdirSync(folder).length) throw Error('Use an empty/new training output directory');
  let model, training, iteration = 0, parent = null;
  if (resume) {
    const loaded = loadCheckpoint(resume, {forResume:true});
    model = loaded.model; training = structuredClone(loaded.checkpoint.training); iteration = loaded.checkpoint.iteration;
    parent = {path:resolve(resume), sha256:loaded.sha256};
    normalizeTrainingConfig(training.config);
    for (const [key, value] of Object.entries(input))
      if (training.config[key] !== value) throw Error(`Cannot change ${key} during exact resume; start a new run`);
    if (iterations <= iteration) throw Error('Resume target must exceed checkpoint iteration');
    // Validate the complete opponent pool before generating new data.
    historyOpponents(training.league);
  } else {
    const config = normalizeTrainingConfig(input);
    model = new ActorCritic({inputSize:INPUT_SIZE, actionSize:ACTION_SIZE, hiddenSize:config.hiddenSize, seed:deriveSeed(config.seed, 'initialization')});
    training = {config, bcDone:false, counters:{imitationEpisodes:0, imitationSamples:0,
      environmentEpisodes:0, environmentHands:0, environmentDecisions:0, learnerDecisions:0}, league:[], history:[], evaluations:[]};
    if (initializeFrom) {
      const loaded = loadCheckpoint(initializeFrom);
      if (loaded.model.config.hiddenSize !== config.hiddenSize) throw Error('Initialization hiddenSize differs');
      if (config.bcEpisodes !== 0) throw Error('Weight initialization requires bcEpisodes=0; imitation must be explicit');
      // This is a new experiment: copy weights only, with fresh Adam state and rollout seeds.
      for (const [name, values] of Object.entries(loaded.model.parameters)) model.parameters[name].set(values);
      parent = {path:resolve(initializeFrom), sha256:loaded.sha256, mode:'weights-only', optimizerReset:true};
      training.initialization = parent;
    }
  }
  const config = training.config, codeHashes = trainingSourceHashes(), began = performance.now();
  mkdirSync(folder, {recursive:true});
  const metadata = {format:'kwx-training-run-1', parent, config, targetIterations:iterations, sourceHashes:codeHashes,
    startedAt:new Date().toISOString(), initialParameterHash:hashNetwork(model)};
  writeAtomicJson(resolve(folder, 'run.json'), metadata, {overwrite:false});
  const checkSources = () => {
    if (JSON.stringify(trainingSourceHashes()) !== JSON.stringify(codeHashes)) throw Error('Training source changed during run');
  };
  let lastCheckpoint = null;
  const persist = index => {
    checkSources();
    const snapshotPath = resolve(folder, 'league', `model-${String(index).padStart(5, '0')}.json`);
    const snapshot = makeCheckpoint(model, {config, counters:{...training.counters}}, {kind:'snapshot', iteration:index, codeHashes});
    const snapshotHash = saveCheckpoint(snapshotPath, snapshot);
    training.league.push({id:`history-${index}-${snapshotHash.slice(0, 8)}`, path:snapshotPath, sha256:snapshotHash, iteration:index});
    training.league = training.league.slice(-config.leagueSize);
    const checkpointPath = resolve(folder, 'checkpoints', `iteration-${String(index).padStart(5, '0')}.json`);
    const checkpoint = makeCheckpoint(model, training, {iteration:index, codeHashes});
    const checkpointHash = saveCheckpoint(checkpointPath, checkpoint);
    lastCheckpoint = {path:checkpointPath, sha256:checkpointHash, iteration:index};
    writeAtomicJson(resolve(folder, 'latest.json'), lastCheckpoint);
    writeAtomicJson(resolve(folder, 'metrics.json'), {history:training.history, evaluations:training.evaluations});
  };
  try {
    if (!training.bcDone) {
      const before = hashNetwork(model);
      let metrics = null;
      if (config.bcEpisodes) {
        const data = await collectImitation({episodes:config.bcEpisodes, seed:config.seed, onProgress});
        metrics = model.bcUpdate(data.samples, {learningRate:config.bcLearningRate, epochs:config.bcEpochs,
          batchSize:config.batchSize, maxGradNorm:config.maxGradNorm, rng:seededRandom(deriveSeed(config.seed, 'bc-update'))});
        training.counters.imitationEpisodes += data.episodes;
        training.counters.imitationSamples += data.samples.length;
      }
      training.bcDone = true;
      training.history.push({phase:'imitation', iteration:0, metrics, parameterHashBefore:before, parameterHashAfter:hashNetwork(model)});
      persist(0);
      onProgress?.({phase:'imitation-complete', metrics, checkpoint:lastCheckpoint});
    }
    while (iteration < iterations) {
      const next = iteration + 1, before = hashNetwork(model);
      const opponents = [{id:'H0', select:policyById('H0')},
        {id:'greedy-speed-v1', select:policyById('greedy-speed-v1')}, ...historyOpponents(training.league)];
      const rollout = await collectRollout({model, episodes:config.episodesPerIteration, seed:config.seed, iteration:next,
        rewardScale:config.rewardScale, sessionHands:config.trainingHands, selfPlayFraction:config.selfPlayFraction, opponents, onProgress});
      const normalized = normalizeAdvantages(rollout.samples);
      const metrics = model.ppoUpdate(normalized.samples, {learningRate:config.learningRate, batchSize:config.batchSize,
        epochs:config.ppoEpochs, clipRatio:config.clipRatio, entropyCoef:config.entropyCoef,
        valueCoef:config.valueCoef, maxGradNorm:config.maxGradNorm,
        rng:seededRandom(deriveSeed(config.seed, 'ppo-update', next))});
      training.counters.environmentEpisodes += rollout.stats.episodes;
      training.counters.environmentHands += rollout.stats.hands;
      training.counters.environmentDecisions += rollout.stats.environmentDecisions;
      training.counters.learnerDecisions += rollout.stats.learnerDecisions;
      training.history.push({phase:'ppo', iteration:next, metrics, rollout:rollout.stats,
        advantageMean:normalized.mean, advantageStd:normalized.std, parameterHashBefore:before, parameterHashAfter:hashNetwork(model)});
      if (config.evalEvery && next % config.evalEvery === 0) {
        onProgress?.({phase:'evaluation', iteration:next});
        const id = `checkpoint-${next}`, report = await runEvaluation({candidate:id, incumbent:'H0',
          policyFactories:{[id]:modelPolicyFactory(model)}, split:'development',
          // Fixed across checkpoints for development comparisons; never enters training rollouts.
          seed:deriveSeed(config.seed, 'development-validation'), independentGroups:config.evalGroups,
          sessionGroups:config.evalSessionGroups, sessionHands:config.evalSessionHands, bootstrapSamples:config.bootstrapSamples,
          onProgress:p => onProgress?.({phase:'evaluation-progress', iteration:next, ...p})});
        const file = resolve(folder, 'evaluations', `iteration-${String(next).padStart(5, '0')}.json`);
        const parameterHash = hashNetwork(model);
        const sha = writeAtomicJson(file, {...report, parameterHash, purpose:'development-only',
          descriptiveOnly:true, sourceHashes:codeHashes}, {overwrite:false});
        training.evaluations.push({iteration:next, path:file, sha256:sha, parameterHash, statistics:report.statistics});
      }
      iteration = next; persist(iteration);
      onProgress?.({phase:'iteration-complete', iteration, metrics, rollout:rollout.stats, checkpoint:lastCheckpoint});
    }
    checkSources();
    const result = {format:'kwx-training-completion-1', status:'complete', purpose:'training-mechanism-validation',
      iteration, config, counters:training.counters, finalCheckpoint:lastCheckpoint,
      initialParameterHash:metadata.initialParameterHash, finalParameterHash:hashNetwork(model),
      changedParameters:metadata.initialParameterHash !== hashNetwork(model),
      elapsedSeconds:(performance.now() - began) / 1000, history:training.history, evaluations:training.evaluations,
      sourceHashes:codeHashes, parent};
    writeAtomicJson(resolve(folder, 'summary.json'), result, {overwrite:false});
    return result;
  } catch (error) {
    writeAtomicJson(resolve(folder, 'failure.json'), {message:error.message, lastCheckpoint,
      note:'Resume a completed checkpoint into a new directory; unfinished rollouts are regenerated.'});
    throw error;
  }
}
