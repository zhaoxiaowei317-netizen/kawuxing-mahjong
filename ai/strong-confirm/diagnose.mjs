import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {MahjongEnvironment,actionKey} from '../environment.mjs';
import {handEfficiency} from '../action-scorer/features.mjs';
import {save} from '../tile-q/collect.mjs';
import {selector,N,read,hash} from '../strong-pool/config.mjs';
import {check,jobsFor} from './study.mjs';

export function diagnose({out}){
  out=resolve(out);const destination=resolve(out,'action-diagnostics.json');if(existsSync(destination))throw Error('Diagnostics exist');
  const p=read(resolve(out,'plan.json'));check(p);const groups=[],byPair={},examples={};
  const empty=()=>({episodes:0,choices:0,changed:0,bothDiscard:0,sameTile:0,onlyRevealDifference:0,
    worseDistance:0,betterDistance:0,sameDistance:0,sameDistanceLowerOuts:0,sameDistanceHigherOuts:0,
    huOffered:0,huDeclined:0,modelReveals:0});
  const total=empty(),kind=a=>a.type==='kong'?'kong-'+a.kind:a.type;
  for(const job of jobsFor(p)){
    const path=resolve(out,'groups',job.id),g=read(resolve(path,'group.json')),file=resolve(path,'replays.jsonl.gz');assert.equal(g.replaysSha256,hash(file));
    groups.push({jobId:job.id,groupSha256:hash(resolve(path,'group.json')),replaysSha256:g.replaysSha256});
    const a=byPair[job.pair.id]??={...empty(),typeTransitions:{}};
    const sampled=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter(e=>e.arm==='candidate'&&e.hand===job.group%p.budget.sessionHands);assert.equal(sampled.length,6);
    for(const e of sampled){
      const target=e.roles.indexOf('C'),env=new MahjongEnvironment({seed:e.replay.seed,initialState:e.replay.initialState,record:false});
      a.episodes++;total.episodes++;
      for(const [decision,entry]of e.replay.actions.entries()){
        assert.equal(env.actor,entry.seat);
        if(env.actor===target){
          const o=env.observation(),legal=env.legalActions();
          if(legal.length>1){
            const chosen=entry.action,reference=selector(N)(o,legal),inc=key=>{a[key]++;total[key]++;};inc('choices');
            if(actionKey(chosen)!==actionKey(reference))inc('changed');
            const transition=kind(reference)+' -> '+kind(chosen);a.typeTransitions[transition]=(a.typeTransitions[transition]||0)+1;
            if(legal.some(a=>a.type==='hu')){inc('huOffered');if(chosen.type!=='hu')inc('huDeclined');}
            if(chosen.type==='discard'&&chosen.reveal)inc('modelReveals');
            if(chosen.type==='discard'&&reference.type==='discard'){
              inc('bothDiscard');if(chosen.tile===reference.tile){inc('sameTile');if(chosen.reveal!==reference.reveal)inc('onlyRevealDifference');}
              const own=o.players[o.seat],shape=tile=>{const hand=[...own.hand],i=hand.indexOf(tile);assert.ok(i>=0);hand.splice(i,1);return handEfficiency(hand,own.melds,o.visibleCounts);};
              const model=shape(chosen.tile),baseline=chosen.tile===reference.tile?model:shape(reference.tile);let category=null;
              if(model.distance>baseline.distance){inc('worseDistance');category='worseDistance';}
              else if(model.distance<baseline.distance){inc('betterDistance');category='betterDistance';}
              else{inc('sameDistance');if(model.outs<baseline.outs){inc('sameDistanceLowerOuts');category='sameDistanceLowerOuts';}
                if(model.outs>baseline.outs){inc('sameDistanceHigherOuts');category='sameDistanceHigherOuts';}}
              if(category&&(examples[category]?.length||0)<3)(examples[category]??=[]).push({jobId:job.id,permutation:e.permutation,hand:e.hand,decision,
                publicObservation:o,chosen,reference,modelEfficiency:model,referenceEfficiency:baseline});
            }
          }
        }
        env.step(entry.action);
      }
      assert.deepEqual(env.result(),e.replay.result);
    }
  }
  assert.equal(total.episodes,jobsFor(p).length*6);assert.equal(total.bothDiscard,total.worseDistance+total.betterDistance+total.sameDistance);check(p);
  const result={postHoc:true,planSha256:hash(resolve(out,'plan.json')),checkpointSha256:p.model.sha256,sourceSha256:hash(fileURLToPath(import.meta.url)),
    sampling:'Every group, all six candidate permutations, hand = group index modulo sessionHands. Deterministic score-independent sampling; no new games or training.',
    interpretation:'Compare local public hand distance and public unseen improving copies with h0-never at the same observation. These are proxies, not counterfactual score, regret or proof of a wrong action. Recorded private state only restores the replay; selectors and efficiency use public observations.',
    total,byPair,examples,groups};save(destination,result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const r=diagnose({out:process.argv[2]});console.log(JSON.stringify({episodes:r.total.episodes,total:r.total}));}catch(e){console.error(e);process.exitCode=1;}}
