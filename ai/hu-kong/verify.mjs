import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {simulate} from './groups.mjs';
import {aggregate} from './study.mjs';
import {check,jobsFor,read,hash} from './config.mjs';
export async function auditGroup({path,plan:p,job,models}){
  check(p);const file=resolve(path,'replays.jsonl.gz'),g=read(resolve(path,'group.json'));assert.equal(g.replaysSha256,hash(file));
  const saved=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let index=0;
  const r=await simulate({plan:p,job,models,cacheCapacity:0,onEpisode:e=>assert.deepEqual(e,saved[index++])});assert.equal(index,saved.length);
  const {cacheMetrics, ...expected}=g,{cacheMetrics:unused,...actual}=r;assert.deepEqual(expected,{...actual,replaysSha256:hash(file)});
  assert.equal(unused.hits,0);
  return {jobId:job.id,games:g.games,allEpisodesRedealtAndPoliciesAndExactTracesMatched:true,cacheDisabled:true,
    replaysSha256:hash(file),groupSha256:hash(resolve(path,'group.json')),uncachedMetrics:unused};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(s.version,p.version);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.deepEqual(models,p.models);assert.deepEqual(s.models,p.models);
  assert.equal(s.productionPolicy,'H0');assert.equal(s.newUniqueTrainingHands,0);assert.equal(s.newUniqueValidationHands,0);
  const jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,groups));
  assert.equal(s.games,s.evaluation.games);assert.equal(s.games,3*p.budget.groupsPerPair*24*p.budget.sessionHands);
  assert.deepEqual(s.primary,Object.fromEntries(['mechanism','strength'].map(k=>[k,s.evaluation.contrasts[k].statistics.session.overall])));
  assert.deepEqual(s.outcomes,Object.fromEntries(Object.entries(s.primary).map(([k,x])=>[k,x.ci95[0]>0?'positive':x.ci95[1]<0?'negative':'inconclusive'])));
  assert.equal(s.positiveJointEvidence,Object.values(s.outcomes).every(x=>x==='positive'));
  for(const g of groups){assert.equal(g.components.patched.conflicts,g.components.patched.overrides);assert.equal(g.components.base.overrides,0);}
  const work=resolve(out,'.audit');if(existsSync(work))throw Error('Audit directory exists');mkdirSync(work);const audited=[];
  await pooled(jobs,p.budget.workers,async job=>{
    const spec=resolve(work,job.id+'.json'),result=resolve(work,job.id+'.result.json');save(spec,{path:resolve(out,'groups',job.id),plan:p,job,models,result});
    await worker(process.execPath,[fileURLToPath(import.meta.url),'group',spec]);audited.push(read(result));onProgress({stage:'audit',completedGroups:audited.length,totalGroups:jobs.length});
  });assert.equal(audited.reduce((n,g)=>n+g.games,0),s.games);check(p);
  const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,sourceMap:p.sourceMap,games:s.games,
    allGroupsRecomputedWithoutScoreCache:true,groups:audited.sort((a,b)=>a.jobId.localeCompare(b.jobId))};save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const task=process.argv[2]==='group'?auditGroup(read(process.argv[3])).then(r=>save(read(process.argv[3]).result,r)):
    verify({out:process.argv[2],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
