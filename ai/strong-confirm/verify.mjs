import assert from 'node:assert/strict';
import {mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {read,hash,pooled} from '../strong-pool/config.mjs';
import {check,jobsFor,aggregate,classify} from './study.mjs';

export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json'));check(p);
  assert.equal(s.version,p.version);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(s.checkpointSha256,p.model.sha256);
  const jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,groups));
  assert.deepEqual(s.primary,s.evaluation.statistics.session.overall);assert.equal(s.outcome,classify(s.primary));assert.equal(s.positivePrimaryEvidence,s.outcome==='positive');
  assert.equal(s.trainingHands,0);assert.equal(s.validationHands,0);assert.equal(s.productionPolicy,'H0');
  const work=resolve(out,'.audit');if(existsSync(work))throw Error('Audit directory exists');mkdirSync(work);const audited=[];
  await pooled(jobs,p.budget.workers,async job=>{
    check(p);const result=resolve(work,job.id+'.result.json'),spec=resolve(work,job.id+'.json');
    save(spec,{path:resolve(out,'groups',job.id),plan:p.protocolPlan,job,checkpoint:p.model.path,result});
    await worker(process.execPath,[resolve(projectRoot,'ai/strong-pool/evaluate.mjs'),'audit',spec]);audited.push(read(result));
    onProgress({stage:'audit',completedGroups:audited.length,totalGroups:jobs.length,games:audited.reduce((n,r)=>n+r.games,0)});
  });check(p);assert.equal(s.games,audited.reduce((n,r)=>n+r.games,0));assert.equal(s.games,3*p.budget.evaluationGroups*12*p.budget.sessionHands);
  const verification={completedAt:new Date().toISOString(),planSha256:s.planSha256,games:s.games,checkpointSha256:p.model.sha256,
    groups:audited.sort((a,b)=>a.jobId.localeCompare(b.jobId)),sources:p.sources};save(resolve(out,'verification.json'),verification);return verification;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))verify({out:process.argv[2],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
