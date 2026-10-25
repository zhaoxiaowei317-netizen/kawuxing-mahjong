import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makePlan} from '../wall-average/config.mjs';
import {generate as originalGenerate,counts,add} from '../wall-average/collect.mjs';
import {generate as fastGenerate} from './collect.mjs';
import {configureGeometryCache,geometryCacheMetrics} from './geometry.mjs';
import {build} from './build.mjs';
import {sha256} from '../provenance.mjs';

export async function benchmarkSimulator({previous,repeats=3,hands=16,capacity=32768,onProgress=()=>{}}){
  assert.ok(Number.isInteger(repeats)&&repeats>0);assert.ok(Number.isInteger(hands)&&hands>0&&hands%16===0);build({verify:true});
  const plans=Array.from({length:repeats},()=>makePlan({previous,trainingHands:64,validationHands:16,epochs:1,groupsPerPair:1,sessionHands:16,workers:4,bootstrapSamples:30,cacheCapacity:2048,wallSamples:8})),results=[];
  for(let repeat=0;repeat<repeats;repeat++){
    const plan=plans[repeat],episodes={},rows={};
    for(const variant of repeat%2===0?['reference','memoized']:['memoized','reference']){
      configureGeometryCache(variant==='memoized'?capacity:0);const start=performance.now(),list=[],c=counts();
      for await(const e of (variant==='memoized'?fastGenerate:originalGenerate)({plan,split:'training',startHand:0,hands})){list.push(e);add(c,e);}
      rows[variant]={seconds:(performance.now()-start)/1000,...c,cache:geometryCacheMetrics(),traceSha256:sha256(JSON.stringify(list))};episodes[variant]=list;
      onProgress({repeat,variant,seconds:rows[variant].seconds,hands:c.hands,roots:c.roots,branches:c.extraBranches});
    }
    assert.deepEqual(episodes.memoized,episodes.reference);assert.equal(rows.memoized.traceSha256,rows.reference.traceSha256);results.push({repeat,plan,variants:rows,wholeCollectionSpeedup:rows.reference.seconds/rows.memoized.seconds});
  }
  build({verify:true});return {technicalVerificationOnly:true,excludedFromTrainingAndFormalEvaluation:true,
    scope:'Same original network and exact full public features; only bounded pure-geometry memoization differs. Includes complete short trajectories and 15 branches per root. Alternating execution order, independent preallocated plans, cold geometry cache each run. Concurrent-load timings are descriptive, not a strength result.',
    backendSources:Object.fromEntries(['geometry.mjs','build.mjs','selector.mjs','benchmark.mjs','manifest.json'].map(name=>['ai/simulator-fast/'+name,sha256(readFileSync(new URL(name,import.meta.url)))])),results,
    allMainHandsMatched:results.reduce((n,r)=>n+r.variants.reference.hands,0),allExtraBranchesMatched:results.reduce((n,r)=>n+r.variants.reference.extraBranches,0),
    allFullEpisodeStructuresIdentical:true,medianSpeedup:results.map(r=>r.wholeCollectionSpeedup).sort((a,b)=>a-b)[Math.floor(results.length/2)]};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [previous,out]=process.argv.slice(2);benchmarkSimulator({previous,onProgress:p=>console.log(JSON.stringify(p))}).then(r=>{if(out)writeFileSync(out,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({complete:true,medianSpeedup:r.medianSpeedup,mainHands:r.allMainHandsMatched,branches:r.allExtraBranchesMatched}));}).catch(e=>{console.error(e);process.exitCode=1;});
}
