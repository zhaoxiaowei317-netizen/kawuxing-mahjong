import {readFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadScorer} from './io.mjs';
import {collectPairedData, diagnostics} from './experiment.mjs';
import {comparePolicy} from './policy-shift.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';
import {sha256} from '../provenance.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--run' || args[2] !== '--out') throw Error('Use --run COMPLETE_STUDY --out NEW_REPORT_DIRECTORY');
const run = resolve(args[1]), out = resolve(args[3]), read = name => JSON.parse(readFileSync(resolve(run, name), 'utf8'));
if (existsSync(out) && readdirSync(out).length) throw Error('Report output must be new');
const summary = read('summary.json'), manifest = read('manifest.json'), rows = read('development.json');
if (summary.status !== 'complete') throw Error('Study incomplete');
const parent = loadScorer(manifest.parent.path);
if (parent.sha256 !== manifest.parent.sha256) throw Error('Parent changed');
const seed = 'kwx-calibration-post-selection-diagnostics-v1';
const data = await collectPairedData({hands:120, seed, onProgress:p => { if (p.hand % 40 === 0) console.log(JSON.stringify(p)); }});
const policy = {seed, hands:120, parent:manifest.parent, parentTeacher:diagnostics(parent.model, data.structured, 'structured'), rows:[],
  diagnosticSourceHash:sha256(readFileSync(fileURLToPath(import.meta.url))),
  helperSourceHashes:Object.fromEntries(['experiment.mjs', 'policy-shift.mjs'].map(file =>
    [file, sha256(readFileSync(new URL(file, import.meta.url)))])),
  note:'Fresh common H0 states after selection. Teacher agreement and policy shift are not score-improvement evidence.'};
for (const row of rows) {
  if (row.arm === 'parent') continue;
  const c = loadScorer(row.path);
  if (c.sha256 !== row.sha256) throw Error('Candidate changed');
  policy.rows.push({seed:row.seed, arm:row.arm, path:row.path, sha256:row.sha256,
    shift:comparePolicy(parent.model, c.model, data.structured), teacher:diagnostics(c.model, data.structured, 'structured')});
}
const n = x => Number(x).toFixed(2), percent = x => `${n(x * 100)}%`, s = summary.selection.selected;
const verdict = r => !r ? '未做自身对比' : r.ci95[0] > 0 ? '区间支持提升' : r.ci95[1] < 0 ? '区间显示落后' : '区间跨零，结论不确定';
const lines = ['# 继续模仿与学习步长对照结果', '',
  `开发筛选选中 ${s.arm}（种子 ${s.seed}）。相对原起点：${verdict(summary.sealed.vsParent?.session.overall)}；相对 H0：${verdict(summary.sealed.vsH0.session.overall)}。`, '',
  `研究起点提升证据：${summary.parentImprovementSupported ? '本批测试支持' : '尚未获得'}；游戏晋级条件：${summary.promotionSupported ? '通过' : '未通过'}。游戏默认保持 H0。${s.arm === 'parent' ? '本次选回原模型，没有对某个新训练终点进行封存晋级测试。' : '不根据封存结果回头改选其他终点。'}`, '',
  ...(s.arm === 'ppo-low' ? ['选中候选来自复用的旧 PPO 终点，不能把它的成绩归因于本轮新增的继续模仿或大步长训练。', ''] : []),
  `新增 ${summary.trainingHands.toLocaleString('en-US')} 手牌训练，复用此前 ${summary.reusedTrainingHands.toLocaleString('en-US')} 手训练的低步长终点；本轮评测 ${summary.totalEvaluationGames.toLocaleString('en-US')} 手牌。用时 ${n(summary.elapsedSeconds / 60)} 分钟，不含额外诊断和回放复核。`, '',
  '## 独立验收', '', '主要指标为真实轮庄完整 16 局净分，统一折算为每百手。以完整起始牌局组配对 bootstrap，组内各手及座位不作为独立样本，各对手组合等权。', '',
  '| 对照 | 测试 | 对手组合 | 分差/百手 | 95% 区间 | 独立组数 |', '| --- | --- | --- | ---: | --- | ---: |'];
