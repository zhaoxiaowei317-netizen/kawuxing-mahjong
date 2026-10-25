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
import {makePlan,check,jobsFor,trainSpec,sourceMap,NEURAL} from '../ai/outs-anchor/config.mjs';
import {run,aggregate} from '../ai/outs-anchor/study.mjs';
import {factories} from '../ai/outs-anchor/groups.mjs';
import {verify,auditGroup,auditData} from '../ai/outs-anchor/verify.mjs';

test('anchor KL preserves unchanged preferences, permits corrections and masks illegal gradients',async()=>{
  await worker('python',['tests/test_outs_anchor.py']);
});
test('matched anchoring experiment uses one corrected dataset, direct network controls and complete audit',async()=>{
  mkdirSync('.tmp/outs-anchor-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/outs-anchor-tests/run-')),
    training=resolve(root,'training'),confirmation=resolve(root,'confirmation'),guard=resolve(root,'guard'),previous=resolve(root,'distill'),out=resolve(root,'study');
  await trainFixture({out:training,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});await verifyTraining({out:training});
  await confirmFixture({out:confirmation,previous:training,evaluationGroups:1,bootstrapSamples:30,workers:2});await verifyConfirmation({out:confirmation});diagnose({out:confirmation});
  await guardFixture({out:guard,previous:confirmation,groupsPerPair:1,bootstrapSamples:30,workers:2});await verifyGuard({out:guard});
  await distillFixture({out:previous,previous:guard,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDistill({out:previous});
  const options={previous,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30},p=makePlan(options);check(p);
  assert.deepEqual(p.sourceMap,sourceMap());assert.notDeepEqual(p.seeds,makePlan(options).seeds);assert.throws(()=>check({...p,constraint:{...p.constraint,weight:2}}));
  const specs=Object.fromEntries(['anchor','plain'].map(a=>[a,trainSpec(out,p,a)]));
  assert.equal(specs.anchor.trainingData,specs.plain.trainingData);assert.equal(specs.anchor.validationData,specs.plain.validationData);assert.equal(specs.anchor.seed,specs.plain.seed);
  const s=await run({out,...options});assert.equal(s.games,72);assert.equal(s.trainingHands,36);assert.equal(s.productionPolicy,'H0');
  const plan=read(resolve(out,'plan.json')),models=read(resolve(out,'models.json')),jobs=jobsFor(plan),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));
  assert.deepEqual(s.evaluation,aggregate(plan,models,groups));assert.throws(()=>aggregate(plan,models,groups.slice(1)));assert.equal(groups.find(g=>g.job.pair.id==='never+never').record.arms.reference.score,0);
  const loaded=Object.fromEntries(NEURAL.map(k=>[k,loadQ(models[k].path).model])),saved=gunzipSync(readFileSync(resolve(out,'groups',jobs[0].id,'replays.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  for(const control of ['plain','raw','reference']){const expected=[],original=await runEvaluation({candidate:'anchor',incumbent:control==='reference'?N:control,seed:plan.seeds.evaluation,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:1,
    opponentPairs:[jobs[0].pair],bootstrapSamples:30,policyFactories:factories(loaded),onEpisode:e=>expected.push(e)});
    assert.deepEqual(original.records[0].candidate,groups[0].record.arms.anchor);assert.deepEqual(original.records[0].incumbent,groups[0].record.arms[control]);
    assert.deepEqual(saved.filter(e=>e.arm==='anchor'||e.arm===control).map(e=>({...e,arm:e.arm==='anchor'?'candidate':'incumbent'})),expected);
  }
  // With zero anchor weight this trainer must reproduce the frozen plain-BC trainer, including every weight.
  const plainSpec={...read(resolve(out,'train-plain.json')),out:resolve(root,'old-bc'),sources:plan.coreSources,mode:'bc',config:plan.optimizer};save(resolve(root,'old-bc.spec.json'),plainSpec);
  await worker('python',['ai/tile-q/train.py',resolve(root,'old-bc.spec.json')]);
  for(const epoch of ['000','001'])assert.deepEqual(loadQ(resolve(root,'old-bc',`epoch-${epoch}.json`)).data.weights,loadQ(resolve(out,'model-plain',`epoch-${epoch}.json`)).data.weights);
  const v=await verify({out});assert.equal(v.games,72);assert.equal(v.snapshotsVerified,4);assert.equal(v.data.reduce((n,d)=>n+d.hands,0),54);
  const shard=read(resolve(out,'training','canonical','manifest.json')).parts[0],path=resolve(shard,'..'),m=read(resolve(shard,'manifest.json')),bytes=readFileSync(resolve(path,'corrected','episodes.jsonl.gz'));
  writeFileSync(resolve(path,'corrected','episodes.jsonl.gz'),bytes.subarray(0,bytes.length-5));await assert.rejects(auditData({path,plan,split:'training',startHand:m.startHand,hands:m.hands}));writeFileSync(resolve(path,'corrected','episodes.jsonl.gz'),bytes);
  const bad=read(resolve(out,'groups',jobs[0].id,'group.json'));bad.record.arms.anchor.score++;save(resolve(out,'groups',jobs[0].id,'group.json'),bad);
  await assert.rejects(auditGroup({path:resolve(out,'groups',jobs[0].id),plan,job:jobs[0],models}));await assert.rejects(run({out,...options}),/exists/);await assert.rejects(verify({out}),/exists/);
});
