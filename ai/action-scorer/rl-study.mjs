import {readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {trainScorer, trainingSources} from './train.mjs';
import {loadScorer} from './io.mjs';
import {evaluateScorer} from './evaluate.mjs';
import {deriveSeed} from '../random.mjs';
import {sha256, projectRoot} from '../provenance.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';

export const DEFAULT_CONFIG = Object.freeze({seed:'kwx-anchored-scorer-ppo-study-v1', seeds:3, iterations:12,
  handsPerIteration:128, selfPlayFraction:0.25, learningRate:0.002, epochs:2, batchSize:128,
  entropyCoef:0.002, valueCoef:0.1, anchorCoef:0.2, targetKl:0.03,
  developmentGroups:8, developmentSessionGroups:1, sealedGroups:32, sealedSessionGroups:8,
  sessionHands:16, bootstrapSamples:2000});
export function normalizeConfig(input={}) {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw Error(`Unknown RL study option: ${key}`);
  const c = {...DEFAULT_CONFIG, ...input};
  if (typeof c.seed !== 'string' || !c.seed.length) throw Error('RL study seed required');
  for (const [key, value] of Object.entries(c)) if (key !== 'seed') {
    if (['selfPlayFraction', 'learningRate', 'entropyCoef', 'valueCoef', 'anchorCoef', 'targetKl'].includes(key)) {
      if (!Number.isFinite(value) || value < 0 || ['learningRate', 'anchorCoef', 'targetKl'].includes(key) && value === 0) throw Error(`Invalid ${key}`);
    } else if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid ${key}`);
  }
  if (c.selfPlayFraction > 1) throw Error('Invalid self play fraction'); return c;
}
export function selectCandidate(rows, seeds) {
  if (rows.length !== 1 + 2 * seeds || rows.filter(r => r.arm === 'parent').length !== 1 ||
    ['ppo', 'anchored'].some(arm => rows.filter(r => r.arm === arm).length !== seeds) ||
    rows.some(r => !Number.isFinite(r.statistics.session.overall.deltaPer100) || !Number.isFinite(r.statistics.independent.overall.deltaPer100)) ||
    rows.some(r => r.arm === 'parent' ? r.seed !== -1 : !Number.isSafeInteger(r.seed) || r.seed < 0 || r.seed >= seeds) ||
    new Set(rows.map(r => `${r.arm}:${r.seed}`)).size !== rows.length) throw Error('Incomplete RL comparison grid');
  const rank = ['parent', 'ppo', 'anchored'].map((arm, order) => {
    const group = rows.filter(r => r.arm === arm);
    return {arm, order, meanSession:group.reduce((sum, r) => sum + r.statistics.session.overall.deltaPer100 / group.length, 0),
      meanIndependent:group.reduce((sum, r) => sum + r.statistics.independent.overall.deltaPer100 / group.length, 0)};
  }).sort((a, b) => b.meanSession - a.meanSession || b.meanIndependent - a.meanIndependent || a.order - b.order);
  const selected = rows.filter(r => r.arm === rank[0].arm).sort((a, b) =>
    b.statistics.session.overall.deltaPer100 - a.statistics.session.overall.deltaPer100 ||
    b.statistics.independent.overall.deltaPer100 - a.statistics.independent.overall.deltaPer100 || a.seed - b.seed)[0];
  return {ranking:rank, selected};
}
export async function runRlStudy({out, parent, config:input={}, onProgress=null}) {
  const config = normalizeConfig(input), folder = resolve(out), parentLoaded = loadScorer(parent);
  if (existsSync(folder) && readdirSync(folder).length) throw Error('RL study output must be new/empty');
  const sources = {...trainingSources(), ...Object.fromEntries(['ai/action-scorer/rl-study.mjs', 'ai/action-scorer/evaluate.mjs']
    .map(file => [file, sha256(readFileSync(resolve(projectRoot, file)))]))};
  const checkSources = () => {
    for (const [file, hash] of Object.entries(sources)) if (sha256(readFileSync(resolve(projectRoot, file))) !== hash) throw Error(`Source changed: ${file}`);
    if (sha256(readFileSync(parent)) !== parentLoaded.sha256) throw Error('Parent model changed');
  };
  mkdirSync(folder, {recursive:true}); const began = Date.now(), sealedSeed = randomBytes(32).toString('hex');
  const manifest = {format:'kwx-scorer-ppo-comparison-1', config, sourceHashes:sources, startedAt:new Date().toISOString(),
    node:process.version, parent:{path:resolve(parent), sha256:parentLoaded.sha256}, sealedSeedCommitment:sha256(sealedSeed),
    design:`${config.seeds} paired training seeds, same parent weights and fresh Adam. Pure PPO versus PPO plus coefficient-${config.anchorCoef} teacher-label cross entropy. Both use the same gradient update schedule and environment budget; actual learner samples and KL-stopped epochs may differ.`,
    opponents:'25% self-play by default, otherwise one rotating learner versus two H0 policies. Single-hand terminal net returns / 16; all kong/draw fees included once.',
    selection:'Rank parent and training arms by mean development 16-hand delta across seeds, then choose best seed in winning arm. Independent score breaks ties; parent wins exact arm ties. Parent is eligible.',
    acceptance:'After selection freeze, compare to H0 and unchanged parent using new sealed groups. Both 16-hand paired CI lower bounds must exceed zero to support promotion. If parent wins selection, skip self-comparison and report no trained improvement. No game deployment.'};
  writeAtomicJson(resolve(folder, 'manifest.json'), manifest, {overwrite:false});
  writeAtomicJson(resolve(folder, 'sealed-seed.json'), {seed:sealedSeed}, {overwrite:false});
  const emit = event => { const p = {...event, elapsedSeconds:(Date.now() - began) / 1000};
    appendFileSync(resolve(folder, 'events.jsonl'), JSON.stringify(p) + '\n'); writeAtomicJson(resolve(folder, 'status.json'), p); onProgress?.(p); };
  const rows = [], trainings = [];
  async function evaluate(row, incumbent, split, name) {
    checkSources(); emit({phase:'evaluation-start', name});
    const report = await evaluateScorer({model:row.path, incumbent, incumbentKind:'structured', out:resolve(folder, name), split,
      seed:split === 'sealed' ? sealedSeed : deriveSeed(config.seed, 'development'),
      independentGroups:split === 'sealed' ? config.sealedGroups : config.developmentGroups,
      sessionGroups:split === 'sealed' ? config.sealedSessionGroups : config.developmentSessionGroups,
      sessionHands:config.sessionHands, bootstrapSamples:config.bootstrapSamples,
      onProgress:p => emit({phase:'evaluation', name, ...p})});
    checkSources(); return report;
  }
  try {
    const parentRow = {arm:'parent', seed:-1, path:resolve(parent), sha256:parentLoaded.sha256};
    const parentEval = await evaluate(parentRow, null, 'development', 'development-parent');
    rows.push({...parentRow, statistics:parentEval.statistics, totalGames:parentEval.totalGames});
    for (let seed = 0; seed < config.seeds; seed++) for (const arm of ['ppo', 'anchored']) {
      emit({phase:'training-start', seed, arm});
      const training = await trainScorer({out:resolve(folder, `seed-${seed}`, arm), initializeFrom:parent,
        iterations:config.iterations, config:{seed:deriveSeed(config.seed, 'training', seed),
          handsPerIteration:config.handsPerIteration, selfPlayFraction:config.selfPlayFraction,
          learningRate:config.learningRate, epochs:config.epochs, batchSize:config.batchSize,
          entropyCoef:config.entropyCoef, valueCoef:config.valueCoef, bcCoef:arm === 'anchored' ? config.anchorCoef : 0, targetKl:config.targetKl},
        onProgress:p => { if (p.phase === 'iteration-complete') emit({phase:'training', seed, arm,
          iteration:p.iteration, rollout:p.rollout, updates:p.updates.map(u => ({loss:u.loss,kl:u.approxKlAfter,anchor:u.anchorLossAfter}))}); }});
      trainings.push({seed, arm, counters:training.counters, finalCheckpoint:training.finalCheckpoint});
      const row = {seed, arm, ...training.finalCheckpoint}, evaluation = await evaluate(row, null, 'development', `development-${seed}-${arm}`);
      rows.push({...row, statistics:evaluation.statistics, totalGames:evaluation.totalGames});
      writeAtomicJson(resolve(folder, 'development.json'), rows);
    }
    const selection = selectCandidate(rows, config.seeds);
    writeAtomicJson(resolve(folder, 'selection-frozen.json'), {...selection, frozenAt:new Date().toISOString(), sealedSeedCommitment:manifest.sealedSeedCommitment}, {overwrite:false});
    emit({phase:'selection-frozen', arm:selection.selected.arm, seed:selection.selected.seed});
    const vsH0 = await evaluate(selection.selected, null, 'sealed', 'sealed-vs-H0');
    const vsParent = selection.selected.arm === 'parent' ? null : await evaluate(selection.selected, parent, 'sealed', 'sealed-vs-parent');
    const summary = {format:manifest.format, status:'complete', config, selection, trainings,
      sealed:{vsH0:vsH0.statistics, vsParent:vsParent?.statistics ?? null},
      improvementSupportedOnThisHoldout:vsH0.statistics.session.overall.ci95[0] > 0 && Boolean(vsParent && vsParent.statistics.session.overall.ci95[0] > 0),
      trainingHands:trainings.reduce((sum, t) => sum + t.counters.hands, 0),
      learnerDecisions:trainings.reduce((sum, t) => sum + t.counters.learnerDecisions, 0),
      totalEvaluationGames:rows.reduce((sum, r) => sum + r.totalGames, 0) + vsH0.totalGames + (vsParent?.totalGames || 0),
      elapsedSeconds:(Date.now() - began) / 1000, sourceHashes:sources, defaultGamePolicy:'H0'};
    checkSources(); writeAtomicJson(resolve(folder, 'summary.json'), summary, {overwrite:false}); emit({phase:'complete', summary}); return summary;
  } catch (error) { emit({phase:'failed', message:error.message, stack:error.stack}); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--parent', '--config'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Use --out NEW_DIRECTORY --parent SCORER_MODEL [--config JSON]');
    options[args[i]] = args[i + 1];
  }
  if (!options['--out'] || !options['--parent']) throw Error('--out and --parent required');
  await runRlStudy({out:options['--out'], parent:options['--parent'],
    config:options['--config'] ? JSON.parse(readFileSync(options['--config'], 'utf8')) : {}, onProgress:p => console.log(JSON.stringify(p))});
}
