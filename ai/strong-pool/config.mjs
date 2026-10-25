import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256,projectRoot,verifyFrozenBaseline} from '../provenance.mjs';
import {sources as coreSources,assertSources} from '../tile-q/sources.mjs';
import {policyById} from '../policies/index.mjs';
import {policyFor} from '../reveal-study/policies.mjs';
import {parallel} from '../tile-q/study.mjs';

export const VERSION='kwx-strong-pool-1';
export const N='h0-never';
export const ARMS=Object.freeze(['bc','offline']);
export const TABLES=Object.freeze([[N,N,N],[N,'H0','H0'],[N,N,'H0'],[N,'greedy-speed-v1','H0']].map(Object.freeze));
export const PAIRS=Object.freeze([
  {id:'never+H0',policies:[N,'H0']},
  {id:'never+never',policies:[N,N]},
  {id:'never+greedy',policies:[N,'greedy-speed-v1']},
]);
export const hash=p=>sha256(readFileSync(p));
export const read=p=>JSON.parse(readFileSync(p,'utf8'));
export const selector=id=>id===N?policyFor(N,null):policyById(id);
export const factories=model=>({[N]:()=>selector(N),learner:()=>(o,legal)=>model.select(o,legal)});
export async function pooled(jobs,concurrency,fn){let next=0;await parallel(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{while(next<jobs.length)await fn(jobs[next++]);}));}
export function rolesFor(hand,sessionHands){
  const session=Math.floor(hand/sessionHands),table=TABLES[session%TABLES.length],rotation=Math.floor(session/TABLES.length)%3;
  return [0,1,2].map(seat=>({id:table[(seat+rotation)%3],learner:true}));
}
export function drivers(){return Object.fromEntries(['config.mjs','collect.mjs','evaluate.mjs','study.mjs','verify.mjs',
  '../reveal-study/policies.mjs'].map(f=>[resolve(projectRoot,'ai/strong-pool',f),hash(new URL(f,import.meta.url))]));}
export function sources(){return {core:coreSources(),drivers:drivers()};}
export function check(p){
  assert.equal(p.version,VERSION);assertSources(p.sources.core);assert.deepEqual(p.sources.drivers,drivers());
  assert.deepEqual(p.baseline,verifyFrozenBaseline());assert.deepEqual(p.tables,TABLES);assert.deepEqual(p.pairs,PAIRS);
  assert.deepEqual(p.arms,ARMS);assert.equal(p.incumbent,N);assert.equal(p.primaryArm,'offline');
  if(p.previous){for(const n of ['plan','summary','verification'])assert.equal(hash(resolve(p.previous.path,n+'.json')),p.previous[n+'Sha256']);}
}
