import assert from 'node:assert/strict';
import {existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {STUDENTS,ARMS,CONTRASTS,read,hash,check,jobsFor} from './config.mjs';
import {aggregate} from './study.mjs';

export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(s.games,v.games);assert.deepEqual(v.sources,p.sources);assert.deepEqual(s.models,models);
  assert.equal(s.productionPolicy,'H0');assert.equal(v.groups.length,jobsFor(p).length);assert.equal(v.snapshotsVerified,STUDENTS.length*(p.budget.epochs+1));
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,models,groups));assert.equal(s.games,s.evaluation.games);
  assert.deepEqual(s.primary,Object.fromEntries(Object.keys(CONTRASTS).map(k=>[k,s.evaluation.contrasts[k].statistics.session.overall])));assert.equal(s.positiveJointEvidence,Object.values(s.primary).every(r=>r.ci95[0]>0));
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndNeuralPoliciesAndExactTracesMatched);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  for(const arm of ARMS){const q=read(models[arm].path);assert.equal(hash(models[arm].path),models[arm].sha256);assert.equal(hash(models[arm].state),q.metadata.optimizerStateSha256);}
  for(const split of ['training','validation'])for(const arm of ['canonical',...STUDENTS]){
    const path=resolve(out,split,arm),m=read(resolve(path,'manifest.json'));assert.deepEqual(m,t.datasets[split][arm]);assert.equal(hash(resolve(path,'episodes.jsonl.gz')),m.sha256);
    for(const part of m.parts){const shard=read(resolve(part,'manifest.json')),audit=v.data.find(d=>d.split===split&&d.startHand===shard.startHand);assert.ok(audit);
      assert.equal(hash(resolve(part,'episodes.jsonl.gz')),audit.hashes[arm]);assert.equal(shard.sha256,audit.hashes[arm]);}
  }
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[],add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)}),copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  for(const name of ['plan.json','summary.json','verification.json','training.json','models.json','validation-diagnostics.json','runtime.json','frozen-sources.tar.gz'])copy(resolve(out,name),name);
  for(const name of ['execution.log','audit.log'])if(existsSync(resolve(out,name)))copy(resolve(out,name),name);copy(tests,'tests-node.log');copy(p.model.path,'original-model.json');copy(p.model.state,'original-model.pt');
  for(const arm of STUDENTS){copy(models[arm].path,`${arm}-model.json`);copy(models[arm].state,`${arm}-model.pt`);copy(resolve(out,`model-${arm}/parity.json`),`${arm}-parity.json`);
    for(const snap of v.snapshots.filter(x=>x.path.startsWith(resolve(out,`model-${arm}`)))){assert.equal(hash(snap.path),snap.sha256);assert.equal(hash(snap.path.replace('.json','.pt')),snap.stateSha256);add(snap.path);add(snap.path.replace('.json','.pt'));}}
  for(const split of ['training','validation'])for(const arm of ['canonical',...STUDENTS])for(const name of ['manifest.json','episodes.jsonl.gz'])add(resolve(out,split,arm,name));
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');const diagnostics=read(resolve(out,'validation-diagnostics.json'));assert.equal(hash(resolve(out,'validation-diagnostics.json')),v.validationDiagnosticsSha256);
  const n=x=>Number(x).toFixed(2),ci=r=>'['+r.ci95.map(n).join(', ')+']',pct=(a,b)=>b?n(100*a/b)+'%':'无样本';
  const conclusion=s.positiveJointEvidence?'本批同时支持纠错学生超过原网络和同预算自模仿学生，纠错学习的联合主张通过。':'本批未通过预定的纠错学习联合门槛，不能认定这套训练已可靠改善网络牌技。';
  const lines=['# 公开进张纠错学习对照结果','',conclusion,'',
    `新增 ${s.trainingHands} 手共同训练牌局、${s.validationHands} 手独立验证，训练选择样本 ${s.trainingSamples} 条。两份标签共用实际轨迹，训练手数只计一次。正式评测 ${s.games} 局，三个网络各 ${s.primary.improvement.hands} 手，共 ${s.primary.improvement.groups} 个完整种子组。游戏默认 H0。`,'',
    '## 学了什么','',
    '原网络在新采集牌局中直接出牌，目标玩家带 5% 合法动作探索；每个目标局面同时保存原网络答案和固定进张约束给出的答案。约束仅在原动作是弃牌时，在同亮倒开关、同弃牌后向听的合法牌中优先保留最多公开进张，再按原完整 Q 排序。它不读取真实牌墙，也不保证每次纠正都最优。','',
    '纠错学生学习约束答案，自模仿学生继续学习原答案。两组从同一 PT 权重出发，使用相同新局面、优化器、批次次序和固定训练预算；唯一训练标签差异为 teacherId。纯交叉熵，收益与顺位权重为零，没有把原行为的终局分数当成纠错动作的反事实收益。','',
    `两组各运行 ${p.budget.epochs} 轮，学习率 ${p.optimizer.learningRate}，批大小 ${p.optimizer.batchSize}，按各自固定验证答案的最低交叉熵选轮次，包含第 0 轮、同分取最早。评测时三个策略全部直接使用各自网络的完整合法动作 Q，不再调用进张约束或 H0 接管。参见[预定方法](../../公开进张纠错学习对照.md)和[规则](../../孝感卡五星正式规则.md)。`,'',
    '## 预定联合检验','',
    '只有以下两个 95% 完整配对组区间都严格高于零，才支持整体纠错学习主张；这是交并检验，单个正结果不替代另一个。每个对手组合等权，所有六种座位及真实轮庄的 16 手连续对局作为完整组重采样，共 5,000 次。','',
    '| 对照 | 净底分差/百手 | 95% 配对组区间 | 判定 |',
    '| --- | ---: | --- | --- |'];
  const labels={improvement:'纠错学生 − 原网络',labelEffect:'纠错学生 − 自模仿学生'};
  for(const [key,r]of Object.entries(s.primary))lines.push(`| ${labels[key]} | ${n(r.deltaPer100)} | ${ci(r)} | ${s.outcomes[key]} |`);
  lines.push('',conclusion,'','positive 表示区间严格为正，negative 表示严格为负，inconclusive 表示区间覆盖零。两项比较共用纠错学生轨迹，不是两次独立复验。本轮没有与不亮倒 H0 做直接目标策略对照，不能通过跨批次相减推断超过强参照。','',
    '计划文字勘误：plan.json 的 secondary 说明将共用轨迹误写为 raw，实际共用的是 corrected。冻结前的方法文档、主检验说明和实际程序均以纠错学生为候选，计算、预算和判定不变；原计划与哈希保留。','',
    '## 固定训练结果','',
    '| 学生 | 选择轮次 | 验证交叉熵：第 0 轮 → 最佳轮 | 各自验证答案吻合率 | 模型 SHA256 |',
    '| --- | ---: | --- | ---: | --- |');
  for(const arm of STUDENTS){const f=t.fitted[arm],r=f.history[f.selected.epoch];lines.push(`| ${arm} | ${f.selected.epoch} | ${f.history[0].validation.loss.toFixed(6)} → ${r.validation.loss.toFixed(6)} | ${pct(r.validation.teacherAgreement,1)} | \`${models[arm].sha256}\` |`);}
  const train=t.datasets.training.canonical,val=t.datasets.validation.canonical;lines.push('',
    `训练局面 ${train.samples} 条中，${train.correctedLabels} 条标签被纠正（${pct(train.correctedLabels,train.samples)}）；验证 ${val.samples} 条中纠正 ${val.correctedLabels} 条（${pct(val.correctedLabels,val.samples)}）。其他局面的原答案保留。`,'',
    '本轮只训练动作排序，记录中 mcHalfMse、cql、rank 均不参与优化或轮次选择；不能把纯模仿后的 Q 数值当成已校准的终局收益预测，也不能用这些未优化的损失判断牌技。','',
    '以下额外诊断均使用已固定的验证局面，没有据此挑选模型。吻合率衡量学到标签的程度，不证明牌技；纠错局面之外的行为改变也需要关注。','',
    '| 直接网络 | 所有局面吻合纠错答案 | 被纠正局面吻合纠错答案 | 未纠正局面保持原答案 | 有胡时未选胡 |',
    '| --- | ---: | ---: | ---: | ---: |');
  for(const arm of ARMS){const c=diagnostics.models[arm];lines.push(`| ${arm} | ${pct(c.correctedAgreement,c.samples)} | ${pct(c.changedCorrectedAgreement,c.changedSamples)} | ${pct(c.unchangedRawAgreement,c.unchangedSamples)} | ${c.huDeclined}/${c.huOffered} |`);}
  lines.push('','## 对手子组（描述性）','','| 对照 / 组合 | 净底分差/百手 | 95% 配对组区间 |','| --- | ---: | --- |');
  for(const [key,r]of Object.entries(s.evaluation.contrasts))for(const [pair,x]of Object.entries(r.statistics.session.byOpponentPair))lines.push(`| ${labels[key]} / ${pair} | ${n(x.deltaPer100)} | ${ci(x)} |`);
  lines.push('','## 三版本得分和行为（描述性）','','| 目标网络 | 净分/百手 | 胡牌比例 | 放炮比例 | 亮倒比例 | 胡分/百手 | 杠分/百手 | 查叫分/百手 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};for(const arm of ARMS){const c=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,groups.reduce((n,g)=>n+g.record.arms[arm][k],0)]));behavior[arm]=c;
    lines.push(`| ${arm} | ${n(100*c.score/c.hands)} | ${pct(c.wins,c.hands)} | ${pct(c.dealIns,c.hands)} | ${pct(c.revealHands,c.hands)} | ${n(100*c.huScore/c.hands)} | ${n(100*c.kongScore/c.hands)} | ${n(100*c.drawScore/c.hands)} |`);}
  lines.push('','corrected 为纠错学生，self 为同预算自模仿学生，raw 为冻结原网络。全部子组和行为分解未经多重比较校正，只作描述；局部标签选择会改变整条后续轨迹，不能据此精确归因每次动作的价值。','',
    '## 核验、范围和下一步','',
    `全部 ${s.trainingHands+s.validationHands} 手共同采集牌局和 ${v.games} 局实际评测按种子重新发牌，逐条复核完整动作、轮庄、结算、两份标签、公开输入和分项汇总。核对 ${v.snapshotsVerified} 份训练快照及其 PT 哈希、最低验证轮次、两个第 0 轮与原权重一致；Python/JavaScript 导出检查通过。完整 JavaScript 回归 ${passed[1]} 项通过。`,'',
    '小型集成测试还分别匹配原双版本考场的完整牌谱和记分记录，检查第三条轨迹不干扰原对照，并拒绝被篡改的来源、标签尾部和分数。审计重放、开发夹具不算额外正式样本。','',
    '这只有一个共同训练种子和固定小网络容量；验证模仿成功与实际收益改善分别判断。即使联合通过，也需要新发牌复验、跨训练种子和更广对手池检验；未通过则保留全部结果，不追加本批比赛争取显著。上一轮固定推理约束的正结果不自动证明学生训练有效。','',
    s.positiveJointEvidence?'下一步冻结纠错学生，在新发牌中复验，并直接挑战不亮倒 H0；不先改默认电脑。':'下一步先依据两类验证局面的学习与保留情况判断问题位于纠错覆盖、旧行为保留还是分布变化，再设计下一项独立训练对照；本轮不自动晋级。','',
    `本地运行目录：\`${relative(projectRoot,out)}\`。报告附选中模型、原模型、优化器状态、训练记录、审计、源码归档及校验索引；全部快照和完整压缩牌谱保存在本机忽略的运行目录，见 [artifacts.json](artifacts.json)。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');
  return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
