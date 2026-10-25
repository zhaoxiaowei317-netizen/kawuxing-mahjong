import assert from 'node:assert/strict';
import {existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {read,hash} from '../strong-pool/config.mjs';
import {check,jobsFor,aggregate} from './study.mjs';
import {ARMS} from './policy.mjs';

export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json'));check(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(s.games,v.games);assert.deepEqual(v.sources,p.sources);
  assert.equal(v.checkpointSha256,p.model.sha256);assert.equal(v.groups.length,jobsFor(p).length);
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,groups));
  assert.deepEqual(s.primary,s.evaluation.contrasts.component.statistics.session.overall);assert.equal(s.games,s.evaluation.games);
  assert.equal(s.outcome,s.primary.ci95[0]>0?'positive':s.primary.ci95[1]<0?'negative':'inconclusive');
  assert.equal(s.positivePrimaryEvidence,s.outcome==='positive');assert.equal(s.trainingHands,0);assert.equal(s.validationHands,0);assert.equal(s.productionPolicy,'H0');
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndExactTracesMatched);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[],add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)});
  const copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  for(const name of ['plan.json','summary.json','verification.json','runtime.json','frozen-sources.tar.gz'])copy(resolve(out,name),name);
  for(const name of ['execution.log','audit.log'])if(existsSync(resolve(out,name)))copy(resolve(out,name),name);
  copy(tests,'tests-node.log');copy(p.model.path,'fixed-model.json');copy(p.model.state,'fixed-model.pt');copy(resolve(p.previous.path,'summary.json'),'previous-summary.json');
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');
  const primary=s.primary,strength=s.evaluation.contrasts.strength.statistics.session.overall,c=s.evaluation.intervention;
  const n=x=>Number(x).toFixed(2),ci=r=>'['+r.ci95.map(n).join(', ')+']';
  const conclusion=s.outcome==='positive'?'最大公开进张约束在本批独立新牌局中取得相对原网络的正净收益证据。':
    s.outcome==='negative'?'最大公开进张约束在本批独立新牌局中明确弱于原网络，不能作为已验证的改进组件。':'本批独立新牌局未确认最大公开进张约束优于原网络，不能把事后牌效线索当成已证实的提升方法。';
  const lines=['# 公开进张取舍组件对照结果','',conclusion,'',
    `本轮保持同一份网络权重，正式训练和验证手数为零。完成 ${s.games} 局实际比赛，${primary.groups} 个完整种子组；约束版、原网络和不亮倒 H0 各 ${primary.hands} 手。所有预算完整运行，默认电脑保持 H0。`,'',
    '## 固定干预','',
    '先用完整合法动作的原网络 Q 确定原动作。只有原动作是弃牌时，保留亮倒开关和弃牌后向听数，在同亮倒、同向听的合法弃牌中优先选择公开进张最多的牌，再按原完整 Q 取舍。若原动作已满足最大公开进张则保持。胡/碰/杠/过不改，不调用 H0 代打。','',
    '公开进张根据可见张数估计，不读取真实牌墙。此规则可能牺牲番数、长期结构或其他价值，因此必须按完整比赛净收益检验，不能只靠局部进张指标认定它更好。','',
    `模型沿用固定 offline 第 ${p.model.epoch} 轮，JSON SHA-256 为 \`${p.model.sha256}\`。没有更新权重、搜索多个约束版本、设置按阶段变化的阈值或根据本轮得分调参。具体设置见[实验方案](../../公开进张取舍组件对照.md)，规则见[正式规则](../../孝感卡五星正式规则.md)。`,'',
    '## 一个主要检验，两个共享轨迹的对照','',
    `三种固定组合等权：不亮倒/H0、不亮倒/不亮倒、不亮倒/速度贪心。每组合 ${p.budget.groupsPerPair} 组，全新开局；每组六种座位、三条轨迹、连续 ${p.budget.sessionHands} 手，保留实际轮庄和累计分。完整组 bootstrap ${p.budget.bootstrapSamples} 次，组内牌局/座位不当成独立样本。`,'',
    '| 对照 | 净底分差/百手 | 95% 配对组区间 | 候选手数 | 配对组 |',
    '| --- | ---: | --- | ---: | ---: |',
    `| 约束版 − 原网络（唯一主要检验） | ${n(primary.deltaPer100)} | ${ci(primary)} | ${primary.hands} | ${primary.groups} |`,
    `| 约束版 − 不亮倒 H0（次要描述） | ${n(strength.deltaPer100)} | ${ci(strength)} | ${strength.hands} | ${strength.groups} |`,'',
    conclusion,'',
    '两个对照共用同一条约束版轨迹，不重复计为两份独立证据。与不亮倒 H0 的对照和所有子组未经多重比较校正，只作描述；即使其次要区间为正，也不立即宣称跨对手稳定超过强参照。此实验没有新增神经网络学习，组件收益与学习收益分别记录。','',
    '## 全部对手子组（次要描述）','',
    '| 对照 / 组合 | 净底分差/百手 | 95% 配对组区间 | 配对组 |',
    '| --- | ---: | --- | ---: |'];
  for(const [name,result]of Object.entries(s.evaluation.contrasts))for(const [pair,r]of Object.entries(result.statistics.session.byOpponentPair))lines.push(`| ${name==='component'?'约束 − 原网络':'约束 − 不亮倒 H0'} / ${pair} | ${n(r.deltaPer100)} | ${ci(r)} | ${r.groups} |`);
  lines.push('','## 实际动作改变','',
    `约束轨迹共有 ${c.choices} 次多合法动作选择，其中原网络选择弃牌 ${c.baseDiscards} 次；${c.changed} 次被约束改变（占这些弃牌的 ${n(c.baseDiscards?100*c.changed/c.baseDiscards:0)}%）。符合增加进张条件的次数与实际改变次数相等，累计增加 ${c.outsGain} 张公开进张，每次改变平均 ${n(c.changed?c.outsGain/c.changed:0)} 张。`,'',
    '这些是每次相同公开局面上的局部变化。弃牌改变会影响未来摸打与其他玩家反应，所以完整轨迹可能在后续动作种类或亮倒状态上分化；不能把逐点约束误说成整局所有亮倒或碰杠行为完全相同。','',
    '## 行为和得分组成（次要描述）','',
    '| 组合 / 目标策略 | 净分/百手 | 亮倒手数比例 | 胡牌比例 | 放炮比例 | 胡分/百手 | 杠分/百手 | 查叫分/百手 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};
  for(const pair of p.pairs){behavior[pair.id]={};for(const arm of ARMS){
    const a=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,groups.filter(g=>g.job.pair.id===pair.id).reduce((n,g)=>n+g.record.arms[arm][k],0)]));behavior[pair.id][arm]=a;
    lines.push(`| ${pair.id} / ${arm} | ${n(100*a.score/a.hands)} | ${n(100*a.revealHands/a.hands)}% | ${n(100*a.wins/a.hands)}% | ${n(100*a.dealIns/a.hands)}% | ${n(100*a.huScore/a.hands)} | ${n(100*a.kongScore/a.hands)} | ${n(100*a.drawScore/a.hands)} |`);
  }}
  lines.push('','guarded 为约束版，raw 为原网络，reference 为不亮倒 H0。这些比例与得分分解不精确分离因果机制，不代表每个被改变的动作都正确。在不亮倒/不亮倒组合中，参照三家同策略的目标平均零分来自座位轮换的零和对称性。','',
    '## 完整核验和范围','',
    `全部 ${v.games} 局从种子重新发牌，逐条匹配三条轨迹的完整动作、策略种子、初始状态、真实连续轮庄、结算与结果；重新汇总干预计数、分数/行为/顺位和两个对照的区间。完整 JavaScript 回归 ${passed[1]} 项通过。`,'',
    '小型集成检查与原双臂考场分别核对两个对照的全部完整牌谱和记分记录，验证增加第三条轨迹不会改变同种子的原对局。规则、旧模型和旧驱动保持冻结，新增源码单列哈希；测试还验证动作种类、亮倒、向听、最大进张与原完整掩码的 Q 排序，并拒绝被篡改的来源/策略/分数。','',
    '本轮只有一个固定模型和一个固定约束，不证明换训练初始化、其他模型、其他规则或真人环境仍有效。旧的 -10.89 分差来自历史另一批发牌，未用于推算本轮强参照分差，也未与本轮事后合并。本轮强参照分差直接来自同时运行的第三条轨迹。','',
    s.outcome==='positive'?'后续可把此组件保留为研究策略，再检验新种子复验及网络能否自主学会这种取舍；需要分别验证策略收益和训练收益，不直接晋级。':
      s.outcome==='negative'?'本轮否定了这个固定最大公开进张约束的正收益假设。后续应保留原网络和强参照，转向其他训练目标或状态分布的控制实验；不把此约束当成正确教师标签。':'本轮证据不足以确认这个组件有净收益。后续不能直接把减少公开进张的动作都标成错误，优先设计其他可控训练对照，不追加本批比赛争取显著性。','',
    `完整本地运行目录：\`${relative(projectRoot,out)}\`。报告保留固定模型与优化器、计划、全部分组、审计、日志、源码归档和校验值。完整牌谱在本机忽略的实验目录，索引见 [artifacts.json](artifacts.json)。测试夹具、审计重放和此前事后诊断均不计为新增正式训练或评测样本。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(name=>({path:name,sha256:hash(resolve(destination,name))})),null,2)+'\n');
  return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
