import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {check as checkTrial,sourceMap as trialSources,read,hash,jobsFor,jobSeed} from '../hu-kong/config.mjs';
import {aggregate} from '../hu-kong/study.mjs';
export {read,hash};
export const VERSION='kwx-hu-kong-confirm-1';
export const sourceMap=()=>({...trialSources(),...Object.fromEntries(['config.mjs','study.mjs','verify.mjs'].map(f=>['ai/hu-kong-confirm/'+f,hash(new URL(f,import.meta.url))]))});
const FILES=['plan.json','summary.json','verification.json','models.json'];
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sourceMap,sourceMap());
  assert.deepEqual(Object.keys(p.discovery.files),FILES);
  for(const [f,sha]of Object.entries(p.discovery.files))assert.equal(hash(resolve(p.discovery.path,f)),sha);
  const d=read(resolve(p.discovery.path,'plan.json')),s=read(resolve(p.discovery.path,'summary.json')),v=read(resolve(p.discovery.path,'verification.json'));checkTrial(d);
  assert.equal(s.planSha256,p.discovery.files['plan.json']);assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);
  assert.deepEqual(v.sourceMap,d.sourceMap);assert.ok(v.allGroupsRecomputedWithoutScoreCache);
  assert.equal(v.groups.length,jobsFor(d).length);assert.deepEqual(p.budget,d.budget);assert.deepEqual(p.models,d.models);
  assert.equal(p.primary,d.primary);assert.equal(p.rule,d.rule);assert.deepEqual(p.discoveryPrimary,s.primary);
  assert.equal(p.stopping,'Repeat the exact discovery budget once with fresh seeds. No pooling, interim selection, budget extension or automatic promotion. Default H0.');
  return {d,s,v};
}
export function makePlan({discovery}){
  discovery=resolve(discovery);const d=read(resolve(discovery,'plan.json')),s=read(resolve(discovery,'summary.json'));
  const p={version:VERSION,createdAt:new Date().toISOString(),sourceMap:sourceMap(),
    discovery:{path:discovery,files:Object.fromEntries(FILES.map(f=>[f,hash(resolve(discovery,f))]))},
    budget:d.budget,models:d.models,primary:d.primary,rule:d.rule,discoveryPrimary:s.primary,
    stopping:'Repeat the exact discovery budget once with fresh seeds. No pooling, interim selection, budget extension or automatic promotion. Default H0.',
    interpretation:'Mechanism replicates only if discovery and this new batch separately have patched-minus-base 95% lower bounds above zero. Current joint claim additionally requires current patched-minus-reference positive. A first positive strength result is not replicated strength. Same fixed weights; no new training or training-seed replication.'};
  const {v}=check(p),groups=[];
  for(const j of jobsFor(d)){const a=v.groups.find(x=>x.jobId===j.id);assert.ok(a?.allEpisodesRedealtAndPoliciesAndExactTracesMatched&&a.cacheDisabled);
    groups.push(read(resolve(discovery,'groups',j.id,'group.json')));
    for(const [f,key]of [['group.json','groupSha256'],['replays.jsonl.gz','replaysSha256']])assert.equal(hash(resolve(discovery,'groups',j.id,f)),a[key]);}
  assert.deepEqual(s.models,d.models);assert.deepEqual(read(resolve(discovery,'models.json')),d.models);assert.deepEqual(s.evaluation,aggregate(d,groups));
  assert.equal(s.games,s.evaluation.games);assert.deepEqual(s.primary,Object.fromEntries(['mechanism','strength'].map(k=>[k,s.evaluation.contrasts[k].statistics.session.overall])));
  assert.deepEqual(s.outcomes,Object.fromEntries(Object.entries(s.primary).map(([k,x])=>[k,x.ci95[0]>0?'positive':x.ci95[1]<0?'negative':'inconclusive'])));
  assert.equal(s.positiveJointEvidence,Object.values(s.outcomes).every(x=>x==='positive'));assert.equal(s.productionPolicy,'H0');
  return p;
}
export function checkBinding(out,p){
  const {d}=check(p),t=read(resolve(out,'trial/plan.json')),b=read(resolve(out,'binding.json'));checkTrial(t);
  assert.equal(b.planSha256,hash(resolve(out,'plan.json')));assert.equal(b.trialPlanSha256,hash(resolve(out,'trial/plan.json')));
  assert.deepEqual(t.models,p.models);assert.deepEqual(t.budget,p.budget);assert.equal(t.previous.path,d.previous.path);
  assert.deepEqual(t.pairs,d.pairs);assert.deepEqual(t.arms,d.arms);assert.deepEqual(t.contrasts,d.contrasts);assert.equal(t.rule,p.rule);assert.equal(t.primary,p.primary);
  assert.notEqual(t.seed,d.seed);const old=new Set(jobsFor(d).map(j=>jobSeed(d,j)));
  const fresh=jobsFor(t).map(j=>jobSeed(t,j));assert.equal(new Set(fresh).size,fresh.length);assert.ok(fresh.every(seed=>!old.has(seed)));
  return {t,b};
}
export function summaryFor(out,p){
  checkBinding(out,p);const t=read(resolve(out,'trial/summary.json'));
  assert.equal(t.planSha256,hash(resolve(out,'trial/plan.json')));assert.equal(t.productionPolicy,'H0');assert.equal(t.newUniqueTrainingHands,0);assert.equal(t.newUniqueValidationHands,0);
  return {version:VERSION,completedAt:t.completedAt,planSha256:hash(resolve(out,'plan.json')),bindingSha256:hash(resolve(out,'binding.json')),
    trialSummarySha256:hash(resolve(out,'trial/summary.json')),games:t.games,primary:t.primary,outcomes:t.outcomes,positiveJointEvidence:t.positiveJointEvidence,
    mechanismReplicated:p.discoveryPrimary.mechanism.ci95[0]>0&&t.primary.mechanism.ci95[0]>0,
    discoveryPrimary:p.discoveryPrimary,newUniqueTrainingHands:0,newUniqueValidationHands:0,optimizationUpdates:0,productionPolicy:'H0'};
}
export function checkSummary(out){const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json'));assert.deepEqual(s,summaryFor(out,p));return {p,s};}
