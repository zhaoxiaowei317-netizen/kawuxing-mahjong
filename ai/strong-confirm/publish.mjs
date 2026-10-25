import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {read,hash} from '../strong-pool/config.mjs';
import {check,jobsFor,aggregate,classify} from './study.mjs';

export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json'));check(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(s.games,v.games);
  assert.equal(v.checkpointSha256,p.model.sha256);assert.deepEqual(v.sources,p.sources);assert.equal(v.groups.length,jobsFor(p).length);
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,groups));
  assert.equal(s.outcome,classify(s.primary));
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndExactTracesMatched);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[],add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)});
  const copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  for(const name of ['plan.json','summary.json','verification.json','runtime.json','frozen-sources.tar.gz'])copy(resolve(out,name),name);
  for(const name of ['execution.log','audit.log'])if(existsSync(resolve(out,name)))copy(resolve(out,name),name);
  copy(tests,'tests-node.log');copy(p.model.path,'fixed-model.json');copy(p.model.state,'fixed-model.pt');
  copy(resolve(p.previous.path,'summary.json'),'previous-summary.json');
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  let diagnostic=null;
  if(existsSync(resolve(out,'action-diagnostics.json'))){
    diagnostic=read(resolve(out,'action-diagnostics.json'));assert.equal(diagnostic.postHoc,true);assert.equal(diagnostic.planSha256,s.planSha256);
    assert.equal(diagnostic.checkpointSha256,p.model.sha256);assert.equal(diagnostic.sourceSha256,hash(new URL('diagnose.mjs',import.meta.url)));
    assert.equal(diagnostic.groups.length,v.groups.length);for(const g of diagnostic.groups){const a=v.groups.find(x=>x.jobId===g.jobId);assert.ok(a);
      assert.equal(g.groupSha256,a.groupSha256);assert.equal(g.replaysSha256,a.replaysSha256);}
    copy(resolve(out,'action-diagnostics.json'),'action-diagnostics.json');copy(fileURLToPath(new URL('diagnose.mjs',import.meta.url)),'diagnose.mjs');
  }
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');
  const r=s.primary,old=p.previous.primary,n=x=>Number(x).toFixed(2),ci=r=>'['+r.ci95.map(n).join(', ')+']';
  const conclusion=s.outcome==='positive'?'固定收益模型在本批新开局中取得超过不亮倒 H0 的正净收益证据，仍需检验跨训练运行的可靠性。':
    s.outcome==='negative'?'固定收益模型在本批新开局中明确落后于不亮倒 H0；上一批正点估计未重现。':'固定收益模型在本批新开局中仍未确认超过不亮倒 H0，不能宣称优势稳定。';
  const lines=['# 收益模型对强参照的独立复验结果','',conclusion,'',
    `本轮仅复验上一轮选定的同一份收益模型，没有新增训练或验证。固定预算全部完成：${s.games} 局实际评测，${r.hands} 手候选轨迹，${r.groups} 个完整配对组。游戏默认继续为 H0。`,'',
    '## 固定对象与赛程','',
    `模型是上一轮 offline 第 ${p.model.epoch} 轮检查点，JSON SHA-256 为 \`${p.model.sha256}\`，原始 Adam 状态另保留。没有根据本轮得分更换检查点、改变亮倒阈值或更新权重。`,'',
    `比较对象为不亮倒 H0。三种对手组合固定等权：不亮倒/H0、不亮倒/不亮倒、不亮倒/速度贪心。每组合 ${p.budget.evaluationGroups} 个全新种子组，每组六种座位、双方轨迹和连续 ${p.budget.sessionHands} 手，真实轮庄与累计分保留。`,'',
    `bootstrap ${p.budget.bootstrapSamples} 次，按完整配对组在各对手组合内重采样，再对组合等权。组内座位和手数不视为独立样本。[实验方案](../../强参照收益模型独立复验.md)在第一手发牌前固定，原规则见[正式规则](../../孝感卡五星正式规则.md)。`,'',
    '## 唯一主要检验','',
    '| 批次 | 对不亮倒 H0 净底分差/百手 | 95% 配对组区间 | 配对组数 | 候选手数 |',
    '| --- | ---: | --- | ---: | ---: |',
    `| 上一轮（历史参考） | ${n(old.deltaPer100)} | ${ci(old)} | ${old.groups} | ${old.hands} |`,
    `| 本轮（独立复验） | ${n(r.deltaPer100)} | ${ci(r)} | ${r.groups} | ${r.hands} |`,'',
    conclusion,'',
    '两个批次分别报告，没有事后合并来争取显著性。分差是平均净底分，不是胜率百分点。区间跨零表示本批证据不足，不表示两种策略完全一样；单批正区间也不表示通用最优或训练方法已稳定复现。','',
    '## 对手组合（次要描述）','',
    '| 组合 | 模型净分/百手 | 参照净分/百手 | 分差/百手 | 95% 配对组区间 | 组数 |',
    '| --- | ---: | ---: | ---: | --- | ---: |'];
  for(const [pair,a]of Object.entries(s.evaluation.statistics.session.byOpponentPair))lines.push(`| ${pair} | ${n(a.candidatePer100)} | ${n(a.incumbentPer100)} | ${n(a.deltaPer100)} | ${ci(a)} | ${a.groups} |`);
  lines.push('','子组未经多重比较校正，只作描述，不能挑最好的组合替代主要检验。在不亮倒/不亮倒组合中，参照轨迹三家均为同一策略，轮换座位后的目标净分为零是零和对称性结果；判断模型强弱仍看相对分差。','',
    '## 行为和得分组成（次要描述）','',
    '| 组合 | 亮倒：模型 / 参照 | 胡牌：模型 / 参照 | 放炮：模型 / 参照 | 胡分差/百手 | 杠分差/百手 | 查叫分差/百手 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};
  for(const pair of p.pairs){
    const records=s.evaluation.records.filter(r=>r.opponentPair===pair.id),a={};
    for(const side of ['candidate','incumbent'])a[side]=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,records.reduce((n,r)=>n+r[side][k],0)]));
    behavior[pair.id]=a;const rate=k=>['candidate','incumbent'].map(side=>n(100*a[side][k]/a[side].hands)+'%').join(' / ');
    const delta=k=>n(100*(a.candidate[k]/a.candidate.hands-a.incumbent[k]/a.incumbent.hands));
    lines.push(`| ${pair.id} | ${rate('revealHands')} | ${rate('wins')} | ${rate('dealIns')} | ${delta('huScore')} | ${delta('kongScore')} | ${delta('drawScore')} |`);
  }
  lines.push('','这些比例不能分离某个机制的因果贡献，也不证明少亮倒或少放炮在所有局面都最优。');
  if(diagnostic){
    const a=diagnostic.total;
    lines.push('','## 抽样动作诊断（事后描述）','',
      `确定性抽样每组的全部六种候选座位，手号取“组号 mod 连续手数”，共复放 ${a.episodes} 局已完成比赛、${a.choices} 个可选择决策。在每个相同的公开局面询问不亮倒 H0，不重开假设世界、不新增比赛；选择规则没有使用得分。`,'',
      '| 两者都出牌的比较 | 次数 | 占两者都出牌的比例 |',
      '| --- | ---: | ---: |',
      `| 同一牌张 | ${a.sameTile} | ${n(a.sameTile/a.bothDiscard*100)}% |`,
      `| 模型弃牌后向听更高 | ${a.worseDistance} | ${n(a.worseDistance/a.bothDiscard*100)}% |`,
      `| 模型弃牌后向听更低 | ${a.betterDistance} | ${n(a.betterDistance/a.bothDiscard*100)}% |`,
      `| 向听相同、模型公开进张更少 | ${a.sameDistanceLowerOuts} | ${n(a.sameDistanceLowerOuts/a.bothDiscard*100)}% |`,
      `| 向听相同、模型公开进张更多 | ${a.sameDistanceHigherOuts} | ${n(a.sameDistanceHigherOuts/a.bothDiscard*100)}% |`,'',
      `两者都出牌共 ${a.bothDiscard} 次；模型有合法胡牌机会 ${a.huOffered} 次，其中选择其他动作 ${a.huDeclined} 次。各牌张差异类别并非相互独立，详情与前三个公开局面示例见 action-diagnostics.json。`,'',
      '公开进张按未公开张数计算，不读取真实牌墙。向听/进张是局部代理指标，不能把每次差异都认定为错误，更不能据此分配输分原因；本诊断只提供后续复盘和训练对照线索，不参与本轮模型选择。');
  }
  lines.push('',
    '## 完整审计','',
    `本轮沿用冻结的原对局/牌谱程序，外层复验驱动只增加固定模型绑定、新种子、调度、汇总与审计。全部 ${v.games} 局从种子重发，逐条匹配完整动作、策略种子、初始私有状态、连续轮庄、结算与结果；重算行为和完整配对组区间。${passed[1]} 项 JavaScript 回归通过。`,'',
    '小规模真实训练夹具验证旧计划精确适配、新种子、模型/来源绑定、完整分组和牌谱复现；来源、协议种子或组分数被篡改时拒绝通过。已有输出目录拒绝覆盖。全部正式评测、审计在本机 CPU 执行。测试夹具与审计重放不计为本轮新增正式训练或比赛样本。','',
    '## 解释范围与下一步','',
    '本轮没有新的训练数据、验证数据、训练初始化或优化步骤，只检验同一固定模型在新开局中的泛化。没有与旧 H0、旧网络或同轮模仿模型重新对战，也未建立对真人水平的结论。旧训练数据的审计沿用已归档证据，本轮完整复核新增的评测牌谱。','',
    s.outcome==='positive'?'下一步应把该模型保留为固定研究候选，并用预先固定配方的新训练初始化和新数据检验训练可重复性，再考虑更广对手或晋级。':
      s.outcome==='negative'?'下一步优先用预先固定的组件对照检验公开进张取舍，再决定如何改变训练目标或数据分布。保留强参照，不继续通过补考相同模型争取正区间。若规则筛选改善得分，应作为策略组件收益记录，另测网络能否自主学会，不能直接宣布网络训练成功。':'两批都未确认超过强参照，下一步应优先设计训练目标或数据分布的可控对照，保留当前模型作为研究起点，不继续补考争取显著性。','',
    `完整本地目录：\`${relative(projectRoot,out)}\`。报告保留两批分数、计划、全部分组汇总、审计、固定模型与优化器、日志、源码归档和校验值；本机完整牌谱索引见 [artifacts.json](artifacts.json)。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(name=>({path:name,sha256:hash(resolve(destination,name))})),null,2)+'\n');
  return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
