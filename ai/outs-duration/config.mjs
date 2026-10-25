import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {projectRoot} from '../provenance.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {check as previousCheck,sourceMap as previousSources,read,hash,PAIRS,N} from '../outs-anchor/config.mjs';
export {read,hash,PAIRS,N};
export const VERSION='kwx-outs-duration-1';
export const NEURAL=Object.freeze(['long','short','raw']),ARMS=Object.freeze([...NEURAL,'reference']);
export const CONTRASTS=Object.freeze({duration:'short',strength:'reference',original:'raw'});
export const sourceMap=()=>({...previousSources(),...Object.fromEntries(['config.mjs','groups.mjs','study.mjs','verify.mjs','check_prefix.py'].map(f=>['ai/outs-duration/'+f,hash(new URL(f,import.meta.url))]))});
const previousFiles=['plan.json','summary.json','verification.json','training.json','models.json','train-plain.json','model-plain/summary.json'];
export function dataMap(previous){return Object.fromEntries(['training','validation'].flatMap(split=>['canonical','corrected','self'].map(label=>{
  const path=resolve(previous,split,label),m=read(resolve(path,'manifest.json'));
  return [split+'/'+label,{path,manifestSha256:hash(resolve(path,'manifest.json')),sha256:m.sha256,hands:m.hands,samples:m.samples}];
})));}
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sourceMap,sourceMap());assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.contrasts,CONTRASTS);
  for(const [name,sha]of Object.entries(p.previous.files))assert.equal(hash(resolve(p.previous.path,name)),sha);
  const old=read(resolve(p.previous.path,'plan.json'));previousCheck(old);
  assert.deepEqual(p.data,dataMap(p.previous.path));assert.deepEqual(p.model,old.model);
  assert.deepEqual(p.short,read(resolve(p.previous.path,'models.json')).plain);
  assert.equal(hash(p.short.path),p.short.sha256);assert.equal(hash(p.short.state),p.shortStateSha256);
  assert.equal(p.budget.shortEpochs,old.budget.epochs);assert.ok(p.budget.epochs>p.budget.shortEpochs);
  for(const k of ['epochs','groupsPerPair','sessionHands','workers','bootstrapSamples'])assert.ok(Number.isSafeInteger(p.budget[k])&&p.budget[k]>0);
  assert.notEqual(p.seed,old.seeds.evaluation);assert.deepEqual(p.trainingSeed,old.seeds.model);
  assert.equal(p.primary,'Both long-minus-short and long-minus-reference complete-group two-sided 95% intervals must be strictly positive.');
}
export function makePlan({previous,python='python',epochs=32,groupsPerPair=16,sessionHands=16,workers=4,bootstrapSamples=5000}){
  previous=resolve(previous);const old=read(resolve(previous,'plan.json'));previousCheck(old);
  const s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json')),short=read(resolve(previous,'models.json')).plain;
  assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);
  const p={version:VERSION,createdAt:new Date().toISOString(),sourceMap:sourceMap(),python,
    previous:{path:previous,files:Object.fromEntries(previousFiles.map(n=>[n,hash(resolve(previous,n))]))},data:dataMap(previous),
    model:old.model,short,shortStateSha256:hash(short.state),pairs:PAIRS,arms:ARMS,contrasts:CONTRASTS,
    seed:deriveSeed(VERSION,randomBytes(32).toString('hex'),'fresh-evaluation'),trainingSeed:old.seeds.model,
    budget:{shortEpochs:old.budget.epochs,epochs,groupsPerPair,sessionHands,workers,bootstrapSamples},
    training:'Reuse exactly the prior corrected training and validation datasets, initialization, seed, Adam reset, batch order and frozen plain trainer. Rerun from epoch 0 through 32 by default without optimizer reset at epoch 8. No new unique collection hands. No returns/rank loss or inference guard.',
    prefix:'Before games compare every epoch 0..shortEpochs exported parameter and training/validation metric exactly with frozen prior plain training; independently compare Python model and Adam state, ignoring provenance/path metadata only. Abort on mismatch.',
    selection:'Minimum fixed validation corrected CE including epoch 0; earliest ties at tolerance 1e-12. Fixed full training budget; select once before any fresh games. Short control remains frozen prior selected plain model.',
    primary:'Both long-minus-short and long-minus-reference complete-group two-sided 95% intervals must be strictly positive.',
    secondary:'Long-minus-raw, subgroups and fixed validation agreement are descriptive without multiplicity correction. Shared long trajectories are not independent replications.',
    stopping:'Complete fixed evaluation budget regardless of scores; equal opponent-pair weights; whole six-seat continuous-session groups are bootstrap units. No score-based checkpoint choice, posthoc enlargement, old exam training, automatic promotion or cross-batch subtraction. Default H0.'};
  check(p);return p;
}
export const jobsFor=p=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seed,'session',j.pair.id,j.group);
export function trainSpec(out,p){return {...read(resolve(p.previous.path,'train-plain.json')),out:resolve(out,'model-long'),epochs:p.budget.epochs,experimentSources:p.sourceMap};}
export function checkData(p){for(const x of Object.values(p.data))assert.equal(hash(resolve(x.path,'episodes.jsonl.gz')),x.sha256);}
