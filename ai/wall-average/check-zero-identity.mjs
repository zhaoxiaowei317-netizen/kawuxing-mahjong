import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {loadQ} from '../tile-q/model.mjs';
import {exactZeroHead} from './policy.mjs';
import {check,read,hash,jobsFor} from './config.mjs';
export function checkZeroIdentity(out){
  out=resolve(out);const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),t=read(resolve(out,'training.json'));check(p);
  if(t.trained.single?.training.selected.epoch!==0)return {applicable:false};
  const model=loadQ(s.models.single.path);assert.equal(model.sha256,s.models.single.sha256);assert.ok(exactZeroHead(model.model));let pairs=0;const groups=[];
  for(const job of jobsFor(p)){
    const path=resolve(out,'groups',job.id),g=read(resolve(path,'group.json')),file=resolve(path,'replays.jsonl.gz');assert.equal(hash(file),g.replaysSha256);assert.deepEqual(g.record.arms.single,g.record.arms.baseline);
    for(const key of ['choices','opportunities','interventions'])assert.equal(g.components.single[key],g.components.baseline[key]);
    const stripped=events=>events.map(({predicted,...rest})=>rest);assert.deepEqual(stripped(g.components.single.events),stripped(g.components.baseline.events));
    const rows=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse),single=new Map();let n=0;
    for(const e of rows){const key=e.permutation+':'+e.hand;if(e.arm==='single')single.set(key,e.replay);if(e.arm==='baseline'){assert.deepEqual(e.replay,single.get(key));n++;}}
    assert.equal(n,6*p.budget.sessionHands);pairs+=n;groups.push({id:job.id,pairs:n,groupSha256:hash(resolve(path,'group.json')),replaysSha256:g.replaysSha256});
  }
  return {applicable:true,sourceSha256:hash(fileURLToPath(import.meta.url)),planSha256:s.planSha256,summarySha256:hash(resolve(out,'summary.json')),singleModelSha256:model.sha256,
    zeroHeadProvesGlobalShortPolicyIdentity:true,recordedActionReplayPairsIdentical:pairs,allGroupMetricsAndChoicesIdentical:true,groups,
    scope:'Additional cross-arm identity check of produced outputs, not an independent strength replication or additional games. Full uncached policy/deal rerun is performed separately by the frozen verifier.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [out,path]=process.argv.slice(2),r=checkZeroIdentity(out);if(path)writeFileSync(path,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({applicable:r.applicable,pairs:r.recordedActionReplayPairsIdentical,allIdentical:r.allGroupMetricsAndChoicesIdentical}));
}
