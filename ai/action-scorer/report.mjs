import {readFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256} from '../provenance.mjs';
import {loadScorer} from './io.mjs';
import {loadCheckpoint} from '../training/checkpoint.mjs';
import {FEATURE_NAMES} from './features.mjs';

const args = process.argv.slice(2);
if (![4, 6].includes(args.length) || args[0] !== '--run' || args[2] !== '--out' || args.length === 6 && args[4] !== '--supplement')
  throw Error('Use --run STUDY_DIRECTORY --out NEW_REPORT_DIRECTORY [--supplement EVALUATION_DIRECTORY]');
const run = resolve(args[1]), out = resolve(args[3]);
if (existsSync(out) && readdirSync(out).length) throw Error('Report directory must be new');
const read = name => JSON.parse(readFileSync(resolve(run, name), 'utf8'));
const s = read('summary.json'), development = read('development.json'), diagnostics = read('action-diagnostics.json');
const supplement = args[5] ? JSON.parse(readFileSync(resolve(args[5], 'report.json'), 'utf8')) : null;
if (s.status !== 'complete') throw Error('Study incomplete');
for (const row of Object.values(s.selected)) if (sha256(readFileSync(row.path)) !== row.sha256) throw Error('Model hash mismatch');
const scorer = loadScorer(s.selected.structured.path), raw = loadCheckpoint(s.selected.raw.path);
const n = x => Number(x).toFixed(2), pct = x => x === null ? '—' : `${n(x * 100)}%`;
const h = s.sealed.vsH0.session.overall, r = s.sealed.vsRaw.session.overall;
const comparison = row => row.ci95[0] > 0 ? '本批独立验收支持提升' : row.ci95[1] < 0 ? '本批独立验收显示落后' : '区间跨过零，尚不能确认差异';
const lines = ['# 动作牌效模型：同数据对照结果', '',
  `结构化模型相对原始网络：${comparison(r)}；相对 H0：${comparison(h)}。游戏默认仍为 H0。`, '',
  `新增 ${s.trainingHands.toLocaleString('en-US')} 局训练数据，由两种模型共用；另有 ${s.validationHands} 局验证数据。实际完成 ${s.totalEvaluationGames.toLocaleString('en-US')} 局评测，重放 ${s.replayed} 个分层审计牌谱。主实验用时 ${n(s.elapsedSeconds / 60)} 分钟。`, '',
  '## 独立验收', '',
  '主要指标为真实轮庄的完整 16 局净分，表中统一换算成每百局的得分差。每组包含相同发牌种子的六种座位排列与候选、对照两臂，以整组配对重采样；各对手组合等权。', '',
  '| 对照 | 测试 | 对手组合 | 分差/百局 | 95% 区间 | 独立组数 |',
  '| --- | --- | --- | ---: | --- | ---: |'];
for (const [against, statistics] of Object.entries(s.sealed)) for (const [suite, result] of Object.entries(statistics))
  for (const [pair, row] of [['总体', result.overall], ...Object.entries(result.byOpponentPair)])
    lines.push(`| ${against === 'vsH0' ? 'H0' : '同数据原始网络'} | ${suite === 'session' ? '完整 16 局' : '独立单局'} | ${pair} | ${n(row.deltaPer100)} | [${row.ci95.map(n).join(', ')}] | ${row.groups} |`);
const allH0 = s.sealed.vsH0.session.byOpponentPair['H0+H0'];
if (allH0?.ci95[1] < 0) lines.push('',
  `对两家 H0 的完整 16 局子组仍显示落后：${n(allH0.deltaPer100)} / 百局，95% 区间 [${allH0.ci95.map(n).join(', ')}]。总体区间跨零不能解释为已经追平 H0，也不能用混合对手的成绩掩盖该弱点。`);
lines.push('', '候选先按独立验证交叉熵选择训练轮次，再按开发 16 局得分选种子。封存牌局在两个候选固定后生成；没有根据封存成绩改选模型。本批封存数据现已消耗。区间只适用于当前对手组合与评测协议，不能据此宣称人类高手段位或普遍最强。', '',
  '## 三个训练种子与开发结果', '',
  '| 种子 | 模型 | 验证选中轮次 | 非强制动作一致率 | 验证交叉熵 | 开发 16 局相对 H0 / 百局 |',
  '| ---: | --- | ---: | ---: | ---: | ---: |');
