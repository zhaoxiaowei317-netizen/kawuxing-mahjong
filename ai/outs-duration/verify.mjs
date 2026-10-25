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
import {classify} from '../strong-confirm/study.mjs';
import {diagnostics} from '../outs-distill/verify.mjs';
import {simulate} from './groups.mjs';
import {aggregate,prefix} from './study.mjs';
import {check,checkData,jobsFor,trainSpec,read,hash} from './config.mjs';
export async function auditGroup({path,plan:p,job,models}){
  check(p);const file=resolve(path,'replays.jsonl.gz'),g=read(resolve(path,'group.json'));assert.equal(g.replaysSha256,hash(file));
  const saved=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let index=0;
  const r=await simulate({plan:p,job,models,onEpisode:e=>assert.deepEqual(e,saved[index++])});assert.equal(index,saved.length);assert.deepEqual(g,{...r,replaysSha256:hash(file)});
  return {jobId:job.id,games:g.games,allEpisodesRedealtAndNeuralPoliciesAndExactTracesMatched:true,replaysSha256:hash(file),groupSha256:hash(resolve(path,'group.json'))};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);checkData(p);
  assert.equal(s.version,p.version);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.deepEqual(s.models,models);
  assert.deepEqual(models.short,p.short);assert.deepEqual(models.raw,p.model);assert.equal(s.productionPolicy,'H0');
  assert.equal(s.newUniqueTrainingHands,0);assert.equal(s.newUniqueValidationHands,0);
  assert.equal(t.newUniqueTrainingHands,0);assert.equal(t.newUniqueValidationHands,0);
  assert.equal(t.reusedTrainingHands,p.data['training/corrected'].hands);assert.equal(t.reusedValidationHands,p.data['validation/corrected'].hands);
  assert.deepEqual(read(resolve(out,'train-long.json')),trainSpec(out,p));
  const f=read(resolve(out,'model-long/summary.json'));assert.deepEqual(f,t.fitted);assert.equal(f.history.length,p.budget.epochs+1);
  const spec=trainSpec(out,p);for(const key of ['config','network','mode','seed','experimentSources'])assert.deepEqual(f[key],spec[key]);
  assert.equal(f.trainingHash,p.data['training/corrected'].sha256);assert.equal(f.validationHash,p.data['validation/corrected'].sha256);
  assert.equal(f.trainingCanonicalHash,p.data['training/canonical'].sha256);assert.equal(f.validationCanonicalHash,p.data['validation/canonical'].sha256);
  assert.equal(f.trainingSamples,p.data['training/corrected'].samples);assert.equal(f.validationSamples,p.data['validation/corrected'].samples);
  let best=f.history[0];for(const [epoch,r]of f.history.entries()){
    assert.equal(r.epoch,epoch);for(const part of [r.training,r.validation]){assert.ok(Number.isFinite(part.bc));assert.equal(part.objective,part.bc);}
    if(r.validation.bc<best.validation.bc-1e-12)best=r;
  }
  assert.equal(f.selected.epoch,best.epoch);assert.equal(f.selected.validationLoss,best.validation.bc);
  assert.equal(f.selected.path,resolve(out,'model-long',`epoch-${String(best.epoch).padStart(3,'0')}.json`));assert.equal(f.selected.state,f.selected.path.replace('.json','.pt'));
  assert.deepEqual(models.long,{...f.selected,sha256:hash(f.selected.path)});
  assert.deepEqual(await prefix({out,plan:p}),t.prefixAudit);
  const files=readdirSync(resolve(out,'model-long')).filter(n=>/^epoch-\d+\.json$/.test(n));assert.equal(files.length,p.budget.epochs+1);
  const snapshots=files.map(file=>{const path=resolve(out,'model-long',file),q=loadQ(path),m=q.data.metadata;
    assert.equal(m.optimizerStateSha256,hash(path.replace('.json','.pt')));assert.equal(m.epoch,Number(file.slice(6,9)));
    assert.deepEqual(m.experimentSources,p.sourceMap);assert.equal(m.seed,p.trainingSeed);assert.equal(m.trainingHash,f.trainingHash);assert.equal(m.validationHash,f.validationHash);assert.equal(m.mode,'plain');
    return {path,sha256:q.sha256,stateSha256:m.optimizerStateSha256};
  });
  for(const x of [models.short,models.raw])assert.equal(hash(x.state),loadQ(x.path).data.metadata.optimizerStateSha256);
  const parity=verifyParity(resolve(out,'model-long/parity.json')),jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));
  assert.deepEqual(s.evaluation,aggregate(p,models,groups));assert.equal(s.games,s.evaluation.games);
  assert.equal(s.games,3*p.budget.groupsPerPair*24*p.budget.sessionHands);
  assert.deepEqual(s.primary,Object.fromEntries(['duration','strength'].map(k=>[k,s.evaluation.contrasts[k].statistics.session.overall])));
  assert.deepEqual(s.outcomes,Object.fromEntries(Object.entries(s.primary).map(([k,v])=>[k,classify(v)])));assert.equal(s.positiveJointEvidence,Object.values(s.outcomes).every(v=>v==='positive'));
  const work=resolve(out,'.audit');if(existsSync(work))throw Error('Audit directory exists');mkdirSync(work);const audited=[];
  await pooled(jobs,p.budget.workers,async job=>{
    const spec=resolve(work,job.id+'.json'),result=resolve(work,job.id+'.result.json');save(spec,{path:resolve(out,'groups',job.id),plan:p,job,models,result});
    await worker(process.execPath,[fileURLToPath(import.meta.url),'group',spec]);audited.push(read(result));onProgress({stage:'audit',completedGroups:audited.length,totalGroups:jobs.length});
  });
  assert.equal(audited.reduce((n,g)=>n+g.games,0),s.games);
  const behavior=await diagnostics({out:p.previous.path,plan:read(resolve(p.previous.path,'plan.json')).protocol,models:{corrected:models.long,self:models.short,raw:models.raw}});
  save(resolve(out,'validation-diagnostics.json'),{planSha256:s.planSha256,models:{long:behavior.corrected,short:behavior.self,raw:behavior.raw},role:'Descriptive only; fixed reused validation, not another independent learning batch.'});
  check(p);checkData(p);const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,sourceMap:p.sourceMap,games:s.games,
    reusedDataHashesRechecked:true,reusedDataPriorVerificationSha256:p.previous.files['verification.json'],prefixAudit:t.prefixAudit,
    snapshotsVerified:snapshots.length,snapshots,parity,groups:audited.sort((a,b)=>a.jobId.localeCompare(b.jobId)),validationDiagnosticsSha256:hash(resolve(out,'validation-diagnostics.json'))};
  save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const task=process.argv[2]==='group'?auditGroup(read(process.argv[3])).then(r=>save(read(process.argv[3]).result,r)):
    verify({out:process.argv[2],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
