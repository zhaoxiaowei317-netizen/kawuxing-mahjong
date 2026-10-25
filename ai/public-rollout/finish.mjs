import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deriveSeed} from '../random.mjs';
import {sha256} from '../provenance.mjs';
import {summarizePaired} from '../statistics.mjs';
import {ARMS, rolloutSources, selectDevelopment, evaluateArm, renderReport} from './study.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function loadPlan(out) {
  const plan = read(resolve(out, 'plan.json')), selection = read(resolve(out, 'selection.json'));
  assert.deepEqual(rolloutSources(), plan.sourceHashes);
  assert.equal(selection.planSha256, sha256(readFileSync(resolve(out, 'plan.json'))));
  assert.equal(selectDevelopment(selection.rows), selection.selected);
  return {plan, selection};
}

// Run only a comparison already declared by the frozen plan. The original
// sequential driver safely refuses an existing phase; finishStudy aggregates it.
export async function runSealedComparison({out, against, onProgress = console.log}) {
  out = resolve(out);
  const {plan, selection} = loadPlan(out), selected = selection.selected;
  if (!selected || !['H0', 'proposal-once'].includes(against) || selected === 'proposal-once' && against !== 'H0')
    throw Error('Comparison is not declared by this plan');
  if (existsSync(resolve(out, 'summary.json'))) throw Error('Study already complete');
  const b = plan.budget;
  return evaluateArm({candidate:selected, incumbent:against, common:plan.common,
    out:resolve(out, `sealed-vs-${against}`), seed:deriveSeed(plan.sealedSeed, against), split:'sealed',
    independentGroups:b.sealedGroups, sessionGroups:b.sealedSessionGroups, sessionHands:b.sessionHands,
    bootstrapSamples:b.bootstrapSamples, sources:plan.sourceHashes,
    onProgress:p => onProgress({stage:`sealed-vs-${against}`, ...p})});
}

export function finishStudy({out, write = true}) {
  out = resolve(out);
  if (write && existsSync(resolve(out, 'summary.json'))) throw Error('Summary already exists');
  const {plan, selection} = loadPlan(out), selected = selection.selected, b = plan.budget;
  const reportHashes = {};
  function checked(stage, candidate, incumbent, sealed) {
    const path = resolve(out, stage, 'report.json');
    if (!existsSync(path)) throw Error(`Comparison incomplete: ${stage}`);
    const r = read(path);
    assert.deepEqual(r.sourceHashes, plan.sourceHashes); assert.equal(r.candidate, candidate); assert.equal(r.incumbent, incumbent);
    assert.equal(r.split, sealed ? 'sealed' : 'development');
    assert.equal(r.seed, sealed ? deriveSeed(plan.sealedSeed, incumbent) : plan.developmentSeed);
    assert.equal(r.independentGroups, sealed ? b.sealedGroups : b.developmentGroups);
    assert.equal(r.sessionGroups, sealed ? b.sealedSessionGroups : b.developmentSessionGroups);
    assert.equal(r.sessionHands, b.sessionHands);
    assert.equal(r.totalGames, 24 * (r.independentGroups + r.sessionGroups * r.sessionHands));
    assert.equal(r.illegalActions, 0); assert.equal(r.conservationCheckedEveryAction, true);
    assert.deepEqual(r.statistics, summarizePaired(r.records, {bootstrapSamples:b.bootstrapSamples,
      seed:deriveSeed(r.seed, 'bootstrap'), base:r.base}));
    for (const [id, config] of Object.entries(r.configs)) assert.deepEqual(config, plan.configs[id]);
    assert.equal(sha256(readFileSync(resolve(out, stage, 'replays.jsonl.gz'))), r.artifacts.replays.sha256);
    assert.equal(sha256(readFileSync(resolve(out, stage, 'searches.jsonl.gz'))), r.artifacts.decisions.sha256);
    assert.equal(r.artifacts.replays.recorded, r.totalGames);
    reportHashes[stage] = sha256(readFileSync(path)); return r;
  }
  const development = ARMS.map(arm => {
    const r = checked(`development-${arm}`, arm, 'H0', false);
    const row = {arm, delta:r.statistics.session.overall.deltaPer100, ci95:r.statistics.session.overall.ci95,
      games:r.totalGames, seconds:r.seconds, search:r.search[arm]};
    assert.deepEqual(row, selection.rows.find(x => x.arm === arm)); return row;
  });
  const sealed = {};
  if (selected) for (const incumbent of ['H0', ...(selected !== 'proposal-once' ? ['proposal-once'] : [])]) {
    const r = checked(`sealed-vs-${incumbent}`, selected, incumbent, true);
    sealed[incumbent] = {primary:r.statistics.session.overall, independent:r.statistics.independent.overall,
      byOpponentPair:r.statistics.session.byOpponentPair, games:r.totalGames, seconds:r.seconds, search:r.search};
  }
  const summary = {version:plan.version, completedAt:new Date().toISOString(), selected, development, sealed,
    games:development.reduce((s, r) => s + r.games, 0) + Object.values(sealed).reduce((s, r) => s + r.games, 0),
    trainingHands:0, productionPolicy:'H0', sourceHashes:plan.sourceHashes, planSha256:selection.planSha256,
    selectionSha256:sha256(readFileSync(resolve(out, 'selection.json'))),
    positiveSealedEvidence:!!(sealed.H0 && sealed.H0.primary.ci95[0] > 0),
    positiveRolloutFilterEvidence:!!(sealed['proposal-once'] && sealed['proposal-once'].primary.ci95[0] > 0)};
  assert.deepEqual(rolloutSources(), plan.sourceHashes);
  if (write) {
    save(resolve(out, 'summary.json'), summary);
    writeFileSync(resolve(out, '结果.md'), renderReport(plan, summary));
    save(resolve(out, 'orchestration.json'), {completedAt:new Date().toISOString(),
      method:'Aggregate only complete phases matching the original frozen plan; no additional evaluation or reselection.',
      reportHashes, finalizerSha256:sha256(readFileSync(fileURLToPath(import.meta.url)))});
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, flag, out, againstFlag, against] = process.argv.slice(2);
  if (flag !== '--out' || !out) throw Error('Use finish --out directory or evaluate --out directory --against planned-comparison');
  if (command === 'finish' && process.argv.length === 5) {
    const result = finishStudy({out}); console.log(JSON.stringify({games:result.games, selected:result.selected}));
  } else if (command === 'evaluate' && againstFlag === '--against' && against && process.argv.length === 7) {
    await runSealedComparison({out, against, onProgress:p => console.log(JSON.stringify(p))});
  } else throw Error('Invalid arguments');
}
