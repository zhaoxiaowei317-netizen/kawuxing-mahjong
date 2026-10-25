import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,projectRoot} from '../provenance.mjs';
import {generate} from './collect.mjs';
import {configureGeometryCache,geometryCacheMetrics} from './geometry.mjs';
import {build} from './build.mjs';
export async function auditBenchmark({benchmarkPath,onProgress=()=>{}}){
  const bytes=readFileSync(benchmarkPath),r=JSON.parse(bytes);assert.equal(r.allFullEpisodeStructuresIdentical,true);build({verify:true});
  for(const [name,expected]of Object.entries(r.backendSources))assert.equal(sha256(readFileSync(resolve(projectRoot,name))),expected);
  const cases=[];
  for(const capacity of [0,1,32768])for(const row of r.results){configureGeometryCache(capacity);const episodes=[];
    for await(const e of generate({plan:row.plan,split:'training',startHand:0,hands:row.variants.reference.hands}))episodes.push(e);
    const actual=sha256(JSON.stringify(episodes));assert.equal(actual,row.variants.reference.traceSha256);assert.equal(actual,row.variants.memoized.traceSha256);
    const metrics=geometryCacheMetrics();if(capacity===0)assert.equal(metrics.distance.hits+metrics.waits.hits,0);
    assert.ok(metrics.waits.size<=capacity&&metrics.distance.size<=capacity);cases.push({capacity,repeat:row.repeat,hands:episodes.length,traceSha256:actual,metrics});onProgress({capacity,repeat:row.repeat,matched:true});
  }
  build({verify:true});return {benchmarkSha256:sha256(bytes),sourceSha256:sha256(readFileSync(fileURLToPath(import.meta.url))),allOriginalTraceHashesRecomputed:true,capacities:[0,1,32768],cases};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [benchmarkPath,out]=process.argv.slice(2);auditBenchmark({benchmarkPath,onProgress:p=>console.log(JSON.stringify(p))}).then(r=>{if(out)writeFileSync(out,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({complete:true,cases:r.cases.length}));}).catch(e=>{console.error(e);process.exitCode=1;});
}
