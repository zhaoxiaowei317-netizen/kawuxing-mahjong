import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync,createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {MahjongEnvironment,actionKey} from '../environment.mjs';
import {policyById} from '../policies/index.mjs';
import {deriveSeed,seededRandom} from '../random.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {summarizePaired} from '../statistics.mjs';
import {sha256} from '../provenance.mjs';
import {encodePublic,legalActionIds,actionId,kongNet} from './encoding.mjs';
import {loadData,DATA_VERSION,rolesFor,selectBehavior,rankTarget,save} from './collect.mjs';
import {loadQ} from './model.mjs';
import {assertSources} from './sources.mjs';
import {ARMS,select} from './study.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
export async function verifyData(path,split,onProgress=()=>{}){
  const {manifest:m,episodes}=loadData(path,split),seen=new Set(),models={};
  for(const [id,entry]of Object.entries(m.modelHashes)){const l=loadQ(entry.path);assert.equal(l.sha256,entry.sha256);models[id]=l.model;}
  const history=Object.keys(models).filter(k=>k.startsWith('history-'));let samples=0,actions=0,previous=null;
  for(const e of episodes){
    assert.ok(Number.isInteger(e.hand)&&e.hand>=m.startHand&&e.hand<m.startHand+m.hands&&!seen.has(e.hand));seen.add(e.hand);
    assert.equal(e.environmentSeed,deriveSeed(DATA_VERSION,split,m.seed,e.hand));assert.deepEqual(e.roles,rolesFor(e.hand,!!models.current,history));
    if(e.hand%m.sessionHands===0)previous=null;
    const before=previous?[...previous.totals]:[0,0,0];
    const env=new MahjongEnvironment({seed:e.environmentSeed,previous,record:false}),rows=new Map(e.rows.map(r=>[r.decision,r]));
    assert.equal(rows.size,e.rows.length);assert.deepEqual(env.auditState(),e.replay.initialState);
    const rngs=[0,1,2].map(i=>seededRandom(deriveSeed(e.environmentSeed,'behavior',i)));
    for(let i=0;i<e.replay.actions.length;i++){
      const a=e.replay.actions[i],o=env.observation(),legal=env.legalActions(),seat=env.actor,row=rows.get(i);
      assert.equal(a.seat,seat);assert.equal(actionKey(a.action),actionKey(selectBehavior(e.roles[seat].id,o,legal,rngs[seat],models,m.epsilon)));
      if(e.roles[seat].learner&&legal.length>1){
        assert.ok(row);assert.equal(row.seat,seat);assert.deepEqual(row.encoded,encodePublic(o,legal));
        assert.deepEqual(row.legalIds,legalActionIds(legal));assert.equal(row.actionId,actionId(a.action));
        assert.equal(row.teacherId,actionId(policyById('H0')(o,legal)));assert.equal(row.pastKong,kongNet(o));samples++;
      }else assert.equal(row,undefined);
      env.step(a.action);actions++;
    }
    const result=env.result();assert.equal(env.done,true);assert.deepEqual(result,e.replay.result);
    const totals=before.map((v,i)=>v+result.delta[i]);
    for(const row of e.rows){assert.equal(row.target,(result.delta[row.seat]-row.pastKong)/16);assert.deepEqual(row.rank,rankTarget(totals,row.seat));}
    previous={dealer:result.next.dealer,seats:result.next.seats,totals,round:e.hand%m.sessionHands+2};
    if(seen.size%100===0){onProgress({stage:'audit-data',split,path,hands:seen.size,total:m.hands,samples});await tick();}
  }
  assert.equal(samples,m.samples);assert.equal(actions,m.actions);return {hands:seen.size,samples,actions,allFeaturesAndReturnsRecomputed:true,sha256:m.sha256};
}
export function verifyParity(path){
  const parity=JSON.parse(readFileSync(path)),{model}=loadQ(parity.checkpoint);let maxError=0;
  for(const f of parity.fixtures){const out=model.forward(f.encoded,f.legalIds);
    for(const id of f.legalIds)maxError=Math.max(maxError,Math.abs(out.q[id]-f.q[id]));
    for(let i=0;i<3;i++)maxError=Math.max(maxError,Math.abs(out.rankLogits[i]-f.rankLogits[i]));}
  assert.ok(maxError<.0001,`Python/JS export mismatch ${maxError}`);return {fixtures:parity.fixtures.length,maxError};
}
export async function verifyEvaluation(path,bootstrapSamples,onProgress=()=>{}){
  const r=JSON.parse(readFileSync(resolve(path,'report.json'))),{model,sha256:modelHash}=loadQ(r.checkpoint);
  assert.equal(modelHash,r.checkpointSha256);assertSources(r.sources);
  const replayPath=resolve(path,'replays.jsonl.gz');assert.equal(sha256(readFileSync(replayPath)),r.artifacts.replays.sha256);
  const previous=new Map(),seen=new Set(),scores=new Map();let games=0,huOffered=0,huMissed=0,choices=0,teacherAgreement=0;
  for await(const line of createInterface({input:createReadStream(replayPath).pipe(createGunzip()),crlfDelay:Infinity})){
    if(!line)continue;const e=JSON.parse(line),key=JSON.stringify([e.suite,e.opponentPair,e.group,e.permutation,e.arm,e.hand]);
    assert.ok(!seen.has(key));seen.add(key);assert.deepEqual(e.roles,r.seatPermutations[e.permutation]);
    const pair=r.opponentPairs.find(p=>p.id===e.opponentPair);assert.ok(pair);
    assert.ok(['independent','session'].includes(e.suite)&&['candidate','incumbent'].includes(e.arm));
    assert.ok(Number.isInteger(e.group)&&e.group>=0&&e.group<(e.suite==='independent'?r.independentGroups:r.sessionGroups));
    assert.ok(Number.isInteger(e.hand)&&e.hand>=0&&e.hand<(e.suite==='independent'?1:r.sessionHands));
    const groupSeed=deriveSeed(PROTOCOL_VERSION,r.split,r.seed,e.suite,e.opponentPair,e.group);assert.equal(groupSeed,e.groupSeed);
    const id=e.arm==='candidate'?r.candidate:'H0',roleIds={C:id,P:pair.policies[0],Q:pair.policies[1]};assert.deepEqual(e.policyIds,e.roles.map(role=>roleIds[role]));
    const sessionKey=JSON.stringify([e.suite,e.opponentPair,e.group,e.permutation,e.arm]),last=previous.get(sessionKey);
    if(e.hand)assert.equal(last?.hand,e.hand-1);
    const seed=deriveSeed(groupSeed,'environment',e.hand),env=new MahjongEnvironment({seed,config:{base:r.base,mode:'bots'},previous:e.hand?last.next:null,record:false});
    assert.equal(e.replay.seed,seed);assert.deepEqual(env.auditState(),e.replay.initialState);
    for(const entry of e.replay.actions){
      const seat=env.actor,o=env.observation(),legal=env.legalActions(),policy=e.policyIds[seat];assert.equal(seat,entry.seat);
      const action=policy===r.candidate?model.select(o,legal):policyById(policy)(o,legal);assert.equal(actionKey(action),actionKey(entry.action));
      if(policy===r.candidate&&legal.length>1){choices++;teacherAgreement+=Number(actionKey(action)===actionKey(policyById('H0')(o,legal)));
        if(legal.some(a=>a.type==='hu')){huOffered++;huMissed+=Number(action.type!=='hu');}}
      env.step(entry.action);
    }
    const result=env.result();assert.equal(env.done,true);assert.deepEqual(result,e.replay.result);
    const target=e.roles.indexOf('C'),groupKey=JSON.stringify([e.suite,e.opponentPair,groupSeed,e.arm]);
    if(!scores.has(groupKey))scores.set(groupKey,{hands:0,score:0,kongScore:0,huScore:0,drawScore:0,wins:0});const a=scores.get(groupKey);
    const kong=result.kongs.reduce((s,l)=>s+(l.to===target?l.amount:0)-(l.from===target?l.amount:0),0);
    a.hands++;a.score+=result.delta[target];a.kongScore+=kong;a[result.winners.length?'huScore':'drawScore']+=result.delta[target]-kong;a.wins+=Number(result.winners.includes(target));
    const totals=e.hand?[...last.next.totals]:[0,0,0];result.delta.forEach((v,i)=>totals[i]+=v);
    previous.set(sessionKey,{hand:e.hand,next:{dealer:result.next.dealer,seats:result.next.seats,totals,round:e.hand+2}});
    games++;if(games%192===0){onProgress({stage:'audit-evaluation',path,games,total:r.totalGames});await tick();}
  }
  assert.equal(games,r.totalGames);assert.equal(games,24*(r.independentGroups+r.sessionGroups*r.sessionHands));
  for(const record of r.records)for(const arm of ['candidate','incumbent']){
    const a=scores.get(JSON.stringify([record.suite,record.opponentPair,record.seed,arm]));assert.ok(a);
    for(const k of Object.keys(a))assert.equal(a[k],record[arm][k]);}
  assert.deepEqual(r.statistics,summarizePaired(r.records,{bootstrapSamples,seed:deriveSeed(r.seed,'bootstrap'),base:r.base}));
  return {games,allGamesRedealtAndPolicyRecomputed:true,choices,teacherAgreement,huOffered,huMissed};
}
export async function verifyStudy({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');
  const read=p=>JSON.parse(readFileSync(resolve(out,p))),plan=read('plan.json'),s=read('summary.json'),selection=read('selection.json'),models=read('models.json');
  assertSources(plan.sources);assert.equal(s.planSha256,sha256(readFileSync(resolve(out,'plan.json'))));assert.equal(select(s.development),s.selected);
  assert.deepEqual(selection,{selected:s.selected,development:s.development});
  const data={};for(const split of ['training','validation']){data[split]=await verifyData(resolve(out,split),split,onProgress);
    assert.deepEqual(loadData(resolve(out,split),split).manifest,s.datasets[split]);assert.equal(data[split].hands,plan.budget[split==='training'?'initialHands':'validationHands']);}
  for(let i=0;i<plan.budget.onlineRounds;i++){
    data[`online-${i}`]=await verifyData(resolve(out,`online-${i}`),'training',onProgress);
    assert.deepEqual(loadData(resolve(out,`online-${i}`),'training').manifest,s.online[i].dataset);assert.equal(data[`online-${i}`].hands,plan.budget.onlineHands);
  }
  const parity={},snapshots=[];
  const stages=['features-bc','tiles-bc','tiles-offline',...Array.from({length:plan.budget.onlineRounds},(_,i)=>`online-${i}`)];
  for(const stage of stages){
    const dir=resolve(out,`model-${stage}`),summary=JSON.parse(readFileSync(resolve(dir,'summary.json')));
    parity[stage]=verifyParity(resolve(dir,'parity.json'));
    for(const name of readdirSync(dir).filter(p=>/^epoch-\d+\.json$/.test(p))){
      const loaded=loadQ(resolve(dir,name));assert.equal(sha256(readFileSync(resolve(dir,name.replace('.json','.pt')))),loaded.data.metadata.optimizerStateSha256);snapshots.push(loaded.sha256);}
    const expected=stage.startsWith('online-')?plan.budget.onlineEpochs:stage.endsWith('-bc')?plan.budget.bcEpochs:plan.budget.offlineEpochs;
    assert.equal(summary.history.length,expected+1);let best=summary.history[0];
    for(const row of summary.history)if(row.validation.loss<best.validation.loss-1e-12)best=row;
    assert.equal(summary.selected.epoch,stage.startsWith('online-')?expected:best.epoch);
  }
  const evaluation={};
  for(const arm of ARMS){assert.deepEqual(models[arm],s.fitted[arm].selected);const r=read(`development-${arm}/report.json`);
    assert.equal(r.seed,plan.seeds.development);assert.equal(r.split,'development');assert.equal(r.candidate,arm);
    assert.equal(r.independentGroups,plan.budget.developmentGroups);assert.equal(r.sessionGroups,plan.budget.developmentSessions);
    assert.equal(r.sessionHands,plan.budget.sessionHands);assert.equal(r.checkpointSha256,loadQ(models[arm].path).sha256);
    assert.equal(r.statistics.session.overall.deltaPer100,s.development.find(x=>x.arm===arm).delta);
    evaluation[`development-${arm}`]=await verifyEvaluation(resolve(out,`development-${arm}`),plan.budget.bootstrapSamples,onProgress);}
  if(s.selected){const r=read('sealed-vs-H0/report.json');assert.equal(r.seed,plan.seeds.sealed);assert.equal(r.split,'sealed');assert.equal(r.candidate,s.selected);
    assert.equal(r.independentGroups,plan.budget.sealedGroups);assert.equal(r.sessionGroups,plan.budget.sealedSessions);assert.equal(r.sessionHands,plan.budget.sessionHands);
    assert.deepEqual(r.statistics.session.overall,s.sealed.primary);evaluation['sealed-vs-H0']=await verifyEvaluation(resolve(out,'sealed-vs-H0'),plan.budget.bootstrapSamples,onProgress);
  }else assert.equal(s.sealed,null);
  const games=Object.values(evaluation).reduce((sum,r)=>sum+r.games,0);assert.equal(games,s.games);assertSources(plan.sources);
  const result={completedAt:new Date().toISOString(),data,evaluation,parity,snapshotsVerified:snapshots.length,games,sourceHashes:plan.sources};
  save(resolve(out,'verification.json'),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [kind,path,arg]=process.argv.slice(2),progress=p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}));
  const task=kind==='data'?verifyData(path,arg,progress):kind==='evaluation'?verifyEvaluation(path,Number(arg),progress):verifyStudy({out:kind,onProgress:progress});
  task.then(r=>console.log(JSON.stringify({verified:true,...r}))).catch(e=>{console.error(e);process.exitCode=1;});
}
