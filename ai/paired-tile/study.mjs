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
import {merge} from './collect.mjs';
import {exactZeroHead} from './policy.mjs';
import {VERSION,CONTRASTS,makePlan,check,jobsFor,jobSeed,read,hash} from './config.mjs';
export function aggregate(p,models,groups){
  const jobs=jobsFor(p);assert.deepEqual(groups.map(g=>g.job.id).sort(),jobs.map(j=>j.id).sort());
  const ordered=jobs.map(j=>{const g=groups.find(g=>g.job.id===j.id);assert.deepEqual(g.job,j);assert.equal(g.groupSeed,jobSeed(p,j));assert.equal(g.games,24*p.budget.sessionHands);
    assert.deepEqual(g.modelHashes,Object.fromEntries(['short','long','learned'].map(k=>[k,models[k].sha256])));return g;});
  return {games:ordered.reduce((n,g)=>n+g.games,0),contrasts:Object.fromEntries(Object.entries(CONTRASTS).map(([key,control])=>{
    const records=ordered.map(g=>({suite:'session',opponentPair:g.record.opponentPair,seed:g.record.seed,candidate:g.record.arms.learned,incumbent:g.record.arms[control]}));
    return [key,{records,statistics:summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seeds.evaluation,'bootstrap',key),base:1})}];
  }))};
}
export function trainSpec(out,p){return {out:resolve(out,'model'),initialize:p.models.short.state,schema:p.schema,sources:p.coreSources,experimentSources:p.sourceMap,
  network:p.network,config:p.optimizer,seed:p.seeds.model,epochs:p.budget.epochs,trainingData:resolve(out,'training'),validationData:resolve(out,'validation')};}
export function checkTraining(out,p){
  const t=read(resolve(out,'model/summary.json')),initial=loadQ(p.models.short.path).data;
  assert.equal(t.history.length,p.budget.epochs+1);const best=t.history.reduce((a,r)=>r.validation.mse<a.validation.mse-1e-12?r:a);
  assert.equal(t.selected.epoch,best.epoch);assert.equal(t.selected.validationLoss,best.validation.mse);assert.deepEqual(t.config,p.optimizer);assert.deepEqual(t.network,p.network);assert.equal(t.seed,p.seeds.model);
  for(const r of t.history){const path=resolve(out,'model',`epoch-${String(r.epoch).padStart(3,'0')}.json`),d=loadQ(path).data;assert.equal(d.metadata.epoch,r.epoch);assert.deepEqual(d.metadata.experimentSources,p.sourceMap);
    assert.equal(d.metadata.optimizerStateSha256,hash(path.replace(/\.json$/,'.pt')));assert.equal(d.metadata.trainingHash,t.trainingHash);assert.equal(d.metadata.validationHash,t.validationHash);
    for(const [key,w]of Object.entries(d.weights)){
      if(key.startsWith('valueHead.')||key==='actionHead.bias'||r.epoch===0&&key==='actionHead.weight')assert.ok(w.values.every(x=>x===0));
      else if(r.epoch===0||key.startsWith('rankHead.'))assert.deepEqual(w,initial.weights[key]);
    }
  }
  const selected=loadQ(t.selected.path);assert.equal(exactZeroHead(selected.model),t.selected.epoch===0);
  const parity=read(resolve(out,'model/parity.json'));assert.equal(parity.checkpoint,t.selected.path);let maxError=0;
  for(const f of parity.fixtures){const q=selected.model.forward(f.encoded,f.legalIds).q;for(const id of f.legalIds){maxError=Math.max(maxError,Math.abs(q[id]-f.q[id]));assert.ok(Math.abs(q[id]-f.q[id])<2e-5);}}
  return {training:t,model:{...t.selected,sha256:selected.sha256},parityMaxError:maxError};
}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');const p=makePlan(options),b=p.budget;mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'.specs'));mkdirSync(resolve(out,'groups'));save(resolve(out,'plan.json'),p);onProgress({stage:'plan',budget:b});
  const parts={training:[],validation:[]},jobs=[];
  for(const [split,hands,n]of [['training',b.trainingHands,b.workers],['validation',b.validationHands,1]])for(let i=0;i<n;i++){
    const path=resolve(out,'.collect',`${split}-${i}`),spec=resolve(out,'.specs',`collect-${split}-${i}.json`);parts[split].push(path);jobs.push({id:`${split}-${i}`,spec,payload:{out:path,plan:p,split,startHand:i*hands/n,hands:hands/n}});
  }
  await pooled(jobs,b.workers,async j=>{save(j.spec,j.payload);await worker(process.execPath,[resolve(projectRoot,'ai/paired-tile/collect.mjs'),j.spec],q=>onProgress({stage:'collect',worker:j.id,...q}));});check(p);
  const datasets=Object.fromEntries(['training','validation'].map(split=>[split,merge({out:resolve(out,split),parts:parts[split],plan:p,split})]));
  let trained=null,models={...p.models},evaluation={games:0,contrasts:{}},status='no-eligible-roots';
  if(datasets.training.roots&&datasets.validation.roots){
    const spec=resolve(out,'train.json');save(spec,trainSpec(out,p));await worker(p.python,[resolve(projectRoot,'ai/paired-tile/train.py'),spec],q=>onProgress({stage:'train',...q}));
    trained=checkTraining(out,p);models.learned=trained.model;status=trained.training.selected.epoch===0?'zero-selected':'evaluated';
  }
  save(resolve(out,'training.json'),{datasets,trained});save(resolve(out,'models.json'),models);onProgress({stage:'models-frozen',status,selected:trained?.training.selected,roots:{training:datasets.training.roots,validation:datasets.validation.roots}});
  if(status==='evaluated'){
    const groups=[],todo=jobsFor(p);await pooled(todo,b.workers,async job=>{const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p,job,models});
      await worker(process.execPath,[resolve(projectRoot,'ai/paired-tile/groups.mjs'),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:todo.length,games:groups.reduce((n,g)=>n+g.games,0)});});
    evaluation=aggregate(p,models,groups);
  }
  check(p);const primary=Object.fromEntries(Object.entries(evaluation.contrasts).map(([k,r])=>[k,r.statistics.session.overall])),outcomes=Object.fromEntries(Object.entries(primary).map(([k,x])=>[k,classify(x)]));
  const s={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),models,status,evaluation,primary,outcomes,
    learningEvidence:outcomes.improvement==='positive'&&outcomes.selection==='positive',positiveJointEvidence:Object.keys(outcomes).length===3&&Object.values(outcomes).every(x=>x==='positive'),
    games:evaluation.games,trainingHands:b.trainingHands,validationHands:b.validationHands,trainingSamples:datasets.training.roots,optimizationUpdates:trained?.training.optimizationUpdates??0,productionPolicy:'H0'};
  save(resolve(out,'summary.json'),s);onProgress({stage:'complete',games:s.games,status,outcomes,positiveJointEvidence:s.positiveJointEvidence});return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))}).then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
