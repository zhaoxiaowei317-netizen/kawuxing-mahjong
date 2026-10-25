import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {MahjongEnvironment,actionKey} from '../ai/environment.mjs';
import {runEvaluation} from '../ai/runner.mjs';
import {FEATURE_NAMES} from '../ai/action-scorer/features.mjs';
import {actionId,encodePublic,legalActionIds} from '../ai/tile-q/encoding.mjs';
import {loadQ} from '../ai/tile-q/model.mjs';
import {save} from '../ai/tile-q/collect.mjs';
import {run as trainFixture} from '../ai/strong-pool/study.mjs';
import {verify as verifyTraining} from '../ai/strong-pool/verify-stream.mjs';
import {read,N} from '../ai/strong-pool/config.mjs';
import {run as confirmFixture} from '../ai/strong-confirm/study.mjs';
import {verify as verifyConfirmation} from '../ai/strong-confirm/verify.mjs';
import {diagnose} from '../ai/strong-confirm/diagnose.mjs';
import {GUARDED,RAW,guardChoice,decide,factories} from '../ai/outs-guard/policy.mjs';
import {run,makePlan,check,jobsFor,aggregate} from '../ai/outs-guard/study.mjs';
import {verify,auditGroup} from '../ai/outs-guard/verify.mjs';

test('outs guard keeps action type, reveal and distance, maximizes public outs and uses full-mask Q ties',()=>{
  const legal=[1,2,3,4,5].map(n=>({type:'discard',tile:'p'+n,reveal:n===4}));
  const shape=[[1,2],[1,6],[1,6],[1,20],[0,20]],scores=[10,7,8,9,9.5],q=Array(88).fill(-Infinity);
  const encoded={candidates:legal.map((a,i)=>{q[actionId(a)]=scores[i];const values=Array(FEATURE_NAMES.length).fill(0);
    values[FEATURE_NAMES.indexOf('negativeDistance')]=-shape[i][0]/6;values[FEATURE_NAMES.indexOf('outs')]=shape[i][1]/12;return {id:actionId(a),values};})};
  const d=guardChoice({q,legal,encoded});assert.equal(d.base,legal[0]);assert.equal(d.action,legal[2]);assert.equal(d.before.outs,2);assert.equal(d.after.outs,6);
  assert.equal(d.before.distance,d.after.distance);assert.equal(d.action.reveal,d.base.reveal);assert.equal(d.changed,true);
  q[actionId(legal[1])]=8;assert.equal(guardChoice({q,legal,encoded}).action,legal[1],'Exact ties follow original ascending action ID');
  q[actionId(legal[0])]=11;encoded.candidates[0].values[FEATURE_NAMES.indexOf('outs')]=6/12;assert.equal(guardChoice({q,legal,encoded}).action,legal[0]);
  const alternatives=[{type:'hu'},{type:'peng'},{type:'ming'},{type:'pass'},{type:'kong',kind:'an',tile:'p1'},{type:'kong',kind:'bu',tile:'p1'}];
  for(const base of alternatives){const actions=[base,...legal],v=Array(88).fill(0);v[actionId(base)]=100;const r=guardChoice({q:v,legal:actions,encoded});assert.equal(r.action,base);assert.equal(r.changed,false);}
});
test('guard computes the original full public input once and forced actions do not need inference',()=>{
  const env=new MahjongEnvironment({seed:'outs-guard-public-fixture'}),o=env.observation(),legal=env.legalActions(),before=JSON.stringify(o);let calls=0;
  const model={forward:(encoded,ids)=>{calls++;assert.deepEqual(ids,legalActionIds(legal));assert.deepEqual(encoded,encodePublic(o,legal));const q=Array(88).fill(-Infinity);for(const id of ids)q[id]=-id;return {q};}};
  const r=decide(model,o,legal);assert.equal(calls,1);assert.ok(legal.some(a=>actionKey(a)===actionKey(r.action)));assert.equal(JSON.stringify(o),before);
  const action={type:'pass'};assert.equal(decide({forward:()=>{throw Error('Unexpected inference');}},o,[action]).action,action);
});
test('three-arm experiment matches original paired runner, audits interventions and rejects score/plan tampering',async()=>{
  mkdirSync('.tmp/outs-guard-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/outs-guard-tests/run-')),training=resolve(root,'training'),previous=resolve(root,'previous'),out=resolve(root,'study');
  await trainFixture({out:training,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});await verifyTraining({out:training});
  await confirmFixture({out:previous,previous:training,evaluationGroups:1,bootstrapSamples:30,workers:2});await verifyConfirmation({out:previous});diagnose({out:previous});
  const options={previous,groupsPerPair:1,bootstrapSamples:30,workers:2},p=makePlan(options);check(p);assert.notEqual(p.seed,makePlan(options).seed);
  assert.throws(()=>check({...p,model:{...p.model,sha256:'wrong'}}));assert.throws(()=>check({...p,policies:{...p.policies,raw:N}}));
  const s=await run({out,...options});assert.equal(s.games,54);assert.equal(s.trainingHands,0);assert.equal(s.productionPolicy,'H0');
  const plan=read(resolve(out,'plan.json')),jobs=jobsFor(plan),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(plan,groups));
  assert.throws(()=>aggregate(plan,groups.slice(1)));const g=groups[0],model=loadQ(plan.model.path).model;
  const episodes=gunzipSync(readFileSync(resolve(out,'groups',jobs[0].id,'replays.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  for(const [name,control,id]of [['component','raw',RAW],['strength','reference',N]]){
    const expected=[];const original=await runEvaluation({candidate:GUARDED,incumbent:id,seed:plan.seed,split:'sealed',independentGroups:0,sessionGroups:1,
      sessionHands:1,opponentPairs:[jobs[0].pair],bootstrapSamples:30,policyFactories:factories(model),onEpisode:e=>expected.push(e)});
    assert.deepEqual(original.records[0].candidate,g.record.arms.guarded);assert.deepEqual(original.records[0].incumbent,g.record.arms[control]);
    const actual=episodes.filter(e=>e.arm==='guarded'||e.arm===control).map(e=>({...e,arm:e.arm==='guarded'?'candidate':'incumbent'}));assert.deepEqual(actual,expected,name+' exact complete traces');
  }
  assert.equal(groups.find(g=>g.job.pair.id==='never+never').record.arms.reference.score,0);
  assert.equal(s.evaluation.intervention.changed,s.evaluation.intervention.eligible);assert.ok(s.evaluation.intervention.outsGain>=s.evaluation.intervention.changed);
  const v=await verify({out});assert.equal(v.games,54);assert.equal(v.groups.length,3);assert.ok(v.groups.every(g=>g.allEpisodesRedealtAndExactTracesMatched));
  const path=resolve(out,'groups',jobs[0].id),bad=read(resolve(path,'group.json'));bad.record.arms.guarded.score++;save(resolve(path,'group.json'),bad);
  await assert.rejects(auditGroup({path,plan,job:jobs[0]}));await assert.rejects(run({out,...options}),/exists/);await assert.rejects(verify({out}),/exists/);
});
