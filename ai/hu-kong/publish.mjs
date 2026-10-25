import assert from 'node:assert/strict';
import {existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {ARMS,NEURAL,check,jobsFor,read,hash} from './config.mjs';
import {aggregate} from './study.mjs';
export function conclusion(s){
  if(s.positiveJointEvidence)return '本批候选相对未替换策略和强参照均有正收益证据，通过联合门槛，仍需独立复验。';
  if(s.outcomes.mechanism==='negative')return '本批替换相对未替换策略有负收益证据，不采用该替换，联合门槛未通过。';
  if(s.outcomes.mechanism==='positive')return '本批支持替换改善基础策略，但未确认超过强参照，联合门槛未通过。';
  return '本批未通过预定机制与强度联合门槛，尚不能确认该胡杠取舍替换既改善基础策略又超过强参照。';
}
export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json'));check(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);assert.deepEqual(v.sourceMap,p.sourceMap);
  assert.equal(s.productionPolicy,'H0');assert.equal(s.newUniqueTrainingHands,0);assert.equal(s.newUniqueValidationHands,0);assert.ok(v.allGroupsRecomputedWithoutScoreCache);
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,groups));assert.equal(v.groups.length,groups.length);
  assert.equal(s.positiveJointEvidence,Object.values(s.primary).every(x=>x.ci95[0]>0));
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndPoliciesAndExactTracesMatched&&a.cacheDisabled);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[],add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)}),copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  for(const name of ['plan.json','summary.json','verification.json','models.json','runtime.json','frozen-sources.tar.gz','execution.log','audit.log'])copy(resolve(out,name),name);copy(tests,'tests-node.log');
  for(const arm of ['short','long']){const x=p.models[arm];assert.equal(hash(x.path),x.sha256);assert.equal(hash(x.state),read(x.path).metadata.optimizerStateSha256);copy(x.path,arm+'-model.json');copy(x.state,arm+'-model.pt');}
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');
  const n=x=>Number(x).toFixed(2),ci=x=>'['+x.ci95.map(n).join(', ')+']',pct=(a,b)=>b?n(100*a/b)+'%':'无样本',labels={mechanism:'候选 − 未替换 base',strength:'候选 − 不亮倒 H0',short:'候选 − 原短版'};
  const events=Object.fromEntries(NEURAL.map(arm=>[arm,{choices:groups.reduce((n,g)=>n+g.components[arm].choices,0),
    huOffered:groups.reduce((n,g)=>n+g.components[arm].huOffered,0),huDeclined:groups.reduce((n,g)=>n+g.components[arm].huDeclined,0),
    conflicts:groups.reduce((n,g)=>n+g.components[arm].conflicts,0),overrides:groups.reduce((n,g)=>n+g.components[arm].overrides,0),
    groupsWithConflicts:groups.filter(g=>g.components[arm].conflicts>0).length,groupsWithOverrides:groups.filter(g=>g.components[arm].overrides>0).length,
    byKind:Object.fromEntries(['an','bu','ming'].map(k=>[k,groups.reduce((n,g)=>n+g.components[arm].byKind[k],0)]))}]));
  const lines=['# 可胡时胡杠取舍独立对照结果','',conclusion(s),'',
    `冻结两模型，新增训练、验证与优化更新均为 0。四策略完成 ${s.games} 局全新对局，每版 ${s.primary.mechanism.hands} 手，${groups.length} 个完整组。默认 H0。`,'',
    '## 本轮仅改变一个冲突条件','',
    'base 精确复现上一轮 other=lss：长版控制动作，短版控制亮倒和弃牌。仅在短版全合法最大 Q 选胡，而 base 选明杠/暗杠/补杠时，候选返回这一个已有合法胡动作。其余选择全部保持 base，不强制短版本身不想胡的牌，也不覆盖其他胡/过/弃牌分歧。参见[预定方案](../../可胡时胡杠取舍独立对照.md)。','',
    '这是冻结模型的推理组件干预，没有新学习权重或逐状态期望收益估计。作用环境是 lss，并非整个长版 lll，不外推到所有开杠或有胡时的取舍。','',
    '## 两项预定主要检验','',
    `三种既有对手组合等权，各 ${p.budget.groupsPerPair} 组；每组六种座位、四条独立策略轨迹、连续轮庄 ${p.budget.sessionHands} 手。完整组 bootstrap ${p.budget.bootstrapSamples} 次。下表前两项双侧 95% 区间必须同时严格大于零，才支持机制与强度联合主张（交并检验）。`,'',
    '| 对照 | 净底分差/百手 | 95% 完整组配对区间 | 口径 |','| --- | ---: | --- | --- |'];
  for(const [key,r]of Object.entries(s.evaluation.contrasts)){const x=r.statistics.session.overall;lines.push(`| ${labels[key]} | ${n(x.deltaPer100)} | ${ci(x)} | ${key==='short'?'次要描述':s.outcomes[key]} |`);}
  lines.push('',conclusion(s),'','不能用一项通过替代联合通过；对照共用候选轨迹，不当作独立复验。没有与历史发牌相减、合并求显著、按中途得分换模型或追加牌局。','',
    '## 实际冲突与替换（描述性）','','| 策略 | 多合法动作选择 | 可胡选择次数 | 未选胡 | 目标冲突 | 实际替换 | 明/暗/补杠冲突 |','| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for(const arm of NEURAL){const x=events[arm];lines.push(`| ${arm} | ${x.choices} | ${x.huOffered} | ${x.huDeclined} | ${x.conflicts} | ${x.overrides} | ${x.byKind.ming}/${x.byKind.an}/${x.byKind.bu} |`);}
  lines.push('',events.patched.overrides===0?'候选轨迹中未实际触发替换，不能据此验证机制有效或声称与 base 普遍等价。':
    `候选实际替换 ${events.patched.overrides} 次，分布在 ${events.patched.groupsWithOverrides}/${groups.length} 个完整组中，全部满足预定条件，冲突与替换计数一致。`,'',
    '上述计数来自各自策略实际到达的公开局面；不同策略轨迹不同，不能简单相减解释每次动作的因果收益。未选胡也不直接判作错误。多次触发可能来自相同种子的相关座位/连续牌局，不当独立样本。完整冲突事件保存在各组记录中。','',
    '## 对手子组（描述性）','','| 对照 / 对手组合 | 净底分差/百手 | 普通 95% 区间 |','| --- | ---: | --- |');
  for(const [key,r]of Object.entries(s.evaluation.contrasts))for(const [pair,x]of Object.entries(r.statistics.session.byOpponentPair))lines.push(`| ${labels[key]} / ${pair} | ${n(x.deltaPer100)} | ${ci(x)} |`);
  lines.push('','## 四策略行为（描述性）','','| 策略 | 净分/百手 | 胡牌比例 | 放炮比例 | 亮倒比例 | 胡分/百手 | 杠分/百手 | 查叫分/百手 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};for(const arm of ARMS){const x=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,groups.reduce((n,g)=>n+g.record.arms[arm][k],0)]));behavior[arm]=x;
    lines.push(`| ${arm} | ${n(100*x.score/x.hands)} | ${pct(x.wins,x.hands)} | ${pct(x.dealIns,x.hands)} | ${pct(x.revealHands,x.hands)} | ${n(100*x.huScore/x.hands)} | ${n(100*x.kongScore/x.hands)} | ${n(100*x.drawScore/x.hands)} |`);}
  lines.push('','patched=候选，base=未替换的 lss，short=冻结短版，reference=不亮倒 H0。胡、杠与查叫分解为描述，不能单独归因于某次替换。','',
    '## 核验和限制','',
    `全部 ${s.games} 局关闭缓存、从种子重发并重新计算各策略，逐动作牌谱、冲突/替换事件、组件计数、轮庄、分项结算和汇总均匹配。两模型 JSON/PT、源码与统计区间已核对。${passed[1]} 项回归通过，覆盖三种杠和不强制胡的边界、base 重现、标准评测对照、无缓存重放及篡改拒绝。`,'',
    '本轮预算为首局前固定的新实验，稀少触发未导致扩样。固定数据/权重/对手分布下的组件效应，不是新训练方法或所有对手上的通用结论。默认 H0，不自动晋级；即使联合通过也需独立复验。已公开考卷不拿来训练，审计重放与测试夹具不计正式样本。','',
    `完整运行位于 \`${relative(projectRoot,out)}\`，全部牌谱索引见 [artifacts.json](artifacts.json)。`,'');
  writeFileSync(resolve(destination,'interventions.json'),JSON.stringify(events,null,2)+'\n');writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
