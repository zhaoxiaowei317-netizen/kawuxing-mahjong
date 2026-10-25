import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {ARMS,check,hash,read} from './config.mjs';
import {jobsFor,aggregate} from './evaluate.mjs';
import {summarizePaired} from '../statistics.mjs';
import {deriveSeed} from '../random.mjs';

export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);if(existsSync(destination))throw Error('Publication exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),v=read(resolve(out,'verification.json')),t=read(resolve(out,'training.json'));check(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);
  assert.equal(v.groups.length,jobsFor(p).length);assert.equal(s.trainingHands,v.data.training.hands);assert.equal(s.validationHands,v.data.validation.hands);
  const log=readFileSync(tests,'utf8'),passed=log.match(/(?:ℹ|#) pass (\d+)/);assert.ok(passed);assert.match(log,/(?:ℹ|#) fail 0\b/);
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(aggregate(p,groups),s.evaluations);
  if(v.auditExtension)for(const [name,expected]of Object.entries(v.auditExtension.sources))assert.equal(hash(new URL(name,import.meta.url)),expected);
  for(const g of groups){const a=v.groups.find(x=>x.jobId===g.job.id);assert.ok(a?.allEpisodesRedealtAndExactTracesMatched);
    assert.equal(a.groupSha256,hash(resolve(out,'groups',g.job.id,'group.json')));assert.equal(a.replaysSha256,hash(resolve(out,'groups',g.job.id,'replays.jsonl.gz')));}
  mkdirSync(destination,{recursive:true});const artifacts=[],add=path=>artifacts.push({path:relative(projectRoot,path),sha256:hash(path)});
  const copy=(path,name)=>{copyFileSync(path,resolve(destination,name));add(path);};
  for(const name of ['plan.json','summary.json','verification.json','training.json','models.json','runtime.json','frozen-sources.tar.gz'])copy(resolve(out,name),name);
  for(const name of ['execution.log','audit-stream.log','initial-audit-failure.log','diagnostics.log'])if(existsSync(resolve(out,name)))copy(resolve(out,name),name);
  copy(tests,'tests-node.log');
  let streamTests=null;
  if(v.auditExtension){
    const path=resolve(out,'stream-tests.log'),extra=readFileSync(path,'utf8');streamTests=extra.match(/(?:ℹ|#) pass (\d+)/);assert.ok(streamTests);assert.match(extra,/(?:ℹ|#) fail 0\b/);copy(path,'tests-stream.log');
    for(const name of ['verify-stream.mjs','stream-data.mjs']){copy(fileURLToPath(new URL(name,import.meta.url)),name);}
  }
  for(const split of ['training','validation']){
    copy(resolve(out,split,'manifest.json'),split+'-manifest.json');add(resolve(out,split,'episodes.jsonl.gz'));
    assert.equal(hash(resolve(out,split,'episodes.jsonl.gz')),t.datasets[split].sha256);
  }
  for(const arm of ARMS){
    const model=s.models[arm];assert.equal(hash(model.path),model.sha256);copy(model.path,arm+'-selected.json');copy(model.state,arm+'-selected.pt');
    assert.equal(hash(model.state),read(model.path).metadata.optimizerStateSha256);
    copy(resolve(out,`model-${arm}/parity.json`),arm+'-parity.json');copy(resolve(out,`train-${arm}.json`),'train-'+arm+'.json');
    for(const name of readdirSync(resolve(out,`model-${arm}`)).filter(n=>/^epoch-\d+\.(json|pt)$/.test(n)))add(resolve(out,`model-${arm}`,name));
  }
  for(const g of groups){add(resolve(out,'groups',g.job.id,'group.json'));add(resolve(out,'groups',g.job.id,'replays.jsonl.gz'));}
  let diagnostic=null;
  if(existsSync(resolve(out,'validation-diagnostics.json'))){
    diagnostic=read(resolve(out,'validation-diagnostics.json'));assert.equal(diagnostic.postHoc,true);assert.equal(diagnostic.validationSha256,t.datasets.validation.sha256);
    assert.equal(diagnostic.sourceSha256,hash(new URL('diagnose.py',import.meta.url)));add(fileURLToPath(new URL('diagnose.py',import.meta.url)));
    for(const arm of ARMS){assert.equal(diagnostic.models[arm].checkpointSha256,s.models[arm].sha256);assert.equal(diagnostic.models[arm].counts.rows,t.datasets.validation.samples);
      const f=t.fitted[arm],expected=f.history.find(r=>r.epoch===f.selected.epoch).validation.teacherAgreement,c=diagnostic.models[arm].counts;assert.ok(Math.abs(c.exact/c.rows-expected)<1e-6);}
    copy(resolve(out,'validation-diagnostics.json'),'validation-diagnostics.json');
  }
  if(p.previous)copy(resolve(p.previous.path,'summary.json'),'previous-summary.json');
  writeFileSync(resolve(destination,'groups.json'),JSON.stringify(groups,null,2)+'\n');
  const n=x=>Number(x).toFixed(2),ci=r=>'['+r.ci95.map(n).join(', ')+']',primary=s.evaluations.offline.statistics.session.overall;
  const contrastRecords=s.evaluations.offline.records.map(r=>{
    const b=s.evaluations.bc.records.find(b=>b.seed===r.seed&&b.opponentPair===r.opponentPair);assert.ok(b);assert.deepEqual(r.incumbent,b.incumbent);
    return {suite:r.suite,opponentPair:r.opponentPair,seed:r.seed,candidate:r.candidate,incumbent:b.candidate};
  });
  const contrast={postHoc:true,primary:false,comparison:'offline minus BC on the same paired opening groups; descriptive, not multiplicity adjusted',records:contrastRecords,
    statistics:summarizePaired(contrastRecords,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seeds.evaluation,'offline-vs-bc-posthoc'),base:1})};
  writeFileSync(resolve(destination,'offline-vs-bc-posthoc.json'),JSON.stringify(contrast,null,2)+'\n');
  const conclusion=primary.ci95[0]>0?'主要离线收益模型在本批新牌局中取得超过不亮倒 H0 的正净收益证据，仍需独立复验。':
    primary.ci95[1]<0?'主要离线收益模型在本批新牌局中明确落后于不亮倒 H0，本轮没有训练出更强的模型。':'主要离线收益模型在本批新牌局中未确认超过不亮倒 H0，本轮没有达到预定提升门槛。';
  const lines=['# 强对手混合训练结果','',conclusion,'',
    `本轮实际新增 ${s.trainingHands} 手训练、${s.validationHands} 手独立验证、${s.trainingSamples} 个训练选择样本，完成 ${s.games} 局正式评测。全部数据和评测完成复核，游戏默认仍为 H0。`,'',
    '## 做了什么','',
    '把经过独立验证的不亮倒 H0 接入混合教师和对手分布。四种牌桌按 16 手连续场次轮换，并在座位上均衡。教师角色占比为不亮倒 7/12、H0 4/12、速度贪心 1/12；每家只给自身决策打标签，5% 合法随机探索发生在标签生成之后。实际选择样本占比会随对局长度变化。','',
    '网络从新初始化开始，先进行 12 轮模仿，再以所选模仿权重开始 8 轮离线终局收益回归。收益阶段保留 CQL、动作模仿和顺位辅助损失。沿用 21 种牌的残差牌张网络与全部合法动作，没有额外硬编码禁止亮倒，没有把错误决策交回 H0。网络输入没有教师身份、对手策略身份或对手暗牌。','',
    '本轮是混合教师模仿加离线收益学习，没有新增在线自博弈强化学习。方法、全部预算和停止规则见[实验方案](../../强对手混合训练.md)，规则见[正式规则](../../孝感卡五星正式规则.md)。','',
    '## 更高的验收门槛','',
    '主要对象在采集第一手之前指定为 offline，比较对象为已经验证更强的不亮倒 H0。对手组合为不亮倒/H0、不亮倒/不亮倒、不亮倒/速度贪心，固定等权。每组合 8 个种子组，六种座位排列、两条轨迹、连续 16 手，每份模型共 4,608 局。','',
    '模仿模型 bc 为次要诊断，成绩不能事后替换主要对象。两份模型在第一手评测前冻结；只按各自独立验证损失选择检查点，包含第 0 轮，平分取较早者。相同考试开局及控制轨迹跨两份模型重复，不能算成两批独立强度证据。每个模型的区间使用 24 个完整配对组，bootstrap 5,000 次，不把组内座位或牌局当成独立样本。','',
    '| 模型 | 对不亮倒 H0 净底分差/百手 | 95% 配对组区间 | 候选手数 | 配对组 |',
    '| --- | ---: | --- | ---: | ---: |'];
  for(const arm of ARMS){const r=s.evaluations[arm].statistics.session.overall;lines.push(`| ${arm==='offline'?'离线收益（唯一主要检验）':'模仿（次要诊断）'} | ${n(r.deltaPer100)} | ${ci(r)} | ${r.hands} | ${r.groups} |`);}
  lines.push('',conclusion,'',
    '分差是平均净底分，不是胜率百分点。主要区间跨零表示证据不足，不代表双方完全一样。BC 和各子组均未经多重比较校正，只作诊断；没有与旧 H0 或旧神经网络在同一轮直接比较，不能据此声称网络相对旧模型提高或退步了多少。','',
    `另作事后配对诊断：收益模型相对同轮模仿模型为 ${n(contrast.statistics.session.overall.deltaPer100)} 底分/百手，95% 区间 ${ci(contrast.statistics.session.overall)}。这里直接配对两份模型的目标轨迹，不将重复控制当作新增证据；未经多重比较校正，不能替代与不亮倒 H0 的主要检验。`,'',
    '## 全部对手子组（次要描述）','',
    '| 模型 / 组合 | 分差/百手 | 95% 配对组区间 | 配对组 |',
    '| --- | ---: | --- | ---: |');
  for(const arm of ARMS)for(const [pair,r]of Object.entries(s.evaluations[arm].statistics.session.byOpponentPair))lines.push(`| ${arm} / ${pair} | ${n(r.deltaPer100)} | ${ci(r)} | ${r.groups} |`);
  lines.push('','## 实际行为和得分组成','',
    '| 模型 | 亮倒：模型 / 参照 | 胡牌：模型 / 参照 | 放炮：模型 / 参照 | 胡分差/百手 | 杠分差/百手 | 查叫分差/百手 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const behavior={};
  for(const arm of ARMS){
    const records=s.evaluations[arm].records,a={};
    for(const side of ['candidate','incumbent'])a[side]=Object.fromEntries(['hands','score','wins','dealIns','revealHands','huScore','kongScore','drawScore'].map(k=>[k,records.reduce((n,r)=>n+r[side][k],0)]));
    behavior[arm]=a;const rate=k=>['candidate','incumbent'].map(side=>n(100*a[side][k]/a[side].hands)+'%').join(' / ');
    const delta=k=>n(100*(a.candidate[k]/a.candidate.hands-a.incumbent[k]/a.incumbent.hands));
    lines.push(`| ${arm} | ${rate('revealHands')} | ${rate('wins')} | ${rate('dealIns')} | ${delta('huScore')} | ${delta('kongScore')} | ${delta('drawScore')} |`);
  }
  lines.push('','这些是事后描述，不能把某一比例当成净收益差的唯一原因。混合标签可能互相冲突，模仿误差下降或亮倒减少都不能单独证明牌技更强。');
  if(diagnostic){
    lines.push('','## 固定验证局面的动作诊断（事后描述）','',
      '| 模型 | 跟随教师全部动作 | 教师出牌时选同一牌张 | 只差亮倒开关的次数 | 教师胡牌但模型未胡 |',
      '| --- | ---: | ---: | ---: | ---: |');
    for(const arm of ARMS){const c=diagnostic.models[arm].counts;lines.push(`| ${arm} | ${n(c.exact/c.rows*100)}% | ${n(c.sameDiscardTile/c.teacherDiscards*100)}% | ${c.onlyRevealDifference} | ${c.teacherHuDeclined}/${c.teacherHu} |`);}
    const c=diagnostic.bcToOffline;lines.push('',`从模仿到收益阶段，在相同的 ${c.rows} 个验证选择中改变了 ${c.changed} 次动作（${n(c.changed/c.rows*100)}%），其中 ${c.discardTileChanged} 次改变出牌牌张，${c.onlyRevealChanged} 次只改变亮倒开关。`,
      '', '这是固定教师分布中的局面，不是模型自身对局状态。偏离教师可能正确也可能错误，合法过胡也不一概认定为错误；此诊断没有用于选择或训练模型，不能替代实际净收益检验。');
  }
  lines.push('',
    '## 训练记录','',
    '| 阶段 | 所选轮次 | 第 0 轮验证损失 | 所选验证损失 | 所选教师动作一致率 | 参数数 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |');
  for(const arm of ARMS){const f=t.fitted[arm],r=f.history.find(x=>x.epoch===f.selected.epoch);lines.push(`| ${arm} | ${f.selected.epoch} | ${n(f.history[0].validation.loss)} | ${n(r.validation.loss)} | ${n(r.validation.teacherAgreement*100)}% | ${f.parameters} |`);}
  lines.push('','两阶段损失含义不同，数值不能直接横向比较。收益目标仍为终局净底分减去已结算杠分后除以 16；没有使用考试牌局作为收益标签。','',
    '| 教师 | 训练选择样本 | 验证选择样本 |',
    '| --- | ---: | ---: |');
  for(const id of ['h0-never','H0','greedy-speed-v1'])lines.push(`| ${id} | ${t.datasets.training.teachers[id]||0} | ${t.datasets.validation.teachers[id]||0} |`);
  lines.push('','## 完整复核和限制','',
    `所有 ${v.data.training.hands+v.data.validation.hands} 手采集牌局已重发，逐个核验教师/探索动作、公开编码、掩码、标签、收益、顺位和连续状态。全部 ${v.games} 局评测已用冻结模型重发并逐条匹配完整牌谱，重算得分、行为与配对组区间。核对 ${v.snapshotsVerified} 份模型快照和 Adam 状态哈希，Python/JavaScript 导出一致性通过。完整 JavaScript 回归 ${passed[1]} 项通过。`,'',
    '集成检查另核对串行采集与分片合并的全部牌谱相同，并主动篡改教师标签和组分数，确认审计会拒绝。训练和测试只在本地 CPU 运行。未修改正式规则、默认电脑或游戏存档。测试夹具、审计重放不计为新增正式训练/评测。','',
    '本轮只有一个训练初始化。相对旧实验，数据量、分布和初始化同时变化，没有同步运行旧配方对照；因此即使成绩为正，也不能把因果收益单独归于加入不亮倒教师。主要问题是这份预先固定的新配方有没有超过更强参照。','',
    primary.deltaPer100>0?'后续可预先固定独立新种子复验，确认当前正点估计能否重现，再决定继续自采样训练或调整配方。当前区间和原预算保持，不通过追加本批考试局数宣布成功。':'后续应结合模仿误差与收益学习变化，设计下一项训练目标或对手配置对照；不通过追加同配方训练轮次或补考局数宣布成功。','',
    `完整本地运行目录：\`${relative(projectRoot,out)}\`。报告保留配置、全部分组汇总、审计、两份所选模型与优化器、训练曲线、测试日志、源码归档和校验值。大体积原始训练/评测牌谱及其余快照保留在本地忽略的实验目录，索引见 [artifacts.json](artifacts.json)。`,'');
  if(v.auditExtension)lines.push(`本轮数据超过旧审计器整文件字符串长度上限，第一次审计在读取训练数据时停止，没有产生通过结论。新增逐行解压审计扩展，原计划、模型、训练/评测代码与预算保持冻结；扩展源码哈希单列在 verification.json，${streamTests[1]} 项新增检查确认它与原审计器在小型全流程上的结果一致，并拒绝压缩损坏、JSON 损坏和数据计数篡改。没有重训或补充正式考试局数。`,'');
  writeFileSync(resolve(destination,'behavior.json'),JSON.stringify(behavior,null,2)+'\n');
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'实验结果.md'),lines.join('\n'));
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).map(name=>({path:name,sha256:hash(resolve(destination,name))})),null,2)+'\n');
  return resolve(destination,'实验结果.md');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(publish({out:process.argv[2],destination:process.argv[3],tests:process.argv[4]}));
