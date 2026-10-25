import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {MahjongEnvironment,observationFor,legalActionsFor} from '../ai/environment.mjs';
import {SCHEMA,encodePublic,unpack,POSITIONS} from '../ai/tile-q/encoding.mjs';
import {sources} from '../ai/tile-q/sources.mjs';
import {collect,rankTarget} from '../ai/tile-q/collect.mjs';
import {loadQ} from '../ai/tile-q/model.mjs';
import {worker,runStudy,select,ARMS} from '../ai/tile-q/study.mjs';
import {verifyData,verifyParity,verifyStudy} from '../ai/tile-q/verify.mjs';
import {verifyParallel} from '../ai/tile-q/verify-parallel.mjs';

const temp=()=>{mkdirSync('.tmp/tile-q-tests',{recursive:true});return mkdtempSync(resolve('.tmp/tile-q-tests/run-'));};
test('tile planes retain complete ordered rivers, separate suits and exclude hidden state',()=>{
  const env=new MahjongEnvironment({seed:'tile-q-public',record:false}),g=env.auditState(),seat=env.actor;
  const o=env.observation(),legal=env.legalActions(),a=encodePublic(o,legal);
  assert.equal(SCHEMA.channels,65);assert.equal(SCHEMA.contextSize,42);assert.equal(unpack(a).length,65*29);
  const other=(seat+1)%3,index=g.wall.findIndex(t=>t!==g.players[other].hand[0]);
  [g.wall[index],g.players[other].hand[0]]=[g.players[other].hand[0],g.wall[index]];
  assert.deepEqual(encodePublic(observationFor(g,seat),legalActionsFor(g,seat)),a);
  const injected=structuredClone(o);injected.players[other].hand=['z5'];injected.wall=['z6'];
  assert.deepEqual(encodePublic(injected,legal),a);
  const river=structuredClone(o);river.players[other].river=['p1','p2','p1','s9'];
  const b=encodePublic(river,legal),c=structuredClone(river);c.players[other].river.reverse();
  assert.notDeepEqual(encodePublic(c,legal).tiles,b.tiles);
  const raw=Buffer.from(a.tiles,'base64');raw[9]=1;assert.throws(()=>unpack({...a,tiles:raw.toString('base64')}),/separator/);
  assert.deepEqual(rankTarget([1,1,-2],0),[.5,.5,0]);assert.deepEqual(rankTarget([0,0,0],1),[1/3,1/3,1/3]);
});
test('tile-Q targets, export parity and Adam resume are reproducible on real legal games',async()=>{
  const root=temp(),training=resolve(root,'training'),validation=resolve(root,'validation');
  await collect({out:training,hands:12,seed:'tile-q-resume',sessionHands:4});await collect({out:validation,hands:6,seed:'tile-q-resume',split:'validation',sessionHands:2});
  const verified=await verifyData(training,'training');assert.ok(verified.samples>12);
  const base={trainingData:training,validationData:validation,schema:SCHEMA,sources:sources(),seed:'tile-q-exact-resume',
    network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true},
    config:{learningRate:.002,batchSize:32,maxGradNorm:5,cqlWeight:.05,bcWeight:.1,auxWeight:.1},mode:'q',epochs:4};
  async function train(name,extra={}){const spec=resolve(root,`${name}.spec.json`);writeFileSync(spec,JSON.stringify({...base,out:resolve(root,name),...extra}));
    await worker('python',[resolve('ai/tile-q/train.py'),spec]);return resolve(root,name);}
  const full=await train('full'),part=await train('part',{epochs:2}),resume=await train('resume',{resume:resolve(part,'epoch-002.pt')});
  const a=loadQ(resolve(full,'epoch-004.json')),b=loadQ(resolve(resume,'epoch-004.json'));
  assert.deepEqual(a.data.weights,b.data.weights);assert.ok(verifyParity(resolve(full,'parity.json')).maxError<.0001);
  const wrong=JSON.parse(readFileSync(resolve(full,'epoch-004.json')));wrong.sources['src/engine.js']='bad';
  writeFileSync(resolve(root,'bad.json'),JSON.stringify(wrong));assert.throws(()=>loadQ(resolve(root,'bad.json')),/sources/);
});
test('bounded tile-Q study covers full training phases, same-data control and independent audit',async()=>{
  const out=resolve(temp(),'study');const s=await runStudy({out,initialHands:18,validationHands:12,bcEpochs:1,offlineEpochs:1,
    onlineRounds:1,onlineHands:6,onlineEpochs:1,developmentGroups:1,developmentSessions:1,sealedGroups:1,sealedSessions:1,
    sessionHands:1,trainingSessionHands:1,bootstrapSamples:30,onProgress:()=>{}});
  assert.equal(s.trainingHands,24);assert.equal(s.validationHands,12);assert.equal(s.productionPolicy,'H0');
  const v=await verifyStudy({out});assert.equal(v.games,s.games);assert.equal(v.snapshotsVerified,8);
  assert.equal(v.data['online-0'].hands,6);
  const parallel=await verifyParallel({out,outputFile:'verification-parallel.json'});
  assert.deepEqual(parallel.data,v.data);assert.deepEqual(parallel.evaluation,v.evaluation);
  assert.deepEqual(parallel.parity,v.parity);assert.equal(parallel.snapshotsVerified,v.snapshotsVerified);
});
test('tile-Q development selection uses fixed arm order and H0 when all scores are nonpositive',()=>{
  const rows=ARMS.map(arm=>({arm,delta:0}));assert.equal(select(rows),null);
  assert.equal(select(rows.map(r=>({...r,delta:1}))),'features-bc');assert.throws(()=>select(rows.slice(1)),/Incomplete/);
});
