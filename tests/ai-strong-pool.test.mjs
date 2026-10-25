import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {save} from '../ai/tile-q/collect.mjs';
import {TABLES,N,rolesFor,read,hash,sources} from '../ai/strong-pool/config.mjs';
import {collect,load} from '../ai/strong-pool/collect.mjs';
import {makePlan,run} from '../ai/strong-pool/study.mjs';
import {verify,verifyData} from '../ai/strong-pool/verify.mjs';
import {auditGroup,jobsFor} from '../ai/strong-pool/evaluate.mjs';

test('mixed-teacher schedule rotates fixed tables, with never/H0/greedy at every seat and a stronger primary control',()=>{
  const counts=[{},{},{}];
  for(let session=0;session<12;session++){
    const first=rolesFor(session*16,16);assert.deepEqual(rolesFor(session*16+15,16),first);
    first.forEach((r,i)=>counts[i][r.id]=(counts[i][r.id]||0)+1);
  }
  for(const count of counts)assert.deepEqual(count,{[N]:7,H0:4,'greedy-speed-v1':1});
  assert.equal(TABLES.length,4);const p=makePlan({trainingHands:24,validationHands:12,trainingSessionHands:1,workers:2});
  assert.equal(p.primaryArm,'offline');assert.equal(p.incumbent,N);assert.equal(p.pairs.length,3);
  assert.notDeepEqual(makePlan({trainingHands:24,validationHands:12,trainingSessionHands:1,workers:2}).seeds,p.seeds);
  assert.throws(()=>makePlan({trainingHands:23,trainingSessionHands:1,workers:2}),/whole sessions/);
});
test('strong-pool pipeline trains real mixed data, preserves shard traces, audits full evaluation and rejects altered teacher or score',async()=>{
  mkdirSync('.tmp/strong-pool-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/strong-pool-tests/run-')),out=resolve(root,'study');
  const s=await run({out,trainingHands:24,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,
    evaluationGroups:1,bootstrapSamples:30,bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});
  assert.equal(s.games,72);assert.equal(s.trainingHands,24);assert.equal(s.productionPolicy,'H0');
  const p=read(resolve(out,'plan.json')),models=read(resolve(out,'models.json')),d=load(resolve(out,'training'),'training');
  assert.ok(Object.keys(d.manifest.teachers).includes(N));assert.equal(d.manifest.behaviorVersion,p.version);assert.deepEqual(p.sources,sources());
  const serial=resolve(root,'serial');await collect({out:serial,hands:24,seed:p.seeds.training,sessionHands:1,epsilon:p.epsilon});
  assert.deepEqual(load(serial,'training').episodes,d.episodes);
  const groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));
  for(let i=0;i<3;i++)assert.deepEqual(groups[i].record.incumbent,groups[i+3].record.incumbent,'Repeated control is the same trajectory, not independent evidence');
  const v=await verify({out});assert.equal(v.games,72);assert.equal(v.snapshotsVerified,4);assert.equal(v.data.training.hands,24);assert.equal(v.data.validation.hands,12);
  assert.ok(v.parity.bc.maxError<.0001);assert.equal(v.groups.length,6);
  const altered=resolve(root,'altered');mkdirSync(altered);const e=d.episodes;
  const row=e.flatMap(x=>x.rows).find(r=>r.legalIds.length>1);row.teacherId=row.legalIds.find(id=>id!==row.teacherId);
  writeFileSync(resolve(altered,'episodes.jsonl.gz'),gzipSync(e.map(x=>JSON.stringify(x)).join('\n')+'\n'));
  save(resolve(altered,'manifest.json'),{...d.manifest,sha256:hash(resolve(altered,'episodes.jsonl.gz'))});
  await assert.rejects(verifyData({path:altered,split:'training'}));
  const job=jobsFor(p)[0],path=resolve(out,'groups',job.id),g=read(resolve(path,'group.json'));g.record.candidate.score++;
  save(resolve(path,'group.json'),g);await assert.rejects(auditGroup({path,plan:p,job,checkpoint:models[job.arm].path}));
  await assert.rejects(run({out}),/exists/);await assert.rejects(verify({out}),/exists/);
});
