import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,projectRoot} from '../provenance.mjs';
import {ARMS} from './study.mjs';
import {assertSources} from './sources.mjs';

export function publish({out,destination,nodeTests,pythonTests,parallelTest}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Published output exists');
  const read=p=>JSON.parse(readFileSync(resolve(out,p),'utf8')),plan=read('plan.json'),s=read('summary.json'),v=read('verification.json');
  assertSources(plan.sources);assert.equal(s.planSha256,sha256(readFileSync(resolve(out,'plan.json'))));assert.equal(v.games,s.games);
  const jsLog=readFileSync(nodeTests,'utf8'),pyLog=readFileSync(pythonTests,'utf8');
  const count=jsLog.match(/(?:ℹ|#) pass (\d+)/);assert.ok(count);assert.match(jsLog,/(?:ℹ|#) fail 0\b/);assert.match(pyLog,/\bOK\b/);assert.doesNotMatch(pyLog,/FAILED|ERROR/);
  mkdirSync(destination,{recursive:true});const artifacts=[];
  const add=p=>artifacts.push({path:relative(projectRoot,p),sha256:sha256(readFileSync(p))});
  for(const p of ['plan.json','summary.json','models.json','selection.json','verification.json'])copyFileSync(resolve(out,p),resolve(destination,p));
  if(existsSync(resolve(out,'runtime.json'))){copyFileSync(resolve(out,'runtime.json'),resolve(destination,'runtime.json'));add(resolve(out,'runtime.json'));}
  copyFileSync(nodeTests,resolve(destination,'tests-node.log'));copyFileSync(pythonTests,resolve(destination,'tests-python.log'));
  if(parallelTest){const log=readFileSync(parallelTest,'utf8');assert.match(log,/(?:ℹ|#) pass 1\b/);assert.match(log,/(?:ℹ|#) fail 0\b/);
    copyFileSync(parallelTest,resolve(destination,'tests-parallel-audit.log'));}
  const n=x=>Number(x).toFixed(2),ci=r=>`[${r.ci95.map(n).join(', ')}]`;
  const trainingSamples=s.datasets.training.samples+s.online.reduce((sum,r)=>sum+r.dataset.samples,0);
  const lines=['# 牌面卷积与动作价值学习实训结果','',
    s.positiveSealedEvidence?'固定候选在本批独立封闭评测中相对 H0 存在正净收益证据；适用范围限于本次规则、对手组合和预算。':'本轮没有确认超过 H0，游戏默认电脑继续保留 H0。','',
    `新增 ${s.trainingHands} 手训练牌局、${s.validationHands} 手固定验证牌局，完成 ${s.games} 局完整对照评测。训练中共记录 ${trainingSamples} 个需要选择的局面；同一手内多个决策及不同座位的样本相关，不能视为同等数量的独立牌局。`,'',
    '训练使用本机 CPU 和已有 PyTorch，推理在项目 Node.js 引擎中运行。原规则、H0、旧实验模型以及游戏存档未由本轮替换。','',
    '## 实际采用的公开方法','',
    '本轮独立实现了 Mortal 风格的残差牌面编码、合法动作遮罩下的 dueling Q、蒙特卡洛动作收益回归、离线 CQL、辅助顺位预测以及继续对战采样。未复制外部源码或使用日麻权重，不声称复现 Mortal 的原架构、训练规模或成绩。',
    '原始方法参考：[Mortal 模型](https://github.com/Equim-chan/Mortal/blob/main/mortal/model.py)、[训练实现](https://github.com/Equim-chan/Mortal/blob/main/mortal/train.py)。卡五星适配与省略项详见 [机制指南](../../牌面卷积与动作价值学习.md)。','',
    `网络使用 ${plan.network.channels} 个卷积通道、${plan.network.blocks} 个残差块，${plan.schema.channels} 个逐牌通道、${plan.schema.contextSize} 个全局字段和每个合法动作的 ${plan.schema.candidateSize} 个公开牌效特征。它在每个有选择的决策点比较全部合法动作，没有每手一次的提案限额。`,'',
    '两种数牌分开卷积，三种字牌分别隔离。模型读取本人手牌、公开副露、可见牌和整条牌河及顺序；没有输入真实对手暗手、真实牌墙或发牌种子。现有牌效计算仍是模型输入的一部分。','',
    '## 训练数据与阶段','',
    '| 阶段 | 新牌局 | 选择样本 | 行为来源 |', '| --- | ---: | ---: | --- |',
    `| 初始训练 | ${s.datasets.training.hands} | ${s.datasets.training.samples} | 85% H0 / 10% greedy-speed / 5% 随机合法动作 |`,
    `| 固定验证 | ${s.datasets.validation.hands} | ${s.datasets.validation.samples} | 独立种子的相同固定行为；不参与参数更新 |`];
  for(let i=0;i<s.online.length;i++)lines.push(`| 对战采样 ${i+1} | ${s.online[i].dataset.hands} | ${s.online[i].dataset.samples} | 当前模型、H0、greedy-speed、冻结历史模型与自博弈 |`);
  lines.push('',`训练采集使用 ${plan.budget.trainingSessionHands} 手连续环境，真实轮庄及累计分进入观测。主回报仍是当前这一手的未来净分，减去决策之前已记入杠账的净分并除以 16；没有估计全部后续手的轮庄收益。辅助标签是当手结算后的累计顺位。`,'',
    `features-bc 和 tiles-bc 共用同一批数据、随机种子、配方与 ${plan.budget.bcEpochs} 轮预算，只改变原始牌面卷积分支是否启用。tiles-offline 从固定 tiles-bc 出发，再做 ${plan.budget.offlineEpochs} 轮收益训练。tiles-online 额外生成 ${plan.budget.onlineRounds} 批新对局，每批训练 ${plan.budget.onlineEpochs} 轮。因此阶段差异不能全部归因于网络结构。`,'',
    '模仿与离线阶段包含第 0 轮，以固定验证组合损失选轮次，打平保留较早轮次；在线每批使用固定末轮。不同目标下的损失值不直接相互比较，也不能替代实际牌技评测。','',
    '## 固定开发评测','',
    '| 候选 | 所选轮次 | 固定验证上 H0 动作一致率 | 开发 Δ 底分/百手 | 95% 组区间（开发描述） |',
    '| --- | ---: | ---: | ---: | --- |');
  for(const row of s.development){const model=s.fitted[row.arm],selected=model.selected;
    const metric=model.history.find(r=>r.epoch===selected.epoch).validation;
    lines.push(`| ${row.arm} | ${selected.epoch} | ${n(100*metric.teacherAgreement)}% | ${n(row.delta)} | ${ci(row)} |`);
    const base=resolve(destination,`${row.arm}-selected`);copyFileSync(selected.path,base+'.json');copyFileSync(selected.state,base+'.pt');add(selected.path);add(selected.state);
    copyFileSync(resolve(out,`development-${row.arm}`,'report.json'),resolve(destination,`development-${row.arm}.json`));
    add(resolve(out,`development-${row.arm}`,'replays.jsonl.gz'));
  }
  lines.push('',`开发选择：${s.selected||'H0（没有候选通过预定的正收益门槛）'}。开发使用相同起手、六种座位排列、H0/H0 与 H0/greedy-speed 两种对手组合，组合等权，以整组重采样。动作一致率衡量模仿程度，不代表高手水平。`,'');
  if(s.sealed){lines.push('## 固定候选的新种子封闭验收','',
    '| 指标 | Δ 底分/百手 | 95% 配对组区间 | 配对组数 | 每版本手数 |','| --- | ---: | --- | ---: | ---: |');
    for(const [label,r]of [[`${plan.budget.sessionHands} 手连续对局（主指标）`,s.sealed.primary],['独立单局（辅助）',s.sealed.independent],...Object.entries(s.sealed.byOpponentPair)])if(r)lines.push(`| ${label} | ${n(r.deltaPer100)} | ${ci(r)} | ${r.groups} | ${r.hands} |`);
    copyFileSync(resolve(out,'sealed-vs-H0/report.json'),resolve(destination,'sealed-vs-H0.json'));add(resolve(out,'sealed-vs-H0/replays.jsonl.gz'));lines.push('');
  }else lines.push('没有候选通过开发门槛，按预先固定的规则未启动封闭验收，未使用封闭种子生成验收牌局。本批开发结果不构成独立牌技提升证据。','');
  lines.push('## 决策与复核','',
    '| 实际候选轨迹 | 有选择的决策 | 与 H0 相同的动作 | 提供胡牌机会 | 选择其他动作 |',
    '| --- | ---: | ---: | ---: | ---: |');
  for(const [stage,r]of Object.entries(v.evaluation))lines.push(`| ${stage} | ${r.choices} | ${r.teacherAgreement} | ${r.huOffered} | ${r.huMissed} |`);
  lines.push('','| 连续对局阶段 | 亮倒比例：候选 / H0 | 胡牌比例：候选 / H0 | 放炮比例：候选 / H0 |',
    '| --- | ---: | ---: | ---: |');
  const behavior={};
  for(const stage of [...ARMS.map(a=>`development-${a}`),...(s.sealed?['sealed-vs-H0']:[])]){
    const r=read(`${stage}/report.json`),aggregate={};
    for(const side of ['candidate','incumbent']){
      aggregate[side]={};for(const key of ['hands','revealHands','wins','dealIns','huScore','kongScore','drawScore'])
        aggregate[side][key]=r.records.filter(x=>x.suite==='session').reduce((sum,x)=>sum+x[side][key],0);
    }
    behavior[stage]=aggregate;
    const percentages=key=>['candidate','incumbent'].map(side=>n(100*aggregate[side][key]/aggregate[side].hands)+'%').join(' / ');
    lines.push(`| ${stage} | ${percentages('revealHands')} | ${percentages('wins')} | ${percentages('dealIns')} |`);
  }
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');
  lines.push('',`全部 ${s.games} 局实际评测已重新发牌、核对双方每次策略动作并重算结算与统计；训练、验证和在线数据的全部公开编码、行为动作、教师标签、杠账与回报也已重新计算。${v.snapshotsVerified} 份网络导出和优化器存档的哈希已核对，各阶段 Python/JavaScript 数值一致性检查通过。`,'',
    `完整 JavaScript 回归 ${count[1]} 项通过，Python 模型检查 2 项通过。检查覆盖已知动作优劣学习、筒条交换一致性、字牌隔离、暗牌不可见、合法掩码、续训恢复及小规模完整流程。`,'',
    ...(parallelTest?['另有 1 项完整流程复测验证并行与串行审计的全部数据、评测和数值一致性结果相同。','']:[]),
    '“有胡牌机会但选择其他动作”是行为诊断：不直接等同于非法行为，也不单独证明该选择正确。训练教师是 H0，初始动作覆盖有限，在线阶段规模较小；模型可能仍未学会可靠的攻守与亮倒取舍。仅有训练损失下降或模仿一致率提高，都不能证明超过 H0。','',
    '本版本没有完整跨玩家事件时序、Suphx 的全局奖励预测与 oracle guiding，也没有日麻高手数据。本轮只有一个配对训练随机种子，不能据此认定训练方法在重复运行中稳定有效。同数据表示对照和各训练阶段对照分别提供方向证据；结论仍受有限样本和预定对手池限制。','',
    `完整运行目录：\`${relative(projectRoot,out)}\`。训练样本和全部牌谱保存在忽略的实验目录；此报告目录保留计划、各阶段指标、模型、Adam 存档和复核结果。四个候选不是四份独立训练数据，重复对局和训练轮次不增加独立牌局数。`,'');
  for(const split of ['training','validation',...s.online.map((_,i)=>`online-${i}`)]){
    copyFileSync(resolve(out,split,'manifest.json'),resolve(destination,`${split}-manifest.json`));add(resolve(out,split,'episodes.jsonl.gz'));
  }
  const archive=resolve(out,'frozen-sources.tar.gz');if(existsSync(archive)){copyFileSync(archive,resolve(destination,'frozen-sources.tar.gz'));add(archive);}
  for(const stage of ['features-bc','tiles-bc','tiles-offline',...s.online.map((_,i)=>`online-${i}`)])copyFileSync(resolve(out,`model-${stage}`,'summary.json'),resolve(destination,`training-${stage}.json`));
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],nodeTests:process.argv[4],pythonTests:process.argv[5],parallelTest:process.argv[6]}));
