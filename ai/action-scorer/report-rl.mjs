import {readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadScorer} from './io.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--run' || args[2] !== '--out') throw Error('Use --run RL_STUDY --out NEW_REPORT_DIRECTORY');
const run = resolve(args[1]), out = resolve(args[3]), read = name => JSON.parse(readFileSync(resolve(run, name), 'utf8'));
if (existsSync(out) && readdirSync(out).length) throw Error('Report output must be new');
const s = read('summary.json'), rows = read('development.json'), manifest = read('manifest.json');
if (s.status !== 'complete') throw Error('Study incomplete');
const loaded = loadScorer(s.selection.selected.path);
if (loaded.sha256 !== s.selection.selected.sha256) throw Error('Selected model hash mismatch');
const n = x => Number(x).toFixed(2), verdict = row => !row ? '未做自身对比' : row.ci95[0] > 0 ? '本批独立测试支持提升' : row.ci95[1] < 0 ? '本批独立测试显示落后' : '区间跨零，未确认差异';
const lines = ['# 牌效模型 PPO 与模仿约束对照结果', '',
  `开发阶段选中 ${s.selection.selected.arm}，种子 ${s.selection.selected.seed}。相对父模型：${verdict(s.sealed.vsParent?.session.overall)}；相对 H0：${verdict(s.sealed.vsH0.session.overall)}。`, '',
  `预设晋级条件${s.improvementSupportedOnThisHoldout ? '通过' : '未通过'}。游戏默认仍为 H0。${s.selection.selected.arm === 'parent' ? '本轮选回未训练的原起点，不能声称强化学习取得了提升。' : '开发阶段的优选结果与独立测试结论分别保留，不根据封存成绩更换候选。'}`, '',
  `新增 ${s.trainingHands.toLocaleString('en-US')} 局训练，${s.learnerDecisions.toLocaleString('en-US')} 次学习者决策；评测 ${s.totalEvaluationGames.toLocaleString('en-US')} 局，用时 ${n(s.elapsedSeconds / 60)} 分钟。`, '',
  '## 独立测试', '',
  '所有得分差统一换算为每百局。完整 16 局是主要指标，以完整初始牌局组做配对 bootstrap，各对手组合等权，不把组内座位和各手当成独立样本。', '',
  '| 对照 | 测试 | 对手组合 | 分差/百局 | 95% 区间 | 独立组数 |',
  '| --- | --- | --- | ---: | --- | ---: |'];
for (const [against, statistics] of Object.entries(s.sealed)) if (statistics)
  for (const [suite, result] of Object.entries(statistics)) for (const [pair, row] of [['总体', result.overall], ...Object.entries(result.byOpponentPair)])
    lines.push(`| ${against === 'vsH0' ? 'H0' : '原牌效模型'} | ${suite === 'session' ? '完整 16 局' : '独立单局'} | ${pair} | ${n(row.deltaPer100)} | [${row.ci95.map(n).join(', ')}] | ${row.groups} |`);
lines.push('', '## 开发结果与选择', '', '| 路线 | 种子 | 开发 16 局分差/百局 | 独立单局分差/百局 |', '| --- | ---: | ---: | ---: |');
for (const row of rows) lines.push(`| ${row.arm} | ${row.seed} | ${n(row.statistics.session.overall.deltaPer100)} | ${n(row.statistics.independent.overall.deltaPer100)} |`);
lines.push('', '| 路线 | 跨种子平均 16 局分差/百局 |', '| --- | ---: |');
for (const row of s.selection.ranking) lines.push(`| ${row.arm} | ${n(row.meanSession)} |`);
lines.push('', '开发评测每对手组合只有一个 16 局组，样本较小，不能作为提升证据。父模型参与筛选，避免强制选出退步模型。候选冻结后才运行独立牌局；本批封存种子已经使用，后续调参需重新验收。', '',
  '## 实际训练计数', '', '| 种子 | 路线 | 训练局数 | 学习者决策 | Adam 更新数 | KL 提前停止轮数 |', '| ---: | --- | ---: | ---: | ---: | ---: |');
