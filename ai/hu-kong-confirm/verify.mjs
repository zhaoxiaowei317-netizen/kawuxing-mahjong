import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verify as verifyTrial} from '../hu-kong/verify.mjs';
import {save} from '../tile-q/collect.mjs';
import {check,checkSummary,read,hash} from './config.mjs';
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');const {p,s}=checkSummary(out);
  const v=await verifyTrial({out:resolve(out,'trial'),onProgress});check(p);checkSummary(out);assert.equal(v.games,s.games);
  const result={completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),summarySha256:hash(resolve(out,'summary.json')),
    bindingSha256:hash(resolve(out,'binding.json')),trialVerificationSha256:hash(resolve(out,'trial/verification.json')),
    sourceMap:p.sourceMap,games:v.games,allGroupsRecomputedWithoutScoreCache:v.allGroupsRecomputedWithoutScoreCache,groups:v.groups};
  save(resolve(out,'verification.json'),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))verify({out:process.argv[2],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
