import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {GainRegressor, fitRidge, predictModel, diagnostics} from '../ai/paired-value/model.mjs';
import {describeRoot, FEATURE_SIZE, FEATURE_NAMES} from '../ai/paired-value/features.mjs';
import {learnedGainFactory} from '../ai/paired-value/policy.mjs';
import {saveGain, loadGain} from '../ai/paired-value/io.mjs';
import {trainGain} from '../ai/paired-value/train.mjs';
import {collectData, loadData, dataSources, DATA_VERSION, mergeData} from '../ai/paired-value/data.mjs';
import {verifyData, verifyEvaluation, verifyStudy} from '../ai/paired-value/verify.mjs';
import {evaluateGain} from '../ai/paired-value/evaluate.mjs';
import {selectCandidate, ARMS, runStudy} from '../ai/paired-value/study.mjs';
import {recoverStudy} from '../ai/paired-value/recover.mjs';
import {verifyParallel} from '../ai/paired-value/verify-parallel.mjs';
import {MahjongEnvironment, observationFor, legalActionsFor} from '../ai/environment.mjs';
import {selectAction as h0} from '../ai/policies/h0.mjs';
import {sha256} from '../ai/provenance.mjs';

const temp = () => mkdtempSync(resolve(tmpdir(),'kwx-paired-value-'));
const vector = x => Array.from({length:FEATURE_SIZE},(_,i) => i === 0 ? 1 : i === 1 ? x : 0);
const rows = Array.from({length:40},(_,i) => {const x=(i-20)/20; return {features:vector(x),gain:3*x+1};});
function fixtureData(out, split) {
  mkdirSync(out); const bytes=gzipSync(rows.map(r=>JSON.stringify({...r,split})).join('\n')+'\n');
  writeFileSync(resolve(out,'rows.jsonl.gz'),bytes);
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify({version:DATA_VERSION,split,seed:split,hands:100,roots:rows.length,
    sources:dataSources(),rowsSha256:sha256(bytes)}));
}
test('paired gain regressor starts exactly at H0, learns net-gain targets and preserves actor weights', () => {
  assert.equal(FEATURE_SIZE,64); assert.equal(new Set(FEATURE_NAMES).size,64);
  const model=new GainRegressor({seed:'supervised-fit',hiddenSize:8}), initial=diagnostics(model,rows,100);
  assert.equal(model.predict(vector(.5)),0);
  const actor=[...model.network.parameters.policyW];
  for(let epoch=1;epoch<=120;epoch++) model.update(rows,{epoch,learningRate:.01,batchSize:40});
  assert.ok(diagnostics(model,rows,100).mse < initial.mse*.05);
  assert.deepEqual([...model.network.parameters.policyW],actor);
  const restored=GainRegressor.fromJSON(model.toJSON()); assert.equal(restored.predict(vector(.5)),model.predict(vector(.5)));
  assert.throws(()=>model.predict([1]),/feature/);
  const ridge=fitRidge(rows,.001); assert.ok(diagnostics(ridge,rows,100).mse < .00001);
});
test('checkpoint and resumed supervised fitting reproduce uninterrupted optimizer state exactly', async () => {
  const root=temp(), trainingData=resolve(root,'train'),validationData=resolve(root,'val');
  fixtureData(trainingData,'training'); fixtureData(validationData,'validation');
  // The validation input deliberately differs in bytes and is never fed to update().
  const opts={trainingData,validationData,seed:'exact-resume',hiddenSize:4,learningRate:.003,batchSize:8,onProgress:()=>{}};
  const full=await trainGain({...opts,out:resolve(root,'full'),epochs:4});
  await trainGain({...opts,out:resolve(root,'part'),epochs:2});
  const resumed=await trainGain({...opts,out:resolve(root,'resume'),epochs:4,resume:resolve(root,'part','epoch-002.json')});
  const a=loadGain(resolve(root,'full','epoch-004.json')),b=loadGain(resolve(root,'resume','epoch-004.json'));
  assert.deepEqual(a.model.toJSON(),b.model.toJSON()); assert.deepEqual(full.history,resumed.history);
  assert.equal(a.model.predict(vector(.2)),b.model.predict(vector(.2)));
  const bad=JSON.parse(readFileSync(resolve(root,'full','epoch-004.json')));bad.sources['src/engine.js']='bad';
  writeFileSync(resolve(root,'bad.json'),JSON.stringify(bad));assert.throws(()=>loadGain(resolve(root,'bad.json')),/source/);
  await assert.rejects(trainGain({...opts,out:resolve(root,'wrong'),epochs:5,seed:'other',resume:resolve(root,'part','epoch-002.json')}),/mismatch/);
});
test('fresh paired labels replay the first public proposal and both actual-world terminal branches', async () => {
  const root=temp(),path=resolve(root,'data');
  await assert.rejects(collectData({out:path,hands:1,seed:'x',split:'sealed'}),/fresh/);
  const manifest=await collectData({out:path,hands:48,seed:'paired-value-smoke'});
  assert.ok(manifest.roots>0); const loaded=loadData(path,'training');
  assert.throws(()=>loadData(path,'validation'),/split/);
  const audit=await verifyData(path,'training');assert.equal(audit.labelsRecomputed,manifest.roots);
  const r=loaded.rows[0],env=new MahjongEnvironment({seed:r.environmentSeed,record:false});
  for(const e of r.prefix)env.step(e.action);
  const g=env.auditState(),before=describeRoot(env.observation(),env.legalActions());
  const other=[0,1,2].find(i=>i!==r.seat&&!g.players[i].liang);
  assert.notEqual(other,undefined);
  const index=g.wall.findIndex(t=>t!==g.players[other].hand[0]);
  [g.wall[index],g.players[other].hand[0]]=[g.players[other].hand[0],g.wall[index]];
  const changed=describeRoot(observationFor(g,r.seat),legalActionsFor(g,r.seat));assert.deepEqual(changed,before);
  const model=new GainRegressor({hiddenSize:4}), select=learnedGainFactory(model)();
  assert.deepEqual(select(r.observation,r.legal),r.baseline);
  const ridge={...fitRidge(rows),weights:Array(FEATURE_SIZE).fill(0)};ridge.weights[0]=1;
  let decisions=0;const choose=learnedGainFactory(ridge,()=>decisions++)();
  assert.deepEqual(choose(r.observation,r.legal),r.alternative);
  assert.deepEqual(choose(r.observation,r.legal),h0(r.observation,r.legal));assert.equal(decisions,1);
  assert.deepEqual(learnedGainFactory(ridge)()(r.observation,r.legal),r.alternative);
  const checkpoint=resolve(root,'model.json');saveGain(checkpoint,model);
  const evalPath=resolve(root,'eval');
  const report=await evaluateGain({out:evalPath,candidate:'gain-fixture',checkpoint,incumbent:'proposal-once',
    seed:'gain-full-audit',split:'development',independentGroups:1,sessionGroups:1,sessionHands:2,bootstrapSamples:40});
  const verified=await verifyEvaluation(evalPath,40);assert.equal(verified.games,72);assert.equal(report.totalGames,72);
  assert.equal(report.counts.accepted,0);
});
test('paired development selection has fixed ties and retains H0 for nonpositive results', () => {
  const rows=ARMS.map(arm=>({arm,delta:0}));assert.equal(selectCandidate(rows),null);
  assert.equal(selectCandidate(rows.map(r=>({...r,delta:1}))),'ridge');
  assert.equal(selectCandidate(rows.map(r=>({...r,delta:r.arm==='mlp-2'?2:1}))),'mlp-2');
  assert.throws(()=>selectCandidate(rows.slice(1)),/Incomplete/);
});
test('CPU shards preserve the serial deal sequence and reject overlapping ranges', async () => {
  const root=temp(),seed='shard-consistency';
  await collectData({out:resolve(root,'serial'),hands:12,seed});
  for (let i=0;i<2;i++) await collectData({out:resolve(root,`part-${i}`),hands:6,seed,startHand:i*6});
  const parts=[resolve(root,'part-0'),resolve(root,'part-1')],out=resolve(root,'merged');
  const m=mergeData({out,parts,split:'training'});assert.equal(m.hands,12);
  assert.deepEqual(loadData(out,'training').rows,loadData(resolve(root,'serial'),'training').rows);
  assert.throws(()=>mergeData({out:resolve(root,'overlap'),parts:[parts[0],parts[0]],split:'training'}),/overlap/);
});
test('bounded paired study freezes new splits, selects checkpoints and passes complete independent audit', async () => {
  const out=resolve(temp(),'study');
  const s=await runStudy({out,trainingHands:60,validationHands:60,epochs:2,developmentGroups:1,
    developmentSessionGroups:1,sealedGroups:1,sealedSessionGroups:1,sessionHands:2,bootstrapSamples:30,onProgress:()=>{}});
  assert.equal(s.productionPolicy,'H0');assert.equal(s.trainingDeals,60);assert.equal(s.validationDeals,60);
  // Reconstruct the result using completed stages without new games or writes.
  const recovered=await recoverStudy({out,onProgress:()=>{},verifyOnly:true});
  assert.deepEqual(recovered.development,s.development);assert.deepEqual(recovered.sealed,s.sealed);
  assert.equal(recovered.planSha256,s.planSha256);assert.deepEqual(recovered.datasets,s.datasets);
  const audit=await verifyStudy({out});assert.equal(audit.games,s.games);assert.equal(audit.snapshotsVerified,10);
  const parallel=await verifyParallel({out,outputFile:'parallel-verification.json'});
  assert.deepEqual(parallel.data,audit.data);assert.deepEqual(parallel.stages,audit.stages);
  assert.equal(parallel.snapshotsVerified,audit.snapshotsVerified);
});
