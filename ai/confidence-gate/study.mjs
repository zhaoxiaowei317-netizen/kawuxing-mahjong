import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deriveSeed} from '../random.mjs';
import {projectRoot} from '../provenance.mjs';
import {summarizePaired} from '../statistics.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {classify} from '../strong-confirm/study.mjs';
import {prepare} from './data.mjs';
import {loadGate} from './model.mjs';
import {VERSION,LAMBDAS,CONTRASTS,makePlan,check,jobsFor,jobSeed,read,hash} from './config.mjs';
export function fitSpec(out,p){return {out:resolve(out,'model'),sources:p.sourceMap,schema:p.schema,lambdas:LAMBDAS,tieTolerance:p.fit.tieTolerance,trainingData:resolve(out,'training'),validationData:resolve(out,'validation')};}
export function checkFit(out,p){
  const f=read(resolve(out,'model/summary.json')),names=['zero','constant',...LAMBDAS.map(n=>'ridge-'+n)];assert.deepEqual(f.history.map(r=>r.name),names);assert.deepEqual(f.lambdas,LAMBDAS);assert.equal(f.tieTolerance,p.fit.tieTolerance);assert.equal(f.gradientUpdates,0);assert.equal(f.closedFormFits,LAMBDAS.length);assert.equal(f.features,p.schema.names.length);assert.equal(f.fittedReadoutParameters,p.schema.names.length+1);
  const best=f.history.reduce((a,r)=>r.validation.mse<a.validation.mse-p.fit.tieTolerance?r:a);assert.equal(f.selected.name,best.name);assert.equal(f.selected.validationMse,best.validation.mse);assert.equal(f.selected.path,resolve(out,'model',best.name+'.json'));
  const train=read(resolve(out,'training/manifest.json')),val=read(resolve(out,'validation/manifest.json'));assert.equal(f.trainingRoots,train.roots);assert.equal(f.validationRoots,val.roots);assert.equal(f.trainingHash,train.sha256);assert.equal(f.validationHash,val.sha256);
  let first=null;for(const r of f.history){const d=loadGate(resolve(out,'model',r.name+'.json')).data;assert.equal(d.metadata.candidate,r.name);assert.equal(d.metadata.lambda,r.lambda);assert.deepEqual(d.metadata.sources,p.sourceMap);assert.equal(d.metadata.trainingHash,train.sha256);assert.equal(d.metadata.validationHash,val.sha256);
    if(first){assert.deepEqual(d.mean,first.mean);assert.deepEqual(d.scale,first.scale);}else first=d;
    if(['zero','constant'].includes(r.name))assert.ok(d.weights.every(x=>x===0));if(r.name==='zero')assert.equal(d.intercept,0);
  }
  const chosen=loadGate(f.selected.path),parity=read(resolve(out,'model/parity.json'));assert.equal(parity.model,f.selected.path);let maxError=0;
  for(const r of parity.fixtures){const error=Math.abs(chosen.model.predict(r.features)-r.prediction);assert.ok(error<1e-10);maxError=Math.max(maxError,error);}
  return {fit:f,model:{...f.selected,sha256:chosen.sha256},constantChoice:chosen.model.constantChoice(),parityMaxError:maxError};
}
export function aggregate(p,models,groups){const jobs=jobsFor(p);assert.deepEqual(groups.map(g=>g.job.id).sort(),jobs.map(j=>j.id).sort());
  const ordered=jobs.map(j=>{const g=groups.find(g=>g.job.id===j.id);assert.deepEqual(g.job,j);assert.equal(g.groupSeed,jobSeed(p,j));assert.equal(g.games,30*p.budget.sessionHands);assert.deepEqual(g.modelHashes,Object.fromEntries(['short','long','average','gate'].map(k=>[k,models[k].sha256])));return g;});
  return {games:ordered.reduce((n,g)=>n+g.games,0),contrasts:Object.fromEntries(Object.entries(CONTRASTS).map(([key,control])=>{const records=ordered.map(g=>({suite:'session',opponentPair:g.record.opponentPair,seed:g.record.seed,candidate:g.record.arms.gate,incumbent:g.record.arms[control]}));
    return [key,{records,statistics:summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seeds.evaluation,'bootstrap',key),base:1})}];}))};
}
export function judgments(evaluation){const primary=Object.fromEntries(Object.entries(evaluation.contrasts).map(([k,r])=>[k,r.statistics.session.overall])),outcomes=Object.fromEntries(Object.entries(primary).map(([k,v])=>[k,classify(v)]));
  return {primary,outcomes,learningEvidence:['representation','improvement','selection'].every(k=>outcomes[k]==='positive'),positiveJointEvidence:Object.keys(outcomes).length===4&&Object.values(outcomes).every(v=>v==='positive')};}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');const p=makePlan(options),b=p.budget;mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'groups'));mkdirSync(resolve(out,'.specs'));save(resolve(out,'plan.json'),p);onProgress({stage:'plan',budget:b});
  const datasets={};for(const split of ['training','validation']){datasets[split]=prepare({out:resolve(out,split),plan:p,split});onProgress({stage:'features',split,hands:datasets[split].hands,roots:datasets[split].roots});}
  const spec=resolve(out,'fit.json');save(spec,fitSpec(out,p));await worker(p.python,[resolve(projectRoot,'ai/confidence-gate/train.py'),spec],q=>onProgress({stage:'fit',...q}));const fitted=checkFit(out,p),models={...p.models,gate:fitted.model},status=fitted.constantChoice===null?'evaluated':'constant-selected';
  save(resolve(out,'training.json'),{datasets,fitted});save(resolve(out,'models.json'),models);onProgress({stage:'model-frozen',status,selected:fitted.fit.selected,identityTo:fitted.constantChoice==='baseline'?'baseline':fitted.constantChoice==='alternative'?'always':null});
  let evaluation={games:0,contrasts:{}};if(status==='evaluated'){
    const groups=[],todo=jobsFor(p);await pooled(todo,b.workers,async job=>{const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p,job,models});await worker(process.execPath,[resolve(projectRoot,'ai/confidence-gate/groups.mjs'),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:todo.length});});evaluation=aggregate(p,models,groups);
  }
  check(p);const s={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),models,status,identityTo:fitted.constantChoice==='baseline'?'baseline':fitted.constantChoice==='alternative'?'always':null,evaluation,...judgments(evaluation),
    games:evaluation.games,newTrainingHands:0,newValidationHands:0,reusedTrainingHands:datasets.training.hands,reusedValidationHands:datasets.validation.hands,trainingRoots:datasets.training.roots,validationRoots:datasets.validation.roots,
    closedFormFits:fitted.fit.closedFormFits,gradientUpdates:0,fittedReadoutParameters:fitted.fit.fittedReadoutParameters,productionPolicy:'H0'};save(resolve(out,'summary.json'),s);onProgress({stage:'complete',status,games:s.games,outcomes:s.outcomes});return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))}).then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
