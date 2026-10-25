import {mkdirSync, existsSync, readdirSync, readFileSync, appendFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {MahjongEnvironment, replayEpisode} from '../environment.mjs';
import {selectAction as h0} from '../policies/h0.mjs';
import {deriveSeed, seededRandom} from '../random.mjs';
import {encodeObservation, legalActionIds, actionId, INPUT_SIZE, ACTION_SIZE} from '../training/encoding.mjs';
import {ActorCritic} from '../training/network.mjs';
import {modelPolicyFactory} from '../training/policy.mjs';
import {makeCheckpoint, saveCheckpoint, loadCheckpoint, writeAtomicJson, trainingSourceHashes} from '../training/checkpoint.mjs';
import {encodeCandidates} from './features.mjs';
import {ActionScorer} from './model.mjs';
import {saveScorer, loadScorer, scorerFactory, scorerSources} from './io.mjs';
import {sha256, projectRoot} from '../provenance.mjs';
import {runEvaluation} from '../runner.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
export const DEFAULT_CONFIG = Object.freeze({seed:'kwx-same-data-action-features-v1', seeds:3,
  trainingHands:600, validationHands:120, epochs:12, checkpointEvery:4, batchSize:128,
  scorerLearningRate:0.02, rawLearningRate:0.001, hiddenSize:64,
  developmentGroups:8, developmentSessionGroups:1, sealedGroups:32, sealedSessionGroups:8,
  sessionHands:16, bootstrapSamples:2000});
export function normalizeConfig(input={}) {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw Error(`Unknown option: ${key}`);
  const c = {...DEFAULT_CONFIG, ...input};
  if (typeof c.seed !== 'string' || !c.seed.length) throw Error('Seed required');
  for (const [key, value] of Object.entries(c)) if (key !== 'seed') {
    if (['scorerLearningRate', 'rawLearningRate'].includes(key)) {
      if (!Number.isFinite(value) || value <= 0) throw Error(`Invalid ${key}`);
    } else if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid ${key}`);
  }
  return c;
}
// Every row has two encodings of exactly the same observation and the same H0 target.
export async function collectPairedData({hands, seed, onProgress=null}) {
  const raw = [], structured = [], actionCounts = {};
  if (!Number.isSafeInteger(hands) || hands < 1) throw Error('Positive hand count required');
  for (let hand = 0; hand < hands; hand++) {
    const env = new MahjongEnvironment({seed:deriveSeed('candidate-teacher-data', seed, hand), record:false});
    let decisions = 0;
    while (!env.done) {
      if (++decisions > 500) throw Error('Teacher action budget exceeded');
      const o = env.observation(), legal = env.legalActions(), action = h0(o, legal), id = actionId(action);
      raw.push({features:encodeObservation(o), legalIds:legalActionIds(legal), actionId:id});
      structured.push({...encodeCandidates(o, legal), actionId:id});
      const kind = action.type === 'discard' && action.reveal ? 'reveal' : action.type;
      actionCounts[kind] = (actionCounts[kind] || 0) + 1;
      env.step(action);
    }
    onProgress?.({hand:hand + 1, hands, decisions:raw.length}); await tick();
  }
  return {raw, structured, hands, decisions:raw.length, actionCounts};
}
const category = id => id < 21 ? 'discard' : id < 42 ? 'reveal' : id < 84 ? 'kong' : ['hu', 'peng', 'ming', 'pass'][id - 84];
export function diagnostics(model, samples, arm) {
  let crossEntropy = 0, correct = 0, choices = 0, choiceCorrect = 0;
  const byAction = {};
  for (const s of samples) {
    const f = arm === 'raw' ? model.forward(s.features, s.legalIds) : model.forward(s);
    const ids = arm === 'raw' ? s.legalIds : f.ids;
    const logs = arm === 'raw' ? ids.map(id => f.logProbs[id]) : f.logProbs;
    const index = logs.reduce((best, q, i) => q > logs[best] ? i : best, 0);
    const hit = Number(ids[index] === s.actionId), name = category(s.actionId);
    crossEntropy -= logs[ids.indexOf(s.actionId)] / samples.length; correct += hit;
    if (ids.length > 1) {
      choices++; choiceCorrect += hit;
      const row = byAction[name] ??= {count:0, correct:0}; row.count++; row.correct += hit;
    }
  }
  for (const row of Object.values(byAction)) row.accuracy = row.correct / row.count;
  return {samples:samples.length, crossEntropy, accuracy:correct / samples.length,
    choices, choiceAccuracy:choices ? choiceCorrect / choices : null, byAction};
}
export function selectArm(rows, arm) {
  const options = rows.filter(r => r.arm === arm);
  if (!options.length || options.some(r => !Number.isFinite(r.statistics.session.overall.deltaPer100))) throw Error('Missing development scores');
  return [...options].sort((a, b) => b.statistics.session.overall.deltaPer100 - a.statistics.session.overall.deltaPer100 ||
    b.statistics.independent.overall.deltaPer100 - a.statistics.independent.overall.deltaPer100 || a.seed - b.seed)[0];
}
export async function runStudy({out, config:input={}, onProgress=null}) {
  const config = normalizeConfig(input), folder = resolve(out);
  if (existsSync(folder) && readdirSync(folder).length) throw Error('Study requires a new empty directory');
  mkdirSync(folder, {recursive:true});
  const began = Date.now(), sources = {...trainingSourceHashes(), ...scorerSources(),
    'ai/action-scorer/experiment.mjs':sha256(readFileSync(fileURLToPath(import.meta.url)))};
  const checkSources = () => {
    for (const [file, hash] of Object.entries(sources)) if (sha256(readFileSync(resolve(projectRoot, file))) !== hash) throw Error(`Source changed: ${file}`);
  };
  const emit = event => {
    const record = {...event, elapsedSeconds:(Date.now() - began) / 1000};
    appendFileSync(resolve(folder, 'events.jsonl'), JSON.stringify(record) + '\n');
    writeAtomicJson(resolve(folder, 'status.json'), record); onProgress?.(record);
  };
  const sealedSeed = randomBytes(32).toString('hex');
  writeFileSync(resolve(folder, 'sealed-seed.txt'), sealedSeed + '\n', {flag:'wx'});
  const manifest = {format:'kwx-candidate-representation-study-1', config, sourceHashes:sources, node:process.version,
    startedAt:new Date().toISOString(), sealedSeedCommitment:sha256(sealedSeed),
    training:'Identical H0 trajectories, targets, epochs and per-epoch shuffle seed within each raw/structured pair. Architecture and learning rate differ.',
    selection:'Within each seed/arm select lowest fixed validation cross-entropy; then choose the best development 16-hand score seed separately in each arm; independent score and lower seed break ties.',
    features:'Structured action scorer uses public shanten, unseen improving tiles, waits, hypothetical fan and H0-informed reveal threshold features. No H0-selected action indicator. Peng continuation is structural, before next-turn legal filtering.',
    acceptance:'Chosen structured model versus H0 and chosen raw model on new sealed seeds. Both session paired 95% lower bounds must exceed zero. Descriptive exploratory study; no automatic deployment.',
    limits:'Whole-representation comparison with different parameter counts and learning rates; not an architecture-only or compute-matched ablation. Three training seeds; two opponent pairs. Holdout consumed once reported.'};
  writeAtomicJson(resolve(folder, 'manifest.json'), manifest, {overwrite:false});
  const rows = [];
  const load = row => row.arm === 'raw' ? loadCheckpoint(row.path) : loadScorer(row.path);
  const factory = (row, model) => row.arm === 'raw' ? modelPolicyFactory(model) : scorerFactory(model);
  async function evaluate(row, incumbent, split, name) {
    checkSources(); const c = load(row), i = incumbent ? load(incumbent) : null;
    const candidate = `model-${c.sha256.slice(0, 12)}`, incumbentId = i ? `model-${i.sha256.slice(0, 12)}` : 'H0';
    const policyFactories = {[candidate]:factory(row, c.model)};
    if (i) policyFactories[incumbentId] = factory(incumbent, i.model);
    let replayed = 0;
    const report = await runEvaluation({candidate, incumbent:incumbentId, policyFactories, split,
      seed:split === 'sealed' ? sealedSeed : deriveSeed(config.seed, 'development'),
      independentGroups:split === 'sealed' ? config.sealedGroups : config.developmentGroups,
      sessionGroups:split === 'sealed' ? config.sealedSessionGroups : config.developmentSessionGroups,
      sessionHands:config.sessionHands, bootstrapSamples:config.bootstrapSamples,
      onProgress:p => emit({phase:'evaluation', name, ...p}),
      onEpisode:e => {
        if (e.group === 0 && e.hand === 0) {
          replayEpisode(e.replay); replayed++;
          appendFileSync(resolve(folder, `${name}-replays.jsonl`), JSON.stringify(e) + '\n');
        }
      }});
    checkSources();
    if (sha256(readFileSync(row.path)) !== c.sha256 || i && sha256(readFileSync(incumbent.path)) !== i.sha256) throw Error('Model changed during evaluation');
    const result = {...report, models:{candidate:{...row, sha256:c.sha256}, incumbent:incumbent ? {...incumbent, sha256:i.sha256} : {id:'H0'}},
      sourceHashes:sources, replayed, holdoutUsed:split === 'sealed'};
    writeAtomicJson(resolve(folder, `${name}.json`), result, {overwrite:false}); return result;
  }
  try {
    emit({phase:'validation-data'});
    const validation = await collectPairedData({hands:config.validationHands, seed:deriveSeed(config.seed, 'validation'),
      onProgress:p => { if (p.hand % 40 === 0) emit({phase:'validation-data', ...p}); }});
    for (let seed = 0; seed < config.seeds; seed++) {
      emit({phase:'training-data', seed});
      let data = await collectPairedData({hands:config.trainingHands, seed:deriveSeed(config.seed, 'training', seed),
        onProgress:p => { if (p.hand % 100 === 0) emit({phase:'training-data', seed, ...p}); }});
      const seedFolder = resolve(folder, `seed-${seed}`); mkdirSync(seedFolder, {recursive:true});
      writeAtomicJson(resolve(seedFolder, 'data.json'), {hands:data.hands, decisions:data.decisions, actionCounts:data.actionCounts});
      for (const arm of ['raw', 'structured']) {
        const modelSeed = deriveSeed(config.seed, 'model', seed);
        const model = arm === 'raw' ? new ActorCritic({inputSize:INPUT_SIZE, actionSize:ACTION_SIZE, hiddenSize:config.hiddenSize, seed:modelSeed}) : new ActionScorer(modelSeed);
        let best = null; const history = [];
        for (let epoch = 1; epoch <= config.epochs; epoch++) {
          const options = {epochs:1, batchSize:config.batchSize, maxGradNorm:0.5,
            learningRate:arm === 'raw' ? config.rawLearningRate : config.scorerLearningRate,
            rng:seededRandom(deriveSeed(config.seed, 'epoch', seed, epoch))};
          const metrics = arm === 'raw' ? model.bcUpdate(data.raw, options) : model.update(data.structured, options);
          emit({phase:'training', seed, arm, epoch, loss:metrics.loss});
          if (epoch % config.checkpointEvery === 0 || epoch === config.epochs) {
            const measured = diagnostics(model, validation[arm], arm);
            const path = resolve(seedFolder, `${arm}-epoch-${epoch}.json`), metadata = {seed, arm, epoch, validation:measured, config};
            checkSources();
            const hash = arm === 'raw' ? saveCheckpoint(path, makeCheckpoint(model, metadata, {kind:'snapshot', codeHashes:sources})) : saveScorer(path, model, metadata);
            const row = {...metadata, path, sha256:hash}; history.push(row);
            if (!best || measured.crossEntropy < best.validation.crossEntropy) best = row;
            writeAtomicJson(resolve(seedFolder, `${arm}-history.json`), history);
            emit({phase:'validation', seed, arm, epoch, validation:measured});
          }
          await tick();
        }
        const row = {seed, arm, path:best.path, sha256:best.sha256, epoch:best.epoch, validation:best.validation};
        const report = await evaluate(row, null, 'development', `development-${seed}-${arm}`);
        rows.push({...row, statistics:report.statistics, totalGames:report.totalGames, replayed:report.replayed});
        writeAtomicJson(resolve(folder, 'development.json'), rows);
      }
      data = null;
    }
    const selected = {structured:selectArm(rows, 'structured'), raw:selectArm(rows, 'raw')};
    writeAtomicJson(resolve(folder, 'selection-frozen.json'), {selected, frozenAt:new Date().toISOString(), sealedSeedCommitment:manifest.sealedSeedCommitment}, {overwrite:false});
    emit({phase:'selection-frozen', selected});
    const vsH0 = await evaluate(selected.structured, null, 'sealed', 'sealed-vs-H0');
    const vsRaw = await evaluate(selected.structured, selected.raw, 'sealed', 'sealed-vs-raw');
    const summary = {format:manifest.format, status:'complete', config, selected,
      sealed:{vsH0:vsH0.statistics, vsRaw:vsRaw.statistics},
      improvementSupportedOnThisHoldout:vsH0.statistics.session.overall.ci95[0] > 0 && vsRaw.statistics.session.overall.ci95[0] > 0,
      trainingHands:config.seeds * config.trainingHands, validationHands:config.validationHands,
      totalEvaluationGames:rows.reduce((sum, r) => sum + r.totalGames, 0) + vsH0.totalGames + vsRaw.totalGames,
      replayed:rows.reduce((sum, r) => sum + r.replayed, 0) + vsH0.replayed + vsRaw.replayed,
      defaultGamePolicy:'H0', elapsedSeconds:(Date.now() - began) / 1000, sourceHashes:sources};
    checkSources(); writeAtomicJson(resolve(folder, 'summary.json'), summary, {overwrite:false});
    emit({phase:'complete', totalEvaluationGames:summary.totalEvaluationGames}); return summary;
  } catch (error) { emit({phase:'failed', message:error.message, stack:error.stack}); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--out')) throw Error('Usage: node ai/action-scorer/experiment.mjs --out NEW_DIRECTORY [--config FILE]');
  runStudy({out:get('--out'), config:args.includes('--config') ? JSON.parse(readFileSync(get('--config'), 'utf8')) : {},
    onProgress:p => console.log(JSON.stringify(p))}).catch(e => { console.error(e); process.exitCode = 1; });
}
