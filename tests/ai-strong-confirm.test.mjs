import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {run as trainFixture} from '../ai/strong-pool/study.mjs';
import {verify as verifyFixture} from '../ai/strong-pool/verify-stream.mjs';
import {read,hash} from '../ai/strong-pool/config.mjs';
import {save} from '../ai/tile-q/collect.mjs';
import {auditGroup} from '../ai/strong-pool/evaluate.mjs';
import {classify,makePlan,check,jobsFor,run,aggregate} from '../ai/strong-confirm/study.mjs';
import {verify} from '../ai/strong-confirm/verify.mjs';

test('confirmation requires a full positive interval and cannot treat zero boundaries as success',()=>{
  assert.equal(classify({ci95:[1,2]}),'positive');assert.equal(classify({ci95:[-2,-1]}),'negative');
  for(const ci95 of [[-1,1],[0,2],[-2,0]])assert.equal(classify({ci95}),'inconclusive');
});
test('fixed-checkpoint confirmation preserves old protocol, uses fresh openings, audits every episode and rejects tampering',async()=>{
  mkdirSync('.tmp/strong-confirm-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/strong-confirm-tests/run-')),previous=resolve(root,'previous'),out=resolve(root,'confirmation');
  await trainFixture({out:previous,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,
    evaluationGroups:1,bootstrapSamples:30,bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});
  await verifyFixture({out:previous});const original=read(resolve(previous,'plan.json')),old=read(resolve(previous,'summary.json'));
  const options={previous,evaluationGroups:1,bootstrapSamples:30,workers:2},p=makePlan(options);check(p);
  assert.notEqual(p.seed,makePlan(options).seed);assert.equal(p.model.sha256,old.models.offline.sha256);
  assert.deepEqual(p.protocolPlan.sources,original.sources);assert.deepEqual(p.protocolPlan.network,original.network);assert.equal(jobsFor(p).length,3);
  assert.ok(jobsFor(p).every(j=>j.arm==='offline'));
  assert.throws(()=>check({...p,model:{...p.model,sha256:'wrong'}}));
  assert.throws(()=>check({...p,protocolPlan:{...p.protocolPlan,seeds:{...p.protocolPlan.seeds,evaluation:'altered'}}}));
  assert.throws(()=>check({...p,previous:{...p.previous,summarySha256:'wrong'}}));
  const s=await run({out,...options});assert.equal(s.games,36);assert.equal(s.trainingHands,0);assert.equal(s.validationHands,0);assert.equal(s.productionPolicy,'H0');
  const plan=read(resolve(out,'plan.json')),groups=jobsFor(plan).map(j=>read(resolve(out,'groups',j.id,'group.json')));
  assert.deepEqual(s.evaluation,aggregate(plan,groups));assert.throws(()=>aggregate(plan,groups.slice(1)));
  assert.ok(groups.every(g=>!old.evaluations.offline.records.some(r=>r.seed===g.record.seed)));
  const v=await verify({out});assert.equal(v.games,36);assert.equal(v.groups.length,3);assert.equal(v.checkpointSha256,old.models.offline.sha256);
  assert.ok(v.groups.every(g=>g.allEpisodesRedealtAndExactTracesMatched));assert.equal(v.planSha256,hash(resolve(out,'plan.json')));
  const job=jobsFor(plan)[0],path=resolve(out,'groups',job.id),g=read(resolve(path,'group.json'));g.record.candidate.score++;save(resolve(path,'group.json'),g);
  await assert.rejects(auditGroup({path,plan:plan.protocolPlan,job,checkpoint:plan.model.path}));
  await assert.rejects(run({out,...options}),/exists/);await assert.rejects(verify({out}),/exists/);
});
