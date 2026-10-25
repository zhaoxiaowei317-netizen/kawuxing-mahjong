import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {loadQ} from '../tile-q/model.mjs';
import {loadFastQ,BACKEND_VERSION} from './model.mjs';
import {sha256} from '../provenance.mjs';

// Performance/semantic check on already-public training inputs. These are not
// new training hands or policy-strength games, and never select model weights.
export function benchmark({modelPath,dataPath,repeats=5,limit=256}){
  assert.ok(Number.isInteger(repeats)&&repeats>0&&Number.isInteger(limit)&&limit>0);
  const dataBytes=readFileSync(dataPath),rows=gunzipSync(dataBytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.root).slice(0,limit).map(e=>e.root);assert.ok(rows.length);
  const reference=loadQ(modelPath),fast=loadFastQ(modelPath);assert.equal(reference.sha256,fast.sha256);let checked=0;
  for(const r of rows){assert.deepEqual(fast.model.forward(r.encoded,r.legalIds),reference.model.forward(r.encoded,r.legalIds));checked++;}
  const variants={reference:reference.model,unrolled:fast.model},timings={reference:[],unrolled:[]};
  for(let pass=-1;pass<repeats;pass++)for(const key of pass%2===0?['reference','unrolled']:['unrolled','reference']){
    const start=performance.now();for(const r of rows)variants[key].forward(r.encoded,r.legalIds);const seconds=(performance.now()-start)/1000;if(pass>=0)timings[key].push(seconds);
  }
  const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)],seconds=Object.fromEntries(Object.entries(timings).map(([k,x])=>[k,median(x)]));
  return {backend:BACKEND_VERSION,modelPath:resolve(modelPath),modelSha256:reference.sha256,dataPath:resolve(dataPath),dataSha256:sha256(dataBytes),rows:rows.length,checkedExactForwards:checked,repeats,
    timings,medianSeconds:seconds,medianSpeedup:seconds.reference/seconds.unrolled,scope:'Forward microbenchmark only. Concurrent load affects timings. Not whole-game throughput or AI strength. No frozen study backend changed.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [modelPath,dataPath,out]=process.argv.slice(2),r=benchmark({modelPath,dataPath});if(out)writeFileSync(out,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r));
}
