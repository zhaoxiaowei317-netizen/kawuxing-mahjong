import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {deriveSeed} from '../random.mjs';
import {summarizePaired} from '../statistics.mjs';
import {save} from '../tile-q/collect.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {worker} from '../tile-q/study.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {classify} from '../strong-confirm/study.mjs';
import {VERSION,NEURAL,CONTRASTS,makePlan,check,checkData,jobsFor,jobSeed,trainSpec,read,hash} from './config.mjs';
export function aggregate(p,models,groups){
  const jobs=jobsFor(p);assert.deepEqual(groups.map(g=>g.job.id).sort(),jobs.map(j=>j.id).sort());
  const ordered=jobs.map(j=>{const g=groups.find(g=>g.job.id===j.id);assert.deepEqual(g.job,j);assert.equal(g.groupSeed,jobSeed(p,j));
    assert.deepEqual(g.modelHashes,Object.fromEntries(NEURAL.map(a=>[a,models[a].sha256])));assert.equal(g.games,24*p.budget.sessionHands);return g;});
  return {games:ordered.reduce((n,g)=>n+g.games,0),contrasts:Object.fromEntries(Object.entries(CONTRASTS).map(([name,control])=>{
    const records=ordered.map(g=>({suite:'session',opponentPair:g.record.opponentPair,seed:g.record.seed,candidate:g.record.arms.long,incumbent:g.record.arms[control]}));
    return [name,{records,statistics:summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seed,'bootstrap',name),base:1})}];
  }))};
}
export async function prefix({out,plan:p}){
  const old=read(resolve(p.previous.path,'model-plain/summary.json')),current=read(resolve(out,'model-long/summary.json'));
  assert.deepEqual(current.history.slice(0,p.budget.shortEpochs+1),old.history);
  for(let e=0;e<=p.budget.shortEpochs;e++){
    const name=`epoch-${String(e).padStart(3,'0')}.json`;
    assert.deepEqual(loadQ(resolve(out,'model-long',name)).data.weights,loadQ(resolve(p.previous.path,'model-plain',name)).data.weights);
  }
  const result=resolve(out,'prefix-python.json'),spec=resolve(out,'prefix-spec.json');
  save(spec,{previous:resolve(p.previous.path,'model-plain'),current:resolve(out,'model-long'),epochs:p.budget.shortEpochs,trainingSpec:resolve(out,'train-long.json'),result});
  await worker(p.python,[resolve(projectRoot,'ai/outs-duration/check_prefix.py'),spec]);
  return {...read(result),allExportedWeightsAndMetricsExactlyEqual:true};
}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');const p=makePlan(options);checkData(p);
  mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'.specs'));mkdirSync(resolve(out,'groups'));save(resolve(out,'plan.json'),p);onProgress({stage:'plan',budget:p.budget});
  const spec=resolve(out,'train-long.json');save(spec,trainSpec(out,p));
  await worker(p.python,[resolve(projectRoot,'ai/outs-anchor/train.py'),spec],r=>onProgress({stage:'train-long',...r}));
  const fitted=read(resolve(out,'model-long/summary.json')),prefixAudit=await prefix({out,plan:p}),models={long:{...fitted.selected,sha256:loadQ(fitted.selected.path).sha256},short:p.short,raw:p.model};
  save(resolve(out,'training.json'),{fitted,prefixAudit,newUniqueTrainingHands:0,newUniqueValidationHands:0,reusedTrainingHands:p.data['training/corrected'].hands,reusedValidationHands:p.data['validation/corrected'].hands});
  save(resolve(out,'models.json'),models);check(p);checkData(p);onProgress({stage:'models-frozen',models,prefixAudit});
  const jobs=jobsFor(p),groups=[];await pooled(jobs,p.budget.workers,async job=>{
    const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p,job,models});
    await worker(process.execPath,[resolve(projectRoot,'ai/outs-duration/groups.mjs'),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));
    onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:jobs.length,games:groups.reduce((n,g)=>n+g.games,0)});
  });check(p);const evaluation=aggregate(p,models,groups),primary=Object.fromEntries(['duration','strength'].map(k=>[k,evaluation.contrasts[k].statistics.session.overall]));
  const s={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),models,evaluation,primary,
    outcomes:Object.fromEntries(Object.entries(primary).map(([k,v])=>[k,classify(v)])),positiveJointEvidence:Object.values(primary).every(v=>classify(v)==='positive'),
    games:evaluation.games,newUniqueTrainingHands:0,newUniqueValidationHands:0,productionPolicy:'H0'};
  save(resolve(out,'summary.json'),s);onProgress({stage:'complete',games:s.games,outcomes:s.outcomes,positiveJointEvidence:s.positiveJointEvidence});return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
