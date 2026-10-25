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
import {componentChoice,scorer,MIX} from '../ai/decision-components/policy.mjs';
import {familyIntervals} from '../ai/decision-components/statistics.mjs';
import {summarizePaired} from '../ai/statistics.mjs';
import {makePlan,check,jobsFor} from '../ai/decision-components/config.mjs';
import {run,aggregate} from '../ai/decision-components/study.mjs';
import {factories} from '../ai/decision-components/groups.mjs';
import {verify,auditGroup} from '../ai/decision-components/verify.mjs';
import {MahjongEnvironment} from '../ai/environment.mjs';
import {actionId,legalActionIds} from '../ai/tile-q/encoding.mjs';

test('hierarchical components reproduce parents and alter only the designated conditional choice',()=>{
 const legal=[{type:'discard',tile:'p1',reveal:false},{type:'discard',tile:'p2',reveal:false},
  {type:'discard',tile:'p1',reveal:true},{type:'discard',tile:'p2',reveal:true},{type:'hu'},{type:'kong',tile:'p3',kind:'an'}];
 const q={s:Array(88).fill(-100),l:Array(88).fill(-100)};
 Object.assign(q.s,{0:10,1:9,21:1,22:2,84:-2,44:-1});Object.assign(q.l,{0:4,1:5,21:9,22:10,84:20,44:11});
 const choose=(code,list=legal)=>componentChoice({code,legal:list,getQ:k=>q[k]});
 assert.equal(actionId(choose(MIX.short)),0);assert.equal(actionId(choose(MIX.long)),84);
 assert.equal(actionId(choose(MIX.tile)),1);assert.equal(actionId(choose(MIX.reveal)),22);assert.equal(actionId(choose(MIX.other)),84);
 assert.equal(actionId(choose(MIX.reveal,legal.filter(a=>a.type==='discard'&&!a.reveal))),0);
 q.s[0]=q.s[1];assert.equal(actionId(choose(MIX.short,[...legal].reverse())),0);
 assert.throws(()=>choose('sss',[]));assert.throws(()=>choose('invalid'));
 q.s[0]=NaN;assert.throws(()=>choose('sss'));
});

test('score cache uses only exact public encoding and complete legal mask, with deterministic eviction',()=>{
 const env=new MahjongEnvironment({seed:'components-cache-test'}),o=env.observation(),legal=env.legalActions(),calls={s:0,l:0};
 const fake=k=>({forward(encoded,ids){calls[k]++;const q=Array(88).fill(-Infinity);for(const id of ids)q[id]=id;return {q};}});
 const scores=scorer({short:fake('s'),long:fake('l')},1);const first=scores.view(o,legal).getQ('s');
 const hidden=structuredClone(o);hidden.wall=['p9'];hidden.environmentSeed='not-an-input';hidden.players[(o.seat+1)%3].hand=['p8'];
 assert.deepEqual(scores.view(hidden,legal).getQ('s'),first);assert.equal(calls.s,1);assert.equal(scores.metrics.hits,1);
 scores.view(o,legal).getQ('l');assert.equal(calls.l,1);
 const changed=structuredClone(o);changed.totals[o.seat]+=1;scores.view(changed,legal).getQ('s');assert.equal(calls.s,2);
 scores.view(o,legal).getQ('s');assert.equal(calls.s,3);
 scores.view(o,legal.slice(1)).getQ('s');assert.equal(calls.s,4);
 const uncached=scorer({short:fake('s'),long:fake('l')},0);assert.deepEqual(uncached.view(o,legal).getQ('s'),first);assert.equal(uncached.metrics.hits,0);
});

test('component family intervals preserve pairing, equal pair weights and Bonferroni tail probabilities',()=>{
 const record=(pair,seed,score)=>({suite:'session',opponentPair:pair,seed,candidate:{hands:6,score},incumbent:{hands:6,score:0}}),
  rows=[record('A','a',12),record('A','b',12),record('A','c',12),record('B','d',-6)],
  records={tile:rows,reveal:rows.map(r=>({...r,candidate:{...r.candidate,score:-r.candidate.score}})),other:rows.map(r=>({...r,candidate:{hands:6,score:0}}))};
 const f=familyIntervals(records,{bootstrapSamples:60,seed:'known'});
 assert.equal(f.tile.deltaPer100,50);assert.deepEqual(f.tile.ciFamily,[50,50]);assert.equal(f.tile.confidence,1-.05/3);
 assert.equal(f.tile.outcome,'positive');assert.equal(f.reveal.outcome,'negative');assert.equal(f.other.outcome,'inconclusive');
 assert.deepEqual(f, familyIntervals(records,{bootstrapSamples:60,seed:'known'}));
 assert.throws(()=>familyIntervals({...records,other:[...records.other].reverse()}));
 assert.throws(()=>familyIntervals(Object.fromEntries(Object.entries(records).map(([k,v])=>[k,[...v,v[0]]]))));
 const borderline=Array.from({length:10},(_,i)=>({suite:'session',opponentPair:'A',seed:String(i),candidate:{hands:100,score:i===0?-10:5},incumbent:{hands:100,score:0}}));
 assert.ok(summarizePaired(borderline,{bootstrapSamples:5000,seed:'borderline'}).session.overall.ci95[0]>0);
 const corrected=familyIntervals({tile:borderline,reveal:borderline,other:borderline},{bootstrapSamples:5000,seed:'borderline'});
 assert.equal(corrected.tile.outcome,'inconclusive');assert.ok(corrected.tile.ciFamily[0]<0);
});

