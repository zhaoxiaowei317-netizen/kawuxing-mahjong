import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {runEvaluation} from '../runner.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {summarizePaired} from '../statistics.mjs';
import {deriveSeed} from '../random.mjs';
import {worker} from '../tile-q/study.mjs';
import {check,hash,read,factories,ARMS,pooled} from './config.mjs';

export function jobsFor(p){return ARMS.flatMap(arm=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.evaluationGroups},(_,group)=>({id:`${arm}-${i}-${String(group).padStart(3,'0')}`,arm,pair,group}))));}
export const jobSeed=(p,j)=>deriveSeed(p.seeds.evaluation,j.pair.id,j.group);
export async function replayGroup({plan:p,job:j,checkpoint,onEpisode}){
  check(p);assert.deepEqual(j,jobsFor(p).find(x=>x.id===j.id));const model=loadQ(checkpoint).model;
  return runEvaluation({candidate:'learner',incumbent:p.incumbent,policyFactories:factories(model),seed:jobSeed(p,j),split:'sealed',
    independentGroups:0,sessionGroups:1,sessionHands:p.budget.sessionHands,opponentPairs:[j.pair],bootstrapSamples:1,onEpisode});
}
export async function playGroup({out,plan,job,checkpoint}){
  out=resolve(out);if(existsSync(out))throw Error('Group output exists');mkdirSync(out,{recursive:true});
  const file=resolve(out,'replays.jsonl.gz');writeFileSync(file,gzipSync(''));
  const r=await replayGroup({plan,job,checkpoint,onEpisode:e=>appendFileSync(file,gzipSync(JSON.stringify(e)+'\n'))});check(plan);
  const result={job,checkpoint:resolve(checkpoint),checkpointSha256:loadQ(checkpoint).sha256,replaysSha256:hash(file),
    record:r.records[0],games:r.totalGames,decisions:r.totalDecisions,seconds:r.seconds,seed:jobSeed(plan,job)};
  save(resolve(out,'group.json'),result);return result;
}
export function aggregate(p,groups){
  assert.deepEqual(groups.map(g=>g.job.id).sort(),jobsFor(p).map(j=>j.id).sort());
  return Object.fromEntries(ARMS.map(arm=>{
    const picked=jobsFor(p).filter(j=>j.arm===arm).map(j=>groups.find(g=>g.job.id===j.id));
    const records=picked.map(g=>g.record),statistics=summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seeds.evaluation,'bootstrap'),base:1});
    return [arm,{records,statistics,games:picked.reduce((n,g)=>n+g.games,0)}];
  }));
}
export async function evaluate({out,plan,models,onProgress=()=>{}}){
  const jobs=jobsFor(plan),groups=[];mkdirSync(resolve(out,'groups'));mkdirSync(resolve(out,'.evaluation'));
  await pooled(jobs,plan.budget.workers,async job=>{
    const spec=resolve(out,'.evaluation',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan,job,checkpoint:models[job.arm].path});
    await worker(process.execPath,[fileURLToPath(import.meta.url),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));
    onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:jobs.length,games:groups.reduce((n,g)=>n+g.games,0)});
  });return aggregate(plan,groups);
}
export async function auditGroup({path,plan,job,checkpoint}){
  const g=read(resolve(path,'group.json')),file=resolve(path,'replays.jsonl.gz');
  assert.deepEqual(g.job,job);assert.equal(g.checkpoint,resolve(checkpoint));assert.equal(g.checkpointSha256,loadQ(checkpoint).sha256);assert.equal(g.replaysSha256,hash(file));
  const episodes=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let i=0;
  const r=await replayGroup({plan,job,checkpoint,onEpisode:e=>assert.deepEqual(e,episodes[i++])});
  assert.equal(i,episodes.length);assert.equal(i,r.totalGames);assert.deepEqual(g.record,r.records[0]);assert.equal(g.decisions,r.totalDecisions);
  assert.equal(g.games,r.totalGames);assert.equal(g.seed,jobSeed(plan,job));
  return {jobId:job.id,games:r.totalGames,allEpisodesRedealtAndExactTracesMatched:true,groupSha256:hash(resolve(path,'group.json')),replaysSha256:hash(file)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const audit=process.argv[2]==='audit',spec=read(process.argv[audit?3:2]);
  (audit?auditGroup(spec).then(r=>save(spec.result,r)):playGroup(spec)).then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
