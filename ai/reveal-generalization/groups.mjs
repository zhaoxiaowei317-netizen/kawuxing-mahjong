import assert from 'node:assert/strict';
import {writeFileSync,appendFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {MahjongEnvironment} from '../environment.mjs';
import {PROTOCOL_VERSION,SEAT_PERMUTATIONS,playEpisode} from '../runner.mjs';
import {deriveSeed} from '../random.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {CANDIDATE,factories} from './policies.mjs';
import {check,hash,read,jobSeed} from './study.mjs';

function empty(){return {hands:0,score:0,wins:0,selfDraws:0,dealIns:0,draws:0,huScore:0,kongScore:0,drawScore:0,
  revealHands:0,revealedScore:0,sessionFirstCredit:0,sessionLastCredit:0,sessions:0,sessionScores:[],largeLosses:0};}
function add(a,r,seat){
  const score=r.delta[seat],won=r.winners.includes(seat),kong=r.kongs.reduce((s,k)=>s+(k.to===seat?k.amount:0)-(k.from===seat?k.amount:0),0);
  a.hands++;a.score+=score;a.wins+=Number(won);a.selfDraws+=Number(won&&r.source===null);a.dealIns+=Number(r.winners.length>0&&r.source===seat);
  a.draws+=Number(!r.winners.length);a.kongScore+=kong;a[r.winners.length?'huScore':'drawScore']+=score-kong;
  if(r.players[seat].liang){a.revealHands++;a.revealedScore+=score;}a.largeLosses+=Number(score<=-16*r.config.base);
}
export async function playGroup({out,plan,job}){
  check(plan);out=resolve(out);if(existsSync(out))throw Error('Group output exists');mkdirSync(out,{recursive:true});
  const seed=jobSeed(plan,job),model=loadQ(plan.checkpoint).model,policyFactories=factories(model),start=performance.now();
  const record={suite:'session',opponentPair:job.pair.id,seed,candidate:empty(),incumbent:empty()};
  const file=resolve(out,'replays.jsonl.gz');writeFileSync(file,gzipSync(''));let games=0,decisions=0;
  for(let permutation=0;permutation<SEAT_PERMUTATIONS.length;permutation++){
    const roles=SEAT_PERMUTATIONS[permutation],target=roles.indexOf('C');
    for(const arm of ['candidate','incumbent']){
      const ids={C:arm==='candidate'?CANDIDATE:'H0',P:job.pair.policies[0],Q:job.pair.policies[1]},policyIds=roles.map(k=>ids[k]);
      let previous=null;const totals=[0,0,0];
      for(let hand=0;hand<plan.budget.sessionHands;hand++){
        const environmentSeed=deriveSeed(seed,'environment',hand),policySeeds=roles.map((role,seat)=>deriveSeed(seed,'policy',permutation,hand,seat,role,ids[role]));
        const env=new MahjongEnvironment({seed:environmentSeed,config:{base:1,mode:'bots'},previous,validate:true});
        const context={cohort:job.cohort,suite:'session',opponentPair:job.pair.id,group:job.group,groupSeed:seed,permutation,roles,arm,hand};
        const played=playEpisode({env,policyIds,policySeeds,policyFactories,context,
          onEpisode:e=>appendFileSync(file,gzipSync(JSON.stringify(e)+'\n'))});
        add(record[arm],played.result,target);decisions+=played.decisions;games++;
        played.result.delta.forEach((v,i)=>totals[i]+=v);
        previous={dealer:played.result.next.dealer,seats:played.result.next.seats,totals:[...totals],round:hand+2};
      }
      const a=record[arm],score=totals[target],high=Math.max(...totals),low=Math.min(...totals);
      a.sessions++;a.sessionScores.push(score);a.sessionFirstCredit+=score===high?1/totals.filter(x=>x===high).length:0;
      a.sessionLastCredit+=score===low?1/totals.filter(x=>x===low).length:0;
    }
  }
  assert.equal(games,12*plan.budget.sessionHands);check(plan);
  const result={version:plan.version,protocolVersion:PROTOCOL_VERSION,job,groupSeed:seed,record,games,decisions,
    seconds:(performance.now()-start)/1000,replaysSha256:hash(file),checkpointSha256:plan.checkpointSha256,sources:plan.sources};
  save(resolve(out,'group.json'),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))playGroup(read(process.argv[2]))
  .then(r=>console.log(JSON.stringify({complete:true,games:r.games}))).catch(e=>{console.error(e);process.exitCode=1;});
