import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {check as previousCheck,sourceMap as previousSources,read,hash,PAIRS} from '../outs-duration/config.mjs';
import {ARMS,MIX,COMPONENTS} from './policy.mjs';
export {read,hash,PAIRS,ARMS,MIX,COMPONENTS};
export const VERSION='kwx-decision-components-1';
export const sourceMap=()=>({...previousSources(),...Object.fromEntries(['config.mjs','policy.mjs','statistics.mjs','groups.mjs','study.mjs','verify.mjs'].map(f=>['ai/decision-components/'+f,hash(new URL(f,import.meta.url))]))});
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sourceMap,sourceMap());assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.mix,MIX);
  for(const [file,sha]of Object.entries(p.previous.files))assert.equal(hash(resolve(p.previous.path,file)),sha);
  const old=read(resolve(p.previous.path,'plan.json'));previousCheck(old);const m=read(resolve(p.previous.path,'models.json'));
  assert.deepEqual(p.models,{short:m.short,long:m.long});
  for(const x of Object.values(p.models)){assert.equal(hash(x.path),x.sha256);assert.equal(hash(x.state),read(x.path).metadata.optimizerStateSha256);}
  for(const k of ['groupsPerPair','sessionHands','workers','bootstrapSamples','cacheCapacity'])assert.ok(Number.isSafeInteger(p.budget[k])&&p.budget[k]>0);
  assert.notEqual(p.seed,old.seed);assert.deepEqual(p.family,{components:COMPONENTS,alpha:.05,adjustment:'Bonferroni',confidence:1-.05/3});
}
export function makePlan({previous,groupsPerPair=16,sessionHands=16,workers=4,bootstrapSamples=5000,cacheCapacity=2048}){
  previous=resolve(previous);const old=read(resolve(previous,'plan.json')),s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json'));previousCheck(old);
  assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);
  const m=read(resolve(previous,'models.json')),p={version:VERSION,createdAt:new Date().toISOString(),sourceMap:sourceMap(),
    previous:{path:previous,files:Object.fromEntries(['plan.json','summary.json','verification.json','models.json'].map(f=>[f,hash(resolve(previous,f))]))},
    models:{short:m.short,long:m.long},seed:deriveSeed(VERSION,randomBytes(32).toString('hex'),'fresh-component-games'),pairs:PAIRS,arms:ARMS,mix:MIX,
    budget:{groupsPerPair,sessionHands,workers,bootstrapSamples,cacheCapacity},family:{components:COMPONENTS,alpha:.05,adjustment:'Bonferroni',confidence:1-.05/3},
    policy:'Hierarchical other-action/reveal/tile composition from two frozen full-legal Q arrays. Controller chooses full argmax; nondiscard returns it directly. If discard: reveal source chooses best discard flag, tile source chooses best discard within that legal flag. Lower action ID wins ties. No thresholds, H0 fallback, retraining or restricted-mask inference.',
    primary:'Three one-component-long hybrids minus short, conditional on the other two components staying short. Joint whole-group bootstrap with pair-equal weighting; Bonferroni two-sided 98.333333% intervals, family alpha .05. Does not estimate independent causes of the whole long-short gap or interactions.',
    secondary:'Long-minus-short 95% and all subgroups/behavior counts descriptive. No h0-never target arm: no claim to beat the strong reference, no expert promotion or posthoc best-hybrid selection.',
    cache:'Bounded exact-public-encoded-input cache keyed by full legal IDs and complete public encoding, per group/two immutable models. Audit disables cache and recomputes every required Q. Cache metrics excluded from replay-score equality.',
    stopping:'Fixed budgets, six seats and genuine consecutive sessions. No score peeking for early stopping, extension, threshold/model tuning, old exam training or cross-batch subtraction. New unique training/validation hands zero. Default H0.'};check(p);return p;
}
export const jobsFor=p=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seed,'session',j.pair.id,j.group);
