import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {SCHEMA} from '../tile-q/encoding.mjs';
import {PROTOCOL_VERSION,SEAT_PERMUTATIONS} from '../runner.mjs';
import {check as checkParent,sourceMap as oldSources} from '../paired-tile/config.mjs';
import {read,hash,PAIRS,N} from '../strong-pool/config.mjs';
export {read,hash,PAIRS,N};
export const VERSION='kwx-wall-average-return-1';
export const ARMS=Object.freeze(['average','single','always','baseline','reference']);
export const CONTRASTS=Object.freeze({variance:'single',improvement:'baseline',selection:'always',strength:'reference'});
export const sourceMap=()=>({...oldSources(),...Object.fromEntries(['config.mjs','worlds.mjs','policy.mjs','collect.mjs','groups.mjs','study.mjs','verify.mjs'].map(f=>['ai/wall-average/'+f,hash(new URL(f,import.meta.url))]))});
const previousFiles=['plan.json','summary.json','verification.json','models.json','training.json'];
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sourceMap,sourceMap());assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.contrasts,CONTRASTS);assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.schema,SCHEMA);
  for(const [f,sha]of Object.entries(p.previous.files))assert.equal(hash(resolve(p.previous.path,f)),sha);
  const old=read(resolve(p.previous.path,'plan.json')),s=read(resolve(p.previous.path,'summary.json')),v=read(resolve(p.previous.path,'verification.json'));checkParent(old);
  assert.equal(v.summarySha256,p.previous.files['summary.json']);assert.ok(v.allGroupsRecomputedWithoutScoreCache);assert.equal(v.games,s.games);assert.deepEqual(v.sourceMap,old.sourceMap);
  assert.deepEqual(p.models,old.models);for(const m of Object.values(p.models)){assert.equal(hash(m.path),m.sha256);assert.equal(hash(m.state),read(m.path).metadata.optimizerStateSha256);}
  assert.deepEqual(p.network,read(p.models.short.path).config);assert.deepEqual(p.coreSources,read(p.models.short.path).sources);
  for(const n of Object.values(p.budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(p.budget.workers<=8);
  assert.equal(p.budget.trainingHands%(p.budget.workers*p.budget.sessionHands),0);assert.equal(p.budget.validationHands%p.budget.sessionHands,0);
  assert.ok(p.budget.wallSamples>=2&&p.budget.wallSamples<=16);
  assert.deepEqual(p.optimizer,{learningRate:.001,batchSize:128,maxGradNorm:5});
  assert.equal(p.primary,'Average-minus-single AND average-minus-short AND average-minus-always AND average-minus-h0-never 95% full-group intervals must all be positive; first three support variance-reduced selection learning.');
  assert.equal(p.stopping,'Complete fixed collection, both fixed training runs, and all fixed heldout groups, including zero-selected models. No extension, pooling, exam training or automatic promotion. Default H0.');
}
export function makePlan({previous,python='python',trainingHands=5760,validationHands=864,epochs=16,groupsPerPair=16,sessionHands=16,workers=4,bootstrapSamples=5000,cacheCapacity=2048,wallSamples=8}){
  previous=resolve(previous);const old=read(resolve(previous,'plan.json'));checkParent(old);const nonce=randomBytes(32).toString('hex');
  const p={version:VERSION,createdAt:new Date().toISOString(),sourceMap:sourceMap(),previous:{path:previous,files:Object.fromEntries(previousFiles.map(f=>[f,hash(resolve(previous,f))]))},
    models:old.models,schema:SCHEMA,network:read(old.models.short.path).config,coreSources:read(old.models.short.path).sources,python,
    arms:ARMS,contrasts:CONTRASTS,pairs:PAIRS,budget:{trainingHands,validationHands,epochs,groupsPerPair,sessionHands,workers,bootstrapSamples,cacheCapacity,wallSamples},
    seeds:Object.fromEntries(['training','validation','model','evaluation'].map(k=>[k,deriveSeed(VERSION,nonce,k)])),optimizer:{learningRate:.001,batchSize:128,maxGradNorm:5},
    data:'Fresh short trajectories. First eligible disagreement only. Original actual wall plus independently shuffled future walls conditional on actual complete hands; sample count fixed by budget.wallSamples. Pair the two legal actions on every identical wall and continue short to terminal. Store all private traces offline; model inputs whitelist public encoding only. Single uses original wall; average uses every sampled wall equally. Not a public posterior; samples from one root are not independent roots.',
    training:'Two identical paired-return regressors, same public inputs, short initialization, zero heads, optimizer, minibatch order and budget.epochs. Only target differs: single original gain or average gain. Each selects earliest minimum own validation MSE including zero epoch. No comparison of raw MSE across different targets. No extra labels or opponent hands in model inputs.',
    policy:'First short non-reveal discard disagreement with ssl only. Average/single switch iff their respective predicted paired gain is positive; ties short. Always accepts first proposal, baseline rejects; subsequent actions all short. No Hu/kong/reveal changes.',
    primary:'Average-minus-single AND average-minus-short AND average-minus-always AND average-minus-h0-never 95% full-group intervals must all be positive; first three support variance-reduced selection learning.',
    stopping:'Complete fixed collection, both fixed training runs, and all fixed heldout groups, including zero-selected models. No extension, pooling, exam training or automatic promotion. Default H0.'};check(p);return p;
}
export function rolesFor(p,hand){const session=Math.floor(hand/p.budget.sessionHands),roles=SEAT_PERMUTATIONS[session%6],pair=p.pairs[Math.floor(session/6)%3],ids={C:'baseline',P:pair.policies[0],Q:pair.policies[1]};return {target:roles.indexOf('C'),pair:pair.id,roles,policyIds:roles.map(r=>ids[r])};}
export const jobsFor=p=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seeds.evaluation,'session',j.pair.id,j.group);
