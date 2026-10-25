import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {MahjongEnvironment} from '../environment.mjs';
import {PROTOCOL_VERSION,SEAT_PERMUTATIONS,playEpisode} from '../runner.mjs';
import {deriveSeed} from '../random.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {read,hash} from '../strong-pool/config.mjs';
import {ARMS,factories,emptyIntervention} from './policy.mjs';
import {check,jobsFor,jobSeed} from './study.mjs';

const empty=()=>({hands:0,score:0,wins:0,selfDraws:0,dealIns:0,draws:0,huScore:0,kongScore:0,drawScore:0,
  revealHands:0,revealedScore:0,sessionFirstCredit:0,sessionLastCredit:0,sessions:0,sessionScores:[],largeLosses:0});
function add(a,r,seat){
  const score=r.delta[seat],won=r.winners.includes(seat),kong=r.kongs.reduce((n,k)=>n+(k.to===seat?k.amount:0)-(k.from===seat?k.amount:0),0);
  a.hands++;a.score+=score;a.wins+=Number(won);a.selfDraws+=Number(won&&r.source===null);a.dealIns+=Number(r.winners.length>0&&r.source===seat);a.draws+=Number(!r.winners.length);
  a.kongScore+=kong;a[r.winners.length?'huScore':'drawScore']+=score-kong;a.revealHands+=Number(r.players[seat].liang);if(r.players[seat].liang)a.revealedScore+=score;
  a.largeLosses+=Number(score<=-16*r.config.base);
}
export async function simulate({plan:p,job,onEpisode}){
  check(p);assert.deepEqual(job,jobsFor(p).find(j=>j.id===job.id));const groupSeed=jobSeed(p,job),model=loadQ(p.model.path).model,intervention=emptyIntervention();
  const record={suite:'session',opponentPair:job.pair.id,seed:groupSeed,arms:Object.fromEntries(ARMS.map(arm=>[arm,empty()]))};let games=0,decisions=0;
  for(let permutation=0;permutation<6;permutation++){
    const roles=SEAT_PERMUTATIONS[permutation],target=roles.indexOf('C');
    for(const arm of ARMS){
      const ids={C:p.policies[arm],P:job.pair.policies[0],Q:job.pair.policies[1]},policyIds=roles.map(r=>ids[r]);let previous=null;const totals=[0,0,0];
      for(let hand=0;hand<p.budget.sessionHands;hand++){
        const seed=deriveSeed(groupSeed,'environment',hand),policySeeds=roles.map((r,seat)=>deriveSeed(groupSeed,'policy',permutation,hand,seat,r,ids[r]));
        const env=new MahjongEnvironment({seed,previous}),played=playEpisode({env,policyIds,policySeeds,policyFactories:factories(model,intervention),onEpisode,
          context:{suite:'session',opponentPair:job.pair.id,group:job.group,groupSeed,permutation,roles,arm,hand}});
        add(record.arms[arm],played.result,target);games++;decisions+=played.decisions;played.result.delta.forEach((v,i)=>totals[i]+=v);
        previous={dealer:played.result.next.dealer,seats:played.result.next.seats,totals:[...totals],round:hand+2};
      }
      const a=record.arms[arm],score=totals[target],hi=Math.max(...totals),lo=Math.min(...totals);a.sessions++;a.sessionScores.push(score);
      a.sessionFirstCredit+=score===hi?1/totals.filter(x=>x===hi).length:0;a.sessionLastCredit+=score===lo?1/totals.filter(x=>x===lo).length:0;
    }
  }
  assert.equal(games,18*p.budget.sessionHands);assert.equal(intervention.changed,intervention.eligible);check(p);
  return {version:p.version,protocolVersion:PROTOCOL_VERSION,job,groupSeed,record,games,decisions,intervention,checkpointSha256:p.model.sha256};
}
export async function playGroup({out,plan,job}){
  out=resolve(out);if(existsSync(out))throw Error('Group output exists');mkdirSync(out,{recursive:true});const file=resolve(out,'replays.jsonl.gz');writeFileSync(file,gzipSync(''));
  const result=await simulate({plan,job,onEpisode:e=>appendFileSync(file,gzipSync(JSON.stringify(e)+'\n'))});result.replaysSha256=hash(file);save(resolve(out,'group.json'),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))playGroup(read(process.argv[2]))
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
