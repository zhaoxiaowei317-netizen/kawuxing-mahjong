import assert from 'node:assert/strict';
import {createReadStream,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {MahjongEnvironment,actionKey} from '../environment.mjs';
import {policyById} from '../policies/index.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker,parallel} from '../tile-q/study.mjs';
import {deriveSeed} from '../random.mjs';
import {PROTOCOL_VERSION,DEFAULT_OPPONENT_PAIRS,SEAT_PERMUTATIONS} from '../runner.mjs';
import {summarizePaired} from '../statistics.mjs';
import {ARMS,decide} from './policies.mjs';
import {check,hash,read,select,contrasts} from './study.mjs';

export async function audit({path,plan,onProgress=()=>{}}){
  check(plan);const r=read(resolve(path,'report.json')),model=loadQ(plan.checkpoint).model;
  assert.equal(r.checkpointSha256,plan.checkpointSha256);assert.equal(r.checkpoint,plan.checkpoint);assert.deepEqual(r.sources,plan.sources);
  assert.deepEqual(r.opponentPairs,DEFAULT_OPPONENT_PAIRS);assert.deepEqual(r.seatPermutations,SEAT_PERMUTATIONS);assert.equal(r.incumbent,'H0');assert.equal(r.base,1);
  assert.equal(r.protocolVersion,PROTOCOL_VERSION);assert.equal(r.conservationCheckedEveryAction,true);assert.equal(r.illegalActions,0);
  const file=resolve(path,'replays.jsonl.gz');assert.equal(hash(file),r.artifacts.replays.sha256);
  const previous=new Map(),seen=new Set(),groups=new Map(),cases=[];
  const diagnostics={decisions:0,opportunities:0,changed:0,baseReveals:0,chosenReveals:0,huOffered:0,huDeclined:0};let games=0;
  const fields=['hands','score','wins','selfDraws','dealIns','draws','huScore','kongScore','drawScore','revealHands','revealedScore','largeLosses'];
  for await(const line of createInterface({input:createReadStream(file).pipe(createGunzip()),crlfDelay:Infinity})){
    if(!line)continue;const e=JSON.parse(line),pair=r.opponentPairs.find(p=>p.id===e.opponentPair);assert.ok(pair);
    assert.equal(e.suite,'session');assert.ok(['candidate','incumbent'].includes(e.arm));assert.deepEqual(e.roles,r.seatPermutations[e.permutation]);
    assert.ok(Number.isInteger(e.group)&&e.group>=0&&e.group<r.sessionGroups);assert.ok(Number.isInteger(e.hand)&&e.hand>=0&&e.hand<r.sessionHands);
    const groupSeed=deriveSeed(PROTOCOL_VERSION,r.split,r.seed,'session',pair.id,e.group);assert.equal(e.groupSeed,groupSeed);
    const policies={C:e.arm==='candidate'?r.candidate:'H0',P:pair.policies[0],Q:pair.policies[1]};assert.deepEqual(e.policyIds,e.roles.map(k=>policies[k]));
    const key=JSON.stringify([pair.id,e.group,e.permutation,e.arm]),unique=JSON.stringify([key,e.hand]);assert.ok(!seen.has(unique));seen.add(unique);
    const last=previous.get(key);assert.equal(last?.hand??-1,e.hand-1);
    const seed=deriveSeed(groupSeed,'environment',e.hand),env=new MahjongEnvironment({seed,previous:last?.next,record:false});
    assert.equal(seed,e.replay.seed);assert.deepEqual(env.auditState(),e.replay.initialState);
    for(const entry of e.replay.actions){
      const seat=env.actor,o=env.observation(),legal=env.legalActions(),id=e.policyIds[seat];assert.equal(entry.seat,seat);
      const d=ARMS.includes(id)?decide(id,model,o,legal):null,chosen=d?d.action:policyById(id)(o,legal);
      assert.equal(actionKey(chosen),actionKey(entry.action));
      if(d&&legal.length>1){
        diagnostics.decisions++;diagnostics.opportunities+=Number(d.opportunity);diagnostics.changed+=Number(d.changed);
        diagnostics.baseReveals+=Number(d.base.type==='discard'&&d.base.reveal);diagnostics.chosenReveals+=Number(chosen.type==='discard'&&chosen.reveal);
        if(legal.some(a=>a.type==='hu')){diagnostics.huOffered++;diagnostics.huDeclined+=Number(chosen.type!=='hu');}
        if(d.changed&&cases.length<12)cases.push({group:e.group,opponentPair:e.opponentPair,permutation:e.permutation,hand:e.hand,
          decision:diagnostics.decisions,wall:o.wallCount,ownHand:[...o.players[o.seat].hand],opponentReveals:o.players.filter(p=>p.seat!==o.seat).map(p=>p.liang),
          base:d.base,chosen,margin:d.margin});
      }
      env.step(entry.action);
    }
    assert.equal(env.done,true);const result=env.result();assert.deepEqual(result,e.replay.result);
    const target=e.roles.indexOf('C'),score=result.delta[target],groupKey=JSON.stringify([pair.id,groupSeed,e.arm]);
    if(!groups.has(groupKey))groups.set(groupKey,Object.fromEntries(fields.map(k=>[k,0])));const a=groups.get(groupKey);
    const won=result.winners.includes(target),revealed=result.players[target].liang;
    const kong=result.kongs.reduce((s,k)=>s+(k.to===target?k.amount:0)-(k.from===target?k.amount:0),0);
    a.hands++;a.score+=score;a.wins+=Number(won);a.selfDraws+=Number(won&&result.source===null);a.dealIns+=Number(result.winners.length>0&&result.source===target);
    a.draws+=Number(!result.winners.length);a.kongScore+=kong;a[result.winners.length?'huScore':'drawScore']+=score-kong;
    a.revealHands+=Number(revealed);if(revealed)a.revealedScore+=score;a.largeLosses+=Number(score<=-16*result.config.base);
    const totals=last?[...last.next.totals]:[0,0,0];result.delta.forEach((v,i)=>totals[i]+=v);
    previous.set(key,{hand:e.hand,next:{dealer:result.next.dealer,seats:result.next.seats,totals,round:e.hand+2}});
    games++;if(games%192===0){onProgress({games,total:r.totalGames});await new Promise(f=>setImmediate(f));}
  }
  assert.equal(games,r.totalGames);assert.equal(games,r.artifacts.replays.games);assert.equal(games,r.artifacts.replays.replayed);
  assert.equal(games,24*r.sessionGroups*r.sessionHands);assert.equal(groups.size,r.records.length*2);
  for(const row of r.records)for(const side of ['candidate','incumbent']){assert.equal(row.suite,'session');const a=groups.get(JSON.stringify([row.opponentPair,row.seed,side]));assert.ok(a);for(const k of fields)assert.equal(a[k],row[side][k]);}
  assert.deepEqual(r.statistics,summarizePaired(r.records,{bootstrapSamples:plan.budget.bootstrapSamples,seed:deriveSeed(r.seed,'bootstrap'),base:1}));check(plan);
  return {games,allGamesRedealtAndPolicyRecomputed:true,behaviorFieldsRecomputed:fields,diagnostics,firstChangedPublicCases:cases,replaysSha256:hash(file)};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json'));check(p);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));
  assert.equal(s.selected,select(s.development));assert.deepEqual(read(resolve(out,'selection.json')),{selected:s.selected,development:s.development,vsReference:s.vsReference});
  const reports={};for(const arm of ARMS)reports[arm]=read(resolve(out,`development-${arm}/report.json`));
  assert.deepEqual(s.vsReference,contrasts(reports,p.budget.bootstrapSamples,p.seeds.development));assert.equal(!!s.sealed,!!s.selected);
  assert.equal(s.positiveSealedEvidence,!!s.sealed&&s.sealed.primary.ci95[0]>0);
  const stages=[...ARMS.map(arm=>({stage:`development-${arm}`,arm,sealed:false})),...(s.selected?[{stage:'sealed',arm:s.selected,sealed:true}]:[])];
  for(const job of stages){const r=read(resolve(out,job.stage,'report.json'));
    assert.equal(r.candidate,job.arm);assert.equal(r.independentGroups,0);assert.equal(r.sessionGroups,p.budget[job.sealed?'sealedGroups':'developmentGroups']);
    assert.equal(r.sessionHands,p.budget.sessionHands);assert.equal(r.split,job.sealed?'sealed':'development');assert.equal(r.seed,p.seeds[job.sealed?'sealed':'development']);
    if(job.sealed)assert.deepEqual(s.sealed,{primary:r.statistics.session.overall,byOpponentPair:r.statistics.session.byOpponentPair,games:r.totalGames});
    else assert.deepEqual(s.development.find(x=>x.arm===job.arm),{arm:job.arm,delta:r.statistics.session.overall.deltaPer100,ci95:r.statistics.session.overall.ci95,games:r.totalGames});
  }
  const dir=resolve(out,'.audit');if(existsSync(dir))throw Error('Audit work directory exists');mkdirSync(dir);const results={};let next=0;
  const jobs=[...stages].sort((a,b)=>Number(b.sealed)-Number(a.sealed));
  async function consume(){while(next<jobs.length){const job=jobs[next++],spec=resolve(dir,`${job.stage}.spec.json`),result=resolve(dir,`${job.stage}.result.json`);
    save(spec,{path:resolve(out,job.stage),plan:p,result});await worker(process.execPath,[fileURLToPath(import.meta.url),'worker',spec],q=>onProgress({stage:job.stage,...q}));results[job.stage]=read(result);}}
  await parallel(Array.from({length:Math.min(4,jobs.length)},consume));
  const games=Object.values(results).reduce((sum,r)=>sum+r.games,0);assert.equal(games,s.games);assert.equal(s.trainingHands,0);assert.equal(s.productionPolicy,'H0');check(p);
  const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,games,evaluation:results,sources:p.sources};save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const progress=p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}));let task;
  if(process.argv[2]==='worker'){const spec=read(process.argv[3]);task=audit({...spec,onProgress:progress}).then(r=>save(spec.result,r));}
  else task=verify({out:process.argv[2],onProgress:progress});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
