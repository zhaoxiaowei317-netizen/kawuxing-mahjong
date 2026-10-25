import {readFileSync, mkdirSync, existsSync, readdirSync, appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scorerSources, loadScorer, saveScorer} from './io.mjs';
import {AnchoredScorer} from './anchored.mjs';
import {collectScorerRollout} from './rollout.mjs';
import {normalizeAdvantages} from '../training/collector.mjs';
import {deriveSeed, seededRandom} from '../random.mjs';
import {sha256, projectRoot} from '../provenance.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';

export const TRAINING_VERSION = 'kwx-action-scorer-anchored-ppo-1';
export const DEFAULT_CONFIG = Object.freeze({seed:'kwx-scorer-ppo-v1', handsPerIteration:128,
  selfPlayFraction:0.25, rewardScale:16, learningRate:0.002, epochs:2, batchSize:128,
  clipRatio:0.2, entropyCoef:0.002, valueCoef:0.1, bcCoef:0.2, maxGradNorm:0.5, targetKl:0.03});
export function normalizeConfig(input={}) {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw Error(`Unknown scorer training option: ${key}`);
  const c = {...DEFAULT_CONFIG, ...input};
  if (typeof c.seed !== 'string' || !c.seed.length) throw Error('Training seed required');
  for (const key of ['handsPerIteration', 'epochs', 'batchSize']) if (!Number.isSafeInteger(c[key]) || c[key] < 1) throw Error(`Invalid ${key}`);
  for (const key of ['rewardScale', 'learningRate', 'clipRatio', 'maxGradNorm', 'targetKl']) if (!Number.isFinite(c[key]) || c[key] <= 0) throw Error(`Invalid ${key}`);
  for (const key of ['selfPlayFraction', 'entropyCoef', 'valueCoef', 'bcCoef']) if (!Number.isFinite(c[key]) || c[key] < 0) throw Error(`Invalid ${key}`);
  if (c.clipRatio >= 1 || c.selfPlayFraction > 1) throw Error('Invalid ratio');
  return c;
}
export function trainingSources() {
  const files = ['ai/action-scorer/anchored.mjs', 'ai/action-scorer/rollout.mjs', 'ai/action-scorer/train.mjs', 'ai/training/collector.mjs'];
  return {...scorerSources(), ...Object.fromEntries(files.map(file => [file, sha256(readFileSync(resolve(projectRoot, file)))]))};
}
export async function trainScorer({out, initializeFrom=null, resume=null, iterations, config:input={}, onProgress=null}) {
  if (Boolean(initializeFrom) === Boolean(resume)) throw Error('Use exactly one of initializeFrom or resume');
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw Error('Iterations must be positive');
  const folder = resolve(out), config = normalizeConfig(input), sources = trainingSources();
  if (existsSync(folder) && readdirSync(folder).length) throw Error('Training output must be new/empty, including resumed branches');
  const loaded = loadScorer(resume || initializeFrom);
  let model, state;
  if (resume) {
    state = structuredClone(loaded.checkpoint.metadata.training);
    if (!state || state.version !== TRAINING_VERSION || loaded.checkpoint.node !== process.version ||
      JSON.stringify(state.config) !== JSON.stringify(config) || JSON.stringify(state.sourceHashes) !== JSON.stringify(sources) ||
      !Number.isSafeInteger(state.iteration) || state.iteration < 0 || !Array.isArray(state.history) || state.history.length !== state.iteration ||
      !state.counters || ['hands', 'learnerDecisions', 'learnerHands'].some(k => !Number.isSafeInteger(state.counters[k]) || state.counters[k] < 0) ||
      state.counters.hands !== state.iteration * config.handsPerIteration) throw Error('Incompatible exact scorer resume');
    model = AnchoredScorer.fromJSON(loaded.checkpoint.network);
  } else {
    model = new AnchoredScorer(config.seed); model.parameters.set(loaded.model.parameters);
    state = {version:TRAINING_VERSION, config, sourceHashes:sources, iteration:0, history:[],
      parent:{path:resolve(initializeFrom), sha256:loaded.sha256}, counters:{hands:0, learnerDecisions:0, learnerHands:0}};
  }
  if (iterations <= state.iteration) throw Error('Target iteration must exceed the restored iteration');
  const checkSources = () => { if (JSON.stringify(trainingSources()) !== JSON.stringify(sources)) throw Error('Training sources changed'); };
  mkdirSync(folder, {recursive:true});
  writeAtomicJson(resolve(folder, 'manifest.json'), {version:TRAINING_VERSION, config, sourceHashes:sources, iterations,
    startedAt:new Date().toISOString(), node:process.version, initializeFrom, resume, sourceModelSha256:loaded.sha256}, {overwrite:false});
  const emit = p => { appendFileSync(resolve(folder, 'events.jsonl'), JSON.stringify(p) + '\n'); writeAtomicJson(resolve(folder, 'status.json'), p); onProgress?.(p); };
  let finalCheckpoint;
  for (let iteration = state.iteration + 1; iteration <= iterations; iteration++) {
    checkSources(); emit({phase:'rollout', iteration});
    const data = await collectScorerRollout({model, hands:config.handsPerIteration, seed:config.seed, iteration,
      selfPlayFraction:config.selfPlayFraction, rewardScale:config.rewardScale,
      onProgress:p => { if (p.hand % 32 === 0) emit({phase:'rollout', iteration, ...p}); }});
    const normalized = normalizeAdvantages(data.samples), samples = normalized.samples;
    const options = {clipRatio:config.clipRatio, entropyCoef:config.entropyCoef, valueCoef:config.valueCoef, bcCoef:config.bcCoef};
    const before = model.lossAndGradients(samples, 'ppo', options), updates = [];
    for (let epoch = 0; epoch < config.epochs; epoch++) {
      const metrics = model.update(samples, {kind:'ppo', epochs:1, batchSize:config.batchSize, learningRate:config.learningRate,
        maxGradNorm:config.maxGradNorm, rng:seededRandom(deriveSeed(config.seed, 'scorer-update', iteration, epoch)), ...options});
      const after = model.lossAndGradients(samples, 'ppo', options);
      updates.push({...metrics, approxKlAfter:after.approxKl, anchorLossAfter:after.anchorLoss});
      if (after.approxKl > config.targetKl) break;
    }
    state.iteration = iteration; state.counters.hands += data.stats.hands;
    state.counters.learnerDecisions += data.stats.learnerDecisions; state.counters.learnerHands += data.stats.learnerHands;
    const row = {iteration, rollout:data.stats, advantage:{mean:normalized.mean, std:normalized.std},
      before:{loss:before.loss, anchorLoss:before.anchorLoss, approxKl:before.approxKl}, updates};
    state.history.push(row); checkSources();
    const path = resolve(folder, 'checkpoints', `iteration-${String(iteration).padStart(5, '0')}.json`);
    const hash = saveScorer(path, model, {training:state}); finalCheckpoint = {path, sha256:hash};
    writeAtomicJson(resolve(folder, 'history.json'), state.history);
    emit({phase:'iteration-complete', iteration, checkpoint:finalCheckpoint, ...row});
    await new Promise(resolve => setImmediate(resolve));
  }
  checkSources(); const result = {status:'complete', config, finalCheckpoint, counters:state.counters, history:state.history};
  writeAtomicJson(resolve(folder, 'summary.json'), result, {overwrite:false}); emit({phase:'complete', finalCheckpoint}); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--config', '--iterations', '--initialize-from', '--resume'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Invalid scorer train arguments');
    options[args[i]] = args[i + 1];
  }
  if (!options['--out']) throw Error('--out required');
  await trainScorer({out:options['--out'], config:options['--config'] ? JSON.parse(readFileSync(options['--config'], 'utf8')) : {},
    iterations:Number(options['--iterations']), initializeFrom:options['--initialize-from'], resume:options['--resume'],
    onProgress:p => console.log(JSON.stringify(p))});
}
