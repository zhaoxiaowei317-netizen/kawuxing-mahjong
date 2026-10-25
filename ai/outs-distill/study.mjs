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
import {merge} from './collect.mjs';
import {VERSION,STUDENTS,ARMS,CONTRASTS,makePlan,check,jobsFor,jobSeed,trainSpec,read,hash} from './config.mjs';
export function aggregate(p,models,groups){
  const jobs=jobsFor(p);assert.deepEqual(groups.map(g=>g.job.id).sort(),jobs.map(j=>j.id).sort());
  const ordered=jobs.map(j=>{const g=groups.find(g=>g.job.id===j.id);assert.deepEqual(g.job,j);assert.deepEqual(g.modelHashes,Object.fromEntries(ARMS.map(a=>[a,models[a].sha256])));
    assert.equal(g.groupSeed,jobSeed(p,j));assert.equal(g.games,18*p.budget.sessionHands);return g;});
  const contrasts=Object.fromEntries(Object.entries(CONTRASTS).map(([name,control])=>{
    const records=ordered.map(g=>({suite:'session',opponentPair:g.record.opponentPair,seed:g.record.seed,candidate:g.record.arms.corrected,incumbent:g.record.arms[control]}));
    return [name,{records,statistics:summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seeds.evaluation,'bootstrap',name),base:1})}];
  }));return {contrasts,games:ordered.reduce((n,g)=>n+g.games,0)};
}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');const p=makePlan(options),b=p.budget;
  mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'.specs'));mkdirSync(resolve(out,'groups'));save(resolve(out,'plan.json'),p);onProgress({stage:'plan',budget:b});
  const parts={training:[],validation:[]},collectJobs=[];
  for(const [split,hands,n]of [['training',b.trainingHands,b.workers],['validation',b.validationHands,1]])for(let i=0;i<n;i++){
    const path=resolve(out,'.collect',`${split}-${i}`),spec=resolve(out,'.specs',`collect-${split}-${i}.json`),payload={out:path,plan:p,split,startHand:i*hands/n,hands:hands/n};
    parts[split].push(path);collectJobs.push({id:`${split}-${i}`,spec,payload});
  }
  await pooled(collectJobs,b.workers,async j=>{save(j.spec,j.payload);await worker(process.execPath,[resolve(projectRoot,'ai/outs-distill/collect.mjs'),j.spec],q=>onProgress({stage:'collect',worker:j.id,...q}));});check(p);
  const datasets={};for(const split of ['training','validation'])datasets[split]=merge({out:resolve(out,split),parts:parts[split],plan:p,split});
  const fitted={},models={raw:p.model};for(const arm of STUDENTS){
    check(p);const spec=resolve(out,`train-${arm}.json`);save(spec,trainSpec(out,p,arm));
    await worker(p.python,[resolve(projectRoot,'ai/tile-q/train.py'),spec],q=>onProgress({stage:`train-${arm}`,...q}));
    fitted[arm]=read(resolve(out,`model-${arm}/summary.json`));models[arm]={...fitted[arm].selected,sha256:loadQ(fitted[arm].selected.path).sha256};
  }
  save(resolve(out,'training.json'),{datasets,fitted});save(resolve(out,'models.json'),models);onProgress({stage:'models-frozen',models});check(p);
  const jobs=jobsFor(p),groups=[];await pooled(jobs,b.workers,async job=>{
    const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p,job,models});
    await worker(process.execPath,[resolve(projectRoot,'ai/outs-distill/groups.mjs'),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));
    onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:jobs.length,games:groups.reduce((n,g)=>n+g.games,0)});
  });check(p);const evaluation=aggregate(p,models,groups),primary=Object.fromEntries(Object.keys(CONTRASTS).map(k=>[k,evaluation.contrasts[k].statistics.session.overall]));
  const s={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),models,evaluation,primary,
    outcomes:Object.fromEntries(Object.entries(primary).map(([k,v])=>[k,classify(v)])),positiveJointEvidence:Object.values(primary).every(v=>classify(v)==='positive'),
    games:evaluation.games,trainingHands:b.trainingHands,validationHands:b.validationHands,trainingSamples:datasets.training.canonical.samples,productionPolicy:'H0'};
  save(resolve(out,'summary.json'),s);onProgress({stage:'complete',games:s.games,outcomes:s.outcomes,positiveJointEvidence:s.positiveJointEvidence});return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