test('five frozen component policies match canonical evaluation and all uncached replays reject tampering',async()=>{
 mkdirSync('.tmp/decision-components-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/decision-components-tests/run-')),
  training=resolve(root,'training'),confirmation=resolve(root,'confirmation'),guard=resolve(root,'guard'),previous=resolve(root,'distill'),anchor=resolve(root,'anchor'),duration=resolve(root,'duration'),out=resolve(root,'components');
  await trainFixture({out:training,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});await verifyTraining({out:training});
  await confirmFixture({out:confirmation,previous:training,evaluationGroups:1,bootstrapSamples:30,workers:2});await verifyConfirmation({out:confirmation});diagnose({out:confirmation});
  await guardFixture({out:guard,previous:confirmation,groupsPerPair:1,bootstrapSamples:30,workers:2});await verifyGuard({out:guard});
  await distillFixture({out:previous,previous:guard,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDistill({out:previous});

  await anchorFixture({out:anchor,previous,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyAnchor({out:anchor});

 await durationFixture({out:duration,previous:anchor,epochs:2,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDuration({out:duration});
 const options={previous:duration,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:60,cacheCapacity:128},p=makePlan(options);check(p);
 assert.notEqual(p.seed,makePlan(options).seed);assert.throws(()=>check({...p,family:{...p.family,alpha:.1}}));
 const s=await run({out,...options});assert.equal(s.games,90);assert.equal(s.newUniqueTrainingHands,0);assert.equal(s.productionPolicy,'H0');
 const plan=read(resolve(out,'plan.json')),models=read(resolve(out,'models.json')),jobs=jobsFor(plan),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));
 assert.deepEqual(s.evaluation,aggregate(plan,groups));assert.throws(()=>aggregate(plan,groups.slice(1)));
 assert.ok(groups[0].cacheMetrics.hits>0);
 const loaded=Object.fromEntries(['short','long'].map(k=>[k,loadQ(models[k].path).model])),saved=gunzipSync(readFileSync(resolve(out,'groups',jobs[0].id,'replays.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
 for(const arm of ['long','tile','reveal','other']){
  const expected=[],f=factories(loaded,0),policies={...f.policies,short:()=>((o,l)=>loaded.short.select(o,l)),long:()=>((o,l)=>loaded.long.select(o,l))};
  const original=await runEvaluation({candidate:arm,incumbent:'short',seed:plan.seed,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:1,
   opponentPairs:[jobs[0].pair],bootstrapSamples:30,policyFactories:policies,onEpisode:e=>expected.push(e)});
  assert.deepEqual(original.records[0].candidate,groups[0].record.arms[arm]);assert.deepEqual(original.records[0].incumbent,groups[0].record.arms.short);
  const normalized=saved.filter(e=>e.arm===arm||e.arm==='short').map(e=>({...e,arm:e.arm===arm?'candidate':'incumbent'}));
  for(const role of ['candidate','incumbent'])assert.deepEqual(normalized.filter(e=>e.arm===role),expected.filter(e=>e.arm===role));
 }
 const v=await verify({out});assert.equal(v.games,90);assert.equal(v.allGroupsRecomputedWithoutScoreCache,true);assert.ok(v.groups.every(g=>g.cacheDisabled));
 const g=read(resolve(out,'groups',jobs[0].id,'group.json'));g.components.tile.changedFromShort++;save(resolve(out,'groups',jobs[0].id,'group.json'),g);
 await assert.rejects(auditGroup({path:resolve(out,'groups',jobs[0].id),plan,job:jobs[0],models}));
 await assert.rejects(run({out,...options}),/exists/);await assert.rejects(verify({out}),/exists/);
});

