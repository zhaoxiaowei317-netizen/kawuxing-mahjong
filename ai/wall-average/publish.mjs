import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {projectRoot} from '../provenance.mjs';
import {check,read,hash,jobsFor} from './config.mjs';
import {aggregate,checkTraining,diagnostics,judgments} from './study.mjs';
export function conclusion(s){
  if(!s.games)return '采集完成，但没有足够有效局面启动双模型训练和独立实战，不能判断方法效果。';
  if(s.positiveJointEvidence)return '本批四项联合门槛通过，支持降低未来摸牌噪声改善条件筛选，且相对固定强规则对照有收益；仍需独立训练与独立发牌复验，不自动晋级。';
  if(s.learningEvidence)return '本批支持降低未来摸牌噪声改善条件筛选，但尚未通过包括强规则对照在内的整体联合门槛。';
  if(['variance','improvement','selection'].some(k=>s.outcomes[k]==='negative'))return '本批未通过预定联合门槛，至少一项学习对照出现负向区间；不能采用本候选作为已提升牌技的策略。';
  return '本批未通过预定联合门槛，尚不能确认平均收益标签让模型学会更赚钱的出牌筛选。';
}
export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(v.planSha256,hash(resolve(out,'plan.json')));assert.equal(s.planSha256,v.planSha256);assert.equal(v.summarySha256,hash(resolve(out,'summary.json')));assert.deepEqual(v.sourceMap,p.sourceMap);assert.equal(v.games,s.games);assert.ok(v.allGroupsRecomputedWithoutScoreCache);
  assert.equal(v.data.reduce((n,x)=>n+x.hands,0),s.trainingHands+s.validationHands);assert.ok(v.data.every(x=>x.allHandsAndBranchesRecomputed&&x.cacheDisabled));
  const groups=s.games?jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json'))):[];
  if(s.games){assert.deepEqual(s.evaluation,aggregate(p,models,groups));for(const [k,x]of Object.entries(judgments(s.evaluation)))assert.deepEqual(s[k],x);
    for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndPoliciesAndExactTracesMatched&&a.cacheDisabled);assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
    for(const variant of ['average','single'])assert.deepEqual(checkTraining(out,p,variant),t.trained[variant]);assert.equal(v.trainingSnapshotsRecomputed,2*(p.budget.epochs+1));
    assert.deepEqual(read(resolve(out,'diagnostics.json')),diagnostics(out,p,models));assert.equal(s.diagnosticsSha256,hash(resolve(out,'diagnostics.json')));
  }
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=new Map(),add=file=>artifacts.set(relative(projectRoot,file),hash(file)),copy=(file,name)=>{copyFileSync(file,resolve(destination,name));add(file);};
  for(const name of ['plan.json','summary.json','verification.json','training.json','models.json','runtime.json','frozen-sources.tar.gz','execution.log','audit.log'])copy(resolve(out,name),name);copy(tests,'tests-node.log');
  for(const split of ['training','validation']){copy(resolve(out,split,'manifest.json'),split+'-manifest.json');add(resolve(out,split,'episodes.jsonl.gz'));for(const part of t.datasets[split].parts)for(const f of ['manifest.json','episodes.jsonl.gz'])add(resolve(part,f));}
  for(const arm of ['short','long']){copy(p.models[arm].path,arm+'-model.json');copy(p.models[arm].state,arm+'-model.pt');}
  if(s.games){copy(resolve(out,'diagnostics.json'),'diagnostics.json');for(const variant of ['average','single']){
    copy(models[variant].path,variant+'-model.json');copy(models[variant].state,variant+'-model.pt');copy(resolve(out,variant,'model/parity.json'),variant+'-parity.json');copy(resolve(out,variant,'model/summary.json'),variant+'-training-summary.json');
    add(resolve(out,variant,'train.json'));for(const split of ['training','validation'])for(const f of ['manifest.json','episodes.jsonl.gz'])add(resolve(out,variant,split,f));
    for(const r of t.trained[variant].training.history)for(const ext of ['json','pt'])add(resolve(out,variant,'model',`epoch-${String(r.epoch).padStart(3,'0')}.${ext}`));
  }}
  const identity=existsSync(resolve(out,'zero-identity.json'))?read(resolve(out,'zero-identity.json')):null;
  if(identity){assert.ok(identity.zeroHeadProvesGlobalShortPolicyIdentity&&identity.allGroupMetricsAndChoicesIdentical);assert.equal(identity.summarySha256,hash(resolve(out,'summary.json')));assert.equal(identity.sourceSha256,hash(new URL('./check-zero-identity.mjs',import.meta.url)));copy(resolve(out,'zero-identity.json'),'zero-identity.json');add(resolve(projectRoot,'ai/wall-average/check-zero-identity.mjs'));}
  for(const g of groups)for(const f of ['group.json','replays.jsonl.gz'])add(resolve(out,'groups',g.job.id,f));
  const n=x=>Number(x).toFixed(2),ci=x=>'['+x.ci95.map(n).join(', ')+']',labels={variance:'Average − Single',improvement:'Average − Short',selection:'Average − Always',strength:'Average − N（不亮倒 H0）'},lines=[
    '# 牌张网络多牌墙收益学习结果','',conclusion(s),'',
    `本轮新增 ${s.trainingHands} 手训练主轨迹和 ${s.validationHands} 手验证主轨迹；两个模型共用这些局面，不能把手数翻倍。完成 ${s.optimizationUpdates} 次优化更新、${s.games} 场实际验收。默认 H0。`,'',
    '## 本轮改了什么','',
    `每手仅取第一次 Short 与 Long 牌张排序产生的不亮倒弃牌分歧。保留实际完整手牌，第 0 组用实际剩余牌墙，另 ${p.budget.wallSamples-1} 组只重洗未来牌墙；每组两种弃牌共享同一牌墙，之后全部继续 Short，固定对手也按其策略续打到本手结束。`,
    '',`Single 学原始一次成对收益，Average 学全部 ${p.budget.wallSamples} 次成对收益的平均值，均除以 16。网络、初始化、批次顺序、优化器与轮数相同，仅标签不同。输入只含公开编码与合法动作，完整手牌和回放只用于离线标签和审计。`,
    '', '这不是重新采样对手手牌，也不是求出了公共信息下的精确期望收益；仍有实际对手手牌与局面分布带来的不确定性。训练只改变每手首次机会的弃牌筛选，胡、碰、杠、亮倒决定仍来自 Short。参见[正式采集前方案](../../牌张网络多牌墙收益学习.md)。','',
    '## 新数据与模拟量','','| 数据 | 主轨迹手数 | 有效局面 | 牌墙配对数 | 额外终局分支 |','| --- | ---: | ---: | ---: | ---: |'];
  for(const split of ['training','validation']){const d=t.datasets[split];lines.push(`| ${split} | ${d.hands} | ${d.roots} | ${d.wallPairs} | ${d.extraBranches} |`);}
  lines.push('',`一个有效局面增加 ${2*p.budget.wallSamples-1} 条分支，原牌墙的原弃牌续打复用主轨迹。牌墙样本、额外分支、审计重算、测试均不能当成新的独立训练局面或正式实战。`,'','## 两个模型的固定训练','','| 模型 | 固定轮数 | 所选轮 | 更新次数 | 自身标签零预测 MSE | 自身标签所选 MSE | 验证接受数 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for(const variant of ['average','single'])if(t.trained[variant]){const f=t.trained[variant].training,r=f.history[f.selected.epoch];lines.push(`| ${variant} | ${p.budget.epochs} | ${f.selected.epoch} | ${f.optimizationUpdates} | ${f.history[0].validation.mse.toFixed(6)} | ${r.validation.mse.toFixed(6)} | ${r.validation.accepts}/${f.validationSamples} |`);}
  lines.push('','两个模型分别按各自验证 MSE 选轮次，包括第 0 轮，同分取最早。**两行标签不同，不能直接比较两行 MSE 来宣称模型更聪明。** 第 0 轮动作头和值头为零，始终保留 Short，仍按预定完成实战对照。');
  for(const variant of ['average','single'])if(t.trained[variant]?.training.selected.epoch===0)lines.push('',`${variant} 本轮选中第 0 轮，严格恒等于 Short。涉及它和 Short 的比较共用同一策略，不是两次独立复验；点估计相同，有限次 bootstrap 使用不同随机流时区间端点可能略有不同。`);
  if(identity)lines.push('',`额外身份核验逐一比较了 Single 与 Short 的 ${identity.recordedActionReplayPairsIdentical} 对完整牌谱、全部分组指标和选择计数，均完全相同。见 [零轮身份核验](zero-identity.json)。这不增加考试场数。`);
  if(s.games){const d=read(resolve(out,'diagnostics.json')),m=d.commonAveragedValidationTarget;lines.push('','## 预设预测诊断（不是牌技证据）','',
    '| 共同目标：验证平均收益标签 | MSE |','| --- | ---: |',`| 零预测 | ${m.zeroMse.toFixed(6)} |`,`| 训练平均收益常数 | ${m.trainingConstantMse.toFixed(6)} |`,`| 已选 Average | ${m.modelMse.average.toFixed(6)} |`,`| 已选 Single | ${m.modelMse.single.toFixed(6)} |`,'',
    `验证局面内平均收益方差为 ${d.validation.averageWithinVariance}；估计单次标签的未来牌墙噪声贡献为 ${d.validation.estimatedFutureWallNoiseInOneLabel}，平均标签为 ${d.validation.estimatedFutureWallNoiseInMeanLabel}。扣除这部分噪声后的局面间方差估计为 ${d.validation.estimatedBetweenRootVariance}，允许负估计，不能据此断言全部训练信号大小。`,
    '',`原始标签与平均标签符号不同的验证局面为 ${d.validation.originalVersusAverageSignDisagreements}/${d.validation.roots}（零算单独符号）。详见 [diagnostics.json](diagnostics.json)。这些诊断不用于换模型、阈值、预算或改变主比较。`);
    lines.push('','## 独立实战验收','',`三种对手组合各 ${p.budget.groupsPerPair} 个完整组，六种座位、五种策略、连续 ${p.budget.sessionHands} 手，共 ${s.games} 场。三个对手组合等权；以完整组配对 bootstrap ${p.budget.bootstrapSamples} 次。单位是每百手净底分差。`,'',
      '| 预定共同主比较 | 净底分差 / 百手 | 名义 95% 完整组区间 | 区间方向 |','| --- | ---: | --- | --- |');
    for(const [key,x]of Object.entries(s.primary))lines.push(`| ${labels[key]} | ${n(x.deltaPer100)} | ${ci(x)} | ${s.outcomes[key]} |`);
    lines.push('',conclusion(s),'','前三项同时严格正向才支持降低牌墙噪声改善筛选学习，四项同时正向才支持包含强规则对照的整体主张。单项区间没有家族错误率校正，不允许四项任挑一项成功来替代联合门槛。区间跨零表示证据不足，不是策略相等。','',
      '## 行为计数（仅描述）','','| 策略 | 多合法动作选择 | 首次机会 | 接受备选 |','| --- | ---: | ---: | ---: |');
    for(const arm of ['average','single','always','baseline'])lines.push(`| ${arm} | ${groups.reduce((n,g)=>n+g.components[arm].choices,0)} | ${groups.reduce((n,g)=>n+g.components[arm].opportunities,0)} | ${groups.reduce((n,g)=>n+g.components[arm].interventions,0)} |`);
    lines.push('','各策略走自己的实际轨迹，不能把行为计数相减当作单次弃牌的因果收益。Always 每手接受首次备选，Short（baseline）拒绝，N 为固定强规则对照。');
  }
  lines.push('','## 核验与适用范围','',
    `全部 ${s.trainingHands+s.validationHands} 手主轨迹及所有额外终局分支已关闭缓存、从种子重算并核对完整动作和结算；两种派生训练数据逐字节核对；${v.trainingSnapshotsRecomputed} 份模型/Adam/历史/选模快照完整重跑；全部 ${s.games} 场考试关闭缓存重发并核对。回归测试 ${passed[1]} 项通过、0 失败。`,
    '', '仅一个训练种子、固定对手池、首次弃牌分歧策略。不能将验证误差降低当作超过强规则 AI，更不能声称达到人类高手水平。通过联合门槛也需要独立复验、更广对手和多训练种子；不自动替换默认策略。完整原始数据、34 份训练快照、全部牌谱与源码归档见 [artifacts.json](artifacts.json)。',
    '',`运行目录：\`${relative(projectRoot,out)}\`。`,'');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify([...artifacts].map(([path,sha256])=>({path,sha256})),null,2)+'\n');
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');return resolve(destination,'实验结果.md');
}
