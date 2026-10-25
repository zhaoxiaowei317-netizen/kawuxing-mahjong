// Audit-only streaming extension. Policy, training, evaluation and original auditor remain frozen.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MahjongEnvironment,actionKey} from '../environment.mjs';
import {deriveSeed,seededRandom} from '../random.mjs';
import {encodePublic,legalActionIds,actionId,kongNet} from '../tile-q/encoding.mjs';
import {save,rankTarget} from '../tile-q/collect.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {projectRoot} from '../provenance.mjs';
import {verifyParity} from '../tile-q/verify.mjs';
import {worker} from '../tile-q/study.mjs';
import {behavior} from './collect.mjs';
import {metadata,episodes} from './stream-data.mjs';
import {jobsFor,aggregate} from './evaluate.mjs';
import {VERSION,ARMS,rolesFor,read,hash,check,pooled,sources} from './config.mjs';

export const auditSources=()=>Object.fromEntries(['verify-stream.mjs','stream-data.mjs','verify.mjs'].map(name=>[name,hash(new URL(name,import.meta.url))]));

export async function verifyData({path,split,onProgress=()=>{}}){
  const m=metadata(path,split);let index=0,previous=null,actions=0,samples=0,huOffered=0,huMissed=0;const teachers={};
  for await(const e of episodes(path)){
    assert.equal(e.hand,index+m.startHand);assert.equal(e.environmentSeed,deriveSeed(VERSION,split,m.seed,e.hand));assert.deepEqual(e.roles,rolesFor(e.hand,m.sessionHands));
    if(e.hand%m.sessionHands===0)previous=null;
    const before=previous?[...previous.totals]:[0,0,0],env=new MahjongEnvironment({seed:e.environmentSeed,previous,record:false});
    assert.deepEqual(env.auditState(),e.replay.initialState);assert.equal(e.replay.seed,e.environmentSeed);
    const rngs=[0,1,2].map(i=>seededRandom(deriveSeed(e.environmentSeed,'behavior',i))),rows=new Map(e.rows.map(r=>[r.decision,r]));assert.equal(rows.size,e.rows.length);
    for(const [decision,entry]of e.replay.actions.entries()){
      const seat=env.actor,o=env.observation(),legal=env.legalActions(),{action,teacher}=behavior(e.roles[seat],o,legal,rngs[seat],m.epsilon);
      assert.equal(seat,entry.seat);assert.equal(actionKey(action),actionKey(entry.action));const row=rows.get(decision);
      if(legal.length>1){
        assert.ok(row);assert.equal(row.seat,seat);assert.deepEqual(row.encoded,encodePublic(o,legal));assert.deepEqual(row.legalIds,legalActionIds(legal));
        assert.equal(row.actionId,actionId(action));assert.equal(row.teacherId,actionId(teacher));assert.equal(row.pastKong,kongNet(o));samples++;
        teachers[e.roles[seat].id]=(teachers[e.roles[seat].id]||0)+1;
        if(legal.some(a=>a.type==='hu')){huOffered++;huMissed+=Number(action.type!=='hu');}
      }else assert.equal(row,undefined);
      env.step(action);actions++;
    }
    assert.equal(env.done,true);const r=env.result();assert.deepEqual(r,e.replay.result);const totals=before.map((v,i)=>v+r.delta[i]);
    for(const row of e.rows){assert.equal(row.target,(r.delta[row.seat]-row.pastKong)/16);assert.deepEqual(row.rank,rankTarget(totals,row.seat));}
    previous={dealer:r.next.dealer,seats:r.next.seats,totals,round:e.hand%m.sessionHands+2};
    if((index+1)%100===0){onProgress({stage:'audit-data',split,hands:index+1,total:m.hands});await new Promise(r=>setImmediate(r));}
    index++;
  }
  assert.equal(index,m.hands);assert.equal(samples,m.samples);assert.equal(actions,m.actions);assert.equal(huOffered,m.huOffered);assert.equal(huMissed,m.huMissed);assert.deepEqual(teachers,m.teachers);
  return {hands:index,samples,actions,teachers,allFeaturesPoliciesAndReturnsRecomputed:true,sha256:m.sha256};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');
  const extension=auditSources();
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.deepEqual(s.models,models);assert.equal(s.productionPolicy,'H0');
  const b=p.budget,data={},parity={},snapshots=[],groups=jobsFor(p).map(j=>read(resolve(out,'groups',j.id,'group.json')));
  assert.deepEqual(s.evaluations,aggregate(p,groups));assert.equal(s.positivePrimaryEvidence,s.evaluations.offline.statistics.session.overall.ci95[0]>0);
  const seeds=new Set();
  for(const split of ['training','validation']){
    const d={manifest:metadata(resolve(out,split),split)};assert.deepEqual(d.manifest,t.datasets[split]);assert.equal(d.manifest.seed,p.seeds[split]);
    assert.equal(d.manifest.hands,b[split+'Hands']);assert.equal(d.manifest.startHand,0);assert.equal(d.manifest.sessionHands,b.trainingSessionHands);assert.equal(d.manifest.epsilon,p.epsilon);
    for await(const e of episodes(resolve(out,split))){assert.ok(!seeds.has(e.environmentSeed));seeds.add(e.environmentSeed);}
  }
  for(const arm of ARMS){
    const dir=resolve(out,`model-${arm}`),f=read(resolve(dir,'summary.json')),spec=read(resolve(out,`train-${arm}.json`)),epochs=b[arm==='bc'?'bcEpochs':'offlineEpochs'];
    assert.deepEqual(f,t.fitted[arm]);assert.equal(f.seed,p.seeds.model);assert.equal(f.mode,arm==='bc'?'bc':'q');assert.deepEqual(f.network,p.network);assert.deepEqual(f.config,p.optimizer);
    assert.equal(f.trainingHash,t.datasets.training.sha256);assert.equal(f.validationHash,t.datasets.validation.sha256);assert.equal(f.history.length,epochs+1);
    let best=f.history[0];for(const row of f.history)if(row.validation.loss<best.validation.loss-1e-12)best=row;
    assert.equal(f.selected.epoch,best.epoch);assert.deepEqual(models[arm],{...f.selected,sha256:hash(f.selected.path)});parity[arm]=verifyParity(resolve(dir,'parity.json'));
    assert.deepEqual(spec,{out:dir,schema:p.schema,sources:p.sources.core,seed:p.seeds.model,trainingData:resolve(out,'training'),validationData:resolve(out,'validation'),
      network:p.network,config:p.optimizer,mode:f.mode,epochs,...(arm==='offline'?{initialize:t.fitted.bc.selected.state}:{})});
    const files=readdirSync(dir).filter(n=>/^epoch-\d+\.json$/.test(n));assert.equal(files.length,epochs+1);
    for(const file of files){const q=loadQ(resolve(dir,file));assert.equal(q.data.metadata.optimizerStateSha256,hash(resolve(dir,file.replace('.json','.pt'))));
      assert.equal(q.data.metadata.trainingHash,f.trainingHash);assert.equal(q.data.metadata.validationHash,f.validationHash);snapshots.push(q.sha256);}
  }
  const work=resolve(out,'.audit-stream');if(existsSync(work))throw Error('Audit directory exists');mkdirSync(work);
  // Training data and evaluation groups are independent audit jobs, with bounded concurrency.
  const jobs=[...['training','validation'].map(split=>({id:split,kind:'data',split})),...jobsFor(p).map(job=>({id:job.id,kind:'evaluation',job}))],audited=[];
  await pooled(jobs,b.workers,async job=>{
    const spec=resolve(work,job.id+'.json'),result=resolve(work,job.id+'.result.json');
    const payload=job.kind==='data'?{path:resolve(out,job.split),split:job.split,result}:{path:resolve(out,'groups',job.id),plan:p,job:job.job,checkpoint:models[job.job.arm].path,result};
    save(spec,payload);await worker(process.execPath,job.kind==='data'?[fileURLToPath(import.meta.url),'data',spec]:[resolve(projectRoot,'ai/strong-pool/evaluate.mjs'),'audit',spec]);
    const r=read(result);if(job.kind==='data')data[job.split]=r;else audited.push(r);
    onProgress({stage:'audit',completedJobs:audited.length+Object.keys(data).length,totalJobs:jobs.length});
  });
  assert.equal(s.trainingHands,data.training.hands);assert.equal(s.validationHands,data.validation.hands);assert.equal(s.trainingSamples,data.training.samples);
  const games=audited.reduce((n,r)=>n+r.games,0);assert.equal(s.games,games);assert.equal(games,ARMS.length*p.pairs.length*b.evaluationGroups*12*b.sessionHands);check(p);
  const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,data,parity,snapshotsVerified:snapshots.length,games,
    groups:audited.sort((a,b)=>a.jobId.localeCompare(b.jobId)),sources:sources(),auditExtension:{version:'kwx-strong-pool-stream-audit-1',sources:extension,reason:'Merged training data exceeds V8 whole-string limit; frozen original policy/training/evaluation drivers are unchanged'}};assert.deepEqual(extension,auditSources());save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const progress=p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}));
  const task=process.argv[2]==='data'?verifyData({...read(process.argv[3]),onProgress:progress}).then(r=>save(read(process.argv[3]).result,r)):verify({out:process.argv[2],onProgress:progress});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
