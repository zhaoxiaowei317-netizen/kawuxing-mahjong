import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {projectRoot} from '../provenance.mjs';
import {check,read,hash,jobsFor} from './config.mjs';
import {checkFit,aggregate,judgments} from './study.mjs';
export function conclusion(s){
  if(s.status==='constant-selected')return `已完成固定收益拟合，但验证选择了恒定策略，判断器在全部合格局面恒等于 ${s.identityTo==='always'?'Always（总接受首次备选）':'Short（保留原弃牌）'}。按预定条件不做重复考试，尚未学到经实战确认有收益的条件筛选。`;
  if(s.positiveJointEvidence)return '本批通过四项联合门槛，支持公开教师分歧特征改善条件筛选，且相对固定强规则对照有收益；仍需独立训练种子和新发牌复验，不自动晋级。';
  if(s.learningEvidence)return '本批支持公开教师分歧特征改善条件筛选，但尚未通过包含强规则对照在内的整体联合门槛。';
  if(['representation','improvement','selection'].some(k=>s.outcomes[k]==='negative'))return '本批未通过预定学习联合门槛，至少一项主要学习对照为负向区间，不能把本候选作为已提升牌技的策略。';
  return '本批未通过预定联合门槛，尚不能确认公开教师分歧特征带来了更赚钱的出牌筛选。';
}
export function publish({out,destination,tests,coreTests}){
  out=resolve(out);destination=resolve(destination);assert.ok(!existsSync(destination));const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(v.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.summarySha256,hash(resolve(out,'summary.json')));assert.equal(v.parentVerificationSha256,p.previous.files['verification.json']);assert.equal(v.games,s.games);assert.deepEqual(v.sourceMap,p.sourceMap);assert.ok(v.parentRawDataAuditInherited&&v.allDerivedPublicFeaturesRecomputed&&v.allEightFitsRecomputed&&v.allGroupsRecomputedWithoutScoreCache);assert.deepEqual(checkFit(out,p),t.fitted);assert.deepEqual(v.data,t.datasets);
  const groups=s.games?jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json'))):[];if(s.games){assert.deepEqual(s.evaluation,aggregate(p,models,groups));for(const [k,x]of Object.entries(judgments(s.evaluation)))assert.deepEqual(s[k],x);
    for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.cacheDisabled&&a.allEpisodesRedealtAndPoliciesAndExactTracesMatched);assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}}
  for(const [path,count]of [[tests,3],[coreTests,242]]){const log=readFileSync(path,'utf8');assert.match(log,new RegExp('(?:ℹ|#) pass '+count+'\\b'));assert.match(log,/(?:ℹ|#) fail 0\b/);}
  mkdirSync(destination,{recursive:true});const artifacts=new Map(),add=path=>artifacts.set(relative(projectRoot,path),hash(path)),copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  for(const name of ['plan.json','summary.json','verification.json','training.json','models.json','runtime.json','execution.log','audit.log','frozen-sources.tar.gz'])copy(resolve(out,name),name);copy(tests,'gate-tests.log');copy(coreTests,'core-tests.log');
  copy(resolve(p.previous.path,'verification.json'),'parent-verification.json');for(const split of ['training','validation']){copy(resolve(out,split,'manifest.json'),split+'-manifest.json');add(resolve(out,split,'rows.jsonl.gz'));add(resolve(p.previous.path,split,'manifest.json'));add(resolve(p.previous.path,split,'episodes.jsonl.gz'));}
  for(const key of ['short','long','average']){copy(p.models[key].path,key+'-model.json');copy(p.models[key].state,key+'-model.pt');}
  copy(models.gate.path,'gate-model.json');copy(resolve(out,'model/summary.json'),'fit-summary.json');copy(resolve(out,'model/parity.json'),'parity.json');add(resolve(out,'fit.json'));
  for(const row of t.fitted.fit.history)add(resolve(out,'model',row.name+'.json'));for(const g of groups)for(const f of ['group.json','replays.jsonl.gz'])add(resolve(out,'groups',g.job.id,f));
  const f=t.fitted.fit,n=x=>Number(x).toFixed(2),ci=x=>'['+x.ci95.map(n).join(', ')+']',labels={representation:'判断器 − 父实验 Average 网络',improvement:'判断器 − Short',selection:'判断器 − Always',strength:'判断器 − N（不亮倒 H0）'},lines=[
    '# 公开教师分歧收益筛选结果','',conclusion(s),'',
    `复用父实验 ${s.reusedTrainingHands} 手训练、${s.reusedValidationHands} 手验证，对应 ${s.trainingRoots} 个训练局面和 ${s.validationRoots} 个验证局面。新增采集手数 0；实际完成 ${s.closedFormFits} 次岭回归闭式拟合、${s.games} 场新考试。没有追加神经网络梯度更新。默认 H0。`,'',
    '## 学习内容','',
    `固定原 Short、Long 网络的全部权重，从完整合法动作集合中提取其公开排序分歧，结合候选弃牌牌效差、原牌效和公开上下文，共 ${f.features} 维特征。收益判断器有 ${f.fittedReadoutParameters} 个回归系数/截距，另保存训练集归一化统计。神经网络排序分数不等于期望得分。`,
    '', '标签复用父实验全部训练/验证局面在固定实际对手手牌下的八种未来牌墙配对收益平均值，除以 16。它仍不是公共状态的精确期望收益。只重算公开特征，没有使用父实验考试牌谱，也没有把复用数据计为新增训练手数。详见[考试前方案](../../教师分歧收益筛选.md)。','',
    '每手只处理第一次 Short 不亮倒弃牌与 Long 牌张备选分歧：预测严格大于零才改牌，平手保留 Short，首次机会用掉后继续 Short。其余胡、碰、杠、亮倒决定沿用 Short。Average 为父实验已固定的收益网络，Always 总接受同一首次备选，N 为固定强规则对照。','',
    '## 固定拟合与验证选择','',
    '只用训练集确定均值和标准差。固定六个正则值及零预测、训练均值常数，按验证 MSE 选最小值，1e-12 内同分取较早候选。没有在考试中换模型、阈值或正则。','',
    '| 候选 | 训练 MSE | 验证 MSE | 验证接受数 |','| --- | ---: | ---: | ---: |'];
  for(const row of f.history)lines.push(`| ${row.name}${row.name===f.selected.name?'（所选）':''} | ${row.training.mse.toFixed(6)} | ${row.validation.mse.toFixed(6)} | ${row.validation.accepts}/${f.validationRoots} |`);
  lines.push('',`Python/JavaScript 最大导出预测差 ${t.fitted.parityMaxError}。全部候选的系数、训练归一化、指标和选模已独立重跑匹配。验证拟合误差不替代实战牌技证据。`,'','## 新发牌验收','');
  if(s.status==='constant-selected')lines.push(`所选模型全部特征系数严格为零，推理显式直接返回截距。因此不论公开牌型如何都选择同一个策略，已证明全局恒等于 ${s.identityTo}。按事先固定的停止条件没有执行考试，实际新增强度评测 0 场；这没有比较其与 N 或父实验 Average 的相对强度。`);
  else{
    lines.push(`三个对手组合各 ${p.budget.groupsPerPair} 个完整组，六种座位、五个策略、每次连续 ${p.budget.sessionHands} 手；三个组合等权，完整组配对 bootstrap ${p.budget.bootstrapSamples} 次。单位是每百手净底分差。`,'',
      '| 预定共同主比较 | 净底分差 / 百手 | 名义 95% 完整组区间 | 区间方向 |','| --- | ---: | --- | --- |');
    for(const [key,x]of Object.entries(s.primary))lines.push(`| ${labels[key]} | ${n(x.deltaPer100)} | ${ci(x)} | ${s.outcomes[key]} |`);
    lines.push('',conclusion(s),'','前三项同时严格正向才支持本方法改善条件筛选，四项均正向才支持整体联合主张。单个区间未做四项任取成功的家族错误率控制；对照共用候选轨迹，可能同策略，不当作独立复验。跨零表示证据不足。','',
      '## 实际行为（仅描述）','','| 策略 | 多合法动作选择 | 首次机会 | 改为备选 |','| --- | ---: | ---: | ---: |');
    for(const arm of ['gate','average','always','baseline'])lines.push(`| ${arm} | ${groups.reduce((n,g)=>n+g.components[arm].choices,0)} | ${groups.reduce((n,g)=>n+g.components[arm].opportunities,0)} | ${groups.reduce((n,g)=>n+g.components[arm].interventions,0)} |`);
    lines.push('','各自牌局轨迹可能不同，不能通过计数相减得出一次改牌的因果收益。');
  }
  lines.push('','## 核验与限制','',
    '父实验的原始采集、额外分支、神经网络和全部考试已完整审计，其文件哈希作为依赖固定；本轮继承这些已验证结果，未重复模拟并重复计数。本轮全部公开特征重新生成并逐字节核对，八个候选完整重跑，所有实际新考试关闭缓存重发且逐项核对牌谱、结算和统计。',
    '',`主回归 242 项与本方法 3 项专项通过。专项覆盖公开输入、完整合法动作教师分数、已知合成信号、精确拟合重跑、导出、派生特征篡改和原始父数据连同相邻校验值一起篡改的拒绝；小规模五策略结果与原评测器四项对照一致。`,
    '', '单一训练数据种子、固定对手池、首次弃牌的条件筛选。不能把一个批次或轻量模型更容易拟合当作最强麻将 AI。任何正向候选仍需新发牌、独立训练数据和更广对手复验，不自动部署。',
    '',`运行目录 \`${relative(projectRoot,out)}\`；原始派生数据、全部拟合、考试牌谱和来源索引见 [artifacts.json](artifacts.json)。`,'');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify([...artifacts].map(([path,sha256])=>({path,sha256})),null,2)+'\n');
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');return resolve(destination,'实验结果.md');
}
