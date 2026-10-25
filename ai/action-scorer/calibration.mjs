import {readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {ActionScorer} from './model.mjs';
import {loadScorer, saveScorer} from './io.mjs';
import {collectScorerRollout} from './rollout.mjs';
import {normalizeConfig as normalizeTraining, trainScorer, trainingSources} from './train.mjs';
import {evaluateScorer} from './evaluate.mjs';
import {deriveSeed, seededRandom} from '../random.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';
import {sha256, projectRoot} from '../provenance.mjs';

export const BC_VERSION = 'kwx-scorer-own-state-bc-1';
export const DEFAULT_CONFIG = Object.freeze({seed:'kwx-step-bc-calibration-v1', fastLearningRate:0.01,
  developmentGroups:8, developmentSessionGroups:2, sealedGroups:32, sealedSessionGroups:8,
  sessionHands:16, bootstrapSamples:2000});
export function normalizeConfig(input={}) {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw Error(`Unknown calibration option: ${key}`);
  const c = {...DEFAULT_CONFIG, ...input};
  if (typeof c.seed !== 'string' || !c.seed.length || !Number.isFinite(c.fastLearningRate) || c.fastLearningRate <= 0) throw Error('Invalid seed/learning rate');
  for (const [key, n] of Object.entries(c)) if (!['seed', 'fastLearningRate'].includes(key) && (!Number.isSafeInteger(n) || n < 1)) throw Error(`Invalid ${key}`);
  return c;
}
export function calibrationSources() {
  return {...trainingSources(), ...Object.fromEntries(['ai/action-scorer/calibration.mjs', 'ai/action-scorer/evaluate.mjs']
    .map(file => [file, sha256(readFileSync(resolve(projectRoot, file)))]))};
}
function checkSources(sources) {
  for (const [file, hash] of Object.entries(sources)) if (sha256(readFileSync(resolve(projectRoot, file))) !== hash) throw Error(`Source changed: ${file}`);
}
function newFolder(out) {
  const folder = resolve(out);
  if (existsSync(folder) && readdirSync(folder).length) throw Error('Output requires a new empty directory');
  mkdirSync(folder, {recursive:true}); return folder;
}
export async function trainBc({out, initializeFrom=null, resume=null, iterations, config:input={}, onProgress=null}) {
  if (Boolean(initializeFrom) === Boolean(resume) || !Number.isSafeInteger(iterations) || iterations < 1) throw Error('Invalid BC initialization/target');
  const config = normalizeTraining(input), sources = calibrationSources(), loaded = loadScorer(resume || initializeFrom);
  let model, state;
  if (resume) {
    state = structuredClone(loaded.checkpoint.metadata.bcOnlyTraining);
    if (!state || state.version !== BC_VERSION || JSON.stringify(state.config) !== JSON.stringify(config) ||
      JSON.stringify(state.sourceHashes) !== JSON.stringify(sources) || loaded.checkpoint.node !== process.version ||
      !Number.isSafeInteger(state.iteration) || state.iteration < 0 || state.history?.length !== state.iteration ||
      !state.counters || ['hands', 'learnerDecisions', 'learnerHands'].some(k => !Number.isSafeInteger(state.counters[k]) || state.counters[k] < 0) ||
      state.counters.hands !== state.iteration * config.handsPerIteration) throw Error('Incompatible exact BC resume');
    model = loaded.model;
  } else {
    model = new ActionScorer(config.seed); model.parameters.set(loaded.model.parameters);
    state = {version:BC_VERSION, config, sourceHashes:sources, iteration:0, history:[],
      parent:{path:resolve(initializeFrom), sha256:loaded.sha256}, counters:{hands:0, learnerDecisions:0, learnerHands:0}};
  }
  if (iterations <= state.iteration) throw Error('Target must exceed saved iteration');
  const folder = newFolder(out);
  writeAtomicJson(resolve(folder, 'manifest.json'), {version:BC_VERSION, config, sourceHashes:sources,
    initializeFrom, resume, iterations, startedAt:new Date().toISOString(), objective:'H0 cross-entropy only; no return, advantage, entropy or critic loss'}, {overwrite:false});
  let finalCheckpoint;
  for (let iteration = state.iteration + 1; iteration <= iterations; iteration++) {
    checkSources(sources);
    const data = await collectScorerRollout({model, hands:config.handsPerIteration, seed:config.seed, iteration,
      selfPlayFraction:config.selfPlayFraction, rewardScale:config.rewardScale});
    const samples = data.samples.map(s => ({...s, actionId:s.teacherActionId})), updates = [];
    for (let epoch = 0; epoch < config.epochs; epoch++) updates.push(model.update(samples, {kind:'bc', epochs:1,
      learningRate:config.learningRate, batchSize:config.batchSize, maxGradNorm:config.maxGradNorm,
      entropyCoef:0, valueCoef:0, rng:seededRandom(deriveSeed(config.seed, 'scorer-update', iteration, epoch))}));
    state.iteration = iteration;
    for (const key of ['hands', 'learnerDecisions', 'learnerHands']) state.counters[key] += data.stats[key];
    const row = {iteration, rollout:data.stats, updates}; state.history.push(row); checkSources(sources);
    const path = resolve(folder, 'checkpoints', `iteration-${String(iteration).padStart(5, '0')}.json`);
    finalCheckpoint = {path, sha256:saveScorer(path, model, {bcOnlyTraining:state})};
    appendFileSync(resolve(folder, 'events.jsonl'), JSON.stringify({...row, checkpoint:finalCheckpoint}) + '\n');
    writeAtomicJson(resolve(folder, 'status.json'), {phase:'iteration-complete', iteration, checkpoint:finalCheckpoint});
    onProgress?.({...row, checkpoint:finalCheckpoint}); await new Promise(resolve => setImmediate(resolve));
  }
  const result = {status:'complete', config, counters:state.counters, finalCheckpoint, history:state.history};
  writeAtomicJson(resolve(folder, 'summary.json'), result, {overwrite:false}); return result;
}
// Tolerant comparisons make mathematical ties independent of floating-point summation order.
const cmp = (a, b) => Math.abs(a - b) <= 1e-9 ? 0 : a < b ? -1 : 1;
export function selectCalibration(rows, seeds) {
  const arms = ['parent', 'ppo-low', 'bc-only', 'ppo-fast'];
  if (!Number.isSafeInteger(seeds) || seeds < 1 || rows.length !== 1 + 3 * seeds ||
    arms.some(arm => rows.filter(r => r.arm === arm).length !== (arm === 'parent' ? 1 : seeds)) ||
    rows.some(r => r.arm === 'parent' ? r.seed !== -1 : !Number.isSafeInteger(r.seed) || r.seed < 0 || r.seed >= seeds) ||
    rows.some(r => !Number.isFinite(r.statistics?.session?.overall?.deltaPer100) || !Number.isFinite(r.statistics?.independent?.overall?.deltaPer100)) ||
    new Set(rows.map(r => `${r.arm}:${r.seed}`)).size !== rows.length) throw Error('Incomplete calibration grid');
  const ranking = arms.map((arm, order) => {
    const group = rows.filter(r => r.arm === arm);
    return {arm, order, meanSession:group.reduce((n, r) => n + r.statistics.session.overall.deltaPer100 / group.length, 0),
      meanIndependent:group.reduce((n, r) => n + r.statistics.independent.overall.deltaPer100 / group.length, 0)};
  }).sort((a, b) => cmp(b.meanSession, a.meanSession) || cmp(b.meanIndependent, a.meanIndependent) || a.order - b.order);
  const selected = rows.filter(r => r.arm === ranking[0].arm).sort((a, b) =>
    cmp(b.statistics.session.overall.deltaPer100, a.statistics.session.overall.deltaPer100) ||
    cmp(b.statistics.independent.overall.deltaPer100, a.statistics.independent.overall.deltaPer100) || a.seed - b.seed)[0];
  return {ranking, selected};
}
export async function runCalibration({out, referenceStudy, config:input={}, onProgress=null}) {
  const config = normalizeConfig(input), reference = resolve(referenceStudy);
  const old = JSON.parse(readFileSync(resolve(reference, 'summary.json'))), oldManifest = JSON.parse(readFileSync(resolve(reference, 'manifest.json')));
  if (old.status !== 'complete' || old.format !== 'kwx-scorer-ppo-comparison-1' || !Number.isSafeInteger(old.config.seeds) || old.config.seeds < 1) throw Error('Complete reference study required');
  const parent = loadScorer(oldManifest.parent.path), sources = calibrationSources(), baselines = [];
  if (parent.sha256 !== oldManifest.parent.sha256) throw Error('Reference parent changed');
  for (let seed = 0; seed < old.config.seeds; seed++) {
    const t = old.trainings.find(t => t.seed === seed && t.arm === 'ppo');
    if (!t) throw Error('Missing reference PPO seed');
    const c = loadScorer(t.finalCheckpoint.path), state = c.checkpoint.metadata.training;
    if (c.sha256 !== t.finalCheckpoint.sha256 || c.checkpoint.node !== process.version || state.parent.sha256 !== parent.sha256 || state.iteration !== old.config.iterations ||
      state.counters.hands !== old.config.iterations * old.config.handsPerIteration || state.config.bcCoef !== 0 ||
      state.config.seed !== deriveSeed(old.config.seed, 'training', seed) || config.fastLearningRate <= state.config.learningRate ||
      JSON.stringify(state.sourceHashes) !== JSON.stringify(trainingSources())) throw Error('Reference recipe or source mismatch');
    baselines.push({seed, arm:'ppo-low', ...t.finalCheckpoint, trainingConfig:state.config, counters:state.counters});
  }
  if (baselines.some(b => JSON.stringify({...b.trainingConfig, seed:'paired'}) !== JSON.stringify({...baselines[0].trainingConfig, seed:'paired'})))
    throw Error('Reference seeds have different training recipes');
  const folder = newFolder(out), began = Date.now(), sealedSeed = randomBytes(32).toString('hex');
  const manifest = {format:'kwx-bc-step-calibration-1', config, sourceHashes:sources, node:process.version,
    referenceStudy:reference, referenceSummarySha256:sha256(readFileSync(resolve(reference, 'summary.json'))),
    parent:{path:oldManifest.parent.path, sha256:parent.sha256}, baselines, startedAt:new Date().toISOString(),
    sealedSeedCommitment:sha256(sealedSeed),
    design:'Reuse all three frozen low-step PPO endpoints. Train BC-only and PPO at the same configured larger step, from identical parent weights/fresh Adam with matching training RNG seeds and environment budget. BC versus fast-PPO compares objectives at one step size; fast-PPO versus reused low-PPO compares step sizes. BC sees H0 labels on its own trajectories and does not use returns. Different policies generate different samples.',
    selection:'Rank parent/low-PPO/BC-only/fast-PPO by mean development 16-hand delta across seeds, then best seed in winning arm. Independent score breaks ties; numerical tolerance 1e-9. Parent wins full arm ties.',
    acceptance:'Freeze candidate before new sealed tests. Compare to H0 and unchanged parent; both session CI lower bounds above zero required for game promotion. Parent selection skips self-comparison. Development arm differences are exploratory, not individually confirmed effects.'};
  writeAtomicJson(resolve(folder, 'manifest.json'), manifest, {overwrite:false});
  writeAtomicJson(resolve(folder, 'sealed-seed.json'), {seed:sealedSeed}, {overwrite:false});
  const emit = e => { const p = {...e, elapsedSeconds:(Date.now() - began) / 1000};
    appendFileSync(resolve(folder, 'events.jsonl'), JSON.stringify(p) + '\n'); writeAtomicJson(resolve(folder, 'status.json'), p); onProgress?.(p); };
  const rows = [], trainings = [];
  const check = () => {
    checkSources(sources);
    if (sha256(readFileSync(oldManifest.parent.path)) !== parent.sha256) throw Error('Parent changed');
    for (const b of baselines) if (sha256(readFileSync(b.path)) !== b.sha256) throw Error('Reused baseline changed');
  };
  async function evaluate(row, incumbent, split, name) {
    check(); emit({phase:'evaluation-start', name});
    const report = await evaluateScorer({model:row.path, incumbent, incumbentKind:'structured', out:resolve(folder, name), split,
      seed:split === 'sealed' ? sealedSeed : deriveSeed(config.seed, 'development'),
      independentGroups:split === 'sealed' ? config.sealedGroups : config.developmentGroups,
      sessionGroups:split === 'sealed' ? config.sealedSessionGroups : config.developmentSessionGroups,
      sessionHands:config.sessionHands, bootstrapSamples:config.bootstrapSamples,
      onProgress:p => emit({phase:'evaluation', name, ...p})});
    if (report.manifest.candidate.sha256 !== row.sha256) throw Error('Evaluation candidate differs from frozen row');
    check(); return report;
  }
  async function add(row) {
    const r = await evaluate(row, null, 'development', row.arm === 'parent' ? 'development-parent' : `development-${row.seed}-${row.arm}`);
    rows.push({...row, statistics:r.statistics, totalGames:r.totalGames}); writeAtomicJson(resolve(folder, 'development.json'), rows);
  }
  try {
    await add({arm:'parent', seed:-1, path:oldManifest.parent.path, sha256:parent.sha256});
    for (const baseline of baselines) {
      await add(baseline);
      for (const arm of ['bc-only', 'ppo-fast']) {
        const trainConfig = {...baseline.trainingConfig, learningRate:config.fastLearningRate};
        emit({phase:'training-start', seed:baseline.seed, arm});
        const fn = arm === 'bc-only' ? trainBc : trainScorer;
        const result = await fn({out:resolve(folder, `seed-${baseline.seed}`, arm), initializeFrom:oldManifest.parent.path,
          iterations:old.config.iterations, config:trainConfig, onProgress:p => {
            if (arm === 'bc-only' || p.phase === 'iteration-complete') emit({phase:'training', seed:baseline.seed, arm,
              iteration:p.iteration, rollout:p.rollout, loss:p.updates.at(-1)?.loss}); }});
        const t = {arm, seed:baseline.seed, ...result.finalCheckpoint, counters:result.counters, trainingConfig:trainConfig};
        trainings.push(t); await add(t);
      }
    }
    const selection = selectCalibration(rows, old.config.seeds);
    writeAtomicJson(resolve(folder, 'selection-frozen.json'), {...selection, frozenAt:new Date().toISOString(), sealedSeedCommitment:manifest.sealedSeedCommitment}, {overwrite:false});
    emit({phase:'selection-frozen', arm:selection.selected.arm, seed:selection.selected.seed});
    const vsH0 = await evaluate(selection.selected, null, 'sealed', 'sealed-vs-H0');
    const vsParent = selection.selected.arm === 'parent' ? null : await evaluate(selection.selected, oldManifest.parent.path, 'sealed', 'sealed-vs-parent');
    const summary = {format:manifest.format, status:'complete', config, selection, trainings,
      sealed:{vsH0:vsH0.statistics, vsParent:vsParent?.statistics ?? null},
      parentImprovementSupported:!!vsParent && vsParent.statistics.session.overall.ci95[0] > 0,
      promotionSupported:!!vsParent && vsParent.statistics.session.overall.ci95[0] > 0 && vsH0.statistics.session.overall.ci95[0] > 0,
      trainingHands:trainings.reduce((n, t) => n + t.counters.hands, 0),
      reusedTrainingHands:baselines.reduce((n, t) => n + t.counters.hands, 0),
      totalEvaluationGames:rows.reduce((n, r) => n + r.totalGames, 0) + vsH0.totalGames + (vsParent?.totalGames || 0),
      elapsedSeconds:(Date.now() - began) / 1000, sourceHashes:sources, defaultGamePolicy:'H0'};
    check(); writeAtomicJson(resolve(folder, 'summary.json'), summary, {overwrite:false}); emit({phase:'complete'}); return summary;
  } catch (e) { emit({phase:'failed', message:e.message, stack:e.stack}); throw e; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), o = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--reference', '--config'].includes(args[i]) || !args[i + 1] || o[args[i]]) throw Error('Use --out NEW_DIRECTORY --reference COMPLETE_RL_STUDY [--config JSON]');
    o[args[i]] = args[i + 1];
  }
  if (!o['--out'] || !o['--reference']) throw Error('--out and --reference required');
  await runCalibration({out:o['--out'], referenceStudy:o['--reference'], config:o['--config'] ? JSON.parse(readFileSync(o['--config'], 'utf8')) : {},
    onProgress:p => console.log(JSON.stringify(p))});
}
