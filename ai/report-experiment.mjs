import {readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync} from 'node:fs';
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
const read = file => JSON.parse(readFileSync(resolve(run, file), 'utf8'));
const summary = read('summary.json'), manifest = read('manifest.json'), rows = read('development.json');
if (summary.status !== 'complete') throw Error('Experiment is not complete');
const selected = summary.selection.selected;
if (sha256(readFileSync(selected.path)) !== selected.sha256) throw Error('Selected model hash mismatch');
const c = summary.config, n = x => x === null || x === undefined ? '—' : Number(x).toFixed(2);
const interval = row => `[${row.ci95.map(n).join(', ')}]`;
const percent = x => x === null || x === undefined ? '—' : `${n(x * 100)}%`;
const lines = ['# 首轮 AI 对照实验结果', '',
  summary.improvementSupportedOnThisHoldout
    ? '本次选定候选在这批封存对手与牌局中，同时超过 H0 和自身模仿起点；结论仅适用于本次预设协议，游戏默认仍为 H0。'
    : '本轮没有通过预设的强化学习提升门槛，游戏默认继续使用 H0。训练流程完成不等于牌技提升。', '',
  `共 ${c.seeds} 个训练种子、${rows.length} 个终点候选、${summary.totalEvaluationGames.toLocaleString('en-US')} 局评测；实验用时 ${n(summary.elapsedSeconds / 60)} 分钟。`, '',
  '## 模仿是否学会', '',
  '下表来自与训练分离的 H0 决策验证集。“选择准确率”排除了唯一合法动作。动作一致率只用于诊断，不能代替实战得分。', '',
  '| 训练种子 | 选中遍数 | 总准确率 | 选择准确率 | 自由出牌一致率 | 亮倒一致率 | 胡牌一致率 | 杠一致率 | 交叉熵 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
const diagnostics = [];
for (let seed = 0; seed < c.seeds; seed++) {
  const d = read(`seed-${seed}/imitation-diagnostics.json`);
  const path = rows.find(r => r.seed === seed && r.arm === 'imitation').path;
  const chosen = d.find(row => row.path === path), v = chosen.validation;
  diagnostics.push({seed, chosen, curve:d});
  lines.push(`| ${seed} | ${chosen.epoch} | ${percent(v.accuracy)} | ${percent(v.choiceAccuracy)} | ${percent(v.categories.discard?.choiceAccuracy)} | ${percent(v.categories.reveal?.accuracy)} | ${percent(v.categories.hu?.accuracy)} | ${percent(v.categories.kong?.accuracy)} | ${n(v.crossEntropy)} |`);
}
lines.push('', '## 开发对照', '',
  '这些牌局用于选择，不能作为独立提升证据。两种 PPO 方案有相同环境局数，但学习决策数不同。表中的分差均为候选相对 H0，每 100 局底分；完整对局每桌保持真实轮庄。', '',
  '| 种子 | 路线 | 单局分差 | 16 局分差 | 16 局分差区间（探索性） | PPO 实际局数 | 学习决策数 |',
  '| --- | --- | ---: | ---: | --- | ---: | ---: |');
let trainingHands = 0, decisions = 0;
for (const row of rows) {
  const training = row.arm === 'imitation' ? null : read(`seed-${row.seed}/${row.arm}/summary.json`);
  trainingHands += training?.counters.environmentHands || 0;
  decisions += training?.counters.learnerDecisions || 0;
  lines.push(`| ${row.seed} | ${row.arm} | ${n(row.statistics.independent.overall.deltaPer100)} | ${n(row.statistics.session.overall.deltaPer100)} | ${interval(row.statistics.session.overall)} | ${training?.counters.environmentHands || 0} | ${training?.counters.learnerDecisions || 0} |`);
}
lines.push('', `PPO 共采集 ${trainingHands} 局、${decisions} 次学习决策；另外有 ${c.seeds * c.bcEpisodes} 局模仿采集和 ${c.validationEpisodes} 局独立教师验证。`, '',
  '先选跨种子平均完整对局得分最高的路线，再选该路线中的种子。模型选择已在独立验收前写入不可覆盖的 selection-frozen.json。', '',
  '| 路线 | 跨种子平均 16 局分差 | 跨种子平均单局分差 |', '| --- | ---: | ---: |');
for (const row of summary.selection.ranking) lines.push(`| ${row.arm} | ${n(row.meanSessionDelta)} | ${n(row.meanIndependentDelta)} |`);
lines.push('', '## 独立验收', '',
  `选定：种子 ${selected.seed}，${selected.arm}。每个对手组合 ${c.sealedGroups} 个单局组、${c.sealedSessionGroups} 个完整 ${c.sessionHands} 局组。bootstrap 按完整发牌组重采样；组内六种座位和同桌各局不作为独立样本。`, '',
  '| 对照 | 测试 | 对手组合 | 候选/百局 | 对照/百局 | 分差/百局 | 分差 95% 区间 | 独立组数 |',
  '| --- | --- | --- | ---: | ---: | ---: | --- | ---: |');
for (const [label, stats] of [['H0', summary.sealed.vsH0], ['模仿起点', summary.sealed.vsImitation]]) if (stats)
  for (const [suite, result] of Object.entries(stats))
    for (const [pair, row] of [['总体', result.overall], ...Object.entries(result.byOpponentPair)])
      lines.push(`| ${label} | ${suite} | ${pair} | ${n(row.candidatePer100)} | ${n(row.incumbentPer100)} | ${n(row.deltaPer100)} | ${interval(row)} | ${row.groups} |`);
if (!summary.sealed.vsImitation) lines.push('', '选中的是模仿对照自身，因此没有重复进行自身对比，也不宣称 PPO 改进成立。');
lines.push('', '预设门槛要求完整对局相对 H0 和自身模仿起点的两个区间下界均高于 0。该门槛只支持这批对手分布中的候选表现，不能认证人类段位或证明跨训练种子的普遍稳定性。封存牌局已使用，后续调参必须换新验收批次。', '',
  '## 模型与复核', '',
  `- [选定模型](<${selected.path.replaceAll('\\', '/')}>): SHA-256 ${selected.sha256}。`,
  `- [原始实验目录](<${run.replaceAll('\\', '/')}>): 保存全部模型、优化器、历史对手、训练指标、事件与重放样本。`,
  '- 本报告目录保留实验设计、开发/封存原始统计、选择记录与模仿诊断；体积较大的权重仍在 ai-runs/，不会自动清理。',
  '- 合法动作、牌数守恒及零和在每步检查，每份评测分层保存并重放 48 局审计样本。', '',
  '## 后续优先级', '',
  '优先根据自由出牌和碰/过判断的误差分析改进表示或数据覆盖；继续增加同一小网络的自博弈轮数未必有效。新增网络或特征应作为新版本，先重新验证 H0 模仿和信息边界，再进行同起点对照。保持本轮所有失败和成功模型作为后续参考对手。', '');
mkdirSync(out, {recursive:true});
for (const file of readdirSync(run).filter(name => name.endsWith('.json') &&
  (name.startsWith('development-') || ['summary.json', 'manifest.json', 'development.json', 'selection-frozen.json', 'sealed-vs-H0.json', 'sealed-vs-imitation.json'].includes(name))))
  copyFileSync(resolve(run, file), resolve(out, file));
writeFileSync(resolve(out, 'imitation-diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n');
writeFileSync(resolve(out, '实验结果.md'), lines.join('\n'));
console.log(JSON.stringify({report:resolve(out, '实验结果.md'), trainingHands, decisions, totalEvaluationGames:summary.totalEvaluationGames}));
