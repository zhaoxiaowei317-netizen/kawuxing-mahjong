import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {collect,save} from '../ai/tile-q/collect.mjs';
import {sources} from '../ai/tile-q/sources.mjs';
import {SCHEMA} from '../ai/tile-q/encoding.mjs';
import {worker} from '../ai/tile-q/study.mjs';
import {loadQ} from '../ai/tile-q/model.mjs';
import {MahjongEnvironment,actionKey} from '../ai/environment.mjs';
import {runEvaluation} from '../ai/runner.mjs';
import {policyById} from '../ai/policies/index.mjs';
import {selector,factories,PAIRS,CANDIDATE} from '../ai/reveal-generalization/policies.mjs';
import {run,jobsFor,jobSeed,read} from '../ai/reveal-generalization/study.mjs';
import {verify,auditGroup} from '../ai/reveal-generalization/verify.mjs';

test('stress pool includes concealed, selective and neural opponents without changing built-ins',()=>{
  assert.equal(PAIRS.replication.length,2);assert.equal(PAIRS.stress.length,5);
  assert.ok(PAIRS.stress.some(p=>p.policies.every(id=>id===CANDIDATE)));
  assert.ok(PAIRS.stress.some(p=>p.policies.includes('h0-q-gate')));assert.ok(PAIRS.stress.some(p=>p.policies.includes('q-reference')));
  const env=new MahjongEnvironment({seed:'generalization-policy-contract',record:false}),o=env.observation(),legal=env.legalActions();
  for(const id of ['H0','greedy-speed-v1'])assert.equal(actionKey(selector(id,null)(o,legal)),actionKey(policyById(id)(o,legal)));
  assert.throws(()=>selector('unknown',null));
});
test('parallel full seed groups match original serial protocol and all records survive an independent audit',async()=>{
  mkdirSync('.tmp/reveal-generalization-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/reveal-generalization-tests/run-'));
  const training=resolve(root,'training'),validation=resolve(root,'validation');
  await collect({out:training,hands:8,seed:'generalization-training'});await collect({out:validation,hands:4,seed:'generalization-validation',split:'validation'});
  const spec=resolve(root,'train.json');save(spec,{out:resolve(root,'model'),schema:SCHEMA,sources:sources(),seed:'generalization-model',trainingData:training,validationData:validation,
    network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true},config:{learningRate:.001,batchSize:32,maxGradNorm:5,cqlWeight:.05,bcWeight:.1,auxWeight:.1},mode:'q',epochs:1});
  await worker('python',[resolve('ai/tile-q/train.py'),spec]);const checkpoint=read(resolve(root,'model/summary.json')).selected.path,out=resolve(root,'study');
  const s=await run({out,checkpoint,replicationGroups:1,stressGroups:1,sessionHands:2,bootstrapSamples:30,workers:2});
  assert.equal(s.games,168);assert.equal(s.trainingHands,0);assert.equal(s.productionPolicy,'H0');
  const p=read(resolve(out,'plan.json')),jobs=jobsFor(p);assert.equal(jobs.length,7);assert.equal(new Set(jobs.map(j=>jobSeed(p,j))).size,7);
  const episodes=[],model=loadQ(checkpoint).model;
  const serial=await runEvaluation({candidate:CANDIDATE,incumbent:'H0',seed:p.seeds.replication,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:2,
    opponentPairs:p.pairs.replication,bootstrapSamples:30,policyFactories:factories(model),onEpisode:e=>episodes.push(e)});
  assert.deepEqual(s.cohorts.replication.records,serial.records);assert.deepEqual(s.cohorts.replication.statistics,serial.statistics);
  const parallelEpisodes=jobs.filter(j=>j.cohort==='replication').flatMap(j=>gunzipSync(readFileSync(resolve(out,'groups',j.id,'replays.jsonl.gz'))).toString('utf8').trim().split('\n').filter(Boolean).map(line=>{
    const {cohort,...e}=JSON.parse(line);return e;
  }));assert.deepEqual(parallelEpisodes,episodes);
  const v=await verify({out});assert.equal(v.games,168);assert.equal(v.groups.length,7);
  assert.ok(v.groups.every(g=>g.allGamesRedealtAndPolicyRecomputed&&g.diagnostics.candidate.huDeclined===0));
  const first=jobs[0],tampered=resolve(root,'tampered');mkdirSync(tampered);
  copyFileSync(resolve(out,'groups',first.id,'replays.jsonl.gz'),resolve(tampered,'replays.jsonl.gz'));
  const g=read(resolve(out,'groups',first.id,'group.json'));g.record.candidate.score++;save(resolve(tampered,'group.json'),g);
  await assert.rejects(auditGroup({path:tampered,plan:p,job:first}));
  await assert.rejects(run({out,checkpoint}),/exists/);await assert.rejects(verify({out}),/exists/);
});
