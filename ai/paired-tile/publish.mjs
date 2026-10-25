import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {projectRoot} from '../provenance.mjs';
import {check,read,hash,jobsFor} from './config.mjs';
import {aggregate,checkTraining} from './study.mjs';
import {verifyPredictionDiagnostic} from './diagnose.mjs';
export function conclusion(s){
  if(s.status==='no-eligible-roots')return '采集完成，但训练或验证没有形成分歧样本，未启动收益训练和封闭验收。';
  if(s.status==='zero-selected')return '实际收益训练已完成，但验证选择第 0 轮。候选与原短版严格同策略，未启动封闭验收，不能宣称牌技提升。';
  if(s.positiveJointEvidence)return '本批学习筛选与强度联合门槛通过，仍需独立发牌和独立训练种子复验，不自动晋级。';
  if(s.outcomes.improvement==='negative'||s.outcomes.selection==='negative')return '本批至少一项主要学习对照有负收益证据，未通过条件筛选门槛，不采用该训练候选。';
  if(s.learningEvidence)return '本批支持相对短版和总接受提议策略均有收益。'+(s.outcomes.strength==='negative'?'但仍明确落后强参照，整体联合门槛未通过。':'尚未确认超过强参照，整体联合门槛未通过。');
  return '本批未通过预定学习与强度联合门槛，尚不能确认网络学会了有收益的条件筛选。'+(s.outcomes.strength==='negative'?'本批还明确落后强参照。':'');
}
export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(v.planSha256,hash(resolve(out,'plan.json')));assert.equal(s.planSha256,v.planSha256);assert.equal(v.summarySha256,hash(resolve(out,'summary.json')));assert.deepEqual(v.sourceMap,p.sourceMap);assert.equal(v.games,s.games);assert.ok(v.allGroupsRecomputedWithoutScoreCache);
  assert.equal(v.data.reduce((n,x)=>n+x.hands,0),s.trainingHands+s.validationHands);assert.ok(v.data.every(x=>x.allHandsAndBranchesRecomputed&&x.cacheDisabled));
  const groups=s.games?jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json'))):[];
  if(s.games){assert.deepEqual(s.evaluation,aggregate(p,models,groups));for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndPoliciesAndExactTracesMatched&&a.cacheDisabled);assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}}
  if(t.trained){assert.deepEqual(checkTraining(out,p),t.trained);assert.equal(v.trainingSnapshotsRecomputed,p.budget.epochs+1);}
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[],add=file=>{artifacts.push({path:relative(projectRoot,file),sha256:hash(file)});},copy=(file,name)=>{copyFileSync(file,resolve(destination,name));add(file);};
  for(const name of ['plan.json','summary.json','verification.json','training.json','models.json','runtime.json','frozen-sources.tar.gz','execution.log','audit.log'])copy(resolve(out,name),name);copy(tests,'tests-node.log');
  for(const split of ['training','validation']){copy(resolve(out,split,'manifest.json'),split+'-manifest.json');add(resolve(out,split,'episodes.jsonl.gz'));for(const part of t.datasets[split].parts)for(const f of ['manifest.json','episodes.jsonl.gz'])add(resolve(part,f));}
  for(const arm of ['short','long']){copy(p.models[arm].path,arm+'-model.json');copy(p.models[arm].state,arm+'-model.pt');}
  if(t.trained){copy(models.learned.path,'learned-model.json');copy(models.learned.state,'learned-model.pt');copy(resolve(out,'model/epoch-000.json'),'zero-model.json');copy(resolve(out,'model/parity.json'),'parity.json');
    add(resolve(out,'train.json'));add(resolve(out,'model/summary.json'));for(const r of t.trained.training.history)for(const ext of ['json','pt'])add(resolve(out,'model',`epoch-${String(r.epoch).padStart(3,'0')}.${ext}`));}
  const diagnostic=existsSync(resolve(out,'constant-baseline-diagnostic.json'))?verifyPredictionDiagnostic(out):null;
  if(diagnostic){copy(resolve(out,'constant-baseline-diagnostic.json'),'constant-baseline-diagnostic.json');add(resolve(projectRoot,'ai/paired-tile/diagnose.mjs'));}
  for(const g of groups)for(const f of ['group.json','replays.jsonl.gz'])add(resolve(out,'groups',g.job.id,f));
  const n=x=>Number(x).toFixed(2),ci=x=>'['+x.ci95.map(n).join(', ')+']',labels={improvement:'学习版 − 原短版',selection:'学习版 − 总接受提议',strength:'学习版 − 不亮倒 H0'},lines=[
    '# 牌张网络成对收益学习结果','',conclusion(s),'',
    `本轮实际新增 ${s.trainingHands} 手训练用牌局、${s.validationHands} 手独立验证，形成 ${s.trainingSamples} 个训练分歧样本，完成 ${s.optimizationUpdates} 次优化更新、${s.games} 局正式评测。默认 H0。`,'',
    '## 训练什么','',
    '在短版自身的新局面中，每手第一次不亮倒弃牌分歧由短版和长版牌张提议各打一条终局。网络用完整公开牌张编码学习两种动作的实际净收益差；只在差分预测大于零时接受提议，随后继续短版。胡、碰、杠、亮倒保持短版，暗牌只用于离线标签和审计。','',
    '本轮将已有成对收益思路用于当前牌张网络和自身状态，不称首次收益学习。一次真实世界的分支收益不是公开状态的已知期望收益，也不是连续轮庄的完整反事实回报。参见[首手前方案](../../牌张网络成对收益学习.md)。','',
    '## 新数据和分支','',
    '| 数据 | 原始牌局 | 分歧样本 | 非零收益差 | 额外终局分支 |','| --- | ---: | ---: | ---: | ---: |'];
  for(const split of ['training','validation']){const d=t.datasets[split];lines.push(`| ${split} | ${d.hands} | ${d.roots} | ${d.nonzeroGains} | ${d.extraBranches} |`);}
  lines.push('','baseline 使用实际采集后续，额外分支只增加一次 alternative 续打。原始训练手数只计一次；成对结果、审计重算及测试夹具不算新增独立牌局。','',
    '## 固定训练和验证选择','');
  if(t.trained){const f=t.trained.training,r=f.history[f.selected.epoch];lines.push(
    `网络共 ${f.parameters} 参数，其中 ${f.trainableParameters} 个可训练。动作头与 valueHead 从零开始，rankHead/valueHead 和动作偏置固定，其余参数从短版继续训练。Adam 固定 ${p.budget.epochs} 轮，以验证成对均方误差选第 ${f.selected.epoch} 轮，包含零轮，同分取最早。`,
    '', '| 验证指标 | 第 0 轮 | 所选轮次 |','| --- | ---: | ---: |',
    `| 成对均方误差 | ${f.history[0].validation.mse.toFixed(6)} | ${r.validation.mse.toFixed(6)} |`,
    `| 接受提议数 / 样本数 | ${f.history[0].validation.accepts}/${f.validationSamples} | ${r.validation.accepts}/${f.validationSamples} |`,'',
    `Python/JavaScript 所选模型导出最大误差 ${t.trained.parityMaxError}。所有 ${p.budget.epochs+1} 份快照的模型、Adam、训练/验证指标和所选轮次已独立重算匹配。验证误差与单步分支收益诊断不能替代连续实战净收益。`);
  }else lines.push('训练或验证未形成可用分歧样本，按预定停止条件没有训练。');
  if(diagnostic)lines.push('','事后预测诊断（未用于选模型或改变主要检验）：仅用训练样本平均收益作常数预测，验证均方误差为 '+diagnostic.validationTrainingMeanConstantMse.toFixed(6)+'；所选网络为 '+diagnostic.validationSelectedNetworkMse.toFixed(6)+'，相对误差降低约 '+(100*diagnostic.networkRelativeMseReductionVsConstant).toFixed(2)+'%。这只是微小预测改善，不是另一项实战强度证据。详见 [诊断记录](constant-baseline-diagnostic.json)。');
  lines.push('','## 封闭验收','');
  if(s.status==='zero-selected')lines.push('验证选择第 0 轮；其动作头和值头严格为零，任意公开输入下两动作 Q 差均为零，规则总是保留短版。因此候选与短版全局同策略，按首手前规则停止封闭验收，实际新增正式评测为 0；这不检验总接受提议或强参照的相对强度。');
  else if(!s.games)lines.push('没有启动封闭验收，不能据此判断实战强度。');
  else{
    lines.push(`三种对手组合各 ${p.budget.groupsPerPair} 个完整组，六座位、四轨迹、连续 ${p.budget.sessionHands} 手。各组合等权，完整组 bootstrap ${p.budget.bootstrapSamples} 次。学习筛选要求前两项区间同时严格大于零；整体学习与强度联合主张要求三项同时通过（交并检验）。`,'',
      '| 预定主要对照 | 净底分差 / 百手 | 95% 完整组配对区间 | 结果 |','| --- | ---: | --- | --- |');
    for(const [key,x]of Object.entries(s.primary))lines.push(`| ${labels[key]} | ${n(x.deltaPer100)} | ${ci(x)} | ${s.outcomes[key]} |`);
    lines.push('',conclusion(s),'','对照共用学习版轨迹，不当作独立复验；区间跨零表示本批证据不足，不是两策略等价。没有与旧考卷相减或合并、根据中途成绩换模型/阈值/预算。','',
      '## 机会与改牌（描述性）','','| 策略 | 多合法动作选择 | 每手首次机会 | 实际改牌 |','| --- | ---: | ---: | ---: |');
    for(const arm of ['learned','always','baseline'])lines.push(`| ${arm} | ${groups.reduce((n,g)=>n+g.components[arm].choices,0)} | ${groups.reduce((n,g)=>n+g.components[arm].opportunities,0)} | ${groups.reduce((n,g)=>n+g.components[arm].interventions,0)} |`);
    lines.push('','计数来自各自实际轨迹，不能相减解释单次改牌的因果收益。learned 按预测筛选，always 每手首次机会总改牌，baseline 始终短版，reference 为不亮倒 H0。','',
      '## 对手子组（未经多重比较校正，仅描述）','','| 对照 / 对手组合 | 净底分差 / 百手 | 普通 95% 区间 |','| --- | ---: | --- |');
    for(const [key,r]of Object.entries(s.evaluation.contrasts))for(const [pair,x]of Object.entries(r.statistics.session.byOpponentPair))lines.push(`| ${labels[key]} / ${pair} | ${n(x.deltaPer100)} | ${ci(x)} |`);
  }
  lines.push('','## 核验和限制','',
    `全部 ${s.trainingHands+s.validationHands} 手采集和全部额外分支均已关闭缓存从种子重算；完整模型输入、两种公开提议、真实动作、标签、轮庄和结算匹配。全部 ${s.games} 局正式评测关闭缓存重新运行匹配。${passed[1]} 项回归通过，包含首次机会边界、零预测保留短版、正负收益梯度、训练快照/Adam 精确重跑、导出和标签篡改拒绝。`,
    '', '单个训练种子、固定对手池、首次弃牌分歧的条件策略。收益回归和验证均方误差不保证牌技提升；没有覆盖后续所有弃牌，也没有训练胡杠亮倒取舍。不将任何旧考试数据用于训练，即使通过仍需独立发牌、独立训练种子和更广对手检验。默认 H0，不自动部署。','',
    `完整运行位于 \`${relative(projectRoot,out)}\`，源数据、快照和完整牌谱索引见 [artifacts.json](artifacts.json)。`,'');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');return resolve(destination,'实验结果.md');
}
