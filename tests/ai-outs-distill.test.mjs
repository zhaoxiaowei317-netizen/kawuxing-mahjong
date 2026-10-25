import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
import {MahjongEnvironment,actionKey} from '../ai/environment.mjs';
import {SEAT_PERMUTATIONS,runEvaluation} from '../ai/runner.mjs';
import {encodePublic,legalActionIds,actionId} from '../ai/tile-q/encoding.mjs';
import {loadQ} from '../ai/tile-q/model.mjs';
import {save} from '../ai/tile-q/collect.mjs';
import {read} from '../ai/strong-pool/config.mjs';
import {episodes} from '../ai/strong-pool/stream-data.mjs';
import {run as trainFixture} from '../ai/strong-pool/study.mjs';
import {verify as verifyTraining} from '../ai/strong-pool/verify-stream.mjs';
import {run as confirmFixture} from '../ai/strong-confirm/study.mjs';
import {verify as verifyConfirmation} from '../ai/strong-confirm/verify.mjs';
import {diagnose} from '../ai/strong-confirm/diagnose.mjs';
import {run as guardFixture} from '../ai/outs-guard/study.mjs';
import {verify as verifyGuard} from '../ai/outs-guard/verify.mjs';
import {guardChoice} from '../ai/outs-guard/policy.mjs';
import {makePlan,check,rolesFor,jobsFor,STUDENTS} from '../ai/outs-distill/config.mjs';
import {labeledDecision,studentEpisode} from '../ai/outs-distill/collect.mjs';
import {run,aggregate} from '../ai/outs-distill/study.mjs';
import {factories} from '../ai/outs-distill/groups.mjs';
import {verify,auditData,auditGroup} from '../ai/outs-distill/verify.mjs';

