import assert from 'node:assert/strict';
import {createReadStream,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {MahjongEnvironment,actionKey} from '../environment.mjs';
import {SEAT_PERMUTATIONS,PROTOCOL_VERSION} from '../runner.mjs';
import {deriveSeed} from '../random.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {CANDIDATE,selector} from './policies.mjs';
import {check,hash,read,jobsFor,jobSeed,pooled,aggregate} from './study.mjs';

export async function auditGroup({path,plan,job}){
  check(plan);const g=read(resolve(path,'group.json')),file=resolve(path,'replays.jsonl.gz'),seed=jobSeed(plan,job),model=loadQ(plan.checkpoint).model;
  assert.deepEqual(g.job,job);assert.equal(g.groupSeed,seed);assert.equal(g.protocolVersion,PROTOCOL_VERSION);assert.equal(g.checkpointSha256,plan.checkpointSha256);
  assert.deepEqual(g.sources,plan.sources);assert.equal(g.replaysSha256,hash(file));
  const sides={},fields=['hands','score','wins','selfDraws','dealIns','draws','huScore','kongScore','drawScore','revealHands','revealedScore','largeLosses'];
  for(const side of ['candidate','incumbent'])sides[side]={...Object.fromEntries(fields.map(f=>[f,0])),sessions:0,sessionFirstCredit:0,sessionLastCredit:0,sessionScores:[]};
  const previous=new Map(),seen=new Set(),decisions={candidate:0,incumbent:0};let games=0,actions=0;
  const diagnostics={candidate:{huOffered:0,huDeclined:0},incumbent:{huOffered:0,huDeclined:0}};
  for await(const line of createInterface({input:createReadStream(file).pipe(createGunzip()),crlfDelay:Infinity})){
    if(!line)continue;const e=JSON.parse(line);assert.equal(e.cohort,job.cohort);assert.equal(e.suite,'session');assert.equal(e.opponentPair,job.pair.id);
    assert.equal(e.group,job.group);assert.equal(e.groupSeed,seed);assert.ok(Number.isInteger(e.permutation)&&e.permutation>=0&&e.permutation<6);
    assert.deepEqual(e.roles,SEAT_PERMUTATIONS[e.permutation]);assert.ok(['candidate','incumbent'].includes(e.arm));
    assert.ok(Number.isInteger(e.hand)&&e.hand>=0&&e.hand<plan.budget.sessionHands);
    const key=e.permutation+':'+e.arm,unique=key+':'+e.hand;assert.ok(!seen.has(unique));seen.add(unique);
    const last=previous.get(key);assert.equal(last?.hand??-1,e.hand-1);
    const ids={C:e.arm==='candidate'?CANDIDATE:'H0',P:job.pair.policies[0],Q:job.pair.policies[1]};assert.deepEqual(e.policyIds,e.roles.map(k=>ids[k]));
    assert.deepEqual(e.policySeeds,e.roles.map((role,seat)=>deriveSeed(seed,'policy',e.permutation,e.hand,seat,role,ids[role])));
    const environmentSeed=deriveSeed(seed,'environment',e.hand),env=new MahjongEnvironment({seed:environmentSeed,previous:last?.next,record:false});
    assert.equal(e.replay.seed,environmentSeed);assert.deepEqual(env.auditState(),e.replay.initialState);
    const target=e.roles.indexOf('C');let decision=0;
    for(const entry of e.replay.actions){
      const seat=env.actor,o=env.observation(),legal=env.legalActions();assert.equal(entry.seat,seat);
      const chosen=selector(e.policyIds[seat],model)(o,legal);assert.equal(actionKey(chosen),actionKey(entry.action));
      if(seat===target&&legal.length>1){decisions[e.arm]++;if(legal.some(a=>a.type==='hu')){diagnostics[e.arm].huOffered++;diagnostics[e.arm].huDeclined+=Number(chosen.type!=='hu');}}
      env.step(entry.action);decision++;actions++;
    }
    assert.equal(e.decisions,decision);assert.equal(env.done,true);const r=env.result();assert.deepEqual(r,e.replay.result);
    const a=sides[e.arm],score=r.delta[target],won=r.winners.includes(target),liang=r.players[target].liang;
    const kong=r.kongs.reduce((n,k)=>n+(k.to===target?k.amount:0)-(k.from===target?k.amount:0),0);
    a.hands++;a.score+=score;a.wins+=Number(won);a.selfDraws+=Number(won&&r.source===null);a.dealIns+=Number(r.winners.length>0&&r.source===target);
    a.draws+=Number(!r.winners.length);a.kongScore+=kong;a[r.winners.length?'huScore':'drawScore']+=score-kong;
    a.revealHands+=Number(liang);if(liang)a.revealedScore+=score;a.largeLosses+=Number(score<=-16*r.config.base);
    const totals=last?[...last.next.totals]:[0,0,0];r.delta.forEach((v,i)=>totals[i]+=v);
    previous.set(key,{hand:e.hand,next:{dealer:r.next.dealer,seats:r.next.seats,totals,round:e.hand+2}});
    if(e.hand===plan.budget.sessionHands-1){const high=Math.max(...totals),low=Math.min(...totals),score=totals[target];a.sessions++;a.sessionScores.push(score);
      a.sessionFirstCredit+=score===high?1/totals.filter(x=>x===high).length:0;a.sessionLastCredit+=score===low?1/totals.filter(x=>x===low).length:0;}
    games++;
  }
  assert.equal(games,12*plan.budget.sessionHands);assert.equal(g.games,games);assert.equal(g.decisions,actions);assert.equal(previous.size,12);
  assert.deepEqual(g.record,{suite:'session',opponentPair:job.pair.id,seed,candidate:sides.candidate,incumbent:sides.incumbent});check(plan);
  return {jobId:job.id,games,actions,allGamesRedealtAndPolicyRecomputed:true,decisions,diagnostics,replaysSha256:hash(file),groupSha256:hash(resolve(path,'group.json'))};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json'));check(p);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));
  const jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.cohorts,aggregate(p,groups));
  assert.equal(s.positiveReplication,s.cohorts.replication.statistics.session.overall.ci95[0]>0);assert.equal(s.trainingHands,0);assert.equal(s.productionPolicy,'H0');
  const seeds=new Set(jobs.map(j=>jobSeed(p,j)));assert.equal(seeds.size,jobs.length);
  const dir=resolve(out,'.audit');if(existsSync(dir))throw Error('Audit work directory exists');mkdirSync(dir);const audited=[];
  await pooled(jobs,p.budget.workers,async job=>{
    const spec=resolve(dir,job.id+'.spec.json'),result=resolve(dir,job.id+'.result.json');save(spec,{path:resolve(out,'groups',job.id),plan:p,job,result});
    await worker(process.execPath,[fileURLToPath(import.meta.url),'worker',spec]);audited.push(read(result));
    onProgress({stage:'audit',completedGroups:audited.length,totalGroups:jobs.length,games:audited.reduce((n,r)=>n+r.games,0)});
  });
  audited.sort((a,b)=>a.jobId.localeCompare(b.jobId));const games=audited.reduce((n,r)=>n+r.games,0);assert.equal(s.games,games);check(p);
  const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,games,groups:audited,sources:p.sources};save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const progress=p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}));let task;
  if(process.argv[2]==='worker'){const spec=read(process.argv[3]);task=auditGroup(spec).then(r=>save(spec.result,r));}
  else task=verify({out:process.argv[2],onProgress:progress});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
