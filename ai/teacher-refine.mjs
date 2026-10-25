import {readFileSync, mkdirSync, readdirSync, existsSync, appendFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {MahjongEnvironment, replayEpisode} from './environment.mjs';
import {policyById} from './policies/index.mjs';
import {deriveSeed, seededRandom} from './random.mjs';
import {chooseModelAction, modelPolicyFactory} from './training/policy.mjs';
import {actionId, encodeObservation, legalActionIds} from './training/encoding.mjs';
import {ActorCritic} from './training/network.mjs';
import {collectImitation} from './training/collector.mjs';
import {imitationDiagnostics} from './training/diagnostics.mjs';
import {loadCheckpoint, makeCheckpoint, saveCheckpoint, writeAtomicJson, trainingSourceHashes} from './training/checkpoint.mjs';
import {runEvaluation} from './runner.mjs';
import {sha256, projectRoot} from './provenance.mjs';

export async function collectTeacherCorrections({model, episodes, seed, round, teacherFraction=0.5, onProgress=null}) {
  if (!Number.isSafeInteger(episodes) || episodes < 1 || !Number.isFinite(teacherFraction) || teacherFraction < 0 || teacherFraction > 1)
    throw Error('Invalid correction collection budget');
  const teacher = policyById('H0'), samples = [];
  const stats = {episodes, teacherEpisodes:0, modelEpisodes:0, decisions:0, choices:0, disagreements:0};
  for (let episode = 0; episode < episodes; episode++) {
    const teacherDriven = episode < Math.floor(episodes * teacherFraction);
    stats[teacherDriven ? 'teacherEpisodes' : 'modelEpisodes']++;
    const env = new MahjongEnvironment({seed:deriveSeed('teacher-refinement', seed, round, episode), record:false});
    let steps = 0;
    while (!env.done) {
      if (++steps > 500) throw Error('Correction episode exceeded action limit');
      const observation = env.observation(), legal = env.legalActions(), label = teacher(observation, legal);
      const executed = teacherDriven ? label : chooseModelAction(model, observation, legal, null, {deterministic:true}).action;
      const labelId = actionId(label), executedId = actionId(executed);
      samples.push({features:encodeObservation(observation), legalIds:legalActionIds(legal), actionId:labelId,
        executedActionId:executedId, driver:teacherDriven ? 'H0' : 'model'});
      if (legal.length > 1) { stats.choices++; stats.disagreements += Number(labelId !== executedId); }
      env.step(executed);
    }
    if ((episode + 1) % 50 === 0) onProgress?.({phase:'collect', round, episode:episode + 1, episodes});
    await new Promise(resolve => setImmediate(resolve));
  }
  stats.decisions = samples.length;
  return {samples, stats};
}

export async function runTeacherRefinement({parent, out, seed='kwx-correction-pilot-v1', rounds=3,
  episodes=800, epochs=4, validationEpisodes=120, groups=16, sessionGroups=4, sessionHands=16,
  bootstrapSamples=2000, onProgress=null}) {
  for (const [key, value] of Object.entries({rounds, episodes, epochs, validationEpisodes, groups, sessionGroups, sessionHands, bootstrapSamples}))
    if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid ${key}`);
  const folder = resolve(out), loaded = loadCheckpoint(parent);
  if (existsSync(folder) && readdirSync(folder).length) throw Error('Refinement needs a new/empty output directory');
  mkdirSync(folder, {recursive:true});
  const sources = {...trainingSourceHashes(), ...Object.fromEntries(['ai/teacher-refine.mjs', 'ai/training/diagnostics.mjs']
    .map(file => [file, sha256(readFileSync(resolve(projectRoot, file)))]))};
  const check = () => {
    for (const [file, hash] of Object.entries(sources)) if (sha256(readFileSync(resolve(projectRoot, file))) !== hash)
      throw Error(`Refinement source changed: ${file}`);
    if (sha256(readFileSync(parent)) !== loaded.sha256) throw Error('Parent model changed');
  };
  const started = Date.now(), emit = event => {
    const record = {...event, elapsedSeconds:(Date.now() - started) / 1000};
    appendFileSync(resolve(folder, 'events.jsonl'), JSON.stringify(record) + '\n');
    writeAtomicJson(resolve(folder, 'status.json'), record); onProgress?.(record);
  };
  const holdoutSeed = randomBytes(32).toString('hex');
  writeFileSync(resolve(folder, 'sealed-seed.txt'), holdoutSeed + '\n', {flag:'wx'});
  const manifest = {format:'kwx-teacher-correction-pilot-1', parent:{path:resolve(parent), sha256:loaded.sha256},
    config:{seed, rounds, episodes, epochs, validationEpisodes, groups, sessionGroups, sessionHands, bootstrapSamples,
      learningRate:0.0005, batchSize:128, teacherFraction:0.5}, sourceHashes:sources,
    sealedSeedCommitment:sha256(holdoutSeed),
    selection:'Lowest mean teacher-label cross entropy on two fixed independent validation distributions: H0-driven and original-parent-driven. Parent is eligible.',
    limits:'One-seed additional-data pilot, not a matched-data ablation. No sealed feedback enters training or candidate selection.'};
  writeAtomicJson(resolve(folder, 'manifest.json'), manifest, {overwrite:false});
  try {
    emit({phase:'validation'});
    const teacherValidation = await collectImitation({episodes:validationEpisodes, seed:deriveSeed(seed, 'teacher-validation')});
    const modelValidation = await collectTeacherCorrections({model:loaded.model, episodes:validationEpisodes,
      seed:deriveSeed(seed, 'parent-validation'), round:0, teacherFraction:0});
    const model = new ActorCritic({...loaded.model.config, seed:deriveSeed(seed, 'fresh-optimizer')});
    for (const [name, values] of Object.entries(loaded.model.parameters)) model.parameters[name].set(values);
    const measure = () => {
      const teacher = imitationDiagnostics(model, teacherValidation.samples), own = imitationDiagnostics(model, modelValidation.samples);
      return {teacher, own, meanCrossEntropy:(teacher.crossEntropy + own.crossEntropy) / 2};
    };
    const history = [{round:0, path:resolve(parent), sha256:loaded.sha256, validation:measure()}];
    let best = history[0], totalEpisodes = 0, totalSamples = 0;
    for (let round = 1; round <= rounds; round++) {
      emit({phase:'collection', round});
      const data = await collectTeacherCorrections({model, episodes, seed, round, onProgress:emit});
      const metrics = [];
      for (let epoch = 1; epoch <= epochs; epoch++) {
        const result = model.bcUpdate(data.samples, {epochs:1, learningRate:0.0005, batchSize:128,
          maxGradNorm:0.5, rng:seededRandom(deriveSeed(seed, 'update', round, epoch))});
        metrics.push(result); emit({phase:'epoch', round, epoch, metrics:result});
        await new Promise(resolve => setImmediate(resolve));
      }
      totalEpisodes += data.stats.episodes; totalSamples += data.stats.decisions;
      const validation = measure(), path = resolve(folder, `round-${round}.json`);
      check();
      const training = {config:manifest.config, parent:manifest.parent, round,
        counters:{imitationEpisodes:totalEpisodes, imitationSamples:totalSamples, learnerDecisions:0}, validation};
      const hash = saveCheckpoint(path, makeCheckpoint(model, training, {kind:'snapshot', codeHashes:sources}));
      const entry = {round, path, sha256:hash, stats:data.stats, metrics, validation};
      history.push(entry); if (validation.meanCrossEntropy < best.validation.meanCrossEntropy) best = entry;
      writeAtomicJson(resolve(folder, 'history.json'), history); emit({phase:'round-complete', round, validation});
    }
    writeAtomicJson(resolve(folder, 'selection-frozen.json'), {selected:best, frozenAt:new Date().toISOString(),
      sealedSeedCommitment:manifest.sealedSeedCommitment}, {overwrite:false});
    emit({phase:'selection-frozen', round:best.round});
    const selected = loadCheckpoint(best.path), candidateId = `model-${selected.sha256.slice(0, 12)}`;
    const comparisons = {};
    for (const opponent of ['H0', 'parent']) {
      if (opponent === 'parent' && best.round === 0) continue;
      const incumbentId = opponent === 'H0' ? 'H0' : `model-${loaded.sha256.slice(0, 12)}`;
      const factories = {[candidateId]:modelPolicyFactory(selected.model)};
      if (opponent === 'parent') factories[incumbentId] = modelPolicyFactory(loaded.model);
      let replayed = 0;
      const report = await runEvaluation({candidate:candidateId, incumbent:incumbentId, policyFactories:factories,
        split:'sealed', seed:holdoutSeed, independentGroups:groups, sessionGroups, sessionHands, bootstrapSamples,
        onProgress:p => emit({phase:'evaluation', opponent, ...p}), onEpisode:episode => {
          if (episode.group === 0 && episode.hand === 0) {
            replayEpisode(episode.replay); replayed++;
            appendFileSync(resolve(folder, `vs-${opponent}-replays.jsonl`), JSON.stringify(episode) + '\n');
          }
        }});
      check(); if (sha256(readFileSync(best.path)) !== selected.sha256) throw Error('Selected refinement model changed');
      comparisons[opponent] = {...report, replayed, candidateModel:{path:best.path, sha256:selected.sha256},
        incumbentModel:opponent === 'parent' ? manifest.parent : null, sourceHashes:sources};
      writeAtomicJson(resolve(folder, `sealed-vs-${opponent}.json`), comparisons[opponent], {overwrite:false});
    }
    const summary = {status:'complete', manifest, history, selected:best, totalEpisodes, totalSamples,
      statistics:Object.fromEntries(Object.entries(comparisons).map(([key, r]) => [key, r.statistics])),
      totalEvaluationGames:Object.values(comparisons).reduce((sum, r) => sum + r.totalGames, 0),
      elapsedSeconds:(Date.now() - started) / 1000, defaultGamePolicy:'H0'};
    check(); writeAtomicJson(resolve(folder, 'summary.json'), summary, {overwrite:false}); emit({phase:'complete'});
    return summary;
  } catch (error) {
    writeAtomicJson(resolve(folder, 'failure.json'), {message:error.message, stack:error.stack});
    emit({phase:'failed', message:error.message}); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--parent', '--out'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Use --parent CHECKPOINT --out NEW_DIRECTORY');
    options[args[i]] = args[i + 1];
  }
  if (!options['--parent'] || !options['--out']) throw Error('--parent and --out required');
  await runTeacherRefinement({parent:options['--parent'], out:options['--out'], onProgress:event => console.log(JSON.stringify(event))});
}
