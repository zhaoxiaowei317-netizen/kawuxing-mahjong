import assert from 'node:assert/strict';
import {existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {NEURAL,ARMS,check,checkData,jobsFor,read,hash} from './config.mjs';
import {aggregate} from './study.mjs';
export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);checkData(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);assert.deepEqual(v.sourceMap,p.sourceMap);
  assert.deepEqual(s.models,models);assert.equal(s.productionPolicy,'H0');assert.equal(s.newUniqueTrainingHands,0);assert.equal(v.snapshotsVerified,p.budget.epochs+1);
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,models,groups));
  assert.equal(s.positiveJointEvidence,Object.values(s.primary).every(x=>x.ci95[0]>0));
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndNeuralPoliciesAndExactTracesMatched);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  for(const x of v.snapshots){assert.equal(hash(x.path),x.sha256);assert.equal(hash(x.path.replace('.json','.pt')),x.stateSha256);}
  assert.equal(hash(resolve(out,'validation-diagnostics.json')),v.validationDiagnosticsSha256);
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[],add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)}),copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  for(const name of ['plan.json','summary.json','verification.json','training.json','models.json','prefix-python.json','validation-diagnostics.json','runtime.json','frozen-sources.tar.gz','execution.log','audit.log'])copy(resolve(out,name),name);
  copy(tests,'tests-node.log');
  for(const arm of NEURAL){assert.equal(hash(models[arm].path),models[arm].sha256);assert.equal(hash(models[arm].state),read(models[arm].path).metadata.optimizerStateSha256);
    copy(models[arm].path,arm+'-model.json');copy(models[arm].state,arm+'-model.pt');}
  copy(resolve(out,'model-long/parity.json'),'long-parity.json');
  for(const x of v.snapshots){add(x.path);add(x.path.replace('.json','.pt'));}
  for(const x of Object.values(p.data)){add(resolve(x.path,'manifest.json'));add(resolve(x.path,'episodes.jsonl.gz'));}
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');
  const n=x=>Number(x).toFixed(2),ci=x=>'['+x.ci95.map(n).join(', ')+']',pct=(a,b)=>b?n(100*a/b)+'%':'无样本',
    labels={duration:'长训练版 − 短训练版',strength:'长训练版 − 不亮倒 H0',original:'长训练版 − 原网络'},
    conclusion=s.positiveJointEvidence?'本批同时支持长训练版超过短训练版和强启发式参照，联合门槛通过，仍需独立复验。':
      s.outcomes.duration==='negative'?'本批长训练版明确落后短训练版，延长优化的联合门槛未通过。':
      s.outcomes.strength==='negative'?'本批长训练版明确落后强启发式参照，联合门槛未通过。':
      s.primary.duration.deltaPer100<0&&s.primary.strength.deltaPer100<0?'本批长训练版相对短版和强参照的两项主要点估计均为负，区间跨零，未通过联合门槛；不能宣称提升，也不能将不确定结果解释为无差别。':'本批未通过预定联合门槛，尚不能确认延长训练同时改善牌技并超过强启发式参照。';
  const f=t.fitted,old=read(resolve(p.previous.path,'model-plain/summary.json')),d=read(resolve(out,'validation-diagnostics.json')).models;
  const lines=['# 纠错学习训练时长对照结果','',conclusion,'',
    `复用同一份 ${t.reusedTrainingHands} 手训练、${t.reusedValidationHands} 手验证，新增独立采集训练/验证手数均为 0。四版本完成 ${s.games} 局全新实战，每版 ${s.primary.duration.hands} 手，${s.primary.duration.groups} 个完整配对组。默认 H0。`,'',
    '## 本轮只增加优化轮数','',
    `沿用上一轮普通纠错版的起点、种子、标签、Adam 初始重置、批次次序与冻结训练器，从第 0 轮连续跑到第 ${p.budget.epochs} 轮；不是在第 ${p.budget.shortEpochs} 轮重置优化器。前 ${p.budget.shortEpochs+1} 份快照的所有导出参数、训练/验证指标、Python 模型和 Adam 状态与上轮完全一致。`,'',
    `短版固定为原先选中的第 ${models.short.epoch} 轮。长版仍按固定验证纠错 CE 最低值选择，含第 0 轮、同分取最早，选中第 ${models.long.epoch} 轮。实战前冻结，不按实战成绩选择。参见[预定方法](../../纠错学习训练时长对照.md)。`,'',
    '这不是新增训练数据、不同训练种子或不同网络的比较。收益和顺位损失为零，KL 约束为零；网络直接依自身完整合法动作 Q 出牌，没有进张规则或 H0 接管。','',
    '## 全新牌局的主要检验','',
    `三种对手组合等权，各 ${p.budget.groupsPerPair} 组。每组包括六种座位排列、四条版本轨迹、连续轮庄 ${p.budget.sessionHands} 手。完整组 bootstrap ${p.budget.bootstrapSamples} 次，组内座位和手数不当独立样本。前两项 95% 区间必须同时严格高于零；第三项为未经多重比较校正的描述。`,'',
    '| 对照 | 净底分差/百手 | 95% 配对组区间 | 口径 |','| --- | ---: | --- | --- |'];
  for(const [key,r]of Object.entries(s.evaluation.contrasts)){const x=r.statistics.session.overall;lines.push(`| ${labels[key]} | ${n(x.deltaPer100)} | ${ci(x)} | ${key==='original'?'次要描述':s.outcomes[key]} |`);}
  lines.push('',conclusion,'','共享长版轨迹的不同对照不算独立复验；不与历史发牌相减，不根据本批结果追加牌局。','',
    '## 训练曲线与固定验证选择','',
    '| 轮次 | 训练纠错 CE | 验证纠错 CE | 验证答案吻合率 |','| --- | ---: | ---: | ---: |');
  for(const r of f.history)lines.push(`| ${r.epoch} | ${r.training.bc.toFixed(6)} | ${r.validation.bc.toFixed(6)} | ${pct(r.validation.teacherAgreement,1)} |`);
  lines.push('',`短版验证 CE ${old.selected.validationLoss.toFixed(6)}；长版所选 CE ${f.selected.validationLoss.toFixed(6)}。验证误差改善是模仿学习效果，不能直接代替实际净收益。复用验证集会带来适应这份验证集的风险，独立实战仍是主要验收。`,'',
    '| 模型 | 纠错局面采纳率 | 无需纠错局面保持原判断 | 全部纠错答案吻合率 | 有胡时未选胡 |','| --- | ---: | ---: | ---: | ---: |');
  for(const arm of NEURAL){const x=d[arm];lines.push(`| ${arm} | ${pct(x.changedCorrectedAgreement,x.changedSamples)} | ${pct(x.unchangedRawAgreement,x.unchangedSamples)} | ${pct(x.correctedAgreement,x.samples)} | ${x.huDeclined}/${x.huOffered} |`);}
  lines.push('','上述为同一固定验证集的描述，不是胡牌率、胜率或独立训练复验；有胡未选胡不直接判作战略错误。','',
    '## 对手子组（描述性）','','| 对照 / 组合 | 净底分差/百手 | 95% 区间 |','| --- | ---: | --- |');
  for(const [key,r]of Object.entries(s.evaluation.contrasts))for(const [pair,x]of Object.entries(r.statistics.session.byOpponentPair))lines.push(`| ${labels[key]} / ${pair} | ${n(x.deltaPer100)} | ${ci(x)} |`);
  lines.push('','## 行为与分数（描述性）','','| 目标版本 | 净分/百手 | 胡牌比例 | 放炮比例 | 亮倒比例 | 胡分/百手 | 杠分/百手 | 查叫分/百手 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};for(const arm of ARMS){const x=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,groups.reduce((n,g)=>n+g.record.arms[arm][k],0)]));behavior[arm]=x;
    lines.push(`| ${arm} | ${n(100*x.score/x.hands)} | ${pct(x.wins,x.hands)} | ${pct(x.dealIns,x.hands)} | ${pct(x.revealHands,x.hands)} | ${n(100*x.huScore/x.hands)} | ${n(100*x.kongScore/x.hands)} | ${n(100*x.drawScore/x.hands)} |`);}
  lines.push('','long 为长训练版，short 为冻结短训练版，raw 为原网络，reference 为不亮倒 H0。','',
    '## 完整核验与限制','',
    `全部 ${s.games} 局新评测均从种子重发，逐动作对照公开策略选择、真实轮庄和结算，完整牌谱与汇总匹配。${v.snapshotsVerified} 份长训练快照的 JSON/PT 哈希、PT 权重导出与元数据已核对，Python/JS 推理误差通过。前缀 Adam/权重/指标完全一致。复用的上轮采集数据本轮重核哈希，依赖上轮已完成的全量重发审计；不声称本轮再次生成采集数据。${passed[1]} 项 JavaScript 回归通过。`,'',
    '只检验固定数据、固定架构和一个训练种子的优化时长。不能推及无限增加数据/模型容量的效果，也不能把不确定结果解释为无差别。默认 H0，不自动晋级。所有开发夹具、审计重放不计正式样本。','',
    '## 后续取舍','',
    s.positiveJointEvidence?'冻结候选，在全新发牌中独立复验，并检验跨训练种子的稳定性。':
      '本轮不采用长训练版，不依据本批成绩追加轮数或扩大本批考试。继续降低模仿误差不是已验证的牌技提升路线。下一步优先检验学习目标、教师取舍及自身实战状态与净收益的关系，使用新开发轨迹并设置同预算对照；不能据本轮直接认定某一个原因，也不将已公开验收牌谱拿来训练。','',
    `完整运行保存在 \`${relative(projectRoot,out)}\`，全部快照及评测牌谱的索引见 [artifacts.json](artifacts.json)。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');
  return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
