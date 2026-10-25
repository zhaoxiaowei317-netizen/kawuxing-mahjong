import assert from 'node:assert/strict';
import {mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {projectRoot} from '../provenance.mjs';
import {deriveSeed} from '../random.mjs';
import {summarizePaired} from '../statistics.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {sources as oldSources,check as oldCheck,read,hash,N,PAIRS,pooled} from '../strong-pool/config.mjs';
import {jobsFor as allJobs,jobSeed} from '../strong-pool/evaluate.mjs';

export const VERSION='kwx-strong-confirm-1';
export const classify=r=>r.ci95[0]>0?'positive':r.ci95[1]<0?'negative':'inconclusive';
export function sources(){return {previous:oldSources(),driver:Object.fromEntries(['study.mjs','verify.mjs'].map(n=>[n,hash(new URL(n,import.meta.url))]))};}
const originNames=['plan','summary','verification','models','training'];
export function protocolPlan(previous,budget,seed){return {...previous,budget:{...previous.budget,evaluationGroups:budget.evaluationGroups,
  workers:budget.workers},seeds:{...previous.seeds,evaluation:seed}};}
export function jobsFor(p){return allJobs(p.protocolPlan).filter(j=>j.arm==='offline');}
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sources,sources());assert.equal(p.incumbent,N);assert.deepEqual(p.pairs,PAIRS);
  for(const name of originNames)assert.equal(hash(resolve(p.previous.path,name+'.json')),p.previous[name+'Sha256']);
  const previous=read(resolve(p.previous.path,'plan.json')),s=read(resolve(p.previous.path,'summary.json'));oldCheck(previous);
  assert.equal(s.planSha256,p.previous.planSha256);assert.deepEqual(p.protocolPlan,protocolPlan(previous,p.budget,p.seed));oldCheck(p.protocolPlan);
  assert.deepEqual(p.model,{...s.models.offline,path:resolve(s.models.offline.path),state:resolve(s.models.offline.state)});
  assert.equal(loadQ(p.model.path).sha256,p.model.sha256);assert.equal(hash(p.model.state),loadQ(p.model.path).data.metadata.optimizerStateSha256);
  assert.equal(p.modelStateSha256,hash(p.model.state));assert.equal(p.budget.sessionHands,previous.budget.sessionHands);
  for(const n of Object.values(p.budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(p.budget.workers<=8);
  assert.ok(!Object.values(previous.seeds).includes(p.seed));
}
export function makePlan({previous,evaluationGroups=16,bootstrapSamples=5000,workers=4}){
  previous=resolve(previous);const original=read(resolve(previous,'plan.json')),s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json'));
  oldCheck(original);assert.equal(s.version,'kwx-strong-pool-1');assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));
  assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);assert.deepEqual(v.sources,original.sources);
  if(v.auditExtension)for(const [name,expected]of Object.entries(v.auditExtension.sources))assert.equal(hash(resolve(projectRoot,'ai/strong-pool',name)),expected);
  assert.equal(original.primaryArm,'offline');assert.deepEqual(s.models,read(resolve(previous,'models.json')));
  const trained=read(resolve(previous,'training.json'));assert.deepEqual({...trained.fitted.offline.selected,sha256:s.models.offline.sha256},s.models.offline);
  const budget={evaluationGroups,bootstrapSamples,workers,sessionHands:original.budget.sessionHands};
  for(const n of Object.values(budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(workers<=8);
  const seed=deriveSeed(VERSION,randomBytes(32).toString('hex'),'sealed'),model={...s.models.offline,path:resolve(s.models.offline.path),state:resolve(s.models.offline.state)};
  const p={version:VERSION,createdAt:new Date().toISOString(),sources:sources(),
    previous:{path:previous,...Object.fromEntries(originNames.map(n=>[n+'Sha256',hash(resolve(previous,n+'.json'))])),primary:s.evaluations.offline.statistics.session.overall},
    model,modelStateSha256:hash(model.state),incumbent:N,pairs:PAIRS,budget,seed,protocolPlan:protocolPlan(original,budget,seed),
    primary:'One frozen previous offline checkpoint vs h0-never on fresh paired 16-hand sessions, equally weighted across the three unchanged opponent pairs; positive only when the full two-sided 95% paired-group interval is above zero.',
    secondary:'Opponent subgroups and behavior are descriptive, without multiplicity correction. No alternative model or new teacher selection.',
    independence:'New dealing/policy seeds, same fixed checkpoint and rule set. Tests new-opening generalization, not independent retraining reproducibility. Do not pool with the previous batch to claim significance.',
    stopping:'Run every fixed group regardless of interim scores. No training, checkpoint change, threshold change, extra games, or automatic promotion. Production remains H0.'};check(p);return p;
}
export function aggregate(p,groups){
  const jobs=jobsFor(p);assert.deepEqual(groups.map(g=>g.job.id).sort(),jobs.map(j=>j.id).sort());
  const ordered=jobs.map(j=>{const g=groups.find(g=>g.job.id===j.id);assert.deepEqual(g.job,j);assert.equal(g.checkpointSha256,p.model.sha256);
    assert.equal(g.checkpoint,p.model.path);assert.equal(g.seed,jobSeed(p.protocolPlan,j));assert.equal(g.games,12*p.budget.sessionHands);return g;});
  const records=ordered.map(g=>g.record),old=read(resolve(p.previous.path,'summary.json')).evaluations.offline.records;
  assert.equal(new Set(records.map(r=>r.seed)).size,jobs.length);assert.ok(records.every(r=>!old.some(o=>o.seed===r.seed)));
  return {records,statistics:summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seed,'bootstrap'),base:1}),
    games:ordered.reduce((n,g)=>n+g.games,0),decisions:ordered.reduce((n,g)=>n+g.decisions,0)};
}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Confirmation output exists');
  const p=makePlan(options);mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'groups'));mkdirSync(resolve(out,'.specs'));save(resolve(out,'plan.json'),p);
  const groups=[],jobs=jobsFor(p);onProgress({stage:'plan',budget:p.budget,groups:jobs.length,checkpointSha256:p.model.sha256});
  await pooled(jobs,p.budget.workers,async job=>{
    check(p);const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p.protocolPlan,job,checkpoint:p.model.path});
    await worker(process.execPath,[resolve(projectRoot,'ai/strong-pool/evaluate.mjs'),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));
    onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:jobs.length,games:groups.reduce((n,g)=>n+g.games,0)});
  });check(p);const evaluation=aggregate(p,groups),primary=evaluation.statistics.session.overall;
  const summary={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),checkpointSha256:p.model.sha256,
    evaluation,primary,outcome:classify(primary),positivePrimaryEvidence:classify(primary)==='positive',trainingHands:0,validationHands:0,games:evaluation.games,productionPolicy:'H0'};
  save(resolve(out,'summary.json'),summary);onProgress({stage:'complete',games:summary.games,outcome:summary.outcome});return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
