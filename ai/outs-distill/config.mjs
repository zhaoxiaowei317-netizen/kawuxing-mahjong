import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {PROTOCOL_VERSION,SEAT_PERMUTATIONS} from '../runner.mjs';
import {sources as coreSources} from '../tile-q/sources.mjs';
import {SCHEMA} from '../tile-q/encoding.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {check as guardCheck,sources as guardSources} from '../outs-guard/study.mjs';
import {read,hash,PAIRS} from '../strong-pool/config.mjs';
export {read,hash,PAIRS};
export const VERSION='kwx-outs-distill-1';
export const STUDENTS=Object.freeze(['corrected','self']);
export const ARMS=Object.freeze([...STUDENTS,'raw']);
export const CONTRASTS=Object.freeze({improvement:'raw',labelEffect:'self'});
export const sources=()=>({previous:guardSources(),drivers:Object.fromEntries(['config.mjs','collect.mjs','groups.mjs','study.mjs','verify.mjs',
  '../strong-pool/stream-data.mjs','../tile-q/verify.mjs'].map(f=>[f,hash(new URL(f,import.meta.url))]))});
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sources,sources());assert.deepEqual(p.coreSources,coreSources());
  assert.deepEqual(p.schema,SCHEMA);assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.contrasts,CONTRASTS);
  for(const n of ['plan','summary','verification'])assert.equal(hash(resolve(p.previous.path,n+'.json')),p.previous[n+'Sha256']);
  const old=read(resolve(p.previous.path,'plan.json'));guardCheck(old);assert.deepEqual(p.model,old.model);assert.equal(p.modelStateSha256,old.modelStateSha256);
  const q=loadQ(p.model.path);assert.equal(q.sha256,p.model.sha256);assert.equal(hash(p.model.state),p.modelStateSha256);assert.deepEqual(p.network,q.data.config);
  for(const n of Object.values(p.budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(p.budget.workers<=8);
  assert.equal(p.budget.trainingHands%(p.budget.workers*18*p.budget.sessionHands),0);assert.equal(p.budget.validationHands%(18*p.budget.sessionHands),0);
  assert.equal(new Set(Object.values(p.seeds)).size,4);assert.ok(Object.values(p.seeds).every(s=>typeof s==='string'&&s));
  assert.deepEqual(p.optimizer,{learningRate:.001,batchSize:256,maxGradNorm:5,cqlWeight:0,bcWeight:0,auxWeight:0});assert.equal(p.epsilon,.05);
}
export function makePlan({previous,python='python',trainingHands=4608,validationHands=576,epochs=8,groupsPerPair=16,sessionHands=16,workers=4,bootstrapSamples=5000}){
  previous=resolve(previous);const old=read(resolve(previous,'plan.json')),s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json'));guardCheck(old);
  assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);assert.deepEqual(v.sources,old.sources);
  const nonce=randomBytes(32).toString('hex');
  const p={version:VERSION,createdAt:new Date().toISOString(),sources:sources(),coreSources:coreSources(),schema:SCHEMA,python,
    previous:{path:previous,...Object.fromEntries(['plan','summary','verification'].map(n=>[n+'Sha256',hash(resolve(previous,n+'.json'))]))},
    model:old.model,modelStateSha256:old.modelStateSha256,network:loadQ(old.model.path).data.config,pairs:PAIRS,arms:ARMS,contrasts:CONTRASTS,
    budget:{trainingHands,validationHands,epochs,groupsPerPair,sessionHands,workers,bootstrapSamples},epsilon:.05,
    optimizer:{learningRate:.001,batchSize:256,maxGradNorm:5,cqlWeight:0,bcWeight:0,auxWeight:0},
    seeds:Object.fromEntries(['training','validation','model','evaluation'].map(k=>[k,deriveSeed(VERSION,nonce,k)])),
    data:'Fresh raw-network behavior with 5% uniform legal exploration at the learner only. Rotate three opponent pairs and all six seat permutations over whole sessions. Only learner observations contribute. Both labels share every input, trajectory and split; corrected uses the frozen public-outs guard, self uses raw greedy Q.',
    training:'Both initialize the same original PT weights and reset Adam. Eight fixed pure-BC epochs by default; same RNG, optimizer, batches and update count. Terminal returns/ranks are recorded for audit, have zero loss weight, and do not attribute raw behavior returns to counterfactual teacher actions.',
    selection:'Each student independently takes minimum fixed-label validation cross entropy including epoch 0, earliest ties. No score-based model selection or hyperparameter tuning. Both frozen before evaluation.',
    primary:'Joint claim requires BOTH corrected-minus-raw and corrected-minus-self full two-sided 95% paired-group bootstrap intervals strictly above zero (intersection-union test). One positive contrast alone is insufficient. Equal opponent-pair weights, complete six-seat groups; no hands-as-independent bootstrap.',
    secondary:'All subgroup, behavior and agreement metrics descriptive. Raw trajectory is shared across contrasts and is not independent replication. No direct h0-never strength contrast in this experiment.',
    stopping:'Complete all fixed budgets regardless of results. Fresh evaluation root, no evaluation episodes used to train. All three actors use their own full-legal-mask neural Q directly, with no guard/H0 inference fallback. No auto promotion; production H0.'};check(p);return p;
}
export function rolesFor(p,hand){const session=Math.floor(hand/p.budget.sessionHands),pair=p.pairs[session%3],permutation=Math.floor(session/3)%6;
  const roles=SEAT_PERMUTATIONS[permutation],ids={C:'raw',P:pair.policies[0],Q:pair.policies[1]};return {pair:pair.id,permutation,roles,policyIds:roles.map(r=>ids[r]),target:roles.indexOf('C')};}
export const jobsFor=p=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seeds.evaluation,'session',j.pair.id,j.group);
export function trainSpec(out,p,arm){assert.ok(STUDENTS.includes(arm));return {out:resolve(out,`model-${arm}`),schema:p.schema,sources:p.coreSources,seed:p.seeds.model,
  trainingData:resolve(out,'training',arm),validationData:resolve(out,'validation',arm),network:p.network,config:p.optimizer,mode:'bc',epochs:p.budget.epochs,initialize:p.model.state};}