for (const t of s.trainings) {
  const c = loadScorer(t.finalCheckpoint.path), state = c.checkpoint.metadata.training;
  if (c.sha256 !== t.finalCheckpoint.sha256) throw Error('Training checkpoint hash mismatch');
  lines.push(`| ${t.seed} | ${t.arm} | ${t.counters.hands} | ${t.counters.learnerDecisions} | ${c.model.optimizer.step} | ${state.history.filter(h => h.updates.length < state.config.epochs).length} |`);
}
const differencesPath = resolve(run, 'parent-decision-differences.json');
if (existsSync(differencesPath)) {
  const d = JSON.parse(readFileSync(differencesPath));
  if (d.model.sha256 !== manifest.parent.sha256) throw Error('Diagnostic parent differs');
  lines.push('', '## 原起点的决策差异诊断', '',
    `额外 ${d.stats.hands} 局自身对局中，有 ${d.stats.choices} 次非强制选择，其中 ${d.stats.mismatches} 次不同于 H0。按向听、听牌进张、一般进张、听口种类依次比较首个不同的牌效指标：`, '',
    '| 首个不同指标 | 次数 |', '| --- | ---: |');
  for (const [key, count] of Object.entries(d.stats.firstEfficiencyDifference)) lines.push(`| ${key} | ${count} |`);
  lines.push('', 'sameEfficiency 表示这些牌效指标相同，仍可能存在亮倒、番数和防守差异，不能解释为动作等价。该诊断不使用暗手，不估计改变动作后的反事实收益，不能把这些次数直接称作错误或分数损失来源。');
}
const shiftPath = resolve(run, 'policy-shift-diagnostics.json');
if (existsSync(shiftPath)) {
  const d = JSON.parse(readFileSync(shiftPath));
  if (d.parent.sha256 !== manifest.parent.sha256) throw Error('Policy-shift parent differs');
  lines.push('', '## 训练究竟改变了多少决策', '',
    `所有终点在同一批新的 ${d.hands} 局 H0 局面上对比原起点，排除唯一合法动作。这个诊断在选模之后执行，不参与选模。原起点与 H0 的选择一致率为 ${n(d.parentTeacher.choiceAccuracy * 100)}%。`, '',
    '| 种子 | 路线 | 最终选择改变比例 | 平均类别 KL | 与 H0 选择一致率 |', '| ---: | --- | ---: | ---: | ---: |');
  for (const row of d.rows) lines.push(`| ${row.seed} | ${row.arm} | ${n(row.shift.changedChoiceRate * 100)}% | ${row.shift.meanParentToCandidateKl.toFixed(6)} | ${n(row.teacher.choiceAccuracy * 100)}% |`);
  lines.push('', '这里是原起点到训练终点的完整动作分布 KL，和训练每轮相对采样策略的近似 KL 含义不同。决策变化率或老师一致率都不能替代实战得分。');
}
lines.push('', '## 解释范围', '', '两条路线起始权重相同，Adam 重置，训练随机种子成对；使用同一更新次数上限与对局预算，只有 BC 约束系数不同。策略分化使轨迹、学习动作数及 KL 停止次数可能不同。老师标签只用于训练损失；推理没有老师答案或暗牌。', '',
  '当前共享线性评分器主要表达基础牌效，尚未具备完整放铳风险和对手听牌概率模型。本轮只能检验当前表示和训练预算下的效果；三个种子、两个对手组合不足以认定普遍最强。', '',
  '本轮没有只继续模仿的训练路线。若带 BC 约束的组合获益，只能说明整套组合有效，不能单独归功于 PPO；需要新增预设的 BC-only 对照才能拆解来源。', '',
  '## 模型与继续工作', '',
  `原起点：[牌效模型](<${manifest.parent.path.replaceAll('\\', '/')}>); SHA-256 ${manifest.parent.sha256}。`, '',
  `选中候选：[${s.selection.selected.arm}](<${s.selection.selected.path.replaceAll('\\', '/')}>); SHA-256 ${s.selection.selected.sha256}。`, '',
  '所有训练终点和各轮检查点均保留。如果未通过独立晋级检验，继续保留原牌效模型为研究对照，不用开发最高分替换它。下一步先加入只继续模仿的对照，并分别比较更大的学习步长或更新预算，检查当前策略变化幅度是否限制了收益；再针对进张排序、对手风险和预期净收益补充表示。所有参数筛选使用新开发数据，最终再做新的封存验收。', '',
  `原始数据：[运行目录](<${run.replaceAll('\\', '/')}>); [训练与恢复指南](../../牌效模型的强化学习与模仿约束.md)。`, '');
mkdirSync(out, {recursive:true});
for (const file of ['summary.json', 'manifest.json', 'development.json', 'selection-frozen.json']) copyFileSync(resolve(run, file), resolve(out, file));
for (const name of ['sealed-vs-H0', 'sealed-vs-parent']) if (existsSync(resolve(run, name, 'report.json'))) copyFileSync(resolve(run, name, 'report.json'), resolve(out, `${name}.json`));
if (existsSync(differencesPath)) copyFileSync(differencesPath, resolve(out, 'parent-decision-differences.json'));
if (existsSync(shiftPath)) copyFileSync(shiftPath, resolve(out, 'policy-shift-diagnostics.json'));
writeFileSync(resolve(out, '实验结果.md'), lines.join('\n')); console.log(resolve(out, '实验结果.md'));
