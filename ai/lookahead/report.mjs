import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderReport, studySources} from './study.mjs';
import {sha256} from '../provenance.mjs';

export function publishLocalReport({study, out, tests, diagnostics, targeted}) {
  study = resolve(study); out = resolve(out);
  if (existsSync(out)) throw Error('Report output exists');
  const read = name => JSON.parse(readFileSync(resolve(study, name), 'utf8'));
  const plan = read('plan.json'), summary = read('summary.json'), verification = read('verification.json');
  assert.equal(verification.games, summary.games);
  assert.equal(verification.verifierSha256, sha256(readFileSync(new URL('./verify.mjs', import.meta.url))));
  assert.deepEqual(studySources(), plan.sourceHashes);
  assert.equal(summary.planSha256, sha256(readFileSync(resolve(study, 'plan.json'))));
  const log = readFileSync(resolve(tests), 'utf8');
  const testCount = Number(/ℹ tests (\d+)/u.exec(log)?.[1]);
  assert.ok(testCount > 0);
  assert.equal(Number(/ℹ pass (\d+)/u.exec(log)?.[1]), testCount);
  assert.equal(Number(/ℹ fail (\d+)/u.exec(log)?.[1]), 0);
  if (targeted) {
    const extraLog = readFileSync(resolve(targeted), 'utf8');
    assert.ok(Number(/ℹ pass (\d+)/u.exec(extraLog)?.[1]) > 0);
    assert.equal(Number(/ℹ fail (\d+)/u.exec(extraLog)?.[1]), 0);
  }
  const diagnosticPath = resolve(diagnostics, 'diagnostics.json');
  const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf8'));
  assert.deepEqual(diagnostic.sources, plan.sourceHashes);
  mkdirSync(out, {recursive:true});
  const copies = {};
  const copy = (source, name) => { copyFileSync(source, resolve(out, name)); copies[name] = sha256(readFileSync(source)); };
  for (const name of ['plan.json', 'summary.json', 'selection.json', 'verification.json']) copy(resolve(study, name), name);
  copy(resolve(tests), 'tests.log'); copy(diagnosticPath, 'diagnostics.json');
  if (targeted) copy(resolve(targeted), 'tests-targeted.log');
  const stages = ['development-ties', 'development-same-shanten', ...(summary.selected ? ['sealed'] : [])];
  const reports = {};
  for (const stage of stages) {
    reports[stage] = read(`${stage}/report.json`);
    copy(resolve(study, stage, 'report.json'), `${stage}.json`);
  }
  const n = x => x.toFixed(2), extra = ['', '## 完整复核与行为诊断', '',
    `${testCount} 项回归测试全部通过。独立复核工具已经从种子重新发牌并核对实际轮庄，完整重放本轮全部 ${verification.games} 局评测牌谱，核对逐步合法性、守恒、结算、分组收益和重新计算的 bootstrap 区间。这里的全部复核在各阶段原先的分层抽样之外另行完成。`, '',
    ...(targeted ? ['完整回归后又加强了暗手交换不变性和连续两摸同种牌的扣除断言，相关五项搜索测试再次全部通过，日志见 tests-targeted.log。', ''] : []),
    `另有 ${diagnostic.hands} 局 H0 轨迹用于事后行为解释，未参与训练、开发选择或封闭计分。这些诊断局不计入 ${summary.games} 局评测总数。`, '',
    '| 策略 | 共同 H0 局面的出牌决策数 | 实际搜索次数 | 改变选择 | 减少当前进张的选择 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(diagnostic.modes).map(([mode, r]) => `| ${mode} | ${r.discardDecisions} | ${r.searched} | ${r.changed} | ${r.lowerImmediateOuts} |`), '',
    '诊断中的公开手牌例子与计算解释见 [两步公开牌效搜索](../../两步公开牌效搜索.md)。选择变化与结构指标提升均不能替代实战收益证据。', '',
    '| 阶段 | 本机实际评测耗时/秒 | 候选决策均值/ms | 候选决策 p95/ms | 改变 H0 选择次数 |',
    '| --- | ---: | ---: | ---: | ---: |'];
  for (const [stage, r] of Object.entries(reports)) {
    const latency = r.latency[r.candidate];
    extra.push(`| ${stage} | ${n(r.seconds)} | ${n(latency.meanMs)} | ${n(latency.p95Ms)} | ${r.search.changed} |`);
  }
  extra.push('', '耗时包含观测、正式动作校验和牌谱保存。部分运行期间并行执行了回归测试与行为诊断；延迟是本轮本机测量，不代表其他硬件的性能。', '');
  if (reports.sealed) {
    const r = reports.sealed;
    extra.push('## 封闭评测的收益分项', '',
      '| 对手组合 / 实验臂 | 胡牌分/百手 | 杠分/百手 | 查叫分/百手 | 胡牌率 | 放炮率 |',
      '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const pair of r.opponentPairs) for (const arm of ['candidate', 'incumbent']) {
      const records = r.records.filter(x => x.suite === 'session' && x.opponentPair === pair.id);
      const sum = key => records.reduce((s, x) => s + x[arm][key], 0), hands = sum('hands');
      const score = key => n(sum(key) / hands / r.base * 100), rate = key => n(sum(key) / hands * 100);
      extra.push(`| ${pair.id} / ${arm} | ${score('huScore')} | ${score('kongScore')} | ${score('drawScore')} | ${rate('wins')}% | ${rate('dealIns')}% |`);
    }
    extra.push('', '分项是各版本实际经历的局面的描述。由于动作会改变后续牌局，不能把分项变化解释成某个动作的独立因果收益。', '');
  }
  extra.push('本轮没有神经网络参数更新。研究策略和全部旧检查点保留，游戏默认仍使用 H0。后续应把两步牌效作为可学习的输入，并补足终局收益与对手提前结束牌局的影响，再用新的固定预算实验检验。', '');
  writeFileSync(resolve(out, '实验结果.md'), renderReport(plan, summary) + extra.join('\n'));
  writeFileSync(resolve(out, 'artifacts.json'), JSON.stringify({createdAt:new Date().toISOString(),
    sourceStudy:study, files:copies, reportSourceSha256:sha256(readFileSync(fileURLToPath(import.meta.url)))}, null, 2) + '\n');
  return {out, games:summary.games, tests:testCount, selected:summary.selected};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !['study', 'out', 'tests', 'diagnostics', 'targeted'].includes(key) ||
      args[i + 1] === undefined || Object.hasOwn(options, key)) throw Error('Use --study --out --tests --diagnostics');
    options[key] = args[i + 1];
  }
  if (['study', 'out', 'tests', 'diagnostics'].some(key => !options[key])) throw Error('All four options are required');
  console.log(JSON.stringify(publishLocalReport(options)));
}
