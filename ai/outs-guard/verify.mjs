import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {read,hash,pooled} from '../strong-pool/config.mjs';
import {classify} from '../strong-confirm/study.mjs';
import {simulate} from './groups.mjs';
import {check,jobsFor,aggregate} from './study.mjs';

export async function auditGroup({path,plan,job}){
  check(plan);const file=resolve(path,'replays.jsonl.gz'),g=read(resolve(path,'group.json'));assert.equal(g.replaysSha256,hash(file));
  const episodes=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let count=0;
  const recomputed=await simulate({plan,job,onEpisode:e=>assert.deepEqual(e,episodes[count++])});assert.equal(count,episodes.length);
  assert.deepEqual(g,{...recomputed,replaysSha256:hash(file)});check(plan);
  return {jobId:job.id,games:g.games,allEpisodesRedealtAndExactTracesMatched:true,groupSha256:hash(resolve(path,'group.json')),replaysSha256:hash(file)};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json'));check(p);
  assert.equal(s.version,p.version);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(s.checkpointSha256,p.model.sha256);
  const jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,groups));
  assert.deepEqual(s.primary,s.evaluation.contrasts.component.statistics.session.overall);assert.equal(s.outcome,classify(s.primary));assert.equal(s.positivePrimaryEvidence,s.outcome==='positive');
  assert.equal(s.trainingHands,0);assert.equal(s.validationHands,0);assert.equal(s.productionPolicy,'H0');
  const work=resolve(out,'.audit');if(existsSync(work))throw Error('Audit directory exists');mkdirSync(work);const audited=[];
  await pooled(jobs,p.budget.workers,async job=>{
    const spec=resolve(work,job.id+'.json'),result=resolve(work,job.id+'.result.json');save(spec,{path:resolve(out,'groups',job.id),plan:p,job,result});
    await worker(process.execPath,[fileURLToPath(import.meta.url),'worker',spec]);audited.push(read(result));onProgress({stage:'audit',completedGroups:audited.length,totalGroups:jobs.length,games:audited.reduce((n,g)=>n+g.games,0)});
  });check(p);assert.equal(s.games,audited.reduce((n,g)=>n+g.games,0));assert.equal(s.games,3*p.budget.groupsPerPair*18*p.budget.sessionHands);
  const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,checkpointSha256:p.model.sha256,games:s.games,groups:audited.sort((a,b)=>a.jobId.localeCompare(b.jobId)),sources:p.sources};save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const progress=p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}));const task=process.argv[2]==='worker'?auditGroup(read(process.argv[3])).then(r=>save(read(process.argv[3]).result,r)):verify({out:process.argv[2],onProgress:progress});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