for (const [against, statistics] of Object.entries(summary.sealed)) if (statistics)
  for (const [suite, result] of Object.entries(statistics)) for (const [pair, row] of [['总体', result.overall], ...Object.entries(result.byOpponentPair)])
    lines.push(`| ${against === 'vsH0' ? 'H0' : '原牌效模型'} | ${suite === 'session' ? '完整 16 局' : '单局'} | ${pair} | ${n(row.deltaPer100)} | [${row.ci95.map(n).join(', ')}] | ${row.groups} |`);
lines.push('', '## 开发筛选', '', '| 路线 | 跨种子平均 16 局分差/百手 |', '| --- | ---: |');
for (const row of summary.selection.ranking) lines.push(`| ${row.arm} | ${n(row.meanSession)} |`);
lines.push('', '| 路线 | 种子 | 16 局分差/百手 |', '| --- | ---: | ---: |');
for (const row of rows) lines.push(`| ${row.arm} | ${row.seed} | ${n(row.statistics.session.overall.deltaPer100)} |`);
lines.push('', '开发牌局增加到每对手组合两组连续 16 局，仍只用于筛选。只有选中候选进入封存测试，因此开发路线的排序不能当作全部方法因果差异的确认。封存种子已经使用，后续调参需新的验收批次。', '',
  '## 决策变化诊断', '', `独立于训练与选模的 ${policy.hands} 局共同 H0 局面，原模型与 H0 的非强制选择一致率为 ${percent(policy.parentTeacher.choiceAccuracy)}。`, '',
  '| 路线 | 种子 | 与原模型选择不同 | 类别 KL | 与 H0 一致率 |', '| --- | ---: | ---: | ---: | ---: |');
for (const row of policy.rows) lines.push(`| ${row.arm} | ${row.seed} | ${percent(row.shift.changedChoiceRate)} | ${row.shift.meanParentToCandidateKl.toFixed(6)} | ${percent(row.teacher.choiceAccuracy)} |`);
lines.push('', '变化比例只描述更新幅度，老师一致率只描述模仿程度，二者均不能替代实际净得分。', '',
  '## 可复核的训练差异', '',
  '三条路线共享起始权重和成对训练随机种子，每终点环境预算相同。ppo-low 使用旧的 0.002 步长；bc-only 和 ppo-fast 都使用 0.01。BC-only 不使用收益、优势、熵或价值损失；两条 PPO 的其他参数相同。策略分化后轨迹和动作样本数可能不同，PPO 的 KL 限制也可能减少更新遍数。', '',
  '| 路线 | 种子 | 训练手数 | 学习动作数 | Adam 更新数 |', '| --- | ---: | ---: | ---: | ---: |');
for (const row of rows.filter(r => r.arm !== 'parent')) {
  const c = loadScorer(row.path), state = c.checkpoint.metadata.bcOnlyTraining || c.checkpoint.metadata.training;
  lines.push(`| ${row.arm} | ${row.seed} | ${state.counters.hands} | ${state.counters.learnerDecisions} | ${c.model.optimizer.step} |`);
}
lines.push('', '当前模型只有 34 个动作权重和 10 个价值权重。该对照检验当前表示、对手组合和预算下的方法，不能据此认定完整麻将智能的上限。', '',
  '## 模型与证据', '', `选中模型：[${s.arm}](<${s.path.replaceAll('\\', '/')}>); SHA-256 ${s.sha256}。`, '',
  `原始记录：[运行目录](<${run.replaceAll('\\', '/')}>); [实验设计](../../继续模仿与学习步长对照.md)。`, '');
mkdirSync(out, {recursive:true});
for (const file of ['summary.json', 'manifest.json', 'development.json', 'selection-frozen.json']) copyFileSync(resolve(run, file), resolve(out, file));
for (const name of ['sealed-vs-H0', 'sealed-vs-parent']) if (existsSync(resolve(run, name, 'report.json'))) copyFileSync(resolve(run, name, 'report.json'), resolve(out, `${name}.json`));
writeAtomicJson(resolve(out, 'policy-diagnostics.json'), policy, {overwrite:false});
writeFileSync(resolve(out, '实验结果.md'), lines.join('\n')); console.log(resolve(out, '实验结果.md'));
