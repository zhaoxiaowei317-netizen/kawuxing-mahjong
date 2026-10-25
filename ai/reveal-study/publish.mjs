import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {ARMS} from './policies.mjs';
import {check,read,hash} from './study.mjs';

export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json'));check(p);
  assert.equal(s.planSha256,v.planSha256);assert.equal(s.games,v.games);assert.equal(s.trainingHands,0);
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  mkdirSync(destination,{recursive:true});const artifacts=[];
  const copy=(source,name)=>copyFileSync(source,resolve(destination,name));
  const add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)});
  for(const file of ['plan.json','summary.json','selection.json','verification.json','runtime.json','frozen-sources.tar.gz']){copy(resolve(out,file),file);add(resolve(out,file));}
  copy(tests,'tests-node.log');copy(p.checkpoint,'frozen-q.json');copy(p.checkpoint.replace(/\.json$/,'.pt'),'frozen-q.pt');
  const model=read(p.checkpoint);assert.equal(model.metadata.optimizerStateSha256,hash(resolve(destination,'frozen-q.pt')));add(p.checkpoint);add(p.checkpoint.replace(/\.json$/,'.pt'));
  const fmt=n=>Number(n).toFixed(2),ci=r=>`[${r.ci95.map(fmt).join(', ')}]`;
  const labels={'h0-never':'H0 不亮倒','h0-q-gate':'H0 出牌 + Q 亮倒开关','q-h0-gate':'Q 出牌 + H0 亮倒开关','q-reference':'原版 Q 参考'};
  const title=s.positiveSealedEvidence?'固定干预在本批独立连续对局验收中得到相对 H0 的正净收益证据。':s.selected?
    '固定干预在本批独立连续对局验收中未确认超过 H0。':'三个干预均未通过预定的开发正收益门槛，没有启动封闭验收。';
  const lines=['# 亮倒取舍干预实验结果','',title,'',
    `本轮没有新增神经网络训练。涉及 Q 的版本使用同一份冻结旧模型（${p.checkpointSha256.slice(0,16)}…）；“H0 不亮倒”不使用神经网络推理。四个版本分别完成固定开发预算${s.selected?'，随后仅对一个固定候选做全新种子封闭验收':''}，合计 ${s.games} 局实际评测。游戏默认仍为 H0。`,'',
    '## 本轮问题与干预','',
    '上轮旧模型比重训模型更少亮倒，但净收益优势未稳定复现。本轮保留基础策略的动作种类和所选牌张，只在该牌同时有普通/亮倒合法动作时替换开关。没有改变规则引擎，也没有输入对手暗手或真实牌墙。','',
    '| 版本 | 基础出牌与其他动作 | 亮倒开关 |','| --- | --- | --- |',
    '| h0-never | H0 | 取消亮倒执行，保留原本考虑亮倒的弃牌排序 |',
    '| h0-q-gate | H0 | 用完整合法输入的 Q 值比较该牌的两个动作 |',
    '| q-h0-gate | 原版 Q | H0 只比较 Q 已选定的那张牌 |',
    '| q-reference | 原版 Q | 保持原版，作为开发参考 |','',
    '改变亮倒会影响后续牌流、轮庄和其他玩家反应。这里比较整个组件替换后的策略收益，不能据此把原模型全部优势归因于某一个孤立动作。方法、预算和停止规则见[实验方案](../../亮倒取舍干预实验.md)。','',
    '## 固定开发结果','',
    '| 版本 | 对 H0 净底分差/百手 | 95% 配对组区间 | 对原版 Q 的差值 | 95% 配对组区间 |',
    '| --- | ---: | --- | ---: | --- |'];
  const reports={};
  for(const arm of ARMS){
    const r=read(resolve(out,`development-${arm}/report.json`));reports[arm]=r;
    const row=s.development.find(x=>x.arm===arm),contrast=s.vsReference[arm]?.overall;
    lines.push(`| ${labels[arm]} | ${fmt(row.delta)} | [${row.ci95.map(fmt).join(', ')}] | ${contrast?fmt(contrast.deltaPer100):'—'} | ${contrast?ci(contrast):'—'} |`);
    copy(resolve(out,`development-${arm}/report.json`),`development-${arm}.json`);add(resolve(out,`development-${arm}/replays.jsonl.gz`));
  }
  const controls=r=>r.records.map(({suite,opponentPair,seed,incumbent})=>({suite,opponentPair,seed,incumbent}));
  for(const arm of ARMS)assert.deepEqual(controls(reports[arm]),controls(reports['q-reference']));
  lines.push('',`开发每种对手组合 ${p.budget.developmentGroups} 个完整种子组，每组 ${p.budget.sessionHands} 手、六种座位排列；H0/H0 与 H0/greedy-speed 等权。四版 H0 对照完全相同，重复计算不增加独立起手数量。开发组很少，上表区间只作方向描述，未经多重比较校正。`,'',
    `固定选择：${s.selected?labels[s.selected]:'无'}。只在三个干预中按开发净收益最高且严格为正选择，打平按预定顺序；原版 Q 不参与重新选冠军。`,'');
  if(s.sealed){
    const r=s.sealed.primary;lines.push('## 唯一候选的新种子封闭验收','',
      '| 指标 | 对 H0 净底分差/百手 | 95% 配对组区间 | 配对组数 | 候选手数 |',
      '| --- | ---: | --- | ---: | ---: |',
      `| 连续对局（唯一主指标） | ${fmt(r.deltaPer100)} | ${ci(r)} | ${r.groups} | ${r.hands} |`);
    for(const [pair,q]of Object.entries(s.sealed.byOpponentPair))lines.push(`| ${pair}（次要描述） | ${fmt(q.deltaPer100)} | ${ci(q)} | ${q.groups} | ${q.hands} |`);
    lines.push('',s.positiveSealedEvidence?'主要区间完全高于零，支持该固定干预在本批规则和对手池中的正收益。只有一次封闭批次，尚未证明多批次稳定性或对真人普遍有效。':
      r.ci95[1]<0?'主要区间完全低于零，本批显示该干预相对 H0 有负净收益证据。':'主要区间包含零，未确认超过 H0；也不能据此认定策略效果完全相同。','',
      '两个对手子组为未经多重比较校正的次要描述。本轮只测连续对局，不能推断独立单局表现。','');
    copy(resolve(out,'sealed/report.json'),'sealed.json');add(resolve(out,'sealed/replays.jsonl.gz'));
  }else lines.push('封闭种子未用于生成验收牌局；没有把开发中的原版 Q 重新作为候选送验。','');
  lines.push('## 亮倒选择与行为','',
    '| 阶段 | 可改变开关的决策 | 实际改变次数 | 基础策略当时欲亮倒 | 实际宣告次数 | 胡牌机会 / 另选动作 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |');
  const stages=[...ARMS.map(a=>`development-${a}`),...(s.selected?['sealed']:[])],behavior={};
  for(const stage of stages){const d=v.evaluation[stage].diagnostics;
    lines.push(`| ${stage} | ${d.opportunities} | ${d.changed} | ${d.baseReveals} | ${d.chosenReveals} | ${d.huOffered} / ${d.huDeclined} |`);}
  lines.push('','“基础策略当时欲亮倒”来自实际干预轨迹，可在同一手中反复出现，不能当作基础策略单独对局的亮倒率。机会数只统计该基础策略已选定牌张的合法普通/亮倒双选；案例取固定牌谱顺序的前 12 次变化，仅供检查，不是代表性样本或精选成功案例。胡牌机会另选动作也不直接等同于非法行为。','',
    '| 阶段 | 亮倒比例：候选 / H0 | 胡牌比例：候选 / H0 | 放炮比例：候选 / H0 |',
    '| --- | ---: | ---: | ---: |');
  for(const stage of stages){const r=read(resolve(out,stage,'report.json')),a={};
    for(const side of ['candidate','incumbent'])a[side]=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(key=>[key,r.records.reduce((sum,row)=>sum+row[side][key],0)]));
    behavior[stage]=a;const rate=key=>['candidate','incumbent'].map(side=>fmt(100*a[side][key]/a[side].hands)+'%').join(' / ');
    lines.push(`| ${stage} | ${rate('revealHands')} | ${rate('wins')} | ${rate('dealIns')} |`);
  }
  if(existsSync(resolve(out,'rule-explanation.json'))){
    const explanation=read(resolve(out,'rule-explanation.json')),a=explanation.sides;
    assert.equal(explanation.replaysSha256,hash(resolve(out,'sealed/replays.jsonl.gz')));
    assert.equal(explanation.rules.engineSha256,p.sources.core['src/engine.js']);assert.equal(explanation.rules.documentSha256,hash('docs/孝感卡五星正式规则.md'));
    assert.equal(explanation.sourceSha256,hash(new URL('./explain.mjs',import.meta.url)));
    copy(resolve(out,'rule-explanation.json'),'rule-explanation.json');add(resolve(out,'rule-explanation.json'));
    lines.push('','## 规则相关的事后解释','',
      '[正式规则](../../孝感卡五星正式规则.md)规定：未亮倒且有安全牌时必须避开亮倒对手的听口；已亮倒正常只能摸切，即使摸到危险牌。本轮未改变这些规则。保留不亮倒状态也保留了更多出牌与避炮空间。','',
      `封闭候选放炮 ${a.candidate.dealIns} 次，H0 对照 ${a.incumbent.dealIns} 次；对照中 ${a.incumbent.dealInsWhileRevealed} 次发生在自身已亮倒时，${a.incumbent.dealInsWhileConcealed} 次发生在未亮倒时。`,
      '这与上述机制相符，但属于事后描述，未分离“避炮空间”对总分提升的精确贡献。它不证明所有局面都应不亮倒，也不能把原 Q 模型全部成绩归因于亮倒频率。');
  }
  lines.push('','行为比例有助于理解策略，不单独证明因果或牌技。开发中取消/替换开关的整条轨迹差异可以提供方向诊断；封闭主要检验只针对固定候选相对 H0，不是三个干预分别通过的因果证明。','',
    '## 复核与归档','',
    `全部 ${v.games} 局已从种子重新发牌，核对双方策略每次动作、连续轮庄、结算、亮倒/胡牌/放炮等行为字段、分组净收益与 bootstrap 统计。合法同牌双动作开关、原始 Q 掩码及不改变出牌种类/牌张的约束有集成检查。完整 JavaScript 回归 ${passed[1]} 项通过。`,'',
    '旧规则、H0 与旧模型的核心源码哈希保持；本轮新干预、编排、审计源码同样在发牌前冻结。模型权重与原 Adam 断点一并保留，但没有更新权重。','',
    `完整运行目录：\`${relative(projectRoot,out)}\`。报告目录保存计划、结果、审计与前 12 个公开干预案例、模型、断点、测试日志、来源哈希和源码归档；完整牌谱保存在本机忽略目录。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(name=>({path:name,sha256:hash(resolve(destination,name))})),null,2)+'\n');
  return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
