import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {SCHEMA} from '../tile-q/encoding.mjs';
import {PROTOCOL_VERSION,SEAT_PERMUTATIONS} from '../runner.mjs';
import {checkSummary,sourceMap as oldSources} from '../hu-kong-confirm/config.mjs';
import {read,hash,PAIRS,N} from '../strong-pool/config.mjs';
export {read,hash,PAIRS,N};
export const VERSION='kwx-paired-tile-return-1';
export const ARMS=Object.freeze(['learned','always','baseline','reference']);
export const CONTRASTS=Object.freeze({improvement:'baseline',selection:'always',strength:'reference'});
export const sourceMap=()=>({...oldSources(),...Object.fromEntries(['config.mjs','policy.mjs','collect.mjs','train.py','groups.mjs','study.mjs','verify.mjs'].map(f=>['ai/paired-tile/'+f,hash(new URL(f,import.meta.url))]))});
const previousFiles=['plan.json','summary.json','verification.json','binding.json','trial/plan.json','trial/summary.json','trial/verification.json','trial/models.json'];
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sourceMap,sourceMap());assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.contrasts,CONTRASTS);assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.schema,SCHEMA);
  for(const [f,sha]of Object.entries(p.previous.files))assert.equal(hash(resolve(p.previous.path,f)),sha);
  const {p:old,s}=checkSummary(p.previous.path),v=read(resolve(p.previous.path,'verification.json'));
  assert.equal(v.summarySha256,p.previous.files['summary.json']);assert.ok(v.allGroupsRecomputedWithoutScoreCache);assert.equal(v.games,s.games);assert.deepEqual(v.sourceMap,old.sourceMap);
  assert.deepEqual(p.models,old.models);for(const m of Object.values(p.models)){assert.equal(hash(m.path),m.sha256);assert.equal(hash(m.state),read(m.path).metadata.optimizerStateSha256);}
  assert.deepEqual(p.network,read(p.models.short.path).config);assert.deepEqual(p.coreSources,read(p.models.short.path).sources);
  for(const n of Object.values(p.budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(p.budget.workers<=8);
  assert.equal(p.budget.trainingHands%(p.budget.workers*p.budget.sessionHands),0);assert.equal(p.budget.validationHands%p.budget.sessionHands,0);
  assert.deepEqual(p.optimizer,{learningRate:.001,batchSize:128,maxGradNorm:5});
  assert.equal(p.primary,'Learned-minus-short AND learned-minus-always AND learned-minus-h0-never 95% full-group intervals must all be positive; first two alone support conditional selection learning.');
  assert.equal(p.stopping,'Complete fixed collection and training. If selected epoch is zero, prove exact short-policy identity and do not spend heldout games; otherwise complete the fixed heldout budget. No extension, pooling, exam training or automatic promotion. Default H0.');
}
export function makePlan({previous,python='python',trainingHands=5760,validationHands=864,epochs=16,groupsPerPair=16,sessionHands=16,workers=4,bootstrapSamples=5000,cacheCapacity=2048}){
  previous=resolve(previous);const {p:old}=checkSummary(previous),nonce=randomBytes(32).toString('hex');
  const p={version:VERSION,createdAt:new Date().toISOString(),sourceMap:sourceMap(),previous:{path:previous,files:Object.fromEntries(previousFiles.map(f=>[f,hash(resolve(previous,f))]))},
    models:old.models,schema:SCHEMA,network:read(old.models.short.path).config,coreSources:read(old.models.short.path).sources,python,
    arms:ARMS,contrasts:CONTRASTS,pairs:PAIRS,budget:{trainingHands,validationHands,epochs,groupsPerPair,sessionHands,workers,bootstrapSamples,cacheCapacity},
    seeds:Object.fromEntries(['training','validation','model','evaluation'].map(k=>[k,deriveSeed(VERSION,nonce,k)])),optimizer:{learningRate:.001,batchSize:128,maxGradNorm:5},
    data:'Fresh short-policy trajectories, three pairs/six seats/whole sessions. At first non-reveal discard disagreement between sss and ssl, reuse actual short continuation as baseline and play alternative to terminal with same hidden state and short continuation. Gain=(alternative net-baseline net)/16. One root per hand, no exploration, private world only offline labels, never model inputs.',
    training:'Initialize short encoder, zero actionHead and valueHead; freeze valueHead, rankHead and redundant action bias. Train remaining tile-network parameters on squared (Qalt-Qbase-gain), no BC/CQL/rank objective. Adam, fixed epochs. Select minimum validation pair MSE including zero epoch, earliest ties. Not imitation of long, not actual expected return from one realized branch.',
    policy:'One opportunity per hand: first short non-reveal discard whose ssl long-tile proposal differs. Learned selects alternative iff Qalt-Qbase>0, ties short. Always always accepts that same first proposal. Both then continue short. All other decisions short. No Hu/kong/reveal intervention.',
    primary:'Learned-minus-short AND learned-minus-always AND learned-minus-h0-never 95% full-group intervals must all be positive; first two alone support conditional selection learning.',
    stopping:'Complete fixed collection and training. If selected epoch is zero, prove exact short-policy identity and do not spend heldout games; otherwise complete the fixed heldout budget. No extension, pooling, exam training or automatic promotion. Default H0.'};check(p);return p;
}
export function rolesFor(p,hand){const session=Math.floor(hand/p.budget.sessionHands),roles=SEAT_PERMUTATIONS[session%6],pair=p.pairs[Math.floor(session/6)%3],ids={C:'baseline',P:pair.policies[0],Q:pair.policies[1]};return {target:roles.indexOf('C'),pair:pair.id,roles,policyIds:roles.map(r=>ids[r])};}
export const jobsFor=p=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seeds.evaluation,'session',j.pair.id,j.group);
