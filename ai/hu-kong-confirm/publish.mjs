import assert from 'node:assert/strict';
import {copyFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {projectRoot} from '../provenance.mjs';
import {publish as publishTrial} from '../hu-kong/publish.mjs';
import {checkSummary,check,read,hash} from './config.mjs';
export function conclusion(s){
  const strength=s.outcomes.strength==='negative'?'本批明确落后强参照，联合门槛未通过。':s.outcomes.strength==='positive'?
    (s.positiveJointEvidence?'本批同时超过强参照，但整体强度仅本批首次得到正向证据，仍不自动晋级。':'本批相对强参照有正向证据，但机制未通过，联合门槛未通过。'):'本批仍未确认超过强参照，联合门槛未通过。';
  if(s.mechanismReplicated)return '限定修正相对 base 的正收益方向得到两批独立发牌支持。'+strength;
  if(s.outcomes.mechanism==='negative')return '本次复验检出限定修正的负收益，未重现发现批的正向结果，不采用该替换。';
  if(s.outcomes.mechanism==='positive')return '本批支持限定修正的正收益，但发现批未单独通过，不能称两批正向复现。';
  return '本次复验未确认限定修正的正收益，发现批的优势尚未在新批次得到确认；证据不足不等于修正无效。'+strength;
}
export function publish({out,destination,tests}){
  out=resolve(out);destination=resolve(destination);const {p,s}=checkSummary(out),v=read(resolve(out,'verification.json'));check(p);
  assert.equal(v.planSha256,hash(resolve(out,'plan.json')));assert.equal(v.summarySha256,hash(resolve(out,'summary.json')));assert.equal(v.bindingSha256,hash(resolve(out,'binding.json')));
  assert.deepEqual(v.sourceMap,p.sourceMap);assert.ok(v.allGroupsRecomputedWithoutScoreCache);assert.equal(v.games,s.games);
  assert.equal(v.trialVerificationSha256,hash(resolve(out,'trial/verification.json')));assert.deepEqual(v.groups,read(resolve(out,'trial/verification.json')).groups);
  const report=publishTrial({out:resolve(out,'trial'),destination,tests}),n=x=>Number(x).toFixed(2),ci=x=>'['+x.ci95.map(n).join(', ')+']',
    a=s.primary.mechanism,b=s.primary.strength,d=s.discoveryPrimary;
  let content=readFileSync(report,'utf8').replace('# 可胡时胡杠取舍独立对照结果','# 胡杠取舍独立复验结果').replace('../../可胡时胡杠取舍独立对照.md','../../胡杠取舍独立复验.md');
  const intro=['',conclusion(s),'',
    '## 独立复验的预定口径','',
    '模型、策略、预算、对手与统计方法均继承发现批，只使用全新种子。复验计划和子计划哈希在首局前绑定，组种子与发现批无重复。原始驱动不变，没有重新训练或调参。本批和发现批分别报告，不合并检验，不跨批相减。','',
    '| 批次 | 候选减 base / 百手（95% 区间） | 候选减强参照 / 百手（95% 区间） |','| --- | --- | --- |',
    `| 发现批 | ${n(d.mechanism.deltaPer100)} ${ci(d.mechanism)} | ${n(d.strength.deltaPer100)} ${ci(d.strength)} |`,
    `| 本次复验 | ${n(a.deltaPer100)} ${ci(a)} | ${n(b.deltaPer100)} ${ci(b)} |`,'',
    '两批都是同一冻结权重上的新发牌实验，不是两次独立训练。机制复现要求两批的机制区间分别严格大于零；本批整体联合门槛仍要求两项主要区间同时严格大于零。原短版和对手子组只作次要描述；整体强度的一批正结果不能称跨批复现。','',
    '发现批结果见[原报告](../hu-kong-2026-10-23/实验结果.md)，本轮首局前方案见[复验方案](../../胡杠取舍独立复验.md)。','',
    '下文为本批独立数据、触发事件和完整核验结果。复验绑定与结果分别保存在 replication-plan.json、binding.json、replication-summary.json 和 replication-verification.json；plan.json、summary.json、verification.json 是未经修改的冻结原驱动输出。',''];
  content=content.replace('\n\n','\n'+intro.join('\n')+'\n');writeFileSync(report,content);
  const artifacts=read(resolve(destination,'artifacts.json'));
  for(const [name,target]of [['plan.json','replication-plan.json'],['binding.json','binding.json'],['summary.json','replication-summary.json'],['verification.json','replication-verification.json']]){
    const file=resolve(out,name);copyFileSync(file,resolve(destination,target));artifacts.push({path:relative(projectRoot,file),sha256:hash(file)});
  }
  writeFileSync(resolve(destination,'artifacts.json'),JSON.stringify(artifacts,null,2)+'\n');
  writeFileSync(resolve(destination,'checksums.json'),JSON.stringify(readdirSync(destination).filter(path=>path!=='checksums.json').map(path=>({path,sha256:hash(resolve(destination,path))})),null,2)+'\n');
  return report;
}
