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
import {emptyCounts} from '../outs-distill/collect.mjs';
import {auditData as oldAuditData,diagnostics as oldDiagnostics} from '../outs-distill/verify.mjs';
import {simulate} from './groups.mjs';
import {aggregate} from './study.mjs';
import {STUDENTS,NEURAL,check,jobsFor,trainSpec,read,hash} from './config.mjs';

export async function auditData(options){check(options.plan);return oldAuditData({...options,plan:options.plan.protocol});}
export async function auditGroup({path,plan:p,job,models}){
  check(p);const file=resolve(path,'replays.jsonl.gz'),g=read(resolve(path,'group.json'));assert.equal(g.replaysSha256,hash(file));
  const saved=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let index=0;
  const r=await simulate({plan:p,job,models,onEpisode:e=>assert.deepEqual(e,saved[index++])});assert.equal(index,saved.length);assert.deepEqual(g,{...r,replaysSha256:hash(file)});
  return {jobId:job.id,games:g.games,allEpisodesRedealtAndNeuralPoliciesAndExactTracesMatched:true,replaysSha256:hash(file),groupSha256:hash(resolve(path,'group.json'))};
}
export async function diagnostics({out,plan,models}){
  const d=await oldDiagnostics({out,plan:plan.protocol,models:{corrected:models.anchor,self:models.plain,raw:models.raw}});
  return {anchor:d.corrected,plain:d.self,raw:d.raw};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),
    t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(s.version,p.version);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.deepEqual(s.models,models);assert.deepEqual(models.raw,p.model);assert.equal(s.productionPolicy,'H0');
  const jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));assert.deepEqual(s.evaluation,aggregate(p,models,groups));
  assert.deepEqual(s.primary,Object.fromEntries(['objective','improvement'].map(k=>[k,s.evaluation.contrasts[k].statistics.session.overall])));
  assert.deepEqual(s.outcomes,Object.fromEntries(Object.entries(s.primary).map(([k,v])=>[k,classify(v)])));assert.equal(s.positiveJointEvidence,Object.values(s.outcomes).every(v=>v==='positive'));
  assert.equal(s.games,3*p.budget.groupsPerPair*24*p.budget.sessionHands);assert.equal(s.trainingHands,p.budget.trainingHands);assert.equal(s.validationHands,p.budget.validationHands);
  const dataJobs=[],allSeeds=new Set();for(const split of ['training','validation']){
    const manifests=t.datasets[split],first=manifests.canonical;assert.equal(first.hands,p.budget[split+'Hands']);assert.equal(first.startHand,0);assert.equal(first.seed,p.seeds[split]);
    for(const arm of ['canonical','corrected','self']){
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
    assert.equal(f.mode,arm);assert.equal(f.seed,p.seeds.model);assert.deepEqual(f.network,p.network);assert.deepEqual(f.config,{...p.optimizer,anchorWeight:arm==='anchor'?1:0,temperature:1});assert.deepEqual(f.experimentSources,p.sourceMap);
    assert.ok(f.history[0].training.anchor<1e-6&&f.history[0].validation.anchor<1e-6);
    for(const a of Object.values(f.teacherBackendAudit)){assert.equal(a.tolerance,1e-5);assert.ok(a.maxScoreGap<1e-5);assert.ok(Number.isSafeInteger(a.argmaxDifferences)&&a.argmaxDifferences>=0);}
    assert.equal(f.trainingSamples,t.datasets.training.corrected.samples);assert.equal(f.validationSamples,t.datasets.validation.corrected.samples);
    assert.equal(f.trainingCanonicalHash,t.datasets.training.canonical.sha256);assert.equal(f.validationCanonicalHash,t.datasets.validation.canonical.sha256);assert.equal(f.trainingHash,t.datasets.training.corrected.sha256);assert.equal(f.validationHash,t.datasets.validation.corrected.sha256);assert.equal(f.history.length,p.budget.epochs+1);
    let best=f.history[0];for(const [epoch,r]of f.history.entries()){assert.equal(r.epoch,epoch);for(const part of [r.training,r.validation]){assert.ok(Math.abs(part.objective-part.bc-f.config.anchorWeight*part.anchor)<1e-5);assert.ok(part.anchor>=0);}
      if(r.validation.bc<best.validation.bc-1e-12)best=r;}
    assert.equal(f.selected.epoch,best.epoch);assert.equal(f.selected.validationLoss,best.validation.bc);assert.equal(f.selected.path,resolve(dir,`epoch-${String(best.epoch).padStart(3,'0')}.json`));
    assert.equal(f.selected.state,f.selected.path.replace('.json','.pt'));assert.deepEqual(models[arm],{...f.selected,sha256:hash(f.selected.path)});parity[arm]=verifyParity(resolve(dir,'parity.json'));
    const files=readdirSync(dir).filter(n=>/^epoch-\d+\.json$/.test(n));assert.equal(files.length,p.budget.epochs+1);
    for(const file of files){const path=resolve(dir,file),q=loadQ(path),metadata=q.data.metadata;assert.equal(metadata.optimizerStateSha256,hash(path.replace('.json','.pt')));
      assert.equal(metadata.mode,arm);assert.deepEqual(metadata.experimentSources,p.sourceMap);assert.equal(metadata.seed,p.seeds.model);assert.equal(metadata.trainingHash,f.trainingHash);assert.equal(metadata.validationHash,f.validationHash);
      assert.equal(metadata.epoch,Number(file.slice(6,9)));snapshots.push({path,sha256:q.sha256,stateSha256:metadata.optimizerStateSha256});
    }
    assert.deepEqual(loadQ(resolve(dir,'epoch-000.json')).data.weights,loadQ(p.model.path).data.weights,'Both students initialize identical original weights');
  }
  assert.equal(t.fitted.plain.trainingSamples,t.fitted.anchor.trainingSamples);const work=resolve(out,'.audit');if(existsSync(work))throw Error('Audit directory exists');mkdirSync(work);
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


