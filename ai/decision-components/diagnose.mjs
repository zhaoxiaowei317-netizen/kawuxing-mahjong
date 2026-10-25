// Posthoc descriptive transition inventory. Never used for training or primary tests.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {MahjongEnvironment,actionKey} from '../environment.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {worker} from '../tile-q/study.mjs';
import {save} from '../tile-q/collect.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {check,jobsFor,read,hash} from './config.mjs';
const category=a=>a.type==='kong'?a.kind:a.type;
export async function inspectGroup({path,plan:p}){
  check(p);const g=read(resolve(path,'group.json')),file=resolve(path,'replays.jsonl.gz');assert.equal(hash(file),g.replaysSha256);
  const {model,sha256}=loadQ(p.models.short.path);assert.equal(sha256,p.models.short.sha256);
  const episodes=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.arm==='other');
  const changes=[];let previous=null,choices=0,huOffered=0,huDeclined=0;
  for(const e of episodes){
    if(e.hand===0)previous=null;const before=previous?[...previous.totals]:[0,0,0],env=new MahjongEnvironment({seed:e.replay.seed,previous});
    assert.deepEqual(env.auditState(),e.replay.initialState);const target=e.roles.indexOf('C');
    for(const [decision,entry]of e.replay.actions.entries()){
      assert.equal(env.actor,entry.seat);if(env.actor===target){const legal=env.legalActions();
        if(legal.length>1){choices++;const short=model.select(env.observation(),legal);
          if(legal.some(a=>a.type==='hu')){huOffered++;huDeclined+=Number(entry.action.type!=='hu');}
          if(actionKey(short)!==actionKey(entry.action))changes.push({jobId:g.job.id,permutation:e.permutation,hand:e.hand,decision,
            from:short,to:entry.action,transition:category(short)+' → '+category(entry.action),huAvailable:legal.some(a=>a.type==='hu')});
        }
      }env.step(entry.action);
    }
    assert.equal(env.done,true);const result=env.result();assert.deepEqual(result,e.replay.result);
    previous={dealer:result.next.dealer,seats:result.next.seats,totals:before.map((v,i)=>v+result.delta[i]),round:e.hand+2};
  }
  assert.equal(episodes.length,6*p.budget.sessionHands);assert.equal(choices,g.components.other.choices);assert.equal(changes.length,g.components.other.changedFromShort);
  assert.equal(huOffered,g.components.other.huOffered);assert.equal(huDeclined,g.components.other.huDeclined);
  return {jobId:g.job.id,choices,changes,huOffered,huDeclined,replaysSha256:g.replaysSha256};
}
export async function diagnose({out,onProgress=()=>{}}){
  out=resolve(out);const p=read(resolve(out,'plan.json'));check(p);const results=[],jobs=jobsFor(p);
  await pooled(jobs,p.budget.workers,async job=>{
    const spec=resolve(out,'.specs','diagnose-'+job.id+'.json'),result=resolve(out,'.specs','diagnose-'+job.id+'.result.json');
    save(spec,{path:resolve(out,'groups',job.id),plan:p,result});await worker(process.execPath,[fileURLToPath(import.meta.url),'group',spec]);results.push(read(result));
    onProgress({stage:'posthoc-transition-inventory',completedGroups:results.length,totalGroups:jobs.length});
  });
  const changes=results.flatMap(r=>r.changes).sort((a,b)=>a.jobId.localeCompare(b.jobId)||a.permutation-b.permutation||a.hand-b.hand||a.decision-b.decision),transitions={};
  for(const x of changes)transitions[x.transition]=(transitions[x.transition]||0)+1;
  const d={completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),driverSha256:hash(fileURLToPath(import.meta.url)),
    role:'Posthoc descriptive same-public-state comparisons on other-policy trajectories. No per-action payoff attribution, training labels, extra test, model selection or primary claim.',
    groups:results.length,choices:results.reduce((n,r)=>n+r.choices,0),changes,transitions,huOffered:results.reduce((n,r)=>n+r.huOffered,0),huDeclined:results.reduce((n,r)=>n+r.huDeclined,0)};
  save(resolve(out,'transition-diagnostics.json'),d);return d;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const task=process.argv[2]==='group'?inspectGroup(read(process.argv[3])).then(r=>save(read(process.argv[3]).result,r)):
    diagnose({out:process.argv[2],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
