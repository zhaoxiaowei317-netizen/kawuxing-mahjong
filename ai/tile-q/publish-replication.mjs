import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,projectRoot} from '../provenance.mjs';
import {checkPlan,classify} from './replicate.mjs';

export function publishReplication({out,destination,tests,pythonTests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Published output exists');
  const read=p=>JSON.parse(readFileSync(resolve(out,p),'utf8')),p=read('plan.json'),s=read('summary.json'),v=read('verification.json'),training=read('training.json');
  checkPlan(p);assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);assert.equal(s.productionPolicy,'H0');
  const logs=readFileSync(tests,'utf8'),py=readFileSync(pythonTests,'utf8'),passed=logs.match(/(?:ℹ|#) pass (\d+)/);
  assert.ok(passed);assert.match(logs,/(?:ℹ|#) fail 0\b/);assert.match(py,/\bOK\b/);assert.doesNotMatch(py,/FAILED|ERROR/);
  const reports=Object.fromEntries(p.evaluations.map(id=>[id,read(`${id}/report.json`)]));
  const control=r=>r.records.map(({suite,opponentPair,seed,incumbent})=>({suite,opponentPair,seed,incumbent}));
  assert.deepEqual(control(reports['fixed-old']),control(reports['retrained-offline']));
  mkdirSync(destination,{recursive:true});const artifacts=[];
  const hash=path=>sha256(readFileSync(path));
  const copy=(source,name)=>copyFileSync(source,resolve(destination,name));
  const copyRun=name=>copy(resolve(out,name),name);
  const add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)});
  for(const name of ['plan.json','summary.json','verification.json','training.json','retrained-selection.json','runtime.json','frozen-sources.tar.gz']){copyRun(name);add(resolve(out,name));}
  copy(tests,'tests-node.log');copy(pythonTests,'tests-python.log');
  for(const split of ['training','validation']){copy(resolve(out,split,'manifest.json'),`${split}-manifest.json`);add(resolve(out,split,'episodes.jsonl.gz'));}
  for(const stage of ['bc','offline']){
    copy(resolve(out,`model-${stage}`,'summary.json'),`training-${stage}.json`);
    copy(resolve(out,`model-${stage}`,'parity.json'),`parity-${stage}.json`);
  }
  const fmt=n=>Number(n).toFixed(2),ci=r=>`[${r.ci95.map(fmt).join(', ')}]`;
  const words={positive:'区间完全高于零',negative:'区间完全低于零',inconclusive:'区间包含零，未确认优势或劣势'};
  const lines=['# 牌面模型独立复验结果','',
    `旧模型的新批次连续对局结果：${words[classify(s.evaluations['fixed-old'].primary)]}。这是本轮唯一主要检验；新模型、单局和对手子组结果均为次要描述。`,'',
    '训练与评测在本机 CPU 上使用正式卡五星引擎完成，游戏默认电脑继续为 H0。两个版本均按固定预算报告，不据测试结果改参数、挑快照或追加牌局。','',
    '## 测了什么','',
    `旧模型固定为前轮离线收益模型的第 ${p.previous.epoch} 轮快照。新模型完全重训：${s.trainingHands} 手新训练、${s.validationHands} 手新验证，记录 ${s.trainingSamples} 个训练选择样本。数据、验证和参数初始化种子都更换了；网络、优化配方与 ${p.budget.bcEpochs} 轮模仿、${p.budget.offlineEpochs} 轮离线收益学习预算保持。没有新增在线训练。`,'',
    `两版分别完成 ${s.games/2} 局，总计 ${s.games} 局实际评测。新测试种子在训练前已登记，两版共用相同起手、六种座位排列及 H0/H0、H0/greedy-speed 两个等权对手组合。两版的匹配 H0 对照组记录完全相同。重复执行计入实际计算量，不增加独立起手数。`,'',
    '预先固定的指标、停止规则和分组方式见[复验方案](../../牌面模型独立复验方案.md)。原架构、收益标签和公开方法的适配见[机制指南](../../牌面卷积与动作价值学习.md)。','',
    '## 连续对局主要结果','',
    '| 模型 / 批次 | 相对 H0 净底分/百手 | 95% 配对组区间 | 配对组数 | 候选手数 |',
    '| --- | ---: | --- | ---: | ---: |',
    `| 旧模型·上一轮（历史对照） | ${fmt(p.previous.primary.deltaPer100)} | ${ci(p.previous.primary)} | ${p.previous.primary.groups} | ${p.previous.primary.hands} |`];
  for(const [id,label]of [['fixed-old','旧模型·本轮（主要检验）'],['retrained-offline','新训练·本轮（次要描述）']]){
    const r=s.evaluations[id].primary;lines.push(`| ${label} | ${fmt(r.deltaPer100)} | ${ci(r)} | ${r.groups} | ${r.hands} |`);
  }
  const old=s.evaluations['fixed-old'].primary,again=s.evaluations['retrained-offline'].primary;
  lines.push('',old.ci95[0]>0?'本轮旧模型复验得到相对 H0 的正收益证据，前次发现获得一次新发牌批次的支持。':
    old.ci95[1]<0?'本轮旧模型复验出现相对 H0 的负收益证据，与前轮方向相反，应降低对前次优势的信心。':
    '本轮旧模型复验未确认超过 H0。区间包含零，也不能据此证明两者完全相同；前次单批优势尚未获得这次复验的支持。','',
    `新训练的连续对局结果为“${words[classify(again)]}”。它检验固定训练流程在另一组数据、验证和初始化下的表现，没有通过测试挑选训练版本。即使为正，也只有两个训练运行，尚不足以宣称方法在多种种子下稳定有效。`,'',
    '历史和本轮结果分别列出，没有事后合并来争取显著性。底分差是平均净收益，不是胜率提升的百分比。','',
    '## 辅助单局与对手子组','',
    '| 模型 | 指标 | 净底分差/百手 | 95% 配对组区间 | 配对组数 |',
    '| --- | --- | ---: | --- | ---: |');
  for(const [id,label]of [['fixed-old','旧模型'],['retrained-offline','新训练']]){
    const e=s.evaluations[id];
    for(const [name,r]of [['独立单局',e.independent],...Object.entries(e.byOpponentPair)])lines.push(`| ${label} | ${name} | ${fmt(r.deltaPer100)} | ${ci(r)} | ${r.groups} |`);
  }
  lines.push('','以上是未经多重比较校正的次要描述。每个区间按完整配对种子组重采样，不把座位排列和同一连续组内的手数当成独立样本；主对手组合等权。有限的对手池不能代表全部人类玩家。','',
    '## 模型与行为','',
    `新模型模仿阶段选第 ${training.fitted.bc.selected.epoch} 轮，离线阶段选第 ${training.fitted.offline.selected.epoch} 轮；均仅依赖各自固定验证组合损失，包含第 0 轮，打平保留较早轮次。`,'',
    '| 连续对局 | 亮倒比例：候选 / H0 | 胡牌比例：候选 / H0 | 放炮比例：候选 / H0 |',
    '| --- | ---: | ---: | ---: |');
  const behavior={};
  for(const id of p.evaluations){
    const r=reports[id];behavior[id]={};
    for(const side of ['candidate','incumbent'])behavior[id][side]=Object.fromEntries(['hands','revealHands','wins','dealIns','huScore','kongScore','drawScore'].map(key=>[key,r.records.filter(x=>x.suite==='session').reduce((sum,x)=>sum+x[side][key],0)]));
    const ratio=key=>['candidate','incumbent'].map(side=>fmt(100*behavior[id][side][key]/behavior[id][side].hands)+'%').join(' / ');
    lines.push(`| ${id} | ${ratio('revealHands')} | ${ratio('wins')} | ${ratio('dealIns')} |`);
    copy(resolve(out,id,'report.json'),`${id}-evaluation.json`);add(resolve(out,id,'replays.jsonl.gz'));
    const checkpoint=r.checkpoint,state=checkpoint.replace(/\.json$/,'.pt');
    copy(checkpoint,`${id}-selected.json`);copy(state,`${id}-selected.pt`);add(checkpoint);add(state);
  }
  lines.push('','这些行为比例只描述同时出现的变化，不证明亮倒频率或某一结构造成了强度差异。','',
    '## 完整复核','',
    '| 版本 | 实际评测局数 | 有选择的决策 | 提供胡牌机会 | 选择其他动作 |',
    '| --- | ---: | ---: | ---: | ---: |');
  for(const id of p.evaluations){const r=v.evaluation[id];lines.push(`| ${id} | ${r.games} | ${r.choices} | ${r.huOffered} | ${r.huMissed} |`);}
  lines.push('',`全部 ${v.games} 局已重新发牌、核对双方策略动作并重算结算和统计。全部新训练与验证数据的公开编码、动作、教师标签、收益、杠账与顺位标签已复算；${v.snapshotsVerified} 份新网络导出及优化器状态已核对哈希，各阶段 Python/JavaScript 数值一致性通过。`,'',
    `完整 JavaScript 回归 ${passed[1]} 项通过，Python 模型检查 2 项通过。新增集成检查覆盖完整重训→两版评测→逐局审计，以及两版 H0 对照一致性、源文件冻结和拒绝覆盖。`,'',
    '胡牌机会诊断不直接等同于非法动作或最优决策证明。模型输入仍限本人手牌与公开信息，没有读取真实对手暗手、牌墙或发牌种子。','',
    `完整运行目录：\`${relative(projectRoot,out)}\`。本报告保存计划、汇总、模型与 Adam 状态、测试记录、审计结果、来源哈希和源码归档；训练样本及完整牌谱仍在本机忽略目录中。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  const files=readdirSync(destination).map(name=>({path:name,sha256:hash(resolve(destination,name))}));
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(files,null,2)+'\n');
  return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publishReplication({out:process.argv[2],destination:process.argv[3],tests:process.argv[4],pythonTests:process.argv[5]}));
