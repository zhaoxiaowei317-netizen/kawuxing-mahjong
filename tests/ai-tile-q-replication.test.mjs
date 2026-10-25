import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sources} from '../ai/tile-q/sources.mjs';
import {SCHEMA} from '../ai/tile-q/encoding.mjs';
import {collect,save} from '../ai/tile-q/collect.mjs';
import {worker} from '../ai/tile-q/study.mjs';
import {evaluate} from '../ai/tile-q/evaluate.mjs';
import {sha256} from '../ai/provenance.mjs';
import {makePlan,checkPlan,classify,runReplication,verifyReplication} from '../ai/tile-q/replicate.mjs';

test('replication decisions distinguish positive, negative and uncertain intervals',()=>{
  assert.equal(classify({ci95:[1,3]}),'positive');assert.equal(classify({ci95:[-3,-1]}),'negative');
  for(const ci95 of [[-1,3],[0,3],[-1,0]])assert.equal(classify({ci95}),'inconclusive');
});
test('fresh-seed replication freezes both candidates, trains fixed recipe and audits all games',async()=>{
  mkdirSync('.tmp/tile-q-replication-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/tile-q-replication-tests/run-'));
  const previous=resolve(root,'previous');mkdirSync(previous);const out=resolve(root,'replication');
  await collect({out:resolve(previous,'training'),hands:8,seed:'replication-fixture-training'});
  await collect({out:resolve(previous,'validation'),hands:4,seed:'replication-fixture-validation',split:'validation'});
  const network={channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true},optimizer={learningRate:.001,batchSize:32,maxGradNorm:5,cqlWeight:.05,bcWeight:.1,auxWeight:.1};
  const spec=resolve(previous,'train.json');save(spec,{out:resolve(previous,'model'),schema:SCHEMA,sources:sources(),seed:'replication-fixture-model',
    trainingData:resolve(previous,'training'),validationData:resolve(previous,'validation'),network,config:optimizer,mode:'q',epochs:1});
  await worker('python',[resolve('ai/tile-q/train.py'),spec]);const fitted=JSON.parse(readFileSync(resolve(previous,'model/summary.json')));
  const old=await evaluate({out:resolve(previous,'evaluation'),candidate:'fixture-offline',checkpoint:fitted.selected.path,seed:'replication-fixture-evaluation',
    split:'sealed',independentGroups:1,sessionGroups:1,sessionHands:1,bootstrapSamples:30});
  save(resolve(previous,'plan.json'),{sources:sources(),network,optimizer,seeds:{training:'replication-fixture-training',validation:'replication-fixture-validation',model:'replication-fixture-model',sealed:'replication-fixture-evaluation'}});
  save(resolve(previous,'summary.json'),{planSha256:sha256(readFileSync(resolve(previous,'plan.json'))),selected:'tiles-offline',fitted:{'tiles-offline':fitted},
    sealed:{primary:old.statistics.session.overall},games:old.totalGames});
  save(resolve(previous,'verification.json'),{games:old.totalGames,fixture:true});
  const args={previous,initialHands:8,validationHands:4,bcEpochs:1,offlineEpochs:1,independentGroups:1,sessionGroups:1,
    sessionHands:1,trainingSessionHands:1,bootstrapSamples:30};
  const p=makePlan(args);checkPlan(p);const q=makePlan(args);assert.notDeepEqual(q.seeds,p.seeds);
  assert.throws(()=>checkPlan({...p,driverSha256:'wrong'}));
  assert.throws(()=>makePlan({...args,initialHands:7}),/whole sessions/);
  const s=await runReplication({out,...args});assert.equal(s.trainingHands,8);assert.equal(s.games,96);assert.equal(s.productionPolicy,'H0');
  const v=await verifyReplication({out});assert.equal(v.games,96);assert.equal(v.snapshotsVerified,4);
  assert.equal(v.data.training.hands,8);assert.equal(v.data.validation.hands,4);
  assert.equal(v.evaluation['fixed-old'].games,48);assert.equal(v.evaluation['retrained-offline'].games,48);
  const a=JSON.parse(readFileSync(resolve(out,'fixed-old/report.json'))),b=JSON.parse(readFileSync(resolve(out,'retrained-offline/report.json')));
  assert.deepEqual(a.records.map(r=>[r.suite,r.opponentPair,r.seed,r.incumbent]),b.records.map(r=>[r.suite,r.opponentPair,r.seed,r.incumbent]));
  await assert.rejects(runReplication({out,...args}),/exists/);await assert.rejects(verifyReplication({out}),/exists/);
});
