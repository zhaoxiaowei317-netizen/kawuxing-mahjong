import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {runEvaluation} from '../ai/runner.mjs';
import {loadQ} from '../ai/tile-q/model.mjs';
import {save} from '../ai/tile-q/collect.mjs';
import {worker} from '../ai/tile-q/study.mjs';
import {read,N} from '../ai/strong-pool/config.mjs';
import {run as trainFixture} from '../ai/strong-pool/study.mjs';
import {verify as verifyTraining} from '../ai/strong-pool/verify-stream.mjs';
import {run as confirmFixture} from '../ai/strong-confirm/study.mjs';
import {verify as verifyConfirmation} from '../ai/strong-confirm/verify.mjs';
import {diagnose} from '../ai/strong-confirm/diagnose.mjs';
import {run as guardFixture} from '../ai/outs-guard/study.mjs';
import {verify as verifyGuard} from '../ai/outs-guard/verify.mjs';
import {run as distillFixture} from '../ai/outs-distill/study.mjs';
import {verify as verifyDistill} from '../ai/outs-distill/verify.mjs';

import {run as anchorFixture} from '../ai/outs-anchor/study.mjs';
import {verify as verifyAnchor} from '../ai/outs-anchor/verify.mjs';
import {makePlan,check,jobsFor,trainSpec,sourceMap,NEURAL} from '../ai/outs-duration/config.mjs';
import {run,aggregate,prefix} from '../ai/outs-duration/study.mjs';
import {factories} from '../ai/outs-duration/groups.mjs';
import {verify,auditGroup} from '../ai/outs-duration/verify.mjs';

test('duration prefix rejects Adam reset and tiny parameter changes',async()=>{
  await worker('python',['tests/test_outs_duration.py']);
});

test('duration study preserves full optimizer prefix and tests four frozen policies on fresh audited groups',async()=>{
  mkdirSync('.tmp/outs-duration-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/outs-duration-tests/run-')),
    training=resolve(root,'training'),confirmation=resolve(root,'confirmation'),guard=resolve(root,'guard'),previous=resolve(root,'distill'),anchor=resolve(root,'anchor'),out=resolve(root,'duration');
  await trainFixture({out:training,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});await verifyTraining({out:training});
  await confirmFixture({out:confirmation,previous:training,evaluationGroups:1,bootstrapSamples:30,workers:2});await verifyConfirmation({out:confirmation});diagnose({out:confirmation});
  await guardFixture({out:guard,previous:confirmation,groupsPerPair:1,bootstrapSamples:30,workers:2});await verifyGuard({out:guard});
  await distillFixture({out:previous,previous:guard,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDistill({out:previous});

  await anchorFixture({out:anchor,previous,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyAnchor({out:anchor});
  const options={previous:anchor,epochs:2,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30},p=makePlan(options);check(p);
  assert.deepEqual(p.sourceMap,sourceMap());assert.notEqual(p.seed,makePlan(options).seed);
  assert.throws(()=>check({...p,budget:{...p.budget,epochs:1}}));assert.throws(()=>check({...p,primary:'changed after results'}));
  const prior=read(resolve(anchor,'train-plain.json')),spec=trainSpec(out,p);
  for(const k of ['trainingData','validationData','initialize','seed','config'])assert.deepEqual(spec[k],prior[k]);
  const s=await run({out,...options});assert.equal(s.games,72);assert.equal(s.newUniqueTrainingHands,0);assert.equal(s.newUniqueValidationHands,0);assert.equal(s.productionPolicy,'H0');
  const plan=read(resolve(out,'plan.json')),models=read(resolve(out,'models.json')),jobs=jobsFor(plan),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));
  assert.deepEqual(s.evaluation,aggregate(plan,models,groups));assert.throws(()=>aggregate(plan,models,groups.slice(1)));
  assert.deepEqual(models.short,read(resolve(anchor,'models.json')).plain);assert.equal(groups.find(g=>g.job.pair.id==='never+never').record.arms.reference.score,0);
  const loaded=Object.fromEntries(NEURAL.map(k=>[k,loadQ(models[k].path).model])),saved=gunzipSync(readFileSync(resolve(out,'groups',jobs[0].id,'replays.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  for(const control of ['short','raw','reference']){const expected=[],original=await runEvaluation({candidate:'long',incumbent:control==='reference'?N:control,seed:plan.seed,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:1,
    opponentPairs:[jobs[0].pair],bootstrapSamples:30,policyFactories:factories(loaded),onEpisode:e=>expected.push(e)});
    assert.deepEqual(original.records[0].candidate,groups[0].record.arms.long);assert.deepEqual(original.records[0].incumbent,groups[0].record.arms[control]);
    assert.deepEqual(saved.filter(e=>e.arm==='long'||e.arm===control).map(e=>({...e,arm:e.arm==='long'?'candidate':'incumbent'})),expected);
  }
  const v=await verify({out});assert.equal(v.games,72);assert.equal(v.snapshotsVerified,3);assert.equal(v.reusedDataHashesRechecked,true);
  assert.deepEqual(v.prefixAudit.epochs,[0,1]);assert.equal(v.prefixAudit.exactModelAndAdamAndHistory,true);
  const badFile=resolve(out,'model-long/epoch-001.json'),bytes=readFileSync(badFile),bad=JSON.parse(bytes);bad.weights[Object.keys(bad.weights)[0]].values[0]+=1;
  writeFileSync(badFile,JSON.stringify(bad));await assert.rejects(prefix({out,plan}));writeFileSync(badFile,bytes);
  const g=read(resolve(out,'groups',jobs[0].id,'group.json'));g.record.arms.long.score++;save(resolve(out,'groups',jobs[0].id,'group.json'),g);
  await assert.rejects(auditGroup({path:resolve(out,'groups',jobs[0].id),plan,job:jobs[0],models}));
  await assert.rejects(run({out,...options}),/exists/);await assert.rejects(verify({out}),/exists/);
});
