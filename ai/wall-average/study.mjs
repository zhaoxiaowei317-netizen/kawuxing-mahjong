import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deriveSeed} from '../random.mjs';
import {projectRoot} from '../provenance.mjs';
import {summarizePaired} from '../statistics.mjs';
import {save} from '../tile-q/collect.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {worker} from '../tile-q/study.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {classify} from '../strong-confirm/study.mjs';
import {checkTraining as checkOldTraining} from '../paired-tile/study.mjs';
import {merge,project,load,VARIANTS,projectEpisode} from './collect.mjs';
import {VERSION,CONTRASTS,makePlan,check,jobsFor,jobSeed,read,hash} from './config.mjs';
export function aggregate(p,models,groups){
  const jobs=jobsFor(p);assert.deepEqual(groups.map(g=>g.job.id).sort(),jobs.map(j=>j.id).sort());
  const ordered=jobs.map(j=>{const g=groups.find(g=>g.job.id===j.id);assert.deepEqual(g.job,j);assert.equal(g.groupSeed,jobSeed(p,j));assert.equal(g.games,30*p.budget.sessionHands);
    assert.deepEqual(g.modelHashes,Object.fromEntries(['short','long','average','single'].map(k=>[k,models[k].sha256])));return g;});
  return {games:ordered.reduce((n,g)=>n+g.games,0),contrasts:Object.fromEntries(Object.entries(CONTRASTS).map(([key,control])=>{
    const records=ordered.map(g=>({suite:'session',opponentPair:g.record.opponentPair,seed:g.record.seed,candidate:g.record.arms.average,incumbent:g.record.arms[control]}));
    return [key,{records,statistics:summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seeds.evaluation,'bootstrap',key),base:1})}];
  }))};
}
export function trainSpec(out,p,variant){assert.ok(VARIANTS.includes(variant));return {out:resolve(out,variant,'model'),initialize:p.models.short.state,schema:p.schema,sources:p.coreSources,experimentSources:p.sourceMap,
  network:p.network,config:p.optimizer,seed:p.seeds.model,epochs:p.budget.epochs,trainingData:resolve(out,variant,'training'),validationData:resolve(out,variant,'validation')};}
export function checkTraining(out,p,variant){assert.ok(VARIANTS.includes(variant));return checkOldTraining(resolve(out,variant),p);}
const mean=a=>a.reduce((n,x)=>n+x,0)/a.length;
const variance=a=>a.length>1?a.reduce((n,x)=>n+(x-mean(a))**2,0)/(a.length-1):null;
export function labelDiagnostic(episodes){const rows=episodes.filter(e=>e.root),g=rows.map(e=>mean(e.samples.map(s=>s.gain))),within=rows.map(e=>variance(e.samples.map(s=>s.gain))),k=rows[0]?.samples.length;
  if(!rows.length)return {roots:0};const averageWithinVariance=mean(within),sampleMeanVariance=variance(g);
  return {roots:rows.length,wallSamples:k,originalMeanGain:mean(rows.map(e=>e.samples[0].gain)),averagedMeanGain:mean(g),
    originalSampleVariance:variance(rows.map(e=>e.samples[0].gain)),averagedSampleVariance:sampleMeanVariance,averageWithinVariance,
    estimatedFutureWallNoiseInOneLabel:averageWithinVariance,estimatedFutureWallNoiseInMeanLabel:averageWithinVariance/k,
    estimatedBetweenRootVariance:sampleMeanVariance===null?null:sampleMeanVariance-averageWithinVariance/k,
    originalVersusAverageSignDisagreements:rows.filter((e,i)=>Math.sign(e.samples[0].gain)!==Math.sign(g[i])).length};}
