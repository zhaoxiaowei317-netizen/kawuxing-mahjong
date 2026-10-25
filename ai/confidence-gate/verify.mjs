import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {projectRoot} from '../provenance.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {loadGate} from './model.mjs';
import {verifyPrepared} from './data.mjs';
import {simulate} from './groups.mjs';
import {fitSpec,checkFit,aggregate,judgments} from './study.mjs';
import {VERSION,check,jobsFor,read,hash} from './config.mjs';
export async function auditGroup({path,plan:p,job,models}){check(p);const g=read(resolve(path,'group.json')),file=resolve(path,'replays.jsonl.gz');assert.equal(g.replaysSha256,hash(file));const episodes=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let index=0;
  const result=await simulate({plan:p,job,models,cacheCapacity:0,onEpisode:e=>assert.deepEqual(e,episodes[index++])});assert.equal(index,episodes.length);const {cacheMetrics,...expected}=g,{cacheMetrics:actualCache,...actual}=result;
  assert.equal(actualCache.hits,0);assert.deepEqual(expected,{...actual,replaysSha256:hash(file)});return {jobId:job.id,games:g.games,groupSha256:hash(resolve(path,'group.json')),replaysSha256:hash(file),allEpisodesRedealtAndPoliciesAndExactTracesMatched:true,cacheDisabled:true};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(s.version,VERSION);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(s.productionPolicy,'H0');assert.deepEqual(models,s.models);assert.equal(s.newTrainingHands,0);assert.equal(s.newValidationHands,0);assert.equal(s.gradientUpdates,0);
  const audit=resolve(out,'.audit');if(existsSync(audit))throw Error('Audit exists');mkdirSync(audit);
  const data={};for(const split of ['training','validation']){data[split]=verifyPrepared({out:resolve(out,split),plan:p,split});assert.deepEqual(data[split],t.datasets[split]);onProgress({stage:'audit-features',split,roots:data[split].roots});}
  const spec=resolve(audit,'fit.json');save(spec,{...fitSpec(out,p),verify:true});await worker(p.python,[resolve(projectRoot,'ai/confidence-gate/train.py'),spec],q=>onProgress({stage:'audit-fit',...q}));const fitted=checkFit(out,p);assert.deepEqual(fitted,t.fitted);assert.deepEqual(models,{...p.models,gate:fitted.model});
  assert.equal(s.reusedTrainingHands,data.training.hands);assert.equal(s.reusedValidationHands,data.validation.hands);assert.equal(s.trainingRoots,data.training.roots);assert.equal(s.validationRoots,data.validation.roots);assert.equal(s.closedFormFits,fitted.fit.closedFormFits);assert.equal(s.fittedReadoutParameters,fitted.fit.fittedReadoutParameters);
  const audited=[];let evaluation={games:0,contrasts:{}};
  if(s.status==='evaluated'){assert.equal(fitted.constantChoice,null);assert.equal(s.identityTo,null);const jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));evaluation=aggregate(p,models,groups);assert.deepEqual(evaluation,s.evaluation);
    await pooled(jobs,p.budget.workers,async job=>{const spec=resolve(audit,job.id+'.json'),result=spec+'.result.json';save(spec,{path:resolve(out,'groups',job.id),plan:p,job,models,result});await worker(process.execPath,[fileURLToPath(import.meta.url),'group',spec]);audited.push(read(result));onProgress({stage:'audit-games',completedGroups:audited.length,totalGroups:jobs.length});});
  }else{assert.equal(s.status,'constant-selected');assert.ok(fitted.constantChoice!==null);assert.equal(loadGate(models.gate.path).model.constantChoice(),fitted.constantChoice);assert.equal(s.identityTo,fitted.constantChoice==='baseline'?'baseline':'always');assert.equal(readdirSync(resolve(out,'groups')).length,0);assert.equal(s.games,0);}
  assert.deepEqual(s.evaluation,evaluation);assert.equal(s.games,evaluation.games);for(const [k,v]of Object.entries(judgments(evaluation)))assert.deepEqual(s[k],v);check(p);
  const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,summarySha256:hash(resolve(out,'summary.json')),sourceMap:p.sourceMap,parentVerificationSha256:p.previous.files['verification.json'],
    allDerivedPublicFeaturesRecomputed:true,parentRawDataAuditInherited:true,data,allEightFitsRecomputed:true,games:s.games,allGroupsRecomputedWithoutScoreCache:true,groups:audited.sort((a,b)=>a.jobId.localeCompare(b.jobId))};save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2],spec=mode==='group'?read(process.argv[3]):null,task=spec?auditGroup(spec).then(v=>save(spec.result,v)):verify({out:mode,onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
