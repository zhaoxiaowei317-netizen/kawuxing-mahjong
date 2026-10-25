import assert from 'node:assert/strict';
import {existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {STUDENTS,NEURAL,ARMS,CONTRASTS,read,hash,check,jobsFor} from './config.mjs';
import {aggregate} from './study.mjs';
export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(s.games,v.games);assert.deepEqual(v.sources,p.sources);assert.deepEqual(s.models,models);
  assert.equal(s.productionPolicy,'H0');assert.equal(v.groups.length,jobsFor(p).length);assert.equal(v.snapshotsVerified,2*(p.budget.epochs+1));
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,models,groups));assert.equal(s.games,s.evaluation.games);
  assert.deepEqual(s.primary,Object.fromEntries(['objective','improvement'].map(k=>[k,s.evaluation.contrasts[k].statistics.session.overall])));
  assert.equal(s.positiveJointEvidence,Object.values(s.primary).every(r=>r.ci95[0]>0));
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndNeuralPoliciesAndExactTracesMatched);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  for(const arm of NEURAL){const q=read(models[arm].path);assert.equal(hash(models[arm].path),models[arm].sha256);assert.equal(hash(models[arm].state),q.metadata.optimizerStateSha256);}
  for(const split of ['training','validation'])for(const label of ['canonical','corrected','self']){
    const path=resolve(out,split,label),m=read(resolve(path,'manifest.json'));assert.deepEqual(m,t.datasets[split][label]);assert.equal(hash(resolve(path,'episodes.jsonl.gz')),m.sha256);
    for(const part of m.parts){const shard=read(resolve(part,'manifest.json')),audit=v.data.find(d=>d.split===split&&d.startHand===shard.startHand);assert.ok(audit);
      assert.equal(hash(resolve(part,'episodes.jsonl.gz')),audit.hashes[label]);assert.equal(shard.sha256,audit.hashes[label]);}}
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[],add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)}),copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  for(const name of ['plan.json','summary.json','verification.json','training.json','models.json','validation-diagnostics.json','runtime.json','frozen-sources.tar.gz'])copy(resolve(out,name),name);
  for(const name of ['execution.log','audit.log'])if(existsSync(resolve(out,name)))copy(resolve(out,name),name);copy(tests,'tests-node.log');copy(p.model.path,'original-model.json');copy(p.model.state,'original-model.pt');
  for(const arm of STUDENTS){copy(models[arm].path,`${arm}-model.json`);copy(models[arm].state,`${arm}-model.pt`);copy(resolve(out,`model-${arm}/parity.json`),`${arm}-parity.json`);
    for(const snap of v.snapshots.filter(x=>x.path.startsWith(resolve(out,`model-${arm}`)))){assert.equal(hash(snap.path),snap.sha256);assert.equal(hash(snap.path.replace('.json','.pt')),snap.stateSha256);add(snap.path);add(snap.path.replace('.json','.pt'));}}
  for(const split of ['training','validation'])for(const label of ['canonical','corrected','self'])for(const name of ['manifest.json','episodes.jsonl.gz'])add(resolve(out,split,label,name));
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');const d=read(resolve(out,'validation-diagnostics.json'));assert.equal(hash(resolve(out,'validation-diagnostics.json')),v.validationDiagnosticsSha256);
  const n=x=>Number(x).toFixed(2),ci=r=>'['+r.ci95.map(n).join(', ')+']',pct=(a,b)=>b?n(100*a/b)+'%':'无样本',labels={objective:'约束学生 − 普通纠错学生',improvement:'约束学生 − 原网络',strength:'约束学生 − 不亮倒 H0'};
  const conclusion=s.positiveJointEvidence?'本批同时支持约束学生超过普通纠错学生和原网络，原策略约束的联合学习门槛通过。':s.outcomes.objective==='negative'?
    '本批约束学生明确落后同预算普通纠错学生，原策略约束的联合学习门槛未通过。':'本批未通过预定联合学习门槛，尚不能确认这项原策略约束改善了网络牌技。';
  const lines=['# 纠错学习的原策略约束对照结果','',conclusion,'',
    `新增 ${s.trainingHands} 手共同训练、${s.validationHands} 手独立验证，${s.trainingSamples} 条训练选择。两个学生使用完全相同的纠错标签与实际轨迹，手数只计一次。四版本共完成 ${s.games} 局新牌局评测，每版本 ${s.primary.objective.hands} 手，${s.primary.objective.groups} 个完整种子组。默认电脑 H0。`,'',
    '## 本轮只改变训练目标','',
    '两组都从原始 offline 第 8 轮出发，学习相同的固定公开进张纠错答案。普通版使用交叉熵；约束版额外保留原网络在无需纠错局面的完整合法动作概率偏好，采用 KL(原网络 || 学生)，权重 1、温度 1，按整个批次平均。需要纠错的局面不加这项约束。软概率来自公开输入上的 Q softmax，不是校准的胜率或终局收益。','',
    `两组同初始化、Adam 重置、随机种子、批次次序、学习率 ${p.optimizer.learningRate}、批大小 ${p.optimizer.batchSize} 和 ${p.budget.epochs} 轮预算。统一按验证集的纠错交叉熵选轮次，包含第 0 轮，取最早最低值；约束损失单独记录，不参加选轮次。收益和顺位损失为零。参见[预定方案](../../纠错学习的原策略约束对照.md)和[正式规则](../../孝感卡五星正式规则.md)。`,'',
    '采集复用冻结的旧配对标签程序，但使用全新种子。plan.json 中的 protocol 是只供采集与采集审计使用的兼容嵌套协议，其中历史评测说明不用于本轮训练或四版本验收；本轮主方案字段、预算与新增驱动单独冻结。没有用旧考试牌谱训练。','',
    '## 联合主要检验与直接强度参照','',
    `三种既有对手组合等权，每组合 ${p.budget.groupsPerPair} 组。每组六种座位、四条独立策略轨迹、真实连续轮庄 ${p.budget.sessionHands} 手。完整组 bootstrap ${p.budget.bootstrapSamples} 次，组内手数、座位不当独立样本。两个主要区间必须同时严格高于零才支持联合主张；强参照对照是未经多重比较校正的次要描述。`,'',
    '| 对照 | 净底分差/百手 | 95% 配对组区间 | 口径 |','| --- | ---: | --- | --- |'];
  for(const [key,r]of Object.entries(s.evaluation.contrasts)){const x=r.statistics.session.overall;lines.push(`| ${labels[key]} | ${n(x.deltaPer100)} | ${ci(x)} | ${key==='strength'?'次要描述':s.outcomes[key]} |`);}
  lines.push('',conclusion,'','两项主要检验采用交并规则，单项通过不能替代整体通过。三项对照共用约束学生轨迹，不是三次独立复验。本轮强度参照来自同期实际第四条轨迹，没有与历史其他发牌批次相减。','',
    '## 训练与公开验证决策','',
    '| 学生 | 选中轮次 | 验证纠错 CE：第 0 轮 → 最佳轮 | 最佳轮约束 KL | 训练 JSON SHA256 |','| --- | ---: | --- | ---: | --- |');
  for(const arm of STUDENTS){const f=t.fitted[arm],x=f.history[f.selected.epoch];lines.push(`| ${arm} | ${f.selected.epoch} | ${f.history[0].validation.bc.toFixed(6)} → ${x.validation.bc.toFixed(6)} | ${x.validation.anchor.toFixed(6)} | \`${models[arm].sha256}\` |`);}
  lines.push('','plain 也计算同一冻结教师与 KL 诊断，但 KL 权重为零。两组不进行温度、约束系数、规则或收益阈值搜索。下表为固定验证局面的描述，不能用吻合率替代实战净收益。','',
    '| 网络 | 全部纠错答案吻合率 | 被纠正局面采纳率 | 无需纠错局面保持原判断 | 有胡时未选胡 |','| --- | ---: | ---: | ---: | ---: |');
  for(const arm of NEURAL){const x=d.models[arm];lines.push(`| ${arm} | ${pct(x.correctedAgreement,x.samples)} | ${pct(x.changedCorrectedAgreement,x.changedSamples)} | ${pct(x.unchangedRawAgreement,x.unchangedSamples)} | ${x.huDeclined}/${x.huOffered} |`);}
  const av=d.models.anchor,pv=d.models.plain,ak=t.fitted.anchor.history[t.fitted.anchor.selected.epoch].validation.anchor,pk=t.fitted.plain.history[t.fitted.plain.selected.epoch].validation.anchor;
  lines.push('',`所选模型的验证 KL 为 ${ak.toFixed(6)} 对 ${pk.toFixed(6)}；原动作保留率为 ${pct(av.unchangedRawAgreement,av.unchangedSamples)} 对 ${pct(pv.unchangedRawAgreement,pv.unchangedSamples)}，纠错采纳率为 ${pct(av.changedCorrectedAgreement,av.changedSamples)} 对 ${pct(pv.changedCorrectedAgreement,pv.changedSamples)}（均为约束版对普通版）。`,'',
    '概率分布接近、最终选择同一动作和实际赚分是三个不同指标。KL 较小不能单独证明保留更多原判断；同样，标签吻合率也不能代替实战强度。这里的验证比较不用于追加训练、调系数或更换本轮候选。');
  const training=t.datasets.training.canonical,validation=t.datasets.validation.canonical;lines.push('',
    `训练 ${training.samples} 条中纠正 ${training.correctedLabels} 条；验证 ${validation.samples} 条中纠正 ${validation.correctedLabels} 条。原始硬教师始终是 JS 标签；软目标由冻结 Python 原模型计算。两后端合法 Q 的允许误差是 1e-5，对每条教师硬标签核验距 Python 最大 Q 的分差，并记录以下实际差异。`,'',
    '| 学生 / 数据 | 教师 argmax 差异条数 | 硬标签距最大 Q 的最大差 |','| --- | ---: | ---: |');
  for(const arm of STUDENTS)for(const [split,x]of Object.entries(t.fitted[arm].teacherBackendAudit))lines.push(`| ${arm} / ${split} | ${x.argmaxDifferences} | ${x.maxScoreGap} |`);
  lines.push('','## 全部子组（描述性）','','| 对照 / 组合 | 净底分差/百手 | 95% 配对组区间 |','| --- | ---: | --- |');
  for(const [key,r]of Object.entries(s.evaluation.contrasts))for(const [pair,x]of Object.entries(r.statistics.session.byOpponentPair))lines.push(`| ${labels[key]} / ${pair} | ${n(x.deltaPer100)} | ${ci(x)} |`);
  lines.push('','## 四版本行为与分数（描述性）','','| 目标策略 | 净分/百手 | 胡牌比例 | 放炮比例 | 亮倒比例 | 胡分/百手 | 杠分/百手 | 查叫分/百手 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};for(const arm of ARMS){const x=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,groups.reduce((n,g)=>n+g.record.arms[arm][k],0)]));behavior[arm]=x;
    lines.push(`| ${arm} | ${n(100*x.score/x.hands)} | ${pct(x.wins,x.hands)} | ${pct(x.dealIns,x.hands)} | ${pct(x.revealHands,x.hands)} | ${n(100*x.huScore/x.hands)} | ${n(100*x.kongScore/x.hands)} | ${n(100*x.drawScore/x.hands)} |`);}
  lines.push('','anchor 为约束学生，plain 为普通纠错学生，raw 为冻结原网络，reference 为不亮倒 H0。三个网络评测时直接用自身完整合法动作 Q 选择，不调用进张约束或 H0 接管。子组、保留率及行为分解均未作多重比较校正，不能精确归因每次改变的价值。','',
    '## 审计、范围与后续','',
    `全部 ${s.trainingHands+s.validationHands} 手采集牌局、全部 ${v.games} 局四版本评测均按种子重新发牌，逐条复核公开输入、教师、探索行为、两份标签、连续轮庄和结算；${v.snapshotsVerified} 份快照、PT 哈希、共同 CE 选轮次、第 0 轮一致性及 Python/JS 导出检查通过。完整 JavaScript 回归 ${passed[1]} 项通过，其中包含调用三项 Python 约束梯度检查。`,'',
    '小型集成测试分别与原双版本考场核对三个对照的完整牌谱与分项记分，确认增加轨迹不干扰原对局；约束权重为零时，新训练器逐权重精确复现旧普通 BC 训练器。还验证截断数据和篡改分数会被审计拒绝。审计重放与开发夹具不计正式样本。','',
    '本轮只有一个共同训练种子和固定容量，不能代表跨初始化或真人泛化。上一轮额外改变无需纠错选择，只是动机，不是已证实的损失原因；即便保留率提高，也要单独看纠错覆盖和实际分差。所有预算完整运行，不扩样求显著、不自动晋级；游戏默认 H0。','',
    s.positiveJointEvidence?'下一步冻结候选，在全新发牌中复验联合收益，并检验跨训练种子与更广对手的稳定性。':s.outcomes.objective==='negative'?
      '本轮不采用这项原策略概率约束。普通纠错版保持为研究对象，后续可用全新预定发牌直接检验它相对原网络和强参照的收益；不能因为本轮约束版落后，就反过来宣布普通版已晋级。也不能推定单纯延长训练一定改善牌技。':
      '下一步将依据保留率、纠错采纳率及同期分差判断约束的取舍，再设计独立对照；保留本轮全部结果，不追加本批比赛。','',
    `本机运行目录：\`${relative(projectRoot,out)}\`。报告保存选中模型和 PT 状态、原模型、训练记录、分组、源码归档、日志及校验索引。完整快照和压缩牌谱在本机忽略的运行目录，索引见 [artifacts.json](artifacts.json)。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