export function diagnostics(out,p,models){
  const training=load(resolve(out,'training'),p,'training').episodes,validation=load(resolve(out,'validation'),p,'validation').episodes,
    rows=validation.filter(e=>e.root),target=rows.map(e=>projectEpisode(e,'average').root.gain),trainMean=mean(training.filter(e=>e.root).map(e=>projectEpisode(e,'average').root.gain)),mse=pred=>mean(pred.map((x,i)=>(x-target[i])**2));
  const predictions=Object.fromEntries(VARIANTS.map(variant=>{const m=loadQ(models[variant].path).model;return [variant,rows.map(e=>{const q=m.forward(e.root.encoded,e.root.legalIds).q;return q[e.root.alternativeId]-q[e.root.baselineId];})];}));
  return {purpose:'Predeclared descriptive diagnostics only; no model selection or policy-strength claim. Gains normalized by 16. Roots share fixed actual opponent hands. Averaged target is noisy, not true public expected value. No raw cross-target MSE comparison.',
    training:labelDiagnostic(training),validation:labelDiagnostic(validation),commonAveragedValidationTarget:{roots:rows.length,trainingAverageConstant:trainMean,
      zeroMse:mse(target.map(()=>0)),trainingConstantMse:mse(target.map(()=>trainMean)),modelMse:Object.fromEntries(VARIANTS.map(k=>[k,mse(predictions[k])])),
      accepts:Object.fromEntries(VARIANTS.map(k=>[k,predictions[k].filter(x=>x>0).length]))}};
}
export function judgments(evaluation){const primary=Object.fromEntries(Object.entries(evaluation.contrasts).map(([k,r])=>[k,r.statistics.session.overall])),outcomes=Object.fromEntries(Object.entries(primary).map(([k,x])=>[k,classify(x)]));
  return {primary,outcomes,learningEvidence:['variance','improvement','selection'].every(k=>outcomes[k]==='positive'),positiveJointEvidence:Object.keys(outcomes).length===4&&Object.values(outcomes).every(x=>x==='positive')};}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');const p=makePlan(options),b=p.budget;mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'.specs'));mkdirSync(resolve(out,'groups'));save(resolve(out,'plan.json'),p);onProgress({stage:'plan',budget:b});
  const parts={training:[],validation:[]},jobs=[];
  for(const [split,hands,n]of [['training',b.trainingHands,b.workers],['validation',b.validationHands,1]])for(let i=0;i<n;i++){
    const path=resolve(out,'.collect',`${split}-${i}`),spec=resolve(out,'.specs',`collect-${split}-${i}.json`);parts[split].push(path);jobs.push({id:`${split}-${i}`,spec,payload:{out:path,plan:p,split,startHand:i*hands/n,hands:hands/n}});
  }
  await pooled(jobs,b.workers,async j=>{save(j.spec,j.payload);await worker(process.execPath,[resolve(projectRoot,'ai/wall-average/collect.mjs'),j.spec],q=>onProgress({stage:'collect',worker:j.id,...q}));});check(p);
  const datasets=Object.fromEntries(['training','validation'].map(split=>[split,merge({out:resolve(out,split),parts:parts[split],plan:p,split})]));
  const trained={},projections={},models={...p.models};let evaluation={games:0,contrasts:{}},status='no-eligible-roots';
  if(datasets.training.roots&&datasets.validation.roots){
    for(const variant of VARIANTS){projections[variant]=Object.fromEntries(['training','validation'].map(split=>[split,project({out:resolve(out,variant,split),raw:resolve(out,split),plan:p,split,variant})]));
      const spec=resolve(out,variant,'train.json');save(spec,trainSpec(out,p,variant));await worker(p.python,[resolve(projectRoot,'ai/paired-tile/train.py'),spec],q=>onProgress({stage:'train',variant,...q}));
      trained[variant]=checkTraining(out,p,variant);models[variant]=trained[variant].model;
    }status='evaluated';
  }
  save(resolve(out,'training.json'),{datasets,projections,trained});save(resolve(out,'models.json'),models);onProgress({stage:'models-frozen',status,selected:Object.fromEntries(Object.entries(trained).map(([k,t])=>[k,t.training.selected])),roots:{training:datasets.training.roots,validation:datasets.validation.roots}});
  if(status==='evaluated')save(resolve(out,'diagnostics.json'),diagnostics(out,p,models));
  if(status==='evaluated'){
    const groups=[],todo=jobsFor(p);await pooled(todo,b.workers,async job=>{const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p,job,models});
      await worker(process.execPath,[resolve(projectRoot,'ai/wall-average/groups.mjs'),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:todo.length,games:groups.reduce((n,g)=>n+g.games,0)});});
    evaluation=aggregate(p,models,groups);
  }
  check(p);const s={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),models,status,evaluation,...judgments(evaluation),
    diagnosticsSha256:status==='evaluated'?hash(resolve(out,'diagnostics.json')):null,games:evaluation.games,trainingHands:b.trainingHands,validationHands:b.validationHands,trainingSamples:datasets.training.roots,optimizationUpdates:Object.values(trained).reduce((n,t)=>n+t.training.optimizationUpdates,0),productionPolicy:'H0'};
  save(resolve(out,'summary.json'),s);onProgress({stage:'complete',games:s.games,status,outcomes:s.outcomes,positiveJointEvidence:s.positiveJointEvidence});return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))}).then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
