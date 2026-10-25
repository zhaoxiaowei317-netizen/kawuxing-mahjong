import {readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {loadScorer, scorerSources} from './io.mjs';
import {evaluateScorer} from './evaluate.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';
import {sha256, projectRoot} from '../provenance.mjs';

const self = fileURLToPath(import.meta.url);
export function prepareConfirmation({study, out, independentGroups=32, sessionGroups=32, sessionHands=16, bootstrapSamples=5000}) {
  for (const n of [independentGroups, sessionGroups, sessionHands, bootstrapSamples]) if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid confirmation budget');
  const folder = resolve(out), root = resolve(study), s = JSON.parse(readFileSync(resolve(root, 'summary.json')));
  const m = JSON.parse(readFileSync(resolve(root, 'manifest.json')));
  if (s.status !== 'complete' || s.selection.selected.arm === 'parent') throw Error('A fixed trained candidate is required');
  if (existsSync(folder) && readdirSync(folder).length) throw Error('Confirmation output must be new');
  const candidate = loadScorer(s.selection.selected.path), parent = loadScorer(m.parent.path);
  if (candidate.sha256 !== s.selection.selected.sha256 || parent.sha256 !== m.parent.sha256) throw Error('Model hash mismatch');
  const plan = {format:'kwx-one-fixed-confirmation-1', preparedAt:new Date().toISOString(), node:process.version,
    study:root, studySummarySha256:sha256(readFileSync(resolve(root, 'summary.json'))),
    candidate:{path:s.selection.selected.path, sha256:candidate.sha256}, parent:m.parent,
    independentGroups, sessionGroups, sessionHands, bootstrapSamples, seed:randomBytes(32).toString('hex'),
    priorStatistics:s.sealed, sourceHashes:{...scorerSources(),
      'ai/action-scorer/evaluate.mjs':sha256(readFileSync(resolve(projectRoot, 'ai/action-scorer/evaluate.mjs'))),
      'ai/action-scorer/confirm.mjs':sha256(readFileSync(self))},
    purpose:'One additional independent confirmation selected after the initial inconclusive test. All model weights fixed before fresh games. No training, no candidate reselection, no extension based on interim results.',
    inference:'Primary evidence is this fresh batch alone; previous batch reported separately, not pooled for significance. Both 16-hand paired 95% lower bounds above zero support replication against H0 and parent. No automatic deployment.',
    replayAudit:'All episodes enforce canonical legality/conservation and are saved. Each comparison immediately replays 48 stratified examples; this confirmation does not claim full replay of every saved episode.'};
  plan.seedCommitment = sha256(plan.seed); mkdirSync(folder, {recursive:true});
  writeAtomicJson(resolve(folder, 'plan.json'), plan, {overwrite:false}); return plan;
}
function checkedPlan(out) {
  const folder = resolve(out), plan = JSON.parse(readFileSync(resolve(folder, 'plan.json')));
  if (plan.format !== 'kwx-one-fixed-confirmation-1' || plan.node !== process.version) throw Error('Confirmation version mismatch');
  for (const [file, hash] of Object.entries(plan.sourceHashes)) if (sha256(readFileSync(resolve(projectRoot, file))) !== hash) throw Error(`Confirmation source changed: ${file}`);
  if (sha256(plan.seed) !== plan.seedCommitment || sha256(readFileSync(plan.candidate.path)) !== plan.candidate.sha256 ||
    sha256(readFileSync(plan.parent.path)) !== plan.parent.sha256 || sha256(readFileSync(resolve(plan.study, 'summary.json'))) !== plan.studySummarySha256)
    throw Error('Confirmation models/plan changed');
  return {folder, plan};
}
export async function runConfirmation({out, against, onProgress=null}) {
  if (!['H0', 'parent'].includes(against)) throw Error('Use H0 or parent');
  const {folder, plan} = checkedPlan(out);
  const report = await evaluateScorer({model:plan.candidate.path, incumbent:against === 'parent' ? plan.parent.path : null,
    incumbentKind:'structured', out:resolve(folder, `vs-${against}`), split:'sealed', seed:plan.seed,
    independentGroups:plan.independentGroups, sessionGroups:plan.sessionGroups, sessionHands:plan.sessionHands,
    bootstrapSamples:plan.bootstrapSamples, onProgress});
  checkedPlan(out); return report;
}
export function finalizeConfirmation(out) {
  const {folder, plan} = checkedPlan(out), reports = {};
  for (const against of ['H0', 'parent']) {
    const r = JSON.parse(readFileSync(resolve(folder, `vs-${against}`, 'report.json'))), m = r.manifest;
    if (m.candidate.sha256 !== plan.candidate.sha256 || m.seed !== plan.seed || m.split !== 'sealed' ||
      m.independentGroups !== plan.independentGroups || m.sessionGroups !== plan.sessionGroups ||
      m.sessionHands !== plan.sessionHands || m.bootstrapSamples !== plan.bootstrapSamples ||
      Date.parse(m.startedAt) < Date.parse(plan.preparedAt) ||
      (against === 'H0' ? m.incumbent.id !== 'H0' : m.incumbent.sha256 !== plan.parent.sha256) ||
      sha256(readFileSync(resolve(folder, `vs-${against}`, 'replays.jsonl.gz'))) !== r.replaySha256) throw Error('Confirmation evidence mismatch');
    reports[against] = r;
  }
  const result = {status:'complete', plan, statistics:Object.fromEntries(Object.entries(reports).map(([key, r]) => [key, r.statistics])),
    replicationSupported:Object.values(reports).every(r => r.statistics.session.overall.ci95[0] > 0),
    totalGames:Object.values(reports).reduce((n, r) => n + r.totalGames, 0),
    stratifiedReplays:Object.values(reports).reduce((n, r) => n + r.replayed, 0), defaultGamePolicy:'H0'};
  const n = x => x.toFixed(2), lines = ['# 固定候选独立复验', '',
    `复验${result.replicationSupported ? '支持候选同时优于 H0 和原牌效模型' : '尚未支持候选同时优于 H0 和原牌效模型'}。游戏默认仍为 H0。`, '',
    `候选在首批测试区间跨零后固定。本次另开新种子、预先固定预算，仅复验一次，不训练或改选模型。新增 ${result.totalGames} 手牌评测，${result.stratifiedReplays} 份分层审计牌谱现场重放；所有完整牌谱保留，未声称全部重放。`, '',
    '| 对照 | 批次 | 完整 16 局分差/百手 | 95% 区间 | 独立组数 |', '| --- | --- | ---: | --- | ---: |'];
  for (const key of ['H0', 'parent']) for (const [batch, row] of [
    ['首批', plan.priorStatistics[key === 'H0' ? 'vsH0' : 'vsParent'].session.overall], ['新复验', reports[key].statistics.session.overall]])
    lines.push(`| ${key} | ${batch} | ${n(row.deltaPer100)} | [${row.ci95.map(n).join(', ')}] | ${row.groups} |`);
  lines.push('', '两批单独报告，不合并挑选显著结果。当前证据只适用于固定候选与当前两个对手组合，不能泛化为人类段位或全部打法最强。', '',
    `候选：[模型](<${plan.candidate.path.replaceAll('\\', '/')}>); SHA-256 ${plan.candidate.sha256}。`, '',
    'plan.json 保存复验前预算、种子承诺、固定权重、源码哈希及首批统计。summary.json 保存本次结论；vs-H0/ 与 vs-parent/ 保存原始分组记录和全部压缩牌谱。', '');
  writeAtomicJson(resolve(folder, 'summary.json'), result, {overwrite:false});
  writeFileSync(resolve(folder, '复验结果.md'), lines.join('\n')); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const args = process.argv.slice(2), o = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--mode', '--out', '--study', '--against'].includes(args[i]) || !args[i + 1] || o[args[i]]) throw Error('Invalid confirmation arguments');
    o[args[i]] = args[i + 1];
  }
  if (!o['--out']) throw Error('--out required');
  if (o['--mode'] === 'prepare') { const p = prepareConfirmation({study:o['--study'], out:o['--out']}); console.log(JSON.stringify({prepared:true, candidate:p.candidate, sessionGroups:p.sessionGroups})); }
  else if (o['--mode'] === 'run') await runConfirmation({out:o['--out'], against:o['--against'], onProgress:p => console.log(JSON.stringify(p))});
  else if (o['--mode'] === 'finalize') { const r = finalizeConfirmation(o['--out']); console.log(JSON.stringify({complete:true, supported:r.replicationSupported, totalGames:r.totalGames})); }
  else throw Error('Use --mode prepare|run|finalize');
}
