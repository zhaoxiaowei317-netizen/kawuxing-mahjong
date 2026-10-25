import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {sha256,projectRoot,verifyFrozenBaseline} from '../provenance.mjs';
import {sources as previousSources} from '../reveal-study/study.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker,parallel} from '../tile-q/study.mjs';
import {deriveSeed} from '../random.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {summarizePaired} from '../statistics.mjs';
import {COHORTS,PAIRS,CANDIDATE} from './policies.mjs';

export const VERSION='kwx-reveal-generalization-1';
export const hash=p=>sha256(readFileSync(p)),read=p=>JSON.parse(readFileSync(p,'utf8'));
export function sources(){return {previous:previousSources(),driver:Object.fromEntries(['policies.mjs','groups.mjs','study.mjs','verify.mjs'].map(p=>[p,hash(new URL(p,import.meta.url))]))};}
export function check(p){assert.equal(p.version,VERSION);assert.deepEqual(p.sources,sources());assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.baseline,verifyFrozenBaseline());
  assert.equal(p.candidate,CANDIDATE);assert.equal(loadQ(p.checkpoint).sha256,p.checkpointSha256);
  if(p.previous)for(const name of ['plan','summary','verification'])assert.equal(hash(resolve(p.previous.path,name+'.json')),p.previous[name+'Sha256']);}
export function jobsFor(p){return COHORTS.flatMap(cohort=>p.pairs[cohort].flatMap((pair,pairIndex)=>Array.from({length:p.budget[cohort+'Groups']},(_,group)=>
  ({id:`${cohort}-${pairIndex}-${String(group).padStart(3,'0')}`,cohort,pair,group}))));}
export function jobSeed(p,job){
  assert.ok(COHORTS.includes(job.cohort));assert.deepEqual(job.pair,p.pairs[job.cohort].find(x=>x.id===job.pair.id));
  assert.ok(Number.isInteger(job.group)&&job.group>=0&&job.group<p.budget[job.cohort+'Groups']);
  return deriveSeed(PROTOCOL_VERSION,'sealed',p.seeds[job.cohort],'session',job.pair.id,job.group);
}
export async function pooled(jobs,concurrency,fn){let next=0;await parallel(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{while(next<jobs.length)await fn(jobs[next++]);}));}
export function aggregate(p,groups){
  assert.deepEqual(groups.map(g=>g.job.id).sort(),jobsFor(p).map(j=>j.id).sort());
  return Object.fromEntries(COHORTS.map(cohort=>{
    const selected=jobsFor(p).filter(j=>j.cohort===cohort).map(j=>groups.find(g=>g.job.id===j.id));
    const records=selected.map(g=>g.record),statistics=summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seeds[cohort],'bootstrap'),base:1});
    return [cohort,{records,statistics,games:selected.reduce((s,g)=>s+g.games,0),decisions:selected.reduce((s,g)=>s+g.decisions,0)}];
  }));
}
export async function run({out,previous=null,checkpoint=null,replicationGroups=16,stressGroups=4,sessionHands=16,bootstrapSamples=5000,workers=4,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');
  let origin=null;if(previous){previous=resolve(previous);const s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json')),p=read(resolve(previous,'plan.json'));
    assert.equal(s.selected,CANDIDATE);assert.equal(s.games,v.games);assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));
    assert.deepEqual(p.sources,previousSources());assert.deepEqual(v.sources,p.sources);assert.equal(v.planSha256,s.planSha256);assert.equal(s.positiveSealedEvidence,true);
    origin={path:previous,...Object.fromEntries(['plan','summary','verification'].map(n=>[n+'Sha256',hash(resolve(previous,n+'.json'))]))};checkpoint=checkpoint||p.checkpoint;}
  const loaded=loadQ(checkpoint),budget={replicationGroups,stressGroups,sessionHands,bootstrapSamples,workers};
  for(const n of Object.values(budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(workers<=16);
  const nonce=randomBytes(32).toString('hex'),p={version:VERSION,createdAt:new Date().toISOString(),baseline:verifyFrozenBaseline(),sources:sources(),
    checkpoint:resolve(checkpoint),checkpointSha256:loaded.sha256,previous:origin,candidate:CANDIDATE,pairs:PAIRS,budget,
    seeds:Object.fromEntries(COHORTS.map(c=>[c,deriveSeed(VERSION,nonce,c)])),
    primary:'The frozen h0-never candidate vs H0 in the original two opponent pairs on fresh 16-hand sessions. Confirm replication only if the full two-sided 95% paired-group interval is above zero.',
    secondary:'Five fixed stress opponent pairs are an equally weighted secondary descriptive pool. The pool and each subgroup are not adjusted for multiple comparisons and do not establish universal strength.',
    parallelism:'Each job is one complete opening-seed group with all six seat permutations, both arms and all session hands. The frozen paired-v1 dealing and policy seeds are unchanged. No group is split for bootstrap.',
    stopping:'Run both full budgets regardless of interim results. No candidate selection, no tuning, no new training, no automatic promotion; default H0 remains.'};
  mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'groups'));mkdirSync(resolve(out,'.specs'));save(resolve(out,'plan.json'),p);check(p);
  const jobs=jobsFor(p),results=[];onProgress({stage:'plan',budget,groups:jobs.length});
  await pooled(jobs,workers,async job=>{
    const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p,job});
    await worker(process.execPath,[resolve(projectRoot,'ai/reveal-generalization/groups.mjs'),spec]);
    const g=read(resolve(out,'groups',job.id,'group.json'));results.push(g);
    onProgress({stage:'evaluation',cohort:job.cohort,pair:job.pair.id,completedGroups:results.length,totalGroups:jobs.length,games:results.reduce((n,g)=>n+g.games,0)});
  });
  check(p);const cohorts=aggregate(p,results),s={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),cohorts,
    games:results.reduce((n,g)=>n+g.games,0),trainingHands:0,productionPolicy:'H0',positiveReplication:cohorts.replication.statistics.session.overall.ci95[0]>0};
  save(resolve(out,'summary.json'),s);onProgress({stage:'complete',games:s.games});return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
 .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
