import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {projectRoot} from '../provenance.mjs';
import {deriveSeed} from '../random.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {summarizePaired} from '../statistics.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {read,hash,PAIRS,N,pooled} from '../strong-pool/config.mjs';
import {check as oldCheck,sources as oldSources,classify} from '../strong-confirm/study.mjs';
import {ARMS,GUARDED,RAW} from './policy.mjs';

export const VERSION='kwx-outs-guard-1';
export const CONTRASTS=Object.freeze({component:'raw',strength:'reference'});
export function sources(){return {previous:oldSources(),driver:Object.fromEntries(['policy.mjs','study.mjs','groups.mjs','verify.mjs'].map(n=>[n,hash(new URL(n,import.meta.url))]))};}
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sources,sources());assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.arms,ARMS);
  assert.deepEqual(p.contrasts,CONTRASTS);assert.deepEqual(p.policies,{guarded:GUARDED,raw:RAW,reference:N});
  for(const n of ['plan','summary','verification','action-diagnostics'])assert.equal(hash(resolve(p.previous.path,n+'.json')),p.previous[n+'Sha256']);
  const old=read(resolve(p.previous.path,'plan.json'));oldCheck(old);assert.deepEqual(p.model,old.model);
  assert.equal(loadQ(p.model.path).sha256,p.model.sha256);assert.equal(hash(p.model.state),p.modelStateSha256);assert.equal(p.modelStateSha256,old.modelStateSha256);
  for(const n of Object.values(p.budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(p.budget.workers<=8);
  assert.equal(p.budget.sessionHands,old.budget.sessionHands);assert.notEqual(p.seed,old.seed);
}
export function makePlan({previous,groupsPerPair=16,bootstrapSamples=5000,workers=4}){
  previous=resolve(previous);const old=read(resolve(previous,'plan.json')),s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json'));
  oldCheck(old);assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);assert.deepEqual(v.sources,old.sources);
  const diagnostic=read(resolve(previous,'action-diagnostics.json'));assert.equal(diagnostic.planSha256,s.planSha256);assert.equal(diagnostic.checkpointSha256,old.model.sha256);
  const p={version:VERSION,createdAt:new Date().toISOString(),sources:sources(),previous:{path:previous,
    ...Object.fromEntries(['plan','summary','verification','action-diagnostics'].map(n=>[n+'Sha256',hash(resolve(previous,n+'.json'))])),primary:s.primary},
    model:old.model,modelStateSha256:old.modelStateSha256,pairs:PAIRS,arms:ARMS,policies:{guarded:GUARDED,raw:RAW,reference:N},contrasts:CONTRASTS,
    budget:{groupsPerPair,bootstrapSamples,workers,sessionHands:old.budget.sessionHands},seed:deriveSeed(VERSION,randomBytes(32).toString('hex'),'sealed'),
    intervention:'One fixed public-outs frontier: preserve raw Q action type, discard reveal flag and post-discard distance; among same-distance/same-reveal legal discards maximize public improving copies, then take highest original full-mask Q. Non-discards unchanged. No teacher selector in the guard.',
    primary:'Guarded vs unchanged raw checkpoint net-score difference, three equally weighted opponent pairs, paired complete-group two-sided 95% bootstrap interval entirely above zero.',
    secondary:'Guarded vs h0-never, opponent subgroups and behavior are descriptive without multiplicity correction. Guarded trajectory is shared across contrasts, not independent repeated evidence.',
    independence:'Fresh seed root, no tuning, development selection, training, threshold search or pooling with old batches. One group includes all six seats, three separate policy trajectories and real continuous dealers.',
    stopping:'Complete every fixed group regardless of interim results. No extra games or automatic promotion. Any gain is a strategy-component effect with frozen weights, not new neural learning. Production H0.'};check(p);return p;
}
export function jobsFor(p){return p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));}
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seed,'session',j.pair.id,j.group);
export function aggregate(p,groups){
  const jobs=jobsFor(p);assert.deepEqual(groups.map(g=>g.job.id).sort(),jobs.map(j=>j.id).sort());
  const ordered=jobs.map(j=>{const g=groups.find(g=>g.job.id===j.id);assert.deepEqual(g.job,j);assert.equal(g.checkpointSha256,p.model.sha256);
    assert.equal(g.groupSeed,jobSeed(p,j));assert.equal(g.games,18*p.budget.sessionHands);return g;});
  const contrasts=Object.fromEntries(Object.entries(CONTRASTS).map(([name,control])=>{
    const records=ordered.map(g=>({suite:'session',opponentPair:g.record.opponentPair,seed:g.record.seed,candidate:g.record.arms.guarded,incumbent:g.record.arms[control]}));
    return [name,{records,statistics:summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seed,'bootstrap',name),base:1})}];
  }));
  return {contrasts,games:ordered.reduce((n,g)=>n+g.games,0),intervention:Object.fromEntries(Object.keys(ordered[0].intervention).map(k=>[k,ordered.reduce((n,g)=>n+g.intervention[k],0)]))};
}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');const p=makePlan(options);
  mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'groups'));mkdirSync(resolve(out,'.specs'));save(resolve(out,'plan.json'),p);
  const jobs=jobsFor(p),groups=[];onProgress({stage:'plan',budget:p.budget,groups:jobs.length});
  await pooled(jobs,p.budget.workers,async job=>{
    check(p);const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p,job});
    await worker(process.execPath,[resolve(projectRoot,'ai/outs-guard/groups.mjs'),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));
    onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:jobs.length,games:groups.reduce((n,g)=>n+g.games,0)});
  });check(p);const evaluation=aggregate(p,groups),primary=evaluation.contrasts.component.statistics.session.overall;
  const s={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),checkpointSha256:p.model.sha256,evaluation,
    primary,outcome:classify(primary),positivePrimaryEvidence:classify(primary)==='positive',games:evaluation.games,trainingHands:0,validationHands:0,productionPolicy:'H0'};
  save(resolve(out,'summary.json'),s);onProgress({stage:'complete',games:s.games,outcome:s.outcome});return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
