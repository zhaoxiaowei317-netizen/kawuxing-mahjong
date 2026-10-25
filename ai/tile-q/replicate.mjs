import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {projectRoot,sha256,verifyFrozenBaseline} from '../provenance.mjs';
import {sources,assertSources} from './sources.mjs';
import {SCHEMA} from './encoding.mjs';
import {save,merge,loadData} from './collect.mjs';
import {loadQ} from './model.mjs';
import {worker,parallel} from './study.mjs';
import {verifyData,verifyEvaluation,verifyParity} from './verify.mjs';

export const VERSION='kwx-tile-q-replication-1';
const self=fileURLToPath(import.meta.url),read=p=>JSON.parse(readFileSync(p,'utf8'));
const checksum=p=>sha256(readFileSync(p));
export function makePlan({previous,python='python',initialHands=2400,validationHands=480,bcEpochs=12,offlineEpochs=8,
  independentGroups=64,sessionGroups=16,sessionHands=16,trainingSessionHands=16,bootstrapSamples=5000}){
  previous=resolve(previous);const original=read(resolve(previous,'plan.json')),s=read(resolve(previous,'summary.json'));
  assertSources(original.sources);assert.equal(s.planSha256,checksum(resolve(previous,'plan.json')));
  assert.equal(s.selected,'tiles-offline','This replication fixes the previous offline recipe, not a new search');
  const verified=read(resolve(previous,'verification.json'));assert.equal(verified.games,s.games);
  const old=s.fitted['tiles-offline'].selected,q=loadQ(old.path);
  const budget={initialHands,validationHands,bcEpochs,offlineEpochs,independentGroups,sessionGroups,sessionHands,trainingSessionHands,bootstrapSamples};
  for(const n of Object.values(budget))assert.ok(Number.isSafeInteger(n)&&n>0);
  assert.equal(initialHands%(2*trainingSessionHands),0,'Training shards must contain whole sessions');
  const nonce=randomBytes(32).toString('hex');
  const seeds=Object.fromEntries(['training','validation','model','evaluation'].map(k=>[k,deriveSeed(VERSION,nonce,k)]));
  assert.equal(new Set([...Object.values(original.seeds),...Object.values(seeds)]).size,Object.values(original.seeds).length+4);
  return {version:VERSION,createdAt:new Date().toISOString(),baseline:verifyFrozenBaseline(),sources:sources(),driverSha256:checksum(self),
    previous:{path:previous,planSha256:checksum(resolve(previous,'plan.json')),summarySha256:checksum(resolve(previous,'summary.json')),
      verificationSha256:checksum(resolve(previous,'verification.json')),checkpoint:resolve(old.path),checkpointSha256:q.sha256,
      epoch:old.epoch,primary:s.sealed.primary},
    schema:SCHEMA,network:original.network,optimizer:original.optimizer,python,budget,seeds,
    evaluations:['fixed-old','retrained-offline'],
    primary:'Confirm the frozen old candidate vs H0 on fresh 16-hand paired sessions; positive only if the two-sided 95% paired-group interval is entirely above zero.',
    secondary:'Independent fixed-recipe retraining with fresh data, validation and initialization. The retrained candidate vs H0, independent single hands and opponent subgroups are secondary descriptive results, without multiplicity-adjusted confirmatory claims.',
    selection:'Both BC and offline checkpoints use their own minimum fixed validation loss, including epoch 0, earliest ties. No development tournament, no choice based on evaluation.',
    pairing:'Both models use the same fresh evaluation seed, six seat permutations and equally weighted H0/H0 and H0/greedy opponent pairs. Each candidate has a separate matched H0 control. Do not count the repeated H0 controls as independent new openings.',
    stopping:'Exactly two fixed evaluation budgets; no extension, no held-out-data training, no automatic promotion. H0 remains the game default.'};
}
export function checkPlan(p){assert.equal(p.version,VERSION);assertSources(p.sources);assert.equal(p.driverSha256,checksum(self));
  assert.equal(checksum(resolve(p.previous.path,'plan.json')),p.previous.planSha256);
  assert.equal(checksum(resolve(p.previous.path,'summary.json')),p.previous.summarySha256);
  assert.equal(checksum(resolve(p.previous.path,'verification.json')),p.previous.verificationSha256);
  assert.equal(loadQ(p.previous.checkpoint).sha256,p.previous.checkpointSha256);
}
export function classify(r){return r.ci95[0]>0?'positive':r.ci95[1]<0?'negative':'inconclusive';}
export async function runReplication({out,previous,...options}){
  const onProgress=options.onProgress||(()=>{});delete options.onProgress;
  out=resolve(out);if(existsSync(out))throw Error('Replication output exists');
  const p=makePlan({previous,...options}),b=p.budget;mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'.collect'));
  save(resolve(out,'plan.json'),p);onProgress({stage:'plan',budget:b});
  const evalOne=async(id,checkpoint)=>{
    checkPlan(p);const spec=resolve(out,`${id}.spec.json`);
    save(spec,{out:resolve(out,id),candidate:id,checkpoint,seed:p.seeds.evaluation,split:'sealed',
      independentGroups:b.independentGroups,sessionGroups:b.sessionGroups,sessionHands:b.sessionHands,bootstrapSamples:b.bootstrapSamples});
    await worker(process.execPath,[resolve(projectRoot,'ai/tile-q/evaluate.mjs'),spec],q=>onProgress({stage:id,...q}));
    return read(resolve(out,id,'report.json'));
  };
  // The two branches share no mutable outputs. Promise.allSettled waits for both
  // even when one fails, so no training child is orphaned on evaluation failure.
  const results=await parallel([evalOne('fixed-old',p.previous.checkpoint),(async()=>{
    const parts={training:[],validation:[]},jobs=[];
    for(const [split,hands,count]of [['training',b.initialHands,2],['validation',b.validationHands,1]]){
      for(let i=0;i<count;i++){
        const path=resolve(out,'.collect',`${split}-${i}`),spec=resolve(out,`collect-${split}-${i}.json`);
        save(spec,{out:path,hands:hands/count,startHand:i*hands/count,seed:p.seeds[split],split,sessionHands:b.trainingSessionHands});
        parts[split].push(path);jobs.push(worker(process.execPath,[resolve(projectRoot,'ai/tile-q/collect.mjs'),spec],q=>onProgress({stage:`collect-${split}-${i}`,...q})));
      }
    }
    await parallel(jobs);
    const datasets=Object.fromEntries(['training','validation'].map(split=>[split,merge({out:resolve(out,split),parts:parts[split],split})]));
    const fitted={};
    for(const [id,mode,epochs]of [['bc','bc',b.bcEpochs],['offline','q',b.offlineEpochs]]){
      checkPlan(p);const spec=resolve(out,`train-${id}.json`);
      save(spec,{out:resolve(out,`model-${id}`),schema:p.schema,sources:p.sources,seed:p.seeds.model,
        trainingData:resolve(out,'training'),validationData:resolve(out,'validation'),network:p.network,config:p.optimizer,
        mode,epochs,...(id==='offline'?{initialize:fitted.bc.selected.state}:{})});
      await worker(p.python,[resolve(projectRoot,'ai/tile-q/train.py'),spec],q=>onProgress({stage:`train-${id}`,...q}));
      fitted[id]=read(resolve(out,`model-${id}`,'summary.json'));loadQ(fitted[id].selected.path);
    }
    save(resolve(out,'training.json'),{datasets,fitted});
    // Freeze this declaration before any evaluation of the new model begins.
    save(resolve(out,'retrained-selection.json'),{checkpoint:fitted.offline.selected,criterion:p.selection});
    const evaluation=await evalOne('retrained-offline',fitted.offline.selected.path);return {datasets,fitted,evaluation};
  })()]);
  checkPlan(p);const [old,newRun]=results,retrained=newRun.evaluation;
  const summary={version:VERSION,completedAt:new Date().toISOString(),planSha256:checksum(resolve(out,'plan.json')),
    trainingHands:b.initialHands,validationHands:b.validationHands,trainingSamples:newRun.datasets.training.samples,
    games:old.totalGames+retrained.totalGames,productionPolicy:'H0',
    evaluations:Object.fromEntries([['fixed-old',old],['retrained-offline',retrained]].map(([id,r])=>[id,{
      checkpoint:r.checkpoint,checkpointSha256:r.checkpointSha256,games:r.totalGames,primary:r.statistics.session.overall,
      independent:r.statistics.independent.overall,byOpponentPair:r.statistics.session.byOpponentPair,
      outcome:classify(r.statistics.session.overall)}]))};
  save(resolve(out,'summary.json'),summary);onProgress({stage:'complete',...summary});return summary;
}
export async function verifyReplication({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification output exists');
  const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),training=read(resolve(out,'training.json')),b=p.budget;checkPlan(p);
  assert.equal(s.planSha256,checksum(resolve(out,'plan.json')));assert.equal(s.productionPolicy,'H0');
  const seen=new Set(),data={},evaluation={},parity={};let snapshots=0;
  for(const split of ['training','validation']){
    const d=loadData(resolve(out,split),split);assert.deepEqual(d.manifest,training.datasets[split]);
    assert.equal(d.manifest.seed,p.seeds[split]);assert.equal(d.manifest.hands,split==='training'?b.initialHands:b.validationHands);
    assert.equal(d.manifest.sessionHands,b.trainingSessionHands);
    for(const e of d.episodes){assert.ok(!seen.has(e.environmentSeed));seen.add(e.environmentSeed);}
  }
  for(const stage of ['bc','offline']){
    const dir=resolve(out,`model-${stage}`),fitted=read(resolve(dir,'summary.json'));
    assert.deepEqual(fitted,training.fitted[stage]);assert.equal(fitted.seed,p.seeds.model);
    assert.deepEqual(fitted.network,p.network);assert.deepEqual(fitted.config,p.optimizer);assert.equal(fitted.mode,stage==='bc'?'bc':'q');
    assert.equal(fitted.trainingHash,training.datasets.training.sha256);assert.equal(fitted.validationHash,training.datasets.validation.sha256);
    const epochs=stage==='bc'?b.bcEpochs:b.offlineEpochs;assert.equal(fitted.history.length,epochs+1);
    let best=fitted.history[0];for(const row of fitted.history)if(row.validation.loss<best.validation.loss-1e-12)best=row;
    assert.equal(fitted.selected.epoch,best.epoch);parity[stage]=verifyParity(resolve(dir,'parity.json'));
    const names=readdirSync(dir).filter(n=>/^epoch-\d+\.json$/.test(n));assert.equal(names.length,epochs+1);
    for(const name of names){const q=loadQ(resolve(dir,name));assert.equal(q.data.metadata.optimizerStateSha256,checksum(resolve(dir,name.replace('.json','.pt'))));snapshots++;}
    const spec=read(resolve(out,`train-${stage}.json`));assert.equal(spec.select,undefined);assert.equal(spec.resume,undefined);
    assert.deepEqual(spec.sources,p.sources);assert.equal(spec.seed,p.seeds.model);assert.equal(spec.epochs,epochs);
    assert.equal(spec.trainingData,resolve(out,'training'));assert.equal(spec.validationData,resolve(out,'validation'));
    if(stage==='offline')assert.equal(spec.initialize,training.fitted.bc.selected.state);else assert.equal(spec.initialize,undefined);
  }
  assert.deepEqual(read(resolve(out,'retrained-selection.json')),{checkpoint:training.fitted.offline.selected,criterion:p.selection});
  for(const id of p.evaluations){
    const r=read(resolve(out,id,'report.json'));assert.equal(r.seed,p.seeds.evaluation);assert.equal(r.split,'sealed');
    assert.equal(r.candidate,id);assert.equal(r.incumbent,'H0');assert.equal(r.independentGroups,b.independentGroups);
    assert.equal(r.sessionGroups,b.sessionGroups);assert.equal(r.sessionHands,b.sessionHands);
    assert.equal(r.checkpointSha256,loadQ(id==='fixed-old'?p.previous.checkpoint:training.fitted.offline.selected.path).sha256);
    assert.deepEqual(s.evaluations[id],{checkpoint:r.checkpoint,checkpointSha256:r.checkpointSha256,games:r.totalGames,
      primary:r.statistics.session.overall,independent:r.statistics.independent.overall,byOpponentPair:r.statistics.session.byOpponentPair,
      outcome:classify(r.statistics.session.overall)});
  }
  const directory=resolve(out,'.audit');if(existsSync(directory))throw Error('Audit work directory exists');mkdirSync(directory);
  const jobs=[...p.evaluations.map(id=>({id,kind:'evaluation'})),...['training','validation'].map(id=>({id,kind:'data'}))];
  await parallel(jobs.map(async job=>{
    const spec=resolve(directory,`${job.id}.json`),result=resolve(directory,`${job.id}.result.json`);
    save(spec,{...job,path:resolve(out,job.id),split:job.id,bootstrapSamples:b.bootstrapSamples,result});
    await worker(process.execPath,[self,'audit-worker',spec],q=>onProgress({job:job.id,...q}));
    (job.kind==='data'?data:evaluation)[job.id]=read(result);
  }));
  assert.equal(s.games,Object.values(evaluation).reduce((sum,r)=>sum+r.games,0));assert.equal(s.games,48*(b.independentGroups+b.sessionGroups*b.sessionHands));
  assert.equal(s.trainingHands,b.initialHands);assert.equal(s.validationHands,b.validationHands);assert.equal(s.trainingSamples,data.training.samples);checkPlan(p);
  const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,data,evaluation,parity,snapshotsVerified:snapshots,
    games:s.games,sources:p.sources,driverSha256:p.driverSha256};save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===self){
  const progress=q=>console.log(JSON.stringify({at:new Date().toISOString(),...q}));
  let task;
  if(process.argv[2]==='audit-worker'){
    const job=read(process.argv[3]);task=(job.kind==='data'?verifyData(job.path,job.split,progress):verifyEvaluation(job.path,job.bootstrapSamples,progress)).then(r=>save(job.result,r));
  }else if(process.argv[2]==='verify')task=verifyReplication({out:process.argv[3],onProgress:progress});
  else task=runReplication({out:process.argv[2],previous:process.argv[3],onProgress:progress});
  Promise.resolve(task).then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
