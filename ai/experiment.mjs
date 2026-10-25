import {readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {ActorCritic} from './training/network.mjs';
import {INPUT_SIZE, ACTION_SIZE} from './training/encoding.mjs';
import {collectImitation} from './training/collector.mjs';
import {imitationDiagnostics} from './training/diagnostics.mjs';
import {modelPolicyFactory} from './training/policy.mjs';
import {makeCheckpoint, saveCheckpoint, loadCheckpoint, writeAtomicJson, trainingSourceHashes} from './training/checkpoint.mjs';
import {normalizeTrainingConfig, runTraining} from './training/trainer.mjs';
import {deriveSeed, seededRandom} from './random.mjs';
import {runEvaluation} from './runner.mjs';
import {replayEpisode} from './environment.mjs';
import {sha256, projectRoot} from './provenance.mjs';

export const DEFAULT_EXPERIMENT_CONFIG = Object.freeze({
  seed:'kwx-first-controlled-experiment-v1', seeds:3, hiddenSize:64,
  bcEpisodes:1200, validationEpisodes:160, bcEpochs:12, bcLearningRate:0.001, checkpointEvery:4,
  iterations:20, episodesPerIteration:96, ppoEpochs:2, learningRate:0.0001,
  entropyCoef:0.002, valueCoef:0.1, batchSize:128,
  developmentGroups:16, developmentSessionGroups:2,
  sealedGroups:32, sealedSessionGroups:8, sessionHands:16, bootstrapSamples:2000,
});
export function normalizeExperimentConfig(input={}) {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_EXPERIMENT_CONFIG, key)) throw Error(`Unknown experiment option: ${key}`);
  const c = {...DEFAULT_EXPERIMENT_CONFIG, ...input};
  if (typeof c.seed !== 'string' || !c.seed.length) throw Error('Experiment seed required');
  for (const [key, value] of Object.entries(c)) if (key !== 'seed') {
    if (['bcLearningRate', 'learningRate', 'entropyCoef', 'valueCoef'].includes(key)) {
      if (!Number.isFinite(value) || value <= 0) throw Error(`Invalid ${key}`);
    } else if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid ${key}`);
  }
  if (c.hiddenSize > 1024 || c.sessionHands > 1000) throw Error('Experiment dimensions exceed CPU limits');
  return c;
}
export function selectDevelopmentCandidate(rows) {
  const arms = [...new Set(rows.map(row => row.arm))];
  if (!arms.length) throw Error('No candidates');
  const seeds = [...new Set(rows.map(row => row.seed))];
  if (rows.length !== arms.length * seeds.length ||
    new Set(rows.map(r => `${r.arm}:${r.seed}`)).size !== rows.length) throw Error('Incomplete seed/arm grid');
  const score = row => row.statistics.session.overall.deltaPer100;
  const secondary = row => row.statistics.independent.overall.deltaPer100;
  if (!rows.every(row => Number.isFinite(score(row)) && Number.isFinite(secondary(row)))) throw Error('Missing development scores');
  const ranking = arms.map(arm => {
    const group = rows.filter(row => row.arm === arm);
    return {arm, meanSessionDelta:group.reduce((sum, row) => sum + score(row) / seeds.length, 0),
      meanIndependentDelta:group.reduce((sum, row) => sum + secondary(row) / seeds.length, 0)};
  }).sort((a, b) => b.meanSessionDelta - a.meanSessionDelta || b.meanIndependentDelta - a.meanIndependentDelta || a.arm.localeCompare(b.arm));
  const selected = rows.filter(row => row.arm === ranking[0].arm)
    .sort((a, b) => score(b) - score(a) || secondary(b) - secondary(a) || a.seed - b.seed)[0];
  return {ranking, selected};
}

export async function runExperiment({out, config:input={}, onProgress=null}) {
  const config = normalizeExperimentConfig(input), folder = resolve(out);
  if (existsSync(folder) && readdirSync(folder).length) throw Error('Experiment needs a new/empty output directory');
  mkdirSync(folder, {recursive:true});
  const sources = {...trainingSourceHashes(), ...Object.fromEntries(['ai/experiment.mjs', 'ai/training/diagnostics.mjs']
    .map(file => [file, sha256(readFileSync(resolve(projectRoot, file)))]))};
  const checkSources = () => {
    for (const [file, hash] of Object.entries(sources))
      if (sha256(readFileSync(resolve(projectRoot, file))) !== hash) throw Error(`Experiment source changed: ${file}`);
  };
  const began = Date.now();
  const emit = event => {
    const record = {...event, elapsedSeconds:(Date.now() - began) / 1000};
    appendFileSync(resolve(folder, 'events.jsonl'), JSON.stringify(record) + '\n');
    writeAtomicJson(resolve(folder, 'status.json'), record); onProgress?.(record);
  };
  // Commit a new holdout seed before learning. Its games are only generated after candidate selection.
  const sealedSeed = randomBytes(32).toString('hex');
  writeFileSync(resolve(folder, 'sealed-seed.txt'), sealedSeed + '\n', {flag:'wx'});
  const manifest = {format:'kwx-controlled-experiment-1', config, sourceHashes:sources,
    startedAt:new Date().toISOString(), node:process.version, sealedSeedCommitment:sha256(sealedSeed),
    arms:['imitation', 'self-play', 'league'],
    selection:'Highest mean development 16-hand score delta across training seeds; then best seed within that arm. Independent score breaks ties.',
    acceptance:'Fixed candidate versus H0 and its imitation parent; sealed session 95% paired interval must be above zero for both to support improvement. No automatic deployment.',
    limits:'Exploratory CPU study. Three seeds are insufficient to establish universal training stability. Holdout is consumed once reported.'};
  writeAtomicJson(resolve(folder, 'manifest.json'), manifest, {overwrite:false});
  const rows = [], imitationPaths = {};
  async function evaluate(path, incumbentPath, split, name) {
    checkSources();
    const candidate = loadCheckpoint(path), incumbent = incumbentPath ? loadCheckpoint(incumbentPath) : null;
    const candidateId = `model-${candidate.sha256.slice(0, 12)}`, incumbentId = incumbent ? `model-${incumbent.sha256.slice(0, 12)}` : 'H0';
    const factories = {[candidateId]:modelPolicyFactory(candidate.model)};
    if (incumbent) factories[incumbentId] = modelPolicyFactory(incumbent.model);
    let replayed = 0;
    const replayFile = resolve(folder, `${name}-sample-replays.jsonl`);
    const report = await runEvaluation({candidate:candidateId, incumbent:incumbentId, policyFactories:factories,
      split, seed:split === 'sealed' ? sealedSeed : deriveSeed(config.seed, 'fixed-development'),
      independentGroups:split === 'sealed' ? config.sealedGroups : config.developmentGroups,
      sessionGroups:split === 'sealed' ? config.sealedSessionGroups : config.developmentSessionGroups,
      sessionHands:config.sessionHands, bootstrapSamples:config.bootstrapSamples,
      onProgress:progress => emit({phase:'evaluation', name, ...progress}),
      onEpisode:episode => {
        // Stratified audit sample: both arms, every suite/pair, all six seats in the first group/hand.
        if (episode.group === 0 && episode.hand === 0) {
          replayEpisode(episode.replay); replayed++;
          appendFileSync(replayFile, JSON.stringify(episode) + '\n');
        }
      }});
    checkSources();
    if (sha256(readFileSync(path)) !== candidate.sha256 || incumbent && sha256(readFileSync(incumbentPath)) !== incumbent.sha256)
      throw Error('Model changed during evaluation');
    const result = {...report, models:{candidate:{path, sha256:candidate.sha256},
      incumbent:incumbent ? {path:incumbentPath, sha256:incumbent.sha256} : {id:'H0'}},
      sourceHashes:sources, replayed, holdoutUsed:split === 'sealed', descriptiveOnly:split !== 'sealed'};
    writeAtomicJson(resolve(folder, `${name}.json`), result, {overwrite:false});
    return result;
  }
  try {
    emit({phase:'validation-data'});
    const validation = await collectImitation({episodes:config.validationEpisodes,
      seed:deriveSeed(config.seed, 'heldout-teacher-validation')});
    for (let seedIndex = 0; seedIndex < config.seeds; seedIndex++) {
      const seed = deriveSeed(config.seed, 'training-seed', seedIndex), seedFolder = resolve(folder, `seed-${seedIndex}`);
      mkdirSync(seedFolder, {recursive:true});
      emit({phase:'imitation-data', seed:seedIndex});
      let data = await collectImitation({episodes:config.bcEpisodes, seed,
        onProgress:p => { if (p.episode % 100 === 0) emit({...p, seed:seedIndex}); }});
      const model = new ActorCritic({inputSize:INPUT_SIZE, hiddenSize:config.hiddenSize, actionSize:ACTION_SIZE, seed});
      const diagnostics = [{epoch:0, validation:imitationDiagnostics(model, validation.samples)}];
      let best = null;
      for (let epoch = 1; epoch <= config.bcEpochs; epoch++) {
        const metrics = model.bcUpdate(data.samples, {epochs:1, learningRate:config.bcLearningRate,
          batchSize:config.batchSize, maxGradNorm:0.5, rng:seededRandom(deriveSeed(seed, 'bc-epoch', epoch))});
        emit({phase:'imitation-epoch', seed:seedIndex, epoch, metrics});
        if (epoch % config.checkpointEvery === 0 || epoch === config.bcEpochs) {
          const measured = imitationDiagnostics(model, validation.samples);
          const trainConfig = normalizeTrainingConfig({seed, hiddenSize:config.hiddenSize, bcEpisodes:config.bcEpisodes,
            bcEpochs:epoch, batchSize:config.batchSize, bcLearningRate:config.bcLearningRate});
          const state = {config:trainConfig, counters:{imitationEpisodes:data.episodes, imitationSamples:data.samples.length, learnerDecisions:0},
            epoch, validation:measured};
          const path = resolve(seedFolder, `imitation-epoch-${epoch}.json`);
          checkSources(); const hash = saveCheckpoint(path, makeCheckpoint(model, state, {kind:'snapshot', codeHashes:sources}));
          diagnostics.push({epoch, metrics, validation:measured, path, sha256:hash});
          if (!best || measured.crossEntropy < best.validation.crossEntropy) best = diagnostics.at(-1);
          writeAtomicJson(resolve(seedFolder, 'imitation-diagnostics.json'), diagnostics);
          emit({phase:'imitation-validation', seed:seedIndex, epoch, validation:measured});
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      data = null;
      imitationPaths[seedIndex] = best.path;
      for (const arm of manifest.arms) {
        let path = best.path;
        if (arm !== 'imitation') {
          const training = await runTraining({out:resolve(seedFolder, arm), initializeFrom:best.path, iterations:config.iterations,
            config:{seed:deriveSeed(seed, 'ppo'), hiddenSize:config.hiddenSize, bcEpisodes:0,
              episodesPerIteration:config.episodesPerIteration, ppoEpochs:config.ppoEpochs, learningRate:config.learningRate,
              entropyCoef:config.entropyCoef, valueCoef:config.valueCoef, batchSize:config.batchSize,
              selfPlayFraction:arm === 'self-play' ? 1 : 0.25, evalEvery:0},
            onProgress:p => { if (p.phase.endsWith('complete')) emit({...p, seed:seedIndex, arm}); }});
          path = training.finalCheckpoint.path;
        }
        const report = await evaluate(path, null, 'development', `development-${seedIndex}-${arm}`);
        rows.push({seed:seedIndex, arm, path, sha256:report.models.candidate.sha256, statistics:report.statistics});
        writeAtomicJson(resolve(folder, 'development.json'), rows);
      }
    }
    const selection = selectDevelopmentCandidate(rows);
    writeAtomicJson(resolve(folder, 'selection-frozen.json'), {...selection, frozenAt:new Date().toISOString(),
      sealedSeedCommitment:manifest.sealedSeedCommitment}, {overwrite:false});
    emit({phase:'selection-frozen', selection});
    const vsH0 = await evaluate(selection.selected.path, null, 'sealed', 'sealed-vs-H0');
    const parentPath = imitationPaths[selection.selected.seed];
    const vsParent = selection.selected.path === parentPath ? null :
      await evaluate(selection.selected.path, parentPath, 'sealed', 'sealed-vs-imitation');
    const supported = vsH0.statistics.session.overall.ci95[0] > 0 &&
      Boolean(vsParent && vsParent.statistics.session.overall.ci95[0] > 0);
    const summary = {format:manifest.format, status:'complete', config, selection,
      sealed:{vsH0:vsH0.statistics, vsImitation:vsParent?.statistics ?? null},
      improvementSupportedOnThisHoldout:supported, defaultGamePolicy:'H0',
      elapsedSeconds:(Date.now() - began) / 1000, sourceHashes:sources,
      totalEvaluationGames:rows.reduce((sum, row) => sum +
        2 * (row.statistics.independent.overall.hands + row.statistics.session.overall.hands), 0) +
        vsH0.totalGames + (vsParent?.totalGames || 0)};
    checkSources(); writeAtomicJson(resolve(folder, 'summary.json'), summary, {overwrite:false});
    emit({phase:'complete', improvementSupportedOnThisHoldout:supported});
    return summary;
  } catch (error) {
    writeAtomicJson(resolve(folder, 'failure.json'), {message:error.message, stack:error.stack,
      partialDevelopment:rows, note:'Completed snapshots and PPO checkpoints are retained. Never reuse consumed holdout for tuning.'});
    emit({phase:'failed', message:error.message}); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--config'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Use --out NEW_DIRECTORY [--config JSON]');
    options[args[i]] = args[i + 1];
  }
  if (!options['--out']) throw Error('--out required');
  await runExperiment({out:options['--out'], config:options['--config'] ? JSON.parse(readFileSync(options['--config'], 'utf8')) : {},
    onProgress:event => console.log(JSON.stringify(event))});
}
