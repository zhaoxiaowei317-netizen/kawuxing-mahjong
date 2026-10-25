import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadQ} from '../tile-q/model.mjs';
import {loadFastQ,BACKEND_VERSION} from './model.mjs';
import {factories} from '../paired-tile/policy.mjs';
import {runEvaluation} from '../runner.mjs';
import {N,PAIRS} from '../strong-pool/config.mjs';
import {sha256} from '../provenance.mjs';

export async function auditFastBackend({modelsPath,sessionHands=8}){
  const descriptors=JSON.parse(readFileSync(modelsPath,'utf8')),reference={},fast={},hashes={},calls={short:0,long:0,learned:0};
  for(const name of ['short','long','learned']){
    const a=loadQ(descriptors[name].path),b=loadFastQ(descriptors[name].path);assert.equal(a.sha256,b.sha256);assert.equal(a.sha256,descriptors[name].sha256);hashes[name]=a.sha256;reference[name]=a.model;
    fast[name]={forward(encoded,ids){const expected=a.model.forward(encoded,ids),actual=b.model.forward(encoded,ids);assert.deepEqual(actual,expected);calls[name]++;return actual;}};
  }
  const f1=factories(reference,0),f2=factories(fast,0),traces=new Map();let matched=0;
  const r=await runEvaluation({candidate:'unrolled',incumbent:'reference',seed:'fast-backend-semantic-only-v1',split:'development',independentGroups:0,sessionGroups:1,sessionHands,
    opponentPairs:PAIRS,bootstrapSamples:30,policyFactories:{[N]:f1.policies.reference,reference:f1.policies.learned,unrolled:f2.policies.learned},
    onEpisode:e=>{const key=JSON.stringify([e.opponentPair,e.permutation,e.hand]);if(e.arm==='candidate')traces.set(key,e.replay);else{assert.deepEqual(e.replay,traces.get(key));matched++;}}});
  for(const row of r.records)assert.deepEqual(row.candidate,row.incumbent);assert.equal(r.totalGames,matched*2);
  return {backend:BACKEND_VERSION,modelHashes:hashes,technicalVerificationOnly:true,notNewPolicyStrengthGames:true,fullReplayPairsMatched:matched,actualTechnicalGames:r.totalGames,
    checkedForwardCalls:calls,allForwardOutputsBitIdentical:true,allActionTracesAndResultsIdentical:true,scoreCacheCapacity:0,sourceSha256:sha256(readFileSync(new URL('./model.mjs',import.meta.url)))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [modelsPath,out]=process.argv.slice(2);auditFastBackend({modelsPath}).then(r=>{if(out)writeFileSync(out,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r));}).catch(e=>{console.error(e);process.exitCode=1;});
}
