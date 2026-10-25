import {readFileSync, readdirSync, mkdirSync, existsSync, copyFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256} from './provenance.mjs';
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--run', '--out'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Use --run DIRECTORY --out NEW_DIRECTORY');
  options[args[i]] = args[i + 1];
}
if (!options['--run'] || !options['--out']) throw Error('--run and --out required');
const run = resolve(options['--run']), out = resolve(options['--out']);
if (existsSync(out) && readdirSync(out).length) throw Error('Report output must be new/empty');
const s = JSON.parse(readFileSync(resolve(run, 'summary.json'), 'utf8'));
if (s.status !== 'complete') throw Error('Refinement has not completed');
if (sha256(readFileSync(s.selected.path)) !== s.selected.sha256) throw Error('Model hash mismatch');
const n = x => Number(x).toFixed(2), pct = x => `${n(x * 100)}%`;
const improvedH0 = s.statistics.H0.session.overall.ci95[0] > 0;
const improvedParent = Boolean(s.statistics.parent && s.statistics.parent.session.overall.ci95[0] > 0);
const lines = ['# 模型自身局面纠错实验结果', '',
  `完整 16 局独立验收：相对 H0 ${improvedH0 ? '区间下界高于 0' : '未证实超越'}；相对模仿父模型 ${improvedParent ? '区间下界高于 0' : '未证实提升'}。游戏默认仍为 H0。`, '',
  `额外训练 ${s.totalEpisodes} 局、${s.totalSamples} 条老师标签，评测 ${s.totalEvaluationGames} 局，用时 ${n(s.elapsedSeconds / 60)} 分钟。选中第 ${s.selected.round} 轮，0 表示原父模型。`, '',
  '## 固定验证集学习曲线', '',
  '| 轮次 | H0 局面选择一致率 | 原父模型局面选择一致率 | H0 局面交叉熵 | 原父模型局面交叉熵 | 平均交叉熵 |',
  '| --- | ---: | ---: | ---: | ---: | ---: |'];
for (const h of s.history) lines.push(`| ${h.round} | ${pct(h.validation.teacher.choiceAccuracy)} | ${pct(h.validation.own.choiceAccuracy)} | ${n(h.validation.teacher.crossEntropy)} | ${n(h.validation.own.crossEntropy)} | ${n(h.validation.meanCrossEntropy)} |`);
lines.push('', '选择只使用上述固定验证数据，验证标签不进入训练。候选固定后才运行下面的独立牌局。', '',
  '## 独立验收', '',
  '| 对照 | 测试 | 对手组合 | 候选/百局 | 对照/百局 | 分差/百局 | 分差 95% 区间 | 独立组数 |',
  '| --- | --- | --- | ---: | ---: | ---: | --- | ---: |');
for (const [against, statistics] of Object.entries(s.statistics)) for (const [suite, result] of Object.entries(statistics))
  for (const [pair, row] of [['总体', result.overall], ...Object.entries(result.byOpponentPair)])
    lines.push(`| ${against} | ${suite} | ${pair} | ${n(row.candidatePer100)} | ${n(row.incumbentPer100)} | ${n(row.deltaPer100)} | [${row.ci95.map(n).join(', ')}] | ${row.groups} |`);
lines.push('', '按完整初始牌局组做配对 bootstrap，不能把组内座位和每桌各局当成独立样本。本补充实验只有一个训练种子，且比父模型使用更多数据，不是等数据量消融；不能将进步直接归因于某一种数据采集方式。封存批次已经消耗。', '',
  `模型：[第 ${s.selected.round} 轮](<${s.selected.path.replaceAll('\\', '/')}>); SHA-256 ${s.selected.sha256}。`, '',
  `原始记录：[运行目录](<${run.replaceAll('\\', '/')}>); 本报告目录保留配置、选择、逐轮诊断和封存原始统计。`, '');
mkdirSync(out, {recursive:true});
for (const file of ['summary.json', 'manifest.json', 'history.json', 'selection-frozen.json', 'sealed-vs-H0.json', 'sealed-vs-parent.json'])
  if (existsSync(resolve(run, file))) copyFileSync(resolve(run, file), resolve(out, file));
writeFileSync(resolve(out, '实验结果.md'), lines.join('\n'));
console.log(resolve(out, '实验结果.md'));
