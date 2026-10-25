import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {check as previousCheck,sourceMap as previousSources,read,hash,PAIRS} from '../decision-components/config.mjs';
import {ARMS,NEURAL} from './policy.mjs';
export {read,hash,PAIRS,ARMS,NEURAL};
export const VERSION='kwx-hu-kong-1';
export const CONTRASTS=Object.freeze({mechanism:'base',strength:'reference',short:'short'});
export const sourceMap=()=>({...previousSources(),'ai/decision-components/diagnose.mjs':hash(new URL('../decision-components/diagnose.mjs',import.meta.url)),
  ...Object.fromEntries(['config.mjs','policy.mjs','groups.mjs','study.mjs','verify.mjs'].map(f=>['ai/hu-kong/'+f,hash(new URL(f,import.meta.url))]))});
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sourceMap,sourceMap());assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.contrasts,CONTRASTS);
  for(const [f,sha]of Object.entries(p.previous.files))assert.equal(hash(resolve(p.previous.path,f)),sha);
  const old=read(resolve(p.previous.path,'plan.json'));previousCheck(old);assert.deepEqual(p.models,old.models);assert.notEqual(p.seed,old.seed);
  for(const x of Object.values(p.models)){assert.equal(hash(x.path),x.sha256);assert.equal(hash(x.state),read(x.path).metadata.optimizerStateSha256);}
  for(const k of ['groupsPerPair','sessionHands','workers','bootstrapSamples','cacheCapacity'])assert.ok(Number.isSafeInteger(p.budget[k])&&p.budget[k]>0);
  assert.equal(p.rule,'Override lss only when short full-legal argmax is hu AND lss chooses ming/an/bu; choose that legal short hu. Everything else remains lss.');
  assert.equal(p.primary,'Both patched-minus-base and patched-minus-h0-never two-sided 95% complete-group intervals must be strictly positive (intersection-union).');
}
export function makePlan({previous,groupsPerPair=32,sessionHands=16,workers=4,bootstrapSamples=5000,cacheCapacity=2048}){
  previous=resolve(previous);const old=read(resolve(previous,'plan.json')),s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json'));previousCheck(old);
  assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);
  const diagnostic=read(resolve(previous,'transition-diagnostics.json'));assert.equal(diagnostic.planSha256,s.planSha256);
  const p={version:VERSION,createdAt:new Date().toISOString(),sourceMap:sourceMap(),
    previous:{path:previous,files:Object.fromEntries(['plan.json','summary.json','verification.json','models.json','transition-diagnostics.json'].map(f=>[f,hash(resolve(previous,f))]))},
    models:old.models,seed:deriveSeed(VERSION,randomBytes(32).toString('hex'),'fresh-hu-kong-games'),pairs:PAIRS,arms:ARMS,contrasts:CONTRASTS,
    budget:{groupsPerPair,sessionHands,workers,bootstrapSamples,cacheCapacity},
    rule:'Override lss only when short full-legal argmax is hu AND lss chooses ming/an/bu; choose that legal short hu. Everything else remains lss.',
    context:'Base is previous other=lss, not the whole long=lll model. Short discard/reveal remain fixed. Rule is conditional use of an existing frozen choice, not must-hu, retraining or per-state expected-value estimation.',
    primary:'Both patched-minus-base and patched-minus-h0-never two-sided 95% complete-group intervals must be strictly positive (intersection-union).',
    secondary:'Patched-minus-short, opponent subgroups, trigger counts and Hu/kong scores descriptive without multiplicity correction. Shared patched trajectories are not independent replications.',
    stopping:'Complete all 96 groups by default regardless of interim scores or rare-trigger counts. Pair-equal full-group bootstrap; no extra hands to obtain significance, no old exam training, cross-batch subtraction, model/threshold tuning or automatic promotion. Default H0.',
    cache:'Exact complete-public-input/whole-legal-mask cache, 2048 entries by default, immutable models. Full replay auditor disables cache and compares all counters/events and scores. New training/validation/optimization updates zero.'};check(p);return p;
}
export const jobsFor=p=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seed,'session',j.pair.id,j.group);