test('aligned teacher decisions use one public full-mask inference and legal exploration does not change labels',()=>{
  const env=new MahjongEnvironment({seed:'outs-distill-public-test'}),o=env.observation(),legal=env.legalActions(),encoded=encodePublic(o,legal),ids=legalActionIds(legal);assert.ok(legal.length>1);
  let calls=0;const q=Array(88).fill(-Infinity);for(const id of ids)q[id]=-id;const model={forward:(e,a)=>{calls++;assert.deepEqual(e,encoded);assert.deepEqual(a,ids);return {q};}};
  const before=JSON.stringify(o),d=labeledDecision(model,o,legal,()=>0,0),expected=guardChoice({q,legal,encoded});assert.equal(calls,1);
  assert.equal(actionKey(d.action),actionKey(expected.base));assert.deepEqual(d.teachers,{self:actionId(expected.base),corrected:actionId(expected.action)});
  const exploratory=labeledDecision(model,o,legal,max=>max===0x100000000?0:legal.length-1,1);assert.deepEqual(exploratory.teachers,d.teachers);assert.equal(exploratory.action,legal.at(-1));
  assert.equal(JSON.stringify(o),before);const forced={type:'pass'};assert.equal(labeledDecision({forward:()=>assert.fail()},o,[forced],()=>assert.fail(),.05).action,forced);
  const e={rows:[{decision:1,teachers:d.teachers,changed:true,encoded}],replay:{same:'trajectory'}};
  const a=studentEpisode(e,'self'),b=studentEpisode(e,'corrected');assert.deepEqual(a.replay,b.replay);assert.deepEqual(a.rows.map(({teacherId,...r})=>r),b.rows.map(({teacherId,...r})=>r));
  assert.ok(!('teachers'in a.rows[0])&&!('changed'in a.rows[0]));
});
test('training session schedule covers every opponent pair and six seat permutations equally',()=>{
  const p={budget:{sessionHands:16},pairs:[{id:'a',policies:['x','y']},{id:'b',policies:['y','z']},{id:'c',policies:['z','x']}]},seen=new Set();
  for(let s=0;s<18;s++){const r=rolesFor(p,s*16);assert.deepEqual(r,rolesFor(p,s*16+15));assert.deepEqual(r.roles,SEAT_PERMUTATIONS[r.permutation]);seen.add(r.pair+':'+r.permutation);assert.equal(r.policyIds[r.target],'raw');}assert.equal(seen.size,18);
});
test('fresh paired-label learning, direct neural evaluation, complete replay audit and tamper rejection',async()=>{
  mkdirSync('.tmp/outs-distill-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/outs-distill-tests/run-')),
    training=resolve(root,'training'),confirmation=resolve(root,'confirmation'),previous=resolve(root,'guard'),out=resolve(root,'study');
  await trainFixture({out:training,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});await verifyTraining({out:training});
  await confirmFixture({out:confirmation,previous:training,evaluationGroups:1,bootstrapSamples:30,workers:2});await verifyConfirmation({out:confirmation});diagnose({out:confirmation});
  await guardFixture({out:previous,previous:confirmation,groupsPerPair:1,bootstrapSamples:30,workers:2});await verifyGuard({out:previous});
  const options={previous,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30},p=makePlan(options);check(p);
  assert.notDeepEqual(p.seeds,makePlan(options).seeds);assert.throws(()=>check({...p,epsilon:0}));assert.throws(()=>check({...p,modelStateSha256:'bad'}));
  const s=await run({out,...options});assert.equal(s.games,54);assert.equal(s.trainingHands,36);assert.equal(s.validationHands,18);assert.equal(s.productionPolicy,'H0');
  const plan=read(resolve(out,'plan.json')),models=read(resolve(out,'models.json')),jobs=jobsFor(plan),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));
  assert.deepEqual(s.evaluation,aggregate(plan,models,groups));assert.throws(()=>aggregate(plan,models,groups.slice(1)));
  const loaded=Object.fromEntries(Object.entries(models).map(([k,v])=>[k,loadQ(v.path).model])),saved=gunzipSync(readFileSync(resolve(out,'groups',jobs[0].id,'replays.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  for(const control of ['raw','self']){const expected=[],original=await runEvaluation({candidate:'corrected',incumbent:control,seed:plan.seeds.evaluation,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:1,
    opponentPairs:[jobs[0].pair],bootstrapSamples:30,policyFactories:factories(loaded),onEpisode:e=>expected.push(e)});
    assert.deepEqual(original.records[0].candidate,groups[0].record.arms.corrected);assert.deepEqual(original.records[0].incumbent,groups[0].record.arms[control]);
    assert.deepEqual(saved.filter(e=>e.arm==='corrected'||e.arm===control).map(e=>({...e,arm:e.arm==='corrected'?'candidate':'incumbent'})),expected);
  }
  for(const split of ['training','validation'])for await(const e of episodes(resolve(out,split,'canonical'))){
    assert.ok(e.rows.every(r=>r.seat===e.schedule.target));assert.ok(e.rows.every(r=>r.legalIds.includes(r.teachers.self)&&r.legalIds.includes(r.teachers.corrected)));
  }
  const v=await verify({out});assert.equal(v.games,54);assert.equal(v.snapshotsVerified,4);assert.equal(v.data.reduce((n,d)=>n+d.hands,0),54);assert.ok(Object.values(v.parity).every(p=>p.maxError<1e-4));
  const d=read(resolve(out,'training','canonical','manifest.json')),path=resolve(d.parts[0],'..'),m=read(resolve(d.parts[0],'manifest.json'));
  appendFileSync(resolve(path,STUDENTS[0],'episodes.jsonl.gz'),gzipSync(JSON.stringify({rows:[]})+'\n'));
  await assert.rejects(auditData({path,plan,split:'training',startHand:m.startHand,hands:m.hands}));
  const bad=read(resolve(out,'groups',jobs[0].id,'group.json'));bad.record.arms.corrected.score++;save(resolve(out,'groups',jobs[0].id,'group.json'),bad);
  await assert.rejects(auditGroup({path:resolve(out,'groups',jobs[0].id),plan,job:jobs[0],models}));await assert.rejects(run({out,...options}),/exists/);await assert.rejects(verify({out}),/exists/);
});