for (const row of development) lines.push(`| ${row.seed} | ${row.arm} | ${row.epoch} | ${pct(row.validation.choiceAccuracy)} | ${n(row.validation.crossEntropy)} | ${n(row.statistics.session.overall.deltaPer100)} |`);
lines.push('', '开发评测每对手组合只有一个完整 16 局独立组，仅用于筛选，不能充当统计提升证据。三个种子也不足以证明训练稳定性。', '',
  '## 动作诊断', '',
  `以下是选模完成后的额外诊断，每种模型分别跑 ${diagnostics.raw.handsPerDistribution} 局 H0 驱动与 ${diagnostics.raw.handsPerDistribution} 局自身驱动对局，不用于选模。H0 驱动下两者看到相同局面；自身驱动下局面分布会不同。高向听出牌有时是在换取番数或防守，不能把该比例直接称为错误率。`, '',
  '| 模型 | 局面来源 | 非强制动作一致率 | 高于最低向听的自由出牌 | 有胡未胡 | 漏掉老师的碰 | 未按老师选择过 |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const [arm, d] of Object.entries(diagnostics)) for (const [driver, row] of Object.entries(d.distributions))
  lines.push(`| ${arm} | ${driver} | ${pct(row.choiceAgreement)} | ${pct(row.higherDistanceRate)} | ${row.huDeclined}/${row.huAvailable} | ${row.missedTeacherPeng}/${row.teacherPeng} | ${row.disagreedTeacherPass}/${row.teacherPass} |`);
if (supplement) {
  if (supplement.manifest.candidate.sha256 !== s.selected.structured.sha256) throw Error('Supplement candidate differs');
  const row = supplement.statistics.session.overall;
  lines.push('', '## 与上一轮最好纠错模型的补充对照', '',
    `另外预先固定了对上一轮 teacher-refine 第 3 轮模型的测试，使用不同封存种子。新增 ${supplement.totalGames.toLocaleString('en-US')} 局评测，完整 16 局分差为 ${n(row.deltaPer100)} / 百局，95% 区间 [${row.ci95.map(n).join(', ')}]：${comparison(row)}。`, '',
    '该对照用于检验相对已有研究模型的实际进展。旧纠错模型的训练数据量和采样方式不同，不能用于解释某个单一训练因素的因果贡献。主实验和补充实验均未根据验收结果改选候选。全部补充牌谱保存在运行目录。');
}
const rawSize = Object.values(raw.model.parameters).reduce((sum, a) => sum + a.length, 0);
lines.push('', '## 能说明什么', '',
  `两个模型使用完全相同的老师轨迹、标签、遍数和批次打乱顺序。原始网络有 ${rawSize.toLocaleString('en-US')} 个参数；动作评分器有 ${FEATURE_NAMES.length} 个动作权重和 10 个价值权重，价值头本轮未训练。动作评分器显式计算向听、公开剩余进张、听口、潜在番数，并使用借鉴 H0 的亮倒阈值特征。`, '',
  '这是两套表示与训练配置的整体验证。参数数量、手工知识和学习率同时不同，不能把效果全部归因于线性模型或声称模型自行发现了麻将牌效。模仿老师也不会自动学会老师本身缺少的防守与长期收益判断。', '',
  '## 可继续使用的模型', '');
for (const [arm, row] of Object.entries(s.selected)) lines.push(`- ${arm}：种子 ${row.seed}，第 ${row.epoch} 遍，[检查点](<${row.path.replaceAll('\\', '/')}>); SHA-256 ${row.sha256}。`);
lines.push('', '结构化模型有独立加载器和完整 Adam 状态，不能传给原始网络的 `ai:train --resume`。原始模型推理及训练源码、规则、H0 均未变更，旧检查点保留兼容。', '',
  '## 学得的动作权重', '', '| 特征 | 权重 |', '| --- | ---: |');
FEATURE_NAMES.forEach((name, i) => lines.push(`| ${name} | ${n(scorer.model.parameters[i])} |`));
lines.push('', '不同特征的缩放和相关性不同，不能仅按权重绝对值解释重要性。', '',
  '## 后续训练重点', '',
  '下一阶段应在稳定牌效起点上学习防守、亮倒与番数收益的取舍。先增加公开信息下的放铳风险和预期净收益表达，再用小步真实收益训练，并保留模仿约束来减少基础能力退步。每次都保留原起点作为对照，同时面对 H0、旧模型和不同风格对手；需要新的封存牌局才能判断是否真的进步。', '',
  `原始实验：[运行目录](<${run.replaceAll('\\', '/')}>); 设计说明：[动作牌效模型与同数据对照](../../动作牌效模型与同数据对照.md)。`, '');
mkdirSync(out, {recursive:true});
for (const file of ['summary.json', 'manifest.json', 'development.json', 'selection-frozen.json', 'sealed-vs-H0.json', 'sealed-vs-raw.json', 'action-diagnostics.json']) copyFileSync(resolve(run, file), resolve(out, file));
if (supplement) copyFileSync(resolve(args[5], 'report.json'), resolve(out, 'supplement-vs-prior-best.json'));
writeFileSync(resolve(out, '实验结果.md'), lines.join('\n'));
console.log(resolve(out, '实验结果.md'));
