import assert from 'node:assert/strict';
import {readFileSync, copyFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderReport, ARMS, rolloutSources} from './study.mjs';
import {sha256} from '../provenance.mjs';

export function publishLocalReport({study, out, tests, targeted}) {
  study = resolve(study); out = resolve(out);
  if (existsSync(out)) throw Error('Report output exists');
  const read = file => JSON.parse(readFileSync(resolve(study, file), 'utf8'));
  const plan = read('plan.json'), summary = read('summary.json'), verification = read('verification.json');
  const audit = read('counterfactual-audit.json');
  assert.equal(audit.scope, 'all-completed');
  assert.deepEqual(rolloutSources(), plan.sourceHashes);
  assert.equal(verification.games, summary.games); assert.equal(verification.traces, audit.roots);
  assert.equal(verification.verifierSha256, sha256(readFileSync(new URL('./verify.mjs', import.meta.url))));
  assert.equal(audit.diagnosticSha256, sha256(readFileSync(new URL('./diagnose.mjs', import.meta.url))));
  const log = readFileSync(tests, 'utf8'), count = Number(/ℹ tests (\d+)/u.exec(log)?.[1]);
  assert.ok(count > 0); assert.equal(Number(/ℹ pass (\d+)/u.exec(log)?.[1]), count);
  assert.equal(Number(/ℹ fail (\d+)/u.exec(log)?.[1]), 0);
  const extraLog = readFileSync(targeted, 'utf8');
  assert.ok(Number(/ℹ pass (\d+)/u.exec(extraLog)?.[1]) > 0); assert.equal(Number(/ℹ fail (\d+)/u.exec(extraLog)?.[1]), 0);
  mkdirSync(out, {recursive:true}); const files = {};
  const copy = (source, name) => { copyFileSync(source, resolve(out, name)); files[name] = sha256(readFileSync(source)); };
  for (const name of ['plan.json', 'summary.json', 'selection.json', 'verification.json', 'counterfactual-audit.json']) copy(resolve(study, name), name);
  if (existsSync(resolve(study, 'orchestration.json'))) copy(resolve(study, 'orchestration.json'), 'orchestration.json');
  copy(resolve(tests), 'tests.log'); copy(resolve(targeted), 'tests-targeted.log');
  const stages = [...ARMS.map(id => `development-${id}`), ...Object.keys(summary.sealed).map(id => `sealed-vs-${id}`)];
  const reports = {};
  for (const stage of stages) { reports[stage] = read(`${stage}/report.json`); copy(resolve(study, stage, 'report.json'), `${stage}.json`); }
  const n = x => x.toFixed(2);
  const lines = ['', '## 完整验证及独立计数', '',
    `${count} 项完整回归测试通过。完整回归之后加入的赛后反事实诊断和分阶段汇总，也通过了单独的端到端测试，日志分别见 tests.log、tests-targeted.log。`, '',
    `全部 ${verification.games} 局实际评测重新按种子发牌、检查实际轮庄并完整回放，核对所有动作、结算、收益分组及重算的配对区间。全部 ${verification.traces} 条提案记录均对应回实际牌局当时的公开观测及动作。`, '',
    `比赛中的收益筛选另外完成 ${verification.hypotheticalGames} 个假设终局分支。这些不是新增训练手数，也不计入 ${verification.games} 局实战式评测。抽样完整重算 ${verification.tracesFullyRecomputed} 条收益提案及其全部假设分支，其余提案检查种子、配置、收益分解与选择规则。`, '',
    `赛后诊断另做 ${audit.hypotheticalAuditGames} 个实际世界的反事实分支，全部仅作离线分析，不把真实暗手传回策略，也不把验收数据转作训练集。`, '',
    '| 阶段 | 实际评测局数 | 本机耗时/秒 | 策略 | 改变 H0 次数 | 收益搜索次数 | 假设终局数 |',
    '| --- | ---: | ---: | --- | ---: | ---: | ---: |'];
  for (const [stage, r] of Object.entries(reports)) for (const [id, stats] of Object.entries(r.search))
    lines.push(`| ${stage} | ${r.totalGames} | ${n(r.seconds)} | ${id} | ${stats.changed} | ${stats.searches} | ${stats.hypotheticalGames} |`);
  lines.push('', '同一阶段可能同时列候选和对照策略，其实际局数与耗时不能重复相加。部分期间同时运行回归测试；本机延迟不代表移动端性能。', '',
    '## 赛后同一局面的反事实诊断', '',
    '审计程序在已经记录的选择点，使用实际暗手和牌墙分别推演 H0 出牌与前瞻出牌；它与比赛决策代码隔离。这只能描述这一批已出现局面里的已实现结果，不是真实条件期望，也不能替代整套策略的独立比赛。', '',
    '| 阶段 / 策略 | 提案数 | 接受替代数 | 始终采用提案的实现收益和 | 实际所选动作的实现收益和 | 筛选相对始终采用提案的差值 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const stage of audit.stages) for (const [id, row] of Object.entries(stage.byPolicy))
    lines.push(`| ${stage.stage} / ${id} | ${row.roots} | ${row.accepted} | ${n(row.realizedAlternativeGainSum)} | ${n(row.realizedChosenGainSum)} | ${n(row.keptH0InsteadOfProposalGainSum)} |`);
  lines.push('', '表中收益以 H0 在同一选择点的后续结果为零点，单位为底分；是这些提案的收益之和，不是每百手。不同策略遇到的局面可能不同，不能跨行直接排名。', '',
    '当前成果是可复核的公开信息终局收益搜索与诊断机制。游戏默认仍为 H0，旧研究模型保持原样。下一步应根据诊断区分未知牌假设偏差、对手模型偏差与采样噪声，再决定是否值得扩大采样或训练收益模型。', '');
  const reportPath = resolve(out, '实验结果.md');
  writeFileSync(reportPath, renderReport(plan, summary) + lines.join('\n'));
  files['实验结果.md'] = sha256(readFileSync(reportPath));
  writeFileSync(resolve(out, 'artifacts.json'), JSON.stringify({createdAt:new Date().toISOString(), files,
    reportSourceSha256:sha256(readFileSync(fileURLToPath(import.meta.url)))}, null, 2) + '\n');
  return {out, games:summary.games, hypotheticalGames:verification.hypotheticalGames, tests:count, selected:summary.selected};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !['study', 'out', 'tests', 'targeted'].includes(key) || args[i + 1] === undefined ||
      Object.hasOwn(options, key)) throw Error('Use --study --out --tests --targeted');
    options[key] = args[i + 1];
  }
  if (Object.keys(options).length !== 4) throw Error('Four options required');
  console.log(JSON.stringify(publishLocalReport(options)));
}
