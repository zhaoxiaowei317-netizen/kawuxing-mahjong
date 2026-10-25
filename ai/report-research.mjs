import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256} from './provenance.mjs';
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--controlled', '--refined', '--ppo', '--out', '--tests-log'].includes(args[i]) || !args[i + 1] || options[args[i]])
    throw Error('Use --controlled RUN --refined RUN --ppo RUN --out NEW_DIRECTORY');
  options[args[i]] = args[i + 1];
}
if (!['--controlled', '--refined', '--ppo', '--out'].every(key => options[key])) throw Error('All four directories are required');
const paths = Object.fromEntries(Object.entries(options).map(([key, value]) => [key.slice(2), resolve(value)]));
if (existsSync(paths.out) && readdirSync(paths.out).length) throw Error('Report directory must be new/empty');
const read = (folder, file) => JSON.parse(readFileSync(resolve(folder, file), 'utf8'));
const controlled = read(paths.controlled, 'summary.json'), refined = read(paths.refined, 'summary.json');
const continuation = read(paths.ppo, 'training/summary.json'), plan = read(paths.ppo, 'plan.json');
const ppoH0 = read(paths.ppo, 'vs-H0/report.json'), ppoParent = read(paths.ppo, 'vs-parent/report.json');
const testsLog = resolve(options['--tests-log'] || '.tmp/overnight-tests.log'), testText = readFileSync(testsLog, 'utf8');
const passed = Number(testText.match(/(?:ℹ|#)\s+pass\s+(\d+)/)?.[1]);
const failed = Number(testText.match(/(?:ℹ|#)\s+fail\s+(\d+)/)?.[1]);
if (!Number.isSafeInteger(passed) || passed < 1 || failed !== 0) throw Error('Successful test evidence required');
if ([controlled, refined, continuation].some(run => run.status !== 'complete')) throw Error('Training is incomplete');
const models = {
  controlled:controlled.selection.selected,
  refined:refined.selected,
  continued:continuation.finalCheckpoint,
};
for (const model of Object.values(models)) if (sha256(readFileSync(model.path)) !== model.sha256) throw Error('Model hash mismatch');
if (ppoH0.models.candidate.sha256 !== models.continued.sha256 ||
  ppoParent.models.candidate.sha256 !== models.continued.sha256 ||
  ppoParent.models.incumbent.sha256 !== models.refined.sha256 || plan.parentSha256 !== models.refined.sha256)
  throw Error('Continuation comparison does not match registered models');
for (const [folder, manifest, reports] of [
  [paths.controlled, read(paths.controlled, 'manifest.json'), [read(paths.controlled, 'sealed-vs-H0.json')]],
  [paths.refined, refined.manifest, [read(paths.refined, 'sealed-vs-H0.json'), read(paths.refined, 'sealed-vs-parent.json')]],
  [paths.ppo, plan, [ppoH0, ppoParent]],
]) {
  const seed = readFileSync(resolve(folder, 'sealed-seed.txt'), 'utf8').trim();
  if (sha256(seed) !== manifest.sealedSeedCommitment || reports.some(r => r.seed !== seed || r.split !== 'sealed'))
    throw Error('Holdout commitment or split mismatch');
}
const primary = {
  controlledVsH0:controlled.sealed.vsH0.session.overall,
  controlledVsParent:controlled.sealed.vsImitation?.session.overall ?? null,
  refinedVsH0:refined.statistics.H0.session.overall,
  refinedVsParent:refined.statistics.parent?.session.overall ?? null,
  continuedVsH0:ppoH0.statistics.session.overall,
  continuedVsParent:ppoParent.statistics.session.overall,
};
const trainingHands = controlled.config.seeds * controlled.config.bcEpisodes +
  controlled.config.seeds * 2 * controlled.config.iterations * controlled.config.episodesPerIteration +
  refined.totalEpisodes + continuation.counters.environmentHands;
const evaluationGames = controlled.totalEvaluationGames + refined.totalEvaluationGames + ppoH0.totalGames + ppoParent.totalGames;
const continuedImproved = primary.continuedVsParent.ci95[0] > 0;
const anyH0Evidence = ['controlledVsH0', 'refinedVsH0', 'continuedVsH0'].some(key => primary[key].ci95[0] > 0);
const diagnostics = {
  original:read(paths.controlled, 'diagnostics/seed-0-imitation.json'),
  refined:read(paths.refined, 'action-diagnostics.json'),
  continued:read(paths.ppo, 'action-diagnostics.json'),
};
const evidence = {format:'kwx-research-summary-1', defaultGamePolicy:'H0', trainingHands, evaluationGames,
  tests:{passed, failed, sourceLog:testsLog, sha256:sha256(readFileSync(testsLog))},
  models, primary, diagnostics, paths, continuationPlan:plan, controlledConfig:controlled.config,
  refinedConfig:refined.manifest.config, nextResearchInitialization:continuedImproved ? models.continued : models.refined,
  note:'Different studies use different held-out deals; compare within each paired study. This adaptive research session is exploratory, not a formal champion certification.'};
const n = x => Number(x).toFixed(2), range = r => `[${r.ci95.map(n).join(', ')}]`;
const lines = ['# 本轮 AI 训练结果与下一步', '',
  primary.refinedVsParent?.ci95[0] > 0
    ? '本轮找到了有实战收益的改进：补充模型自身走出的局面并由 H0 标注，再做模仿训练，优于原始模仿模型。'
    : '本轮完成了三种训练路线及两个后续探索实验，结果如下。', '',
  anyH0Evidence ? '至少一项独立验收相对 H0 的区间下界高于 0，但这是探索研究中的固定候选结果；游戏默认仍为 H0，未做自动晋级。'
    : '目前没有证实实验模型超过 H0，游戏默认继续使用 H0。', '',
  `实际完成 ${trainingHands.toLocaleString('en-US')} 局训练用对局、${evaluationGames.toLocaleString('en-US')} 局实战评测。训练用局数包含教师采集与 PPO，独立教师验证和动作诊断不计入该数字。`, '',
  '## 完整 16 局的独立验收', '',
  '数值为每 100 局底分差，正值表示新模型更好。不同实验使用不同的封存牌局，不能直接用各自的绝对分数给所有模型排序。', '',
  '| 实验候选 | 对照 | 分差/百局 | 配对 95% 区间 | 独立组数 |',
  '| --- | --- | ---: | --- | ---: |'];
for (const [label, opponent, key] of [
  ['三种子主实验选定模型', 'H0', 'controlledVsH0'], ['三种子主实验选定模型', '其模仿起点', 'controlledVsParent'],
  ['自身局面纠错模型', 'H0', 'refinedVsH0'], ['自身局面纠错模型', '原始模仿模型', 'refinedVsParent'],
  ['纠错后继续 PPO', 'H0', 'continuedVsH0'], ['纠错后继续 PPO', '纠错模型', 'continuedVsParent'],
]) { const r = primary[key]; if (r) lines.push(`| ${label} | ${opponent} | ${n(r.deltaPer100)} | ${range(r)} | ${r.groups} |`); }
lines.push('', '组内六种座位和一桌 16 局不当作独立样本。对手仅覆盖 H0+H0、H0+速度策略，结论不代表人类段位或所有打法。后续两个探索实验各只有一个训练种子；纠错实验增加了数据，不能把收益单独归因于采集方式。', '',
  '## 出牌诊断', '',
  '每个模型各使用 160 局 H0 驱动与 160 局自身驱动对局。下面是自身驱动局面的指标，不能把与 H0 不同或更高向听数一概判成错误；更高向听也可能是在做大牌或防守。', '',
  '| 模型 | 非强制动作与 H0 一致率 | 自由出牌选择较高向听数比例 | 有胡牌机会而未胡次数 |',
  '| --- | ---: | ---: | ---: |');
for (const [name, d] of Object.entries(diagnostics)) {
  const r = d.distributions.model;
  lines.push(`| ${name} | ${n(r.choiceAgreement * 100)}% | ${n(r.higherDistanceRate * 100)}% | ${r.huDeclined}/${r.huAvailable} |`);
}
lines.push('',
  '## 做了哪些工作', '',
  '- 三个独立训练种子，分别比较模仿、纯自博弈、历史模型混合对手；从同样权重、全新 Adam 状态出发。',
  '- 用独立教师数据诊断自由出牌、亮倒、胡、碰、杠、过，区分强制动作与真正的选择。',
  '- 基于模型自身局面的误差追加三轮老师标注训练，再用全新牌局验收。',
  '- 从改进后的模仿起点追加固定 12 轮、1,536 局 PPO，用另一批全新牌局比较 H0 和起点模型。',
  '- 保留全部模型、Adam、历史对手、来源哈希、分组统计及审计牌谱，游戏默认策略没有被实验模型覆盖。', '',
  '## 后续优先级', '',
  continuedImproved ? '这次继续 PPO 相对纠错起点有正向区间证据，可作为下一轮研究起点；先用多个新训练种子复核稳定性，再谈冠军晋级。'
    : '这次继续 PPO 没有显示相对纠错起点的可靠增益。下一轮先保留纠错模型作为研究起点，避免直接覆盖已经获得的改善。', '',
  '优先改进候选动作的牌效表示：显式计算自己可见手牌下，出牌或碰牌前后的向听、有效进张、听口与可见剩余牌。以这些特征训练动作评分模型，与当前只输入原始观测的小网络做同数据量对照。计算只能使用玩家可见信息，并保留隐藏牌不变性与合法动作测试。', '',
  '待基础出牌、碰/过判断和对 H0 的收益稳定后，再扩大强化学习预算、扩充对手池与保留不同打法。不能仅凭训练 loss 或某一批牌局的胜率宣称变强。', '',
  '## 产物与使用', '');
for (const [name, model] of Object.entries(models)) lines.push(`- [${name} 模型](<${model.path.replaceAll('\\', '/')}>): SHA-256 ${model.sha256}。`);
for (const name of ['controlled', 'refined', 'ppo']) lines.push(`- [${name} 实验目录](<${paths[name].replaceAll('\\', '/')}>): 原始配置、训练过程和独立评测。`);
lines.push('', '模型位于本地 ai-runs/，不进入 Git。继续已有 PPO 必须保留原目录与历史模型，使用 ai:train 的 --resume；从纠错快照开始新实验使用 --initialize-from 并设置 bcEpisodes 为 0。不要修改旧检查点哈希绕过版本检查。', '',
  `自动测试：${passed} 项通过。此次没有修改游戏规则或 UI，因此未重复浏览器构建验证。新报告脚本另做实际运行检查。`, '');
mkdirSync(paths.out, {recursive:true});
writeFileSync(resolve(paths.out, 'research-summary.json'), JSON.stringify(evidence, null, 2) + '\n');
copyFileSync(testsLog, resolve(paths.out, 'tests.log'));
writeFileSync(resolve(paths.out, '本轮结果与下一步.md'), lines.join('\n'));
console.log(JSON.stringify({report:resolve(paths.out, '本轮结果与下一步.md'), trainingHands, evaluationGames, primary}));
