import assert from 'node:assert/strict';
import {existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {ARMS,COMPONENTS,check,jobsFor,read,hash} from './config.mjs';
import {aggregate} from './study.mjs';
export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json'));check(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);assert.deepEqual(v.sourceMap,p.sourceMap);
  assert.equal(s.productionPolicy,'H0');assert.equal(s.newUniqueTrainingHands,0);assert.equal(s.newUniqueValidationHands,0);assert.ok(v.allGroupsRecomputedWithoutScoreCache);
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,groups));assert.equal(v.groups.length,groups.length);
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndPoliciesAndExactTracesMatched&&a.cacheDisabled);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[],add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)}),copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  const diagnostic=read(resolve(out,'transition-diagnostics.json'));assert.equal(diagnostic.planSha256,s.planSha256);
  assert.equal(diagnostic.driverSha256,hash(new URL('diagnose.mjs',import.meta.url)));assert.equal(diagnostic.groups,groups.length);
  assert.equal(diagnostic.changes.length,groups.reduce((n,g)=>n+g.components.other.changedFromShort,0));
  assert.equal(diagnostic.choices,groups.reduce((n,g)=>n+g.components.other.choices,0));
  for(const name of ['plan.json','summary.json','verification.json','models.json','runtime.json','frozen-sources.tar.gz','execution.log','audit.log','transition-diagnostics.json','diagnose.log'])copy(resolve(out,name),name);
  copy(tests,'tests-node.log');
  for(const arm of ['short','long']){const x=p.models[arm];assert.equal(hash(x.path),x.sha256);assert.equal(hash(x.state),read(x.path).metadata.optimizerStateSha256);copy(x.path,arm+'-model.json');copy(x.state,arm+'-model.pt');}
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');
  const n=x=>Number(x).toFixed(2),ci=x=>'['+x.map(n).join(', ')+']',pct=(a,b)=>b?n(100*a/b)+'%':'无样本',labels={tile:'弃牌牌张',reveal:'亮倒层',other:'动作控制器'},
    detected=COMPONENTS.filter(a=>s.outcomes[a]!=='inconclusive'),conclusion=detected.length?
      '经三项比较校正，本批检出部分单组件替换的收益方向；适用范围是另外两层保持短版的混合策略，不能直接分解长版整体分差。':
      '三项经多重比较校正的区间均包含零，本批尚未定位到有充分收益证据的单组件替换；不能把不确定解释成三个组件都没有影响。';
  const lines=['# 长短训练模型决策组件对照结果','',conclusion,'',
    `冻结短版第 ${p.models.short.epoch} 轮和长版第 ${p.models.long.epoch} 轮，新增训练、验证和优化更新均为 0。五种策略完成 ${s.games} 局新牌局，每策略 ${s.evaluation.contrasts.long.statistics.session.overall.hands} 手、${groups.length} 个完整组。默认 H0。`,'',
    '## 三项主要组件比较','',
    '短版分为动作控制器、亮倒标志和弃牌牌张三层。tile 只替换牌张层，reveal 只替换亮倒层，other 只替换动作控制器，其余两层始终使用短版。两个全同源组合精确重现原短版和长版。全部从完整合法 Q 中选择，未重新用受限掩码计算网络。参见[预定方法](../../长短训练模型决策组件对照.md)。','',
    `三种对手组合等权，每组合 ${p.budget.groupsPerPair} 组，每组六种座位、五条策略轨迹、连续轮庄 ${p.budget.sessionHands} 手。完整组 bootstrap ${p.budget.bootstrapSamples} 次；三项共用每次分层组索引，Bonferroni 双侧 98.333333% 区间，检验族 alpha 0.05。下表使用校正区间，不用普通 95% 区间替换主要判断。`,'',
    '| 单组件替换减短版 | 净底分差/百手 | 98.333333% 校正区间 | 结果 |','| --- | ---: | --- | --- |'];
  for(const a of COMPONENTS){const x=s.evaluation.family[a];lines.push(`| ${labels[a]} | ${n(x.deltaPer100)} | ${ci(x.ciFamily)} | ${x.outcome} |`);}
  const parent=s.evaluation.contrasts.long.statistics.session.overall;
  lines.push('',conclusion,'',
    `同期长版减短版为 ${n(parent.deltaPer100)} 底分/百手，普通 95% 区间 ${ci(parent.ci95)}，仅作次要描述。没有将它与上一轮不同发牌相减或事后合并。`,'',
    '## 判断边界','',
    '本轮没有完整八组合因子实验，三个组件效应不能相加解释长版总损失，也不估计交互。其他两层固定短版时的结果，不能直接外推到长版环境。早期动作改变会带动后续局面改变，完整策略分差不是每次动作的独立价值。','',
    '亮倒标志变化后，合法牌张集合可能改变，因此 reveal 也可能打出不同牌张；不能称为保持牌张不变的纯亮倒试验。other 包含打牌/胡/碰/杠/过的控制及非弃牌内部选择，不把其效果单独归给某一种杠。','',
    '五条策略没有不亮倒 H0 的目标参照。本轮不宣布强度超过它、不自动选择最好混合版、不晋级或部署。相同短版控制被多个对照共用，不是三份独立复验。','',
    '## 普通区间及子组（描述性）','','| 对照 / 组合 | 净底分差/百手 | 普通 95% 区间 |','| --- | ---: | --- |');
  for(const [key,r]of Object.entries(s.evaluation.contrasts)){
    const x=r.statistics.session.overall;lines.push(`| ${key} / 全体 | ${n(x.deltaPer100)} | ${ci(x.ci95)} |`);
    for(const [pair,x]of Object.entries(r.statistics.session.byOpponentPair))lines.push(`| ${key} / ${pair} | ${n(x.deltaPer100)} | ${ci(x.ci95)} |`);
  }
  lines.push('','## 实战行为（描述性）','','| 策略 | 净分/百手 | 胡牌比例 | 放炮比例 | 亮倒比例 | 胡分/百手 | 杠分/百手 | 查叫分/百手 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};for(const arm of ARMS){const x=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,groups.reduce((n,g)=>n+g.record.arms[arm][k],0)]));behavior[arm]=x;
    lines.push(`| ${arm} | ${n(100*x.score/x.hands)} | ${pct(x.wins,x.hands)} | ${pct(x.dealIns,x.hands)} | ${pct(x.revealHands,x.hands)} | ${n(100*x.huScore/x.hands)} | ${n(100*x.kongScore/x.hands)} | ${n(100*x.drawScore/x.hands)} |`);}
  lines.push('','| 混合策略 | 多合法动作选择 | 相对短版在该局面改变 | 改变比例 |','| --- | ---: | ---: | ---: |');
  for(const arm of COMPONENTS){const choices=groups.reduce((n,g)=>n+g.components[arm].choices,0),changed=groups.reduce((n,g)=>n+g.components[arm].changedFromShort,0);lines.push(`| ${arm} | ${choices} | ${changed} | ${pct(changed,choices)} |`);}
  lines.push('','改变比例是在各自真实轨迹上，将当前混合选择与同一公开局面的短版选择比较；不同策略到达的状态不同，这些比例不是配对局面上的错误率，也不能用来精确归因净分差。','',
    '## 动作控制器变化分类（事后描述）','',
    `主要结果出来后，另用冻结短版逐局检查 other 策略到达的相同公开局面。共 ${diagnostic.choices} 次多合法动作选择，实际不同 ${diagnostic.changes.length} 次；每组选择数、变化数和有胡未选胡计数均与原组记录匹配，初始状态和终局结算也一致。程序和结果另存来源哈希，不属于事前冻结的主要检验。`,'',
    '| 同一公开局面的短版选择 → 混合版实际选择 | 次数 |','| --- | ---: |');
  const transitionCounts={};for(const x of diagnostic.changes)transitionCounts[x.transition]=(transitionCounts[x.transition]||0)+1;assert.deepEqual(transitionCounts,diagnostic.transitions);
  for(const [transition,count]of Object.entries(diagnostic.transitions))lines.push(`| ${transition} | ${count} |`);
  lines.push('','hu=胡，peng=碰，ming=明杠，an=暗杠，bu=补杠，pass=过，discard=弃牌。上述比较只记录选择发生了什么变化，没有给替代动作逐次计算反事实终局收益。变化来自相关的整组轨迹，不当作独立统计样本；也不能据此判断每次未选胡都错误，或把组件净损失全部归因于某一种变化。后续如检验特定胡/碰杠取舍，须重新固定方案、使用新牌局；这些已公开考卷不拿来训练。','',
    '## 完整核验与后续','',
    `全部 ${s.games} 局已关闭公开输入缓存，从种子重发并重新计算网络选择，逐动作、连续轮庄、组件计数、结算与完整牌谱均匹配。冻结模型/PT、源码、组汇总和三个校正区间已核对。${passed[1]} 项回归通过，涵盖双亲精确重现、单组件合法语义、缓存隐私和开关一致、多重比较以及篡改拒绝。`,'',
    detected.length?'后续可围绕已检出的条件组件效应，预先固定候选并另做独立强度验收；不根据本批分数直接晋级，也不能推定同方向训练一定有效。':
      '本轮不依据点估计自动选出组件或修改网络。后续需结合区间宽度和真实干预覆盖率，预定更有针对性的组件/状态对照或独立复验；不能追加本批牌局争取显著性。','',
    `完整运行位于 \`${relative(projectRoot,out)}\`；全部牌谱索引见 [artifacts.json](artifacts.json)。审计重放和开发夹具不计实际评测，不新增训练手数。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));

