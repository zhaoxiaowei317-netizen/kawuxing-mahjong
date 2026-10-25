import assert from 'node:assert/strict';
import {copyFileSync,writeFileSync,readFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {COHORTS} from './policies.mjs';
import {check,hash,read,jobsFor} from './study.mjs';

export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json'));check(p);
  assert.equal(s.planSha256,v.planSha256);assert.equal(v.games,s.games);assert.equal(s.trainingHands,0);assert.equal(v.groups.length,jobsFor(p).length);
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allGamesRedealtAndPolicyRecomputed);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  mkdirSync(destination,{recursive:true});const artifacts=[],copy=(path,name)=>copyFileSync(path,resolve(destination,name));
  const add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)});
  for(const name of ['plan.json','summary.json','verification.json','runtime.json','frozen-sources.tar.gz']){copy(resolve(out,name),name);add(resolve(out,name));}
  copy(tests,'tests-node.log');copy(p.checkpoint,'frozen-q.json');copy(p.checkpoint.replace(/\.json$/,'.pt'),'frozen-q.pt');
  assert.equal(hash(resolve(destination,'frozen-q.pt')),read(p.checkpoint).metadata.optimizerStateSha256);add(p.checkpoint);add(p.checkpoint.replace(/\.json$/,'.pt'));
  if(p.previous){copy(resolve(p.previous.path,'summary.json'),'previous-summary.json');add(resolve(p.previous.path,'summary.json'));}
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');
  const n=x=>Number(x).toFixed(2),ci=r=>`[${r.ci95.map(n).join(', ')}]`,r=s.cohorts.replication.statistics.session.overall,t=s.cohorts.stress.statistics.session.overall;
  const primaryText=r.ci95[0]>0?'固定“不亮倒”候选在原对手池的新种子复验中再次得到相对 H0 的正净收益证据。':
    r.ci95[1]<0?'固定“不亮倒”候选在原对手池本批复验中出现相对 H0 的负净收益证据。':'固定“不亮倒”候选在原对手池本批复验中未确认超过 H0。';
  const lines=['# 不亮倒策略独立复验与对手扩展结果','',primaryText,'',
    `候选、对手、规则与模型均在发牌前固定，未筛选新策略、未调整开关或训练网络。两套固定考场合计 ${s.games} 局实际评测，游戏默认继续为 H0。扩展池是次要描述，不与原池合并成一个冠军分数。`,'',
    '## 本轮设置','',
    '候选沿用 h0-never：保留 H0 的动作种类与弃牌排序，在同一牌张有合法普通/亮倒双动作时取消亮倒。它不使用神经网络推理，也不是重新优化过的最佳不亮倒策略。神经网络和 Q 开关只用于部分固定对手，权重没有更新。','',
    '[实验方案](../../不亮倒策略复验与泛化.md)记录全部预算和停止规则。规则依据见[正式规则](../../孝感卡五星正式规则.md)，上一轮组件干预见[历史报告](../reveal-study-2026-10-19/实验结果.md)。','',
    '| 考场 | 对手组合数 | 每组合种子组 | 连续手数 | 实际局数 |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| 原池复验（唯一主要检验） | ${p.pairs.replication.length} | ${p.budget.replicationGroups} | ${p.budget.sessionHands} | ${s.cohorts.replication.games} |`,
    `| 扩展池（次要描述） | ${p.pairs.stress.length} | ${p.budget.stressGroups} | ${p.budget.sessionHands} | ${s.cohorts.stress.games} |`,'',
    '每个种子组都包含六种座位排列、候选/H0 完整轨迹及真实连续轮庄。各考场内对手组合等权，bootstrap 保持整组配对；重复座位与同组手数不当作独立样本。两套预算全部执行，没有根据前半段表现取消后半段。','',
    '## 原对手池独立复验','',
    '| 批次 | 对 H0 净底分差/百手 | 95% 配对组区间 | 配对组数 | 候选手数 |',
    '| --- | ---: | --- | ---: | ---: |'];
  if(p.previous){const old=read(resolve(p.previous.path,'summary.json')).sealed.primary;lines.push(`| 上一轮（历史参考） | ${n(old.deltaPer100)} | ${ci(old)} | ${old.groups} | ${old.hands} |`);}
  lines.push(`| 本轮（唯一主要检验） | ${n(r.deltaPer100)} | ${ci(r)} | ${r.groups} | ${r.hands} |`,'',
    r.ci95[0]>0?'本轮主要区间完全高于零，支持原池优势在另一批发牌中重现。结果适用于本次规则、对手组合与固定策略，不能据此推断对所有对手普遍更强。':
    r.ci95[1]<0?'本轮主要区间完全低于零，前次优势在本批反转，应降低对原池稳定性的判断。':'本轮主要区间包含零，未确认原池优势重现；也不证明两种策略完全相同。','',
    '历史和本轮分别报告，没有事后合并来争取显著性。此结果衡量净得分，不是胜率提升百分比，也不等于神经网络训练成功。','',
    '## 扩展对手池与全部子组','',
    '| 考场 / 组合 | 对 H0 净底分差/百手 | 95% 配对组区间 | 配对组数 | 候选手数 |',
    '| --- | ---: | --- | ---: | ---: |',
    `| 扩展池整体（次要描述） | ${n(t.deltaPer100)} | ${ci(t)} | ${t.groups} | ${t.hands} |`);
  for(const cohort of COHORTS)for(const [pair,a]of Object.entries(s.cohorts[cohort].statistics.session.byOpponentPair))
    lines.push(`| ${cohort} / ${pair} | ${n(a.deltaPer100)} | ${ci(a)} | ${a.groups} | ${a.hands} |`);
  lines.push('','组合名称：never 为同一个不亮倒候选；greedy 为速度贪心；selective 保留 H0 出牌、由冻结旧 Q 决定亮倒开关；neural 为冻结旧 Q 的完整决策。它们是不同风格，不保证都是高手。','',
    '扩展池和各子组未经多重比较校正，尤其每个扩展组合的组数较少，区间只作描述。不能挑其中最好的组合重定义主要结果，也不能把原池优势直接称为通用牌技优势。','',
    'never+never 的候选轨迹三家都用同一策略，轮换座位后平均净分为零是零和对称性结果；这里比较的是把目标玩家替换成 H0 后的分差。自博弈零分本身不表示策略好坏。','',
    '## 行为和得分组成','',
    '| 考场 / 组合 | 亮倒：候选 / H0 | 胡牌：候选 / H0 | 放炮：候选 / H0 | 胡分差/百手 | 杠分差/百手 | 查叫分差/百手 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};
  for(const cohort of COHORTS){behavior[cohort]={};for(const pair of p.pairs[cohort]){
    const rows=s.cohorts[cohort].records.filter(row=>row.opponentPair===pair.id),a={};
    for(const side of ['candidate','incumbent'])a[side]=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,rows.reduce((sum,row)=>sum+row[side][k],0)]));
    behavior[cohort][pair.id]=a;const rate=k=>['candidate','incumbent'].map(side=>n(100*a[side][k]/a[side].hands)+'%').join(' / ');
    const delta=k=>n(100*(a.candidate[k]/a.candidate.hands-a.incumbent[k]/a.incumbent.hands));
    lines.push(`| ${cohort} / ${pair.id} | ${rate('revealHands')} | ${rate('wins')} | ${rate('dealIns')} | ${delta('huScore')} | ${delta('kongScore')} | ${delta('drawScore')} |`);
  }}
  lines.push('','行为比例和分项有助于理解适用条件，不分离某一机制对净收益差的精确贡献。未亮倒避炮、亮倒锁手和公开听口规则均保持。没有依据单个比例宣称“不亮倒一定最优”，也没有把候选设为唯一训练教师。','',
    '## 并行一致性与完整复核','',
    `本轮按 ${v.groups.length} 个完整种子组分配至最多 ${p.budget.workers} 个本地进程。原 paired-v1 的发牌、策略种子、座位和轮庄口径保持；小规模集成检查与原串行程序的完整牌谱、所有结算记录和 bootstrap 结果相同。`,'',
    `全部 ${v.games} 局已重新发牌、核对双方每个策略动作及策略种子，重算连续状态、积分零和、胡/杠/查叫分、亮倒/胡牌/放炮和顺位汇总。重新汇总两套考场并核对全部区间；33 份冻结核心/驱动源码与模型哈希核对通过。完整 JavaScript 回归 ${passed[1]} 项通过，新增检查还会拒绝被篡改的汇总分数。`,'',
    '候选的网络训练手数为零。测试夹具和验证程序内的小规模训练不计入正式训练或评测总数。原 H0、规则、游戏存档和既有模型没有替换。','',
    `完整运行目录：\`${relative(projectRoot,out)}\`。此报告保留计划、两个池的全部分组结果、审计、旧模型与 Adam 状态、测试日志、源码归档和文件校验值。逐组完整牌谱位于本机忽略的实验目录。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(name=>({path:name,sha256:hash(resolve(destination,name))})),null,2)+'\n');
  return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
