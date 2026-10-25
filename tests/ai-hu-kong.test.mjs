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

import {run as durationFixture} from '../ai/outs-duration/study.mjs';
import {verify as verifyDuration} from '../ai/outs-duration/verify.mjs';

import {run as componentFixture} from '../ai/decision-components/study.mjs';
import {verify as verifyComponent} from '../ai/decision-components/verify.mjs';
import {diagnose as diagnoseComponent} from '../ai/decision-components/diagnose.mjs';
import {factories as componentFactories} from '../ai/decision-components/groups.mjs';
import {choose} from '../ai/hu-kong/policy.mjs';
import {makePlan,check,jobsFor} from '../ai/hu-kong/config.mjs';
import {run,aggregate} from '../ai/hu-kong/study.mjs';
import {factories} from '../ai/hu-kong/groups.mjs';
import {verify,auditGroup} from '../ai/hu-kong/verify.mjs';
import {actionId} from '../ai/tile-q/encoding.mjs';

test('hu-kong substitution covers all three kongs and leaves every other Hu choice alone',()=>{
 const legal=[{type:'discard',tile:'p1',reveal:false},{type:'hu'},{type:'ming'},{type:'pass'},
   {type:'kong',tile:'p3',kind:'an'},{type:'kong',tile:'p3',kind:'bu'}];
 const q={s:Array(88).fill(-100),l:Array(88).fill(-100)};q.s[84]=20;q.s[0]=2;q.l[84]=10;q.l[0]=1;
 const select=(arm='patched',list=legal)=>choose({arm,legal:list,getQ:k=>q[k]});
 for(const id of [44,65,86]){q.l.fill(-100);q.l[id]=30;q.l[84]=10;
  assert.equal(actionId(select().base),id);assert.equal(actionId(select().action),84);assert.equal(select().conflict,true);
  assert.equal(actionId(select('base').action),id);assert.equal(actionId(select('short').action),84);
 }
 q.l.fill(-100);q.l[87]=40;assert.equal(actionId(select().action),87);assert.equal(select().conflict,false);
 q.l.fill(-100);q.l[44]=40;q.s[87]=50;assert.equal(actionId(select().action),44);assert.equal(select().conflict,false);
 q.s[87]=-100;assert.equal(actionId(select('patched',legal.filter(a=>a.type!=='hu')).action),44);
 q.l[0]=60;assert.equal(actionId(select().action),0);assert.equal(select().conflict,false);
 q.l[84]=70;assert.equal(actionId(select().action),84);assert.equal(select().conflict,false);
 q.l[84]=q.l[44]=70;assert.equal(actionId(select().action),84);assert.equal(actionId(select('base').action),44);
 assert.throws(()=>select('unknown'));
});

test('fresh hu-kong mechanism and strength experiment matches canonical policies and uncached audit',async()=>{
 mkdirSync('.tmp/hu-kong-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/hu-kong-tests/run-')),
  training=resolve(root,'training'),confirmation=resolve(root,'confirmation'),guard=resolve(root,'guard'),previous=resolve(root,'distill'),anchor=resolve(root,'anchor'),duration=resolve(root,'duration'),component=resolve(root,'components'),out=resolve(root,'hu-kong');
  await trainFixture({out:training,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});await verifyTraining({out:training});
  await confirmFixture({out:confirmation,previous:training,evaluationGroups:1,bootstrapSamples:30,workers:2});await verifyConfirmation({out:confirmation});diagnose({out:confirmation});
  await guardFixture({out:guard,previous:confirmation,groupsPerPair:1,bootstrapSamples:30,workers:2});await verifyGuard({out:guard});
  await distillFixture({out:previous,previous:guard,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDistill({out:previous});

  await anchorFixture({out:anchor,previous,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyAnchor({out:anchor});

 await durationFixture({out:duration,previous:anchor,epochs:2,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDuration({out:duration});

 await componentFixture({out:component,previous:duration,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:128});await verifyComponent({out:component});await diagnoseComponent({out:component});
 const options={previous:component,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:128},p=makePlan(options);check(p);
 assert.notEqual(p.seed,makePlan(options).seed);assert.throws(()=>check({...p,rule:'always Hu'}));assert.throws(()=>check({...p,primary:'choose best after games'}));
 const s=await run({out,...options});assert.equal(s.games,72);assert.equal(s.newUniqueTrainingHands,0);assert.equal(s.productionPolicy,'H0');
 const plan=read(resolve(out,'plan.json')),models=read(resolve(out,'models.json')),jobs=jobsFor(plan),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));
 assert.deepEqual(s.evaluation,aggregate(plan,groups));assert.throws(()=>aggregate(plan,groups.slice(1)));
 assert.equal(groups.find(g=>g.job.pair.id==='never+never').record.arms.reference.score,0);
 const loaded=Object.fromEntries(['short','long'].map(k=>[k,loadQ(models[k].path).model])),saved=gunzipSync(readFileSync(resolve(out,'groups',jobs[0].id,'replays.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
 for(const control of ['base','short','reference']){
  const expected=[],f=factories(loaded,0),legacy=componentFactories(loaded,0),policies={...f.policies,base:legacy.policies.other,short:()=>((o,l)=>loaded.short.select(o,l))};
  const original=await runEvaluation({candidate:'patched',incumbent:control,seed:plan.seed,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:1,
   opponentPairs:[jobs[0].pair],bootstrapSamples:30,policyFactories:policies,onEpisode:e=>expected.push(e)});
  assert.deepEqual(original.records[0].candidate,groups[0].record.arms.patched);assert.deepEqual(original.records[0].incumbent,groups[0].record.arms[control]);
  const normalized=saved.filter(e=>e.arm==='patched'||e.arm===control).map(e=>({...e,arm:e.arm==='patched'?'candidate':'incumbent'}));
  for(const role of ['candidate','incumbent'])assert.deepEqual(normalized.filter(e=>e.arm===role),expected.filter(e=>e.arm===role));
 }
 const v=await verify({out});assert.equal(v.games,72);assert.equal(v.allGroupsRecomputedWithoutScoreCache,true);assert.ok(v.groups.every(g=>g.cacheDisabled));
 const g=read(resolve(out,'groups',jobs[0].id,'group.json'));g.components.patched.overrides++;save(resolve(out,'groups',jobs[0].id,'group.json'),g);
 await assert.rejects(auditGroup({path:resolve(out,'groups',jobs[0].id),plan,job:jobs[0],models}));
 await assert.rejects(run({out,...options}),/exists/);await assert.rejects(verify({out}),/exists/);
});
