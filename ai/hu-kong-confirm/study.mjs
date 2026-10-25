import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {save} from '../tile-q/collect.mjs';
import {run as runTrial} from '../hu-kong/study.mjs';
import {makePlan,check,checkBinding,summaryFor,read,hash} from './config.mjs';
export async function run({out,discovery,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(out))throw Error('Confirmation output exists');const p=makePlan({discovery}),{d}=check(p);
  mkdirSync(out,{recursive:true});save(resolve(out,'plan.json'),p);
  await runTrial({out:resolve(out,'trial'),previous:d.previous.path,...p.budget,onProgress:event=>{
    if(event.stage==='plan'){
      save(resolve(out,'binding.json'),{createdAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),trialPlanSha256:hash(resolve(out,'trial/plan.json'))});
      checkBinding(out,p);
    }onProgress(event);
  }});
  check(p);const s=summaryFor(out,p);save(resolve(out,'summary.json'),s);return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],discovery:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(s=>console.log(JSON.stringify({complete:true,mechanismReplicated:s.mechanismReplicated,outcomes:s.outcomes}))).catch(e=>{console.error(e);process.exitCode=1;});
