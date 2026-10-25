import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,projectRoot} from '../provenance.mjs';
import {loadGain} from './io.mjs';
import {loadData} from './data.mjs';
import {diagnostics,predictModel} from './model.mjs';

export function publish({out,destination,testLog,extraTestLog}) {
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Published report exists');
  const read=p=>JSON.parse(readFileSync(resolve(out,p),'utf8'));
  const plan=read('plan.json'),s=read('summary.json'),v=read('verification.json');
  if(s.planSha256!==sha256(readFileSync(resolve(out,'plan.json')))||v.games!==s.games)throw Error('Unverified study');
  mkdirSync(destination,{recursive:true});
  for(const p of ['plan.json','summary.json','selection.json','models.json','verification.json'])copyFileSync(resolve(out,p),resolve(destination,p));
  if(existsSync(resolve(out,'recovery.json')))copyFileSync(resolve(out,'recovery.json'),resolve(destination,'recovery.json'));
  const artifacts=[];
  const artifact=p=>artifacts.push({path:relative(projectRoot,p),sha256:sha256(readFileSync(p))});
  const archive=resolve(out,existsSync(resolve(out,'frozen-sources-final.tar.gz'))?'frozen-sources-final.tar.gz':'frozen-sources.tar.gz');
  if(existsSync(archive)){copyFileSync(archive,resolve(destination,'frozen-sources.tar.gz'));artifact(archive);}
  for(const split of ['training','validation']){
    copyFileSync(resolve(out,split,'manifest.json'),resolve(destination,`${split}-manifest.json`));
    artifact(resolve(out,split,'rows.jsonl.gz'));
  }
  const val=loadData(resolve(out,'validation'),'validation'),training=loadData(resolve(out,'training'),'training'),n=x=>Number(x).toFixed(2);
  const trainingMean=training.manifest.gainSum/training.rows.length;
  const diagnostic={trainingMeanGain:trainingMean,validationZeroMse:val.rows.reduce((sum,r)=>sum+r.gain*r.gain,0)/val.rows.length,
    validationTrainingMeanMse:val.rows.reduce((sum,r)=>sum+(r.gain-trainingMean)**2,0)/val.rows.length,models:{}};
  const interval=x=>`[${x.map(n).join(', ')}]`;
  const lines=['# 成对终局收益监督训练实训结果','',
    s.positiveSealedEvidence?'本次独立封闭评测对 H0 存在正收益证据，结论仅适用于预设规则、对手和预算。':'本轮尚未证明超过 H0，游戏默认电脑继续使用 H0。','',
    `新增 ${s.trainingDeals.toLocaleString('en-US')} 手训练牌局、${s.validationDeals.toLocaleString('en-US')} 手独立验证牌局，完成 ${s.games.toLocaleString('en-US')} 局实际评测。训练数据与旧评测数据分离；同一批数据供三个小网络与一个线性模型共用。`,'',
    '实验在本机 CPU 上运行，所有牌局均由项目正式规则引擎生成。评测局数包含新旧版本及不同模型的配对重复，不等于相同数量的独立发牌样本。','',
    '## 这一轮在学什么','',
    '遇到 H0 和两次摸牌前瞻给出不同出牌时，在同一个实际训练局面上把两个选择分别打到正式结算，学习“换一种出牌最终多赢或少赢多少”。暗牌和牌墙只用于离线生成奖励；模型实际选牌只输入自己的牌与公开信息。模型没有得到真实暗手、牌墙或发牌种子。','',
    `每手最多改变一次出牌，后续继续使用 H0。线性模型使用 64 个公开特征；三个网络各有 ${plan.models.mlp.hiddenSize} 个隐单元，初始预测严格为零。每个网络训练 ${plan.budget.epochs} 轮，按独立验证误差选择轮次，包含第 0 轮。不同初始值和重复训练轮次不增加独立牌局数量。`,'',
    '| 数据 | 原始牌局 | 有争议的决策点 | 两种出牌的终局分支 | 非零收益差标签 |',
    '| --- | ---: | ---: | ---: | ---: |'];
  for(const split of ['training','validation']){const d=s.datasets[split];lines.push(`| ${split} | ${d.hands} | ${d.roots} | ${d.counterfactualBranches} | ${d.nonzeroLabels} |`);}
  lines.push('',`共 ${s.branches} 个离线终局分支单列，不计为新增实际评测或独立牌局。`,'',
    '## 验证与开发筛选','',
    '| 模型 | 验证所选轮次 | 验证均方误差 | 验证选择收益/百原始牌局（诊断） | 开发净分差/百手 | 开发 95% 区间 |',
    '| --- | ---: | ---: | ---: | ---: | --- |');
  for(const row of s.development){
    const fit=s.fitted[row.arm],loaded=loadGain(fit.path),d=diagnostics(loaded.model,val.rows,val.manifest.hands);
    const predictions=val.rows.map(r=>predictModel(loaded.model,r.features));
    diagnostic.models[row.arm]={...d,predictedGainMin:Math.min(...predictions),predictedGainMax:Math.max(...predictions)};
    if(row.arm!=='ridge'){
      const h=read(`model-${row.arm}/summary.json`);
      diagnostic.models[row.arm].epoch0=h.history[0];diagnostic.models[row.arm].lastEpoch=h.history.at(-1);
    }
    lines.push(`| ${row.arm} | ${fit.epoch??'线性拟合'} | ${n(d.mse)} | ${n(d.chosenGainPer100Hands)} | ${n(row.delta)} | ${interval(row.ci95)} |`);
    copyFileSync(fit.path,resolve(destination,`${row.arm}-selected.json`));artifact(fit.path);
  }
  const zeroMse=val.rows.reduce((a,r)=>a+r.gain*r.gain,0)/val.rows.length;
  lines.push('',`零收益预测的验证均方误差为 ${n(zeroMse)}。验证收益是已采决策点上的反事实诊断，不是连续对局的实际分差。开发结果只用于选候选，不能作为提升证据。开发选择：${s.selected??'H0（所有候选开发分差均不为正）'}。`,'');
  if(!s.selected)lines.push('四个候选都没有通过预先约定的开发门槛，因此没有启动封闭验收，也没有消耗封闭评测牌局。本批开发结果不能替代对固定候选的独立牌技结论；本轮没有晋级模型。','');
  for(const [control,r] of Object.entries(s.sealed)){
    lines.push(`## 固定候选封闭评测：对照 ${control}`,'',
      '| 指标 | Δ 底分/百手 | 95% 配对组区间 | 配对组数 | 每版本手数 |',
      '| --- | ---: | --- | ---: | ---: |');
    for(const [label,row] of [[`${plan.budget.sessionHands} 手连续对局（主指标）`,r.primary],['独立单局（辅助）',r.independent],...Object.entries(r.byOpponentPair)]){
      if(row)lines.push(`| ${label} | ${n(row.deltaPer100)} | ${interval(row.ci95)} | ${row.groups} | ${row.hands} |`);
    }
    lines.push('',`本项共 ${r.games} 局实际评测；模型在 ${r.counts.proposals} 个提案点接受了 ${r.counts.accepted} 次替代出牌。`,'');
  }
  writeFileSync(resolve(destination,'diagnostics.json'),JSON.stringify(diagnostic,null,2)+'\n');
  lines.push('## 模型究竟学到了多少','',
    `验证集始终预测零收益的均方误差为 ${n(diagnostic.validationZeroMse)}；始终预测训练集平均收益 ${n(trainingMean)} 的误差为 ${n(diagnostic.validationTrainingMeanMse)}。这两个参照只帮助诊断预测能力，不是额外评测候选，也不参与本轮选择。`,'');
  for(const [arm,d]of Object.entries(diagnostic.models))lines.push(`- ${arm}：验证集接受 ${d.accepted}/${d.rows} 次替代出牌，预测收益范围 [${n(d.predictedGainMin)}, ${n(d.predictedGainMax)}]。`);
  lines.push('');
  const always=Object.entries(diagnostic.models).filter(([arm,d])=>arm!=='ridge'&&d.accepted===d.rows).map(([arm])=>arm);
  if(always.length)lines.push(`${always.join('、')} 在全部验证争议点都接受替代出牌，表明这批早停模型尚未体现按场景筛选的行为。预测误差略降也可能主要来自学习了整体收益倾向；应结合直接前瞻对照，不能把“网络参数变化”当作独立策略能力的证据。`,'');
  lines.push('## 可信度和限制','',
    `实验在首手采集前固定预算、源码和分阶段种子。所有 ${v.games} 局实际评测均保存完整牌谱并重放；独立审计还从种子重新发牌，重算轮庄、每次策略动作、净分汇总与 bootstrap 统计。`,
    `全部 ${v.data.training.roots+v.data.validation.roots} 个已保存决策点及 ${s.branches} 个终局标签分支均重新计算；${v.snapshotsVerified} 份模型快照的权重、训练和验证选择已复核。没有决策点的采集牌局不在逐局重算范围内。`,'',
    `对手包含两家 H0，以及 H0 与 greedy-speed 的组合。相同发牌种子、六种座位排列和真实轮庄减少运气差异；区间按整个配对组计算。${s.selected?'两项封闭对照分别报告，不合并挑选显著结果。':'封闭对照按计划有条件启动，本轮没有候选进入该阶段。'}评测数据不回流训练。`,
    '输入仍为手工特征，动作只覆盖每手首次前瞻分歧；碰、杠、亮倒及之后的出牌沿用 H0。训练只有两类预设对手，独立开局采集与连续轮庄评测也存在分布差异。有限预算可能无法分辨很小的收益差；结果不能直接换算成真人段位。','');
  if(testLog){
    const log=readFileSync(testLog,'utf8');const pass=log.match(/(?:ℹ|#) pass (\d+)/),fail=log.match(/(?:ℹ|#) fail (\d+)/);
    if(!pass||!fail||Number(fail[1])!==0)throw Error('Tests not passed');
    copyFileSync(testLog,resolve(destination,'tests.log'));lines.push(`完整回归测试 ${pass[1]} 项通过，0 项失败。`,'');
  }
  if(extraTestLog){
    const log=readFileSync(extraTestLog,'utf8');if(!/(?:ℹ|#) pass 1\b/.test(log)||!/(?:ℹ|#) fail 0\b/.test(log))throw Error('Supplementary recovery/audit test failed');
    copyFileSync(extraTestLog,resolve(destination,'tests-recovery-audit.log'));
    lines.push('新增恢复汇总与多进程审计又通过 1 项完整流程测试；多进程结果与原串行审计逐项一致。','');
  }
  if(existsSync(resolve(out,'recovery.json')))lines.push('采集时一个分片创建目录遇到 EPERM，使用原计划相同手号和种子补跑；其他分片复用。随后按冻结计划继续训练和评测，没有更改数据量、评测预算、候选规则或模型源码，见 recovery.json。','');
  for(const stage of [...s.development.map(r=>`development-${r.arm}`),...Object.keys(s.sealed).map(c=>`sealed-vs-${c}`)]){
    copyFileSync(resolve(out,stage,'report.json'),resolve(destination,`${stage}.json`));
    artifact(resolve(out,stage,'replays.jsonl.gz'));artifact(resolve(out,stage,'decisions.jsonl.gz'));
  }
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  lines.push(`完整本地运行目录：\`${relative(projectRoot,out)}\`。训练数据和完整牌谱位于忽略的实验目录；本报告目录保存计划、汇总、各阶段指标、四个所选模型和审计结果。`,'',
    '下一步应优先检验更完整的逐张牌面和对手出牌历史表示，再扩大可学习的决策范围，使用新的预先固定的训练与评测预算。','');
  if(existsSync(archive))lines.push('frozen-sources.tar.gz 保存本轮 AI 源码、规则引擎及依赖版本配置；原始 SHA-256 仍以 plan.json 为准。','');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],testLog:process.argv[4],extraTestLog:process.argv[5]}));
