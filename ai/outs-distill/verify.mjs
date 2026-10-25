import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {save} from '../tile-q/collect.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {verifyParity} from '../tile-q/verify.mjs';
import {worker} from '../tile-q/study.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {episodes} from '../strong-pool/stream-data.mjs';
import {classify} from '../strong-confirm/study.mjs';
import {generate,studentEpisode,emptyCounts,count} from './collect.mjs';
import {simulate} from './groups.mjs';
import {aggregate} from './study.mjs';
import {STUDENTS,ARMS,CONTRASTS,check,jobsFor,trainSpec,read,hash} from './config.mjs';

export async function auditData({path,plan:p,split,startHand,hands}){
  check(p);const dirs=['canonical',...STUDENTS],iters=Object.fromEntries(dirs.map(a=>[a,episodes(resolve(path,a))[Symbol.asyncIterator]()])),counts=emptyCounts();
  try{for await(const e of generate({plan:p,split,startHand,hands})){
    for(const arm of dirs){const next=await iters[arm].next();assert.equal(next.done,false);assert.deepEqual(next.value,arm==='canonical'?e:studentEpisode(e,arm));}count(counts,e);
  }for(const arm of dirs)assert.equal((await iters[arm].next()).done,true);
  }finally{for(const it of Object.values(iters))await it.return?.();}
  const hashes={};for(const arm of dirs){const m=read(resolve(path,arm,'manifest.json'));assert.equal(m.split,split);assert.equal(m.seed,p.seeds[split]);assert.equal(m.startHand,startHand);
    assert.equal(m.label,arm);assert.equal(m.version,'kwx-tile-q-episodes-1');assert.equal(m.behaviorVersion,p.version);assert.deepEqual(m.schema,p.schema);
    assert.deepEqual(m.sources,p.coreSources);assert.deepEqual(m.driverSources,p.sources);assert.deepEqual(m.modelHashes,{raw:p.model});
    assert.equal(m.sessionHands,p.budget.sessionHands);assert.equal(m.epsilon,p.epsilon);for(const k of Object.keys(counts))assert.equal(m[k],counts[k]);
    hashes[arm]=hash(resolve(path,arm,'episodes.jsonl.gz'));assert.equal(m.sha256,hashes[arm]);
  }check(p);return {...counts,split,startHand,hashes,allEpisodesRedealtAndBothTeachersInputsReturnsAndLabelsRecomputed:true};
}
export async function auditGroup({path,plan:p,job,models}){
  check(p);const file=resolve(path,'replays.jsonl.gz'),g=read(resolve(path,'group.json'));assert.equal(g.replaysSha256,hash(file));
  const saved=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let index=0;
  const r=await simulate({plan:p,job,models,onEpisode:e=>assert.deepEqual(e,saved[index++])});assert.equal(index,saved.length);assert.deepEqual(g,{...r,replaysSha256:hash(file)});
  return {jobId:job.id,games:g.games,allEpisodesRedealtAndNeuralPoliciesAndExactTracesMatched:true,replaysSha256:hash(file),groupSha256:hash(resolve(path,'group.json'))};
}
function bestId(model,row){const {q}=model.forward(row.encoded,row.legalIds);let best=row.legalIds[0];for(const id of row.legalIds)if(q[id]>q[best])best=id;return best;}
export async function diagnostics({out,plan:p,models}){
  const loaded=Object.fromEntries(ARMS.map(a=>[a,loadQ(models[a].path).model]));
  const counters=()=>({samples:0,rawAgreement:0,correctedAgreement:0,changedSamples:0,changedCorrectedAgreement:0,unchangedSamples:0,unchangedRawAgreement:0,huOffered:0,huDeclined:0});
  const result=Object.fromEntries(ARMS.map(a=>[a,counters()]));for await(const e of episodes(resolve(out,'validation','canonical')))for(const row of e.rows)for(const arm of ARMS){
    const id=bestId(loaded[arm],row),c=result[arm];c.samples++;c.rawAgreement+=Number(id===row.teachers.self);c.correctedAgreement+=Number(id===row.teachers.corrected);
    if(row.changed){c.changedSamples++;c.changedCorrectedAgreement+=Number(id===row.teachers.corrected);}else{c.unchangedSamples++;c.unchangedRawAgreement+=Number(id===row.teachers.self);}
    if(row.legalIds.includes(84)){c.huOffered++;c.huDeclined+=Number(id!==84);}
  }return result;
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),
    t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(s.version,p.version);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.deepEqual(s.models,models);assert.deepEqual(models.raw,p.model);assert.equal(s.productionPolicy,'H0');
  const jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,models,groups));
  assert.deepEqual(s.primary,Object.fromEntries(Object.keys(CONTRASTS).map(k=>[k,s.evaluation.contrasts[k].statistics.session.overall])));
  assert.deepEqual(s.outcomes,Object.fromEntries(Object.entries(s.primary).map(([k,v])=>[k,classify(v)])));assert.equal(s.positiveJointEvidence,Object.values(s.outcomes).every(v=>v==='positive'));
  assert.equal(s.games,3*p.budget.groupsPerPair*18*p.budget.sessionHands);assert.equal(s.trainingHands,p.budget.trainingHands);assert.equal(s.validationHands,p.budget.validationHands);
  const dataJobs=[],allSeeds=new Set();for(const split of ['training','validation']){
    const manifests=t.datasets[split],first=manifests.canonical;assert.equal(first.hands,p.budget[split+'Hands']);assert.equal(first.startHand,0);assert.equal(first.seed,p.seeds[split]);
    for(const arm of ['canonical',...STUDENTS]){
      const path=resolve(out,split,arm),m=read(resolve(path,'manifest.json'));assert.deepEqual(m,manifests[arm]);assert.equal(m.sha256,hash(resolve(path,'episodes.jsonl.gz')));
      const chunks=m.parts.map(part=>readFileSync(resolve(part,'episodes.jsonl.gz')));assert.deepEqual(readFileSync(resolve(path,'episodes.jsonl.gz')),Buffer.concat(chunks));
      for(const k of Object.keys(emptyCounts()))assert.equal(m[k],m.parts.reduce((n,part)=>n+read(resolve(part,'manifest.json'))[k],0));
    }
    let offset=0;for(const canonical of first.parts){const path=resolve(canonical,'..'),m=read(resolve(canonical,'manifest.json'));assert.equal(m.startHand,offset);
      dataJobs.push({id:`data-${split}-${offset}`,kind:'data',path,split,startHand:offset,hands:m.hands});offset+=m.hands;
    }assert.equal(offset,first.hands);
    for await(const e of episodes(resolve(out,split,'canonical'))){assert.ok(!allSeeds.has(e.environmentSeed));allSeeds.add(e.environmentSeed);}
  }
  assert.equal(s.trainingSamples,t.datasets.training.canonical.samples);
  const parity={},snapshots=[];for(const arm of STUDENTS){
    const dir=resolve(out,`model-${arm}`),f=read(resolve(dir,'summary.json')),spec=read(resolve(out,`train-${arm}.json`));assert.deepEqual(spec,trainSpec(out,p,arm));assert.deepEqual(f,t.fitted[arm]);
    assert.equal(f.mode,'bc');assert.equal(f.seed,p.seeds.model);assert.deepEqual(f.network,p.network);assert.deepEqual(f.config,p.optimizer);
    assert.equal(f.trainingSamples,t.datasets.training[arm].samples);assert.equal(f.validationSamples,t.datasets.validation[arm].samples);
    assert.equal(f.trainingHash,t.datasets.training[arm].sha256);assert.equal(f.validationHash,t.datasets.validation[arm].sha256);assert.equal(f.history.length,p.budget.epochs+1);
    let best=f.history[0];for(const [epoch,r]of f.history.entries()){assert.equal(r.epoch,epoch);assert.equal(r.validation.loss,r.validation.bc);assert.equal(r.training.loss,r.training.bc);if(r.validation.loss<best.validation.loss-1e-12)best=r;}
    assert.equal(f.selected.epoch,best.epoch);assert.equal(f.selected.validationLoss,best.validation.loss);assert.equal(f.selected.path,resolve(dir,`epoch-${String(best.epoch).padStart(3,'0')}.json`));
    assert.equal(f.selected.state,f.selected.path.replace('.json','.pt'));assert.deepEqual(models[arm],{...f.selected,sha256:hash(f.selected.path)});parity[arm]=verifyParity(resolve(dir,'parity.json'));
    const files=readdirSync(dir).filter(n=>/^epoch-\d+\.json$/.test(n));assert.equal(files.length,p.budget.epochs+1);
    for(const file of files){const path=resolve(dir,file),q=loadQ(path),metadata=q.data.metadata;assert.equal(metadata.optimizerStateSha256,hash(path.replace('.json','.pt')));
      assert.equal(metadata.mode,'bc');assert.equal(metadata.seed,p.seeds.model);assert.equal(metadata.trainingHash,f.trainingHash);assert.equal(metadata.validationHash,f.validationHash);
      assert.equal(metadata.epoch,Number(file.slice(6,9)));snapshots.push({path,sha256:q.sha256,stateSha256:metadata.optimizerStateSha256});
    }
    assert.deepEqual(loadQ(resolve(dir,'epoch-000.json')).data.weights,loadQ(p.model.path).data.weights,'Both students initialize identical original weights');
  }
  assert.equal(t.fitted.self.trainingSamples,t.fitted.corrected.trainingSamples);const work=resolve(out,'.audit');if(existsSync(work))throw Error('Audit directory exists');mkdirSync(work);
  const audited=[],all=[...dataJobs,...jobs.map(job=>({id:job.id,kind:'group',job}))];await pooled(all,p.budget.workers,async j=>{
    const spec=resolve(work,j.id+'.json'),result=resolve(work,j.id+'.result.json'),payload=j.kind==='data'?{...j,plan:p,result}:{path:resolve(out,'groups',j.id),plan:p,job:j.job,models,result};save(spec,payload);
    await worker(process.execPath,[fileURLToPath(import.meta.url),j.kind,spec]);audited.push({kind:j.kind,...read(result)});onProgress({stage:'audit',completedJobs:audited.length,totalJobs:all.length});
  });
  const data=audited.filter(a=>a.kind==='data'),games=audited.filter(a=>a.kind==='group').reduce((n,g)=>n+g.games,0);assert.equal(games,s.games);
  for(const split of ['training','validation']){assert.equal(data.filter(d=>d.split===split).reduce((n,d)=>n+d.hands,0),p.budget[split+'Hands']);
    for(const k of ['samples','actions','correctedLabels'])assert.equal(data.filter(d=>d.split===split).reduce((n,d)=>n+d[k],0),t.datasets[split].canonical[k]);}
  const behavior=await diagnostics({out,plan:p,models});save(resolve(out,'validation-diagnostics.json'),{planSha256:s.planSha256,models:behavior,role:'Descriptive fixed validation decisions; no checkpoint selection based on these extra metrics.'});
  check(p);const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,sources:p.sources,games,data,groups:audited.filter(a=>a.kind==='group').sort((a,b)=>a.jobId.localeCompare(b.jobId)),
    snapshotsVerified:snapshots.length,snapshots,parity,validationDiagnosticsSha256:hash(resolve(out,'validation-diagnostics.json'))};save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const kind=process.argv[2],progress=p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}));
  const task=['data','group'].includes(kind)?(kind==='data'?auditData(read(process.argv[3])):auditGroup(read(process.argv[3]))).then(r=>save(read(process.argv[3]).result,r)):verify({out:kind,onProgress:progress});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
