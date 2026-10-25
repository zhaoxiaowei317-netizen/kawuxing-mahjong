import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {SCHEMA} from './features.mjs';
import {check as checkParent,sourceMap as oldSources} from '../wall-average/config.mjs';
import {read,hash,PAIRS,N} from '../strong-pool/config.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
export {read,hash,PAIRS,N};
export const VERSION='kwx-confidence-return-gate-1';
export const ARMS=Object.freeze(['gate','average','always','baseline','reference']);
export const CONTRASTS=Object.freeze({representation:'average',improvement:'baseline',selection:'always',strength:'reference'});
export const LAMBDAS=Object.freeze([.001,.01,.1,1,10,100]);
export const sourceMap=()=>({...oldSources(),...Object.fromEntries(['config.mjs','features.mjs','model.mjs','policy.mjs','data.mjs','groups.mjs','study.mjs','verify.mjs','train.py'].map(f=>['ai/confidence-gate/'+f,hash(new URL(f,import.meta.url))]))});
const parentFiles=['plan.json','summary.json','verification.json','models.json','training.json','diagnostics.json'];
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sourceMap,sourceMap());assert.deepEqual(p.schema,SCHEMA);assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.contrasts,CONTRASTS);assert.deepEqual(p.pairs,PAIRS);
  assert.deepEqual(Object.keys(p.previous.files).sort(),[...parentFiles].sort());for(const [name,expected]of Object.entries(p.previous.files))assert.equal(hash(resolve(p.previous.path,name)),expected);
  const parent=read(resolve(p.previous.path,'plan.json')),s=read(resolve(p.previous.path,'summary.json')),v=read(resolve(p.previous.path,'verification.json'));checkParent(parent);
  assert.equal(s.status,'evaluated');assert.equal(s.planSha256,p.previous.files['plan.json']);assert.equal(v.planSha256,s.planSha256);assert.deepEqual(s.models,read(resolve(p.previous.path,'models.json')));
  assert.ok(v.allGroupsRecomputedWithoutScoreCache);assert.equal(v.summarySha256,p.previous.files['summary.json']);assert.equal(v.games,s.games);assert.deepEqual(v.sourceMap,parent.sourceMap);assert.equal(v.trainingSnapshotsRecomputed,2*(parent.budget.epochs+1));
  assert.deepEqual(p.models,Object.fromEntries(['short','long','average'].map(k=>[k,s.models[k]])));
  for(const m of Object.values(p.models)){assert.equal(hash(m.path),m.sha256);assert.equal(hash(m.state),read(m.path).metadata.optimizerStateSha256);}
  assert.deepEqual(p.fit,{lambdas:LAMBDAS,tieTolerance:1e-12,featureScale:'Training means and population standard deviation; <=1e-12 becomes one; no validation statistics.'});
  for(const n of Object.values(p.budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(p.budget.workers<=8);
  assert.equal(p.primary,'Gate-minus-average AND gate-minus-short AND gate-minus-always support feature selection learning only if all three 95% full-group intervals are positive; all four including gate-minus-N support the overall joint claim.');
  assert.equal(p.stopping,'Fit all fixed candidates and select by validation MSE. If all selected weights are exactly zero, prove global identity to Short or Always and skip heldout. Otherwise finish all preallocated groups. No extension, pooling, exam training or automatic promotion. Default H0.');
}
export function makePlan({previous,python='python',groupsPerPair=16,sessionHands=16,workers=4,bootstrapSamples=5000,cacheCapacity=2048}){
  previous=resolve(previous);const s=read(resolve(previous,'summary.json')),nonce=randomBytes(32).toString('hex');
  const p={version:VERSION,createdAt:new Date().toISOString(),sourceMap:sourceMap(),previous:{path:previous,files:Object.fromEntries(parentFiles.map(name=>[name,hash(resolve(previous,name))]))},
    models:Object.fromEntries(['short','long','average'].map(k=>[k,s.models[k]])),schema:SCHEMA,python,arms:ARMS,contrasts:CONTRASTS,pairs:PAIRS,
    fit:{lambdas:LAMBDAS,tieTolerance:1e-12,featureScale:'Training means and population standard deviation; <=1e-12 becomes one; no validation statistics.'},
    budget:{groupsPerPair,sessionHands,workers,bootstrapSamples,cacheCapacity},seeds:{evaluation:deriveSeed(VERSION,nonce,'evaluation')},
    data:'Reuse only parent training/validation main-hand roots and their equally averaged wall-paired labels. All public teacher-confidence features recomputed; no parent evaluation data, no new collection hands. Parent complete uncached data audit is pinned and inherited.',
    training:'Fixed six ridge regularizations, zero and training-mean constants; standardize using training only, unpenalized intercept. Fixed public feature schema includes full-mask short/long score margins, candidate features and public context. Select minimum validation MSE, earliest tolerance 1e-12. Not additional gradient training of either CNN.',
    primary:'Gate-minus-average AND gate-minus-short AND gate-minus-always support feature selection learning only if all three 95% full-group intervals are positive; all four including gate-minus-N support the overall joint claim.',
    stopping:'Fit all fixed candidates and select by validation MSE. If all selected weights are exactly zero, prove global identity to Short or Always and skip heldout. Otherwise finish all preallocated groups. No extension, pooling, exam training or automatic promotion. Default H0.'};check(p);return p;
}
export const jobsFor=p=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seeds.evaluation,'session',j.pair.id,j.group);
