// Parallel orchestration only: all episode/feature/policy checks call the
// frozen verifier functions whose hashes were declared before collection.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,projectRoot} from '../provenance.mjs';
import {sources,assertSources} from './sources.mjs';
import {loadQ} from './model.mjs';
import {loadData,save} from './collect.mjs';
import {verifyData,verifyEvaluation,verifyParity} from './verify.mjs';
import {ARMS,select,worker,parallel} from './study.mjs';

export async function verifyParallel({out,outputFile='verification.json',onProgress=()=>{}}){
  out=resolve(out);assert.match(outputFile,/^[a-z-]+\.json$/);if(existsSync(resolve(out,outputFile)))throw Error('Verification exists');
  const read=p=>JSON.parse(readFileSync(resolve(out,p))),plan=read('plan.json'),s=read('summary.json'),selection=read('selection.json'),models=read('models.json'),b=plan.budget;
  assertSources(plan.sources);assert.equal(s.planSha256,sha256(readFileSync(resolve(out,'plan.json'))));assert.equal(select(s.development),s.selected);
  assert.deepEqual(selection,{selected:s.selected,development:s.development});assert.deepEqual(plan.arms,ARMS);
  const dataPaths=['training','validation',...Array.from({length:b.onlineRounds},(_,i)=>`online-${i}`)];
  const seedSet=new Set();
  for(const name of dataPaths){
    const split=name==='validation'?'validation':'training',d=loadData(resolve(out,name),split);
    const expected=name==='training'?s.datasets.training:name==='validation'?s.datasets.validation:s.online[Number(name.slice(7))].dataset;
    assert.deepEqual(d.manifest,expected);assert.equal(d.manifest.seed,plan.seeds[name]);
    assert.equal(d.manifest.hands,name==='training'?b.initialHands:name==='validation'?b.validationHands:b.onlineHands);
    assert.equal(d.manifest.sessionHands,b.trainingSessionHands);
    for(const e of d.episodes){assert.ok(!seedSet.has(e.environmentSeed));seedSet.add(e.environmentSeed);}
  }
  const parity={},snapshots=[];
  for(const stage of ['features-bc','tiles-bc','tiles-offline',...Array.from({length:b.onlineRounds},(_,i)=>`online-${i}`)]){
    const dir=resolve(out,`model-${stage}`),summary=JSON.parse(readFileSync(resolve(dir,'summary.json')));
    parity[stage]=verifyParity(resolve(dir,'parity.json'));
    for(const name of readdirSync(dir).filter(p=>/^epoch-\d+\.json$/.test(p))){
      const q=loadQ(resolve(dir,name));assert.equal(q.data.metadata.optimizerStateSha256,sha256(readFileSync(resolve(dir,name.replace('.json','.pt')))));snapshots.push(q.sha256);
      assert.equal(q.data.config.useTiles,stage!=='features-bc');
    }
    const expected=stage.startsWith('online-')?b.onlineEpochs:stage.endsWith('-bc')?b.bcEpochs:b.offlineEpochs;
    assert.equal(summary.history.length,expected+1);let best=summary.history[0];
    for(const row of summary.history)if(row.validation.loss<best.validation.loss-1e-12)best=row;
    assert.equal(summary.selected.epoch,stage.startsWith('online-')?expected:best.epoch);
    const expectedData=stage.startsWith('online-')?s.online[Number(stage.slice(7))].dataset:s.datasets.training;
    assert.equal(summary.trainingHash,expectedData.sha256);assert.equal(summary.validationHash,s.datasets.validation.sha256);
    assert.equal(summary.seed,stage.startsWith('online-')?plan.seeds[stage]:plan.seeds.model);
  }
  const evalStages=[...ARMS.map(a=>`development-${a}`),...(s.selected?['sealed-vs-H0']:[])];
  assert.equal(!!s.sealed,!!s.selected);
  for(const stage of evalStages){
    const sealed=stage==='sealed-vs-H0',arm=sealed?s.selected:stage.slice(12),r=read(`${stage}/report.json`);
    assert.deepEqual(models[arm],s.fitted[arm].selected);assert.equal(r.seed,sealed?plan.seeds.sealed:plan.seeds.development);
    assert.equal(r.candidate,arm);assert.equal(r.incumbent,'H0');assert.equal(r.split,sealed?'sealed':'development');
    assert.equal(r.independentGroups,sealed?b.sealedGroups:b.developmentGroups);assert.equal(r.sessionGroups,sealed?b.sealedSessions:b.developmentSessions);
    assert.equal(r.sessionHands,b.sessionHands);assert.equal(r.checkpointSha256,loadQ(models[arm].path).sha256);assertSources(r.sources);
    if(sealed)assert.deepEqual({primary:r.statistics.session.overall,independent:r.statistics.independent.overall,byOpponentPair:r.statistics.session.byOpponentPair,games:r.totalGames},s.sealed);
    else assert.deepEqual({arm,delta:r.statistics.session.overall.deltaPer100,ci95:r.statistics.session.overall.ci95,games:r.totalGames},s.development.find(x=>x.arm===arm));
  }
  const directory=resolve(out,`.${outputFile.slice(0,-5)}-workers`);if(existsSync(directory))throw Error('Audit work directory exists');mkdirSync(directory);
  // Largest tasks first; all outputs are disjoint and results are aggregated only
  // after every declared task succeeds.
  const jobs=[...(s.selected?[{id:'sealed-vs-H0',kind:'evaluation'}]:[]),{id:'training',kind:'data'},
    ...Array.from({length:b.onlineRounds},(_,i)=>({id:`online-${i}`,kind:'data'})),{id:'validation',kind:'data'},
    ...ARMS.map(a=>({id:`development-${a}`,kind:'evaluation'}))];
  const results={};let next=0;
  async function consume(){while(next<jobs.length){
    const job=jobs[next++],spec=resolve(directory,`${job.id}.spec.json`),result=resolve(directory,`${job.id}.result.json`);
    save(spec,{...job,path:resolve(out,job.id),split:job.id==='validation'?'validation':'training',bootstrapSamples:b.bootstrapSamples,result});
    await worker(process.execPath,[fileURLToPath(import.meta.url),'worker',spec],p=>onProgress({job:job.id,...p}));
    results[job.id]=JSON.parse(readFileSync(result));
  }}
  await parallel(Array.from({length:Math.min(4,jobs.length)},consume));
  const data=Object.fromEntries(dataPaths.map(k=>[k,results[k]])),evaluation=Object.fromEntries(evalStages.map(k=>[k,results[k]]));
  const games=Object.values(evaluation).reduce((sum,r)=>sum+r.games,0);assert.equal(games,s.games);
  assert.equal(s.trainingHands,b.initialHands+b.onlineRounds*b.onlineHands);assert.equal(s.validationHands,b.validationHands);assertSources(plan.sources);
  const result={completedAt:new Date().toISOString(),data,evaluation,parity,snapshotsVerified:snapshots.length,games,sourceHashes:plan.sources,
    orchestration:{workers:4,sourceSha256:sha256(readFileSync(fileURLToPath(import.meta.url))),frozenVerifierSha256:sha256(readFileSync(new URL('./verify.mjs',import.meta.url)))}};
  save(resolve(out,outputFile),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='worker'){
    const job=JSON.parse(readFileSync(process.argv[3])),progress=p=>console.log(JSON.stringify(p));
    (job.kind==='data'?verifyData(job.path,job.split,progress):verifyEvaluation(job.path,job.bootstrapSamples,progress))
      .then(r=>save(job.result,r)).catch(e=>{console.error(e);process.exitCode=1;});
  }else verifyParallel({out:process.argv[2],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
    .then(r=>console.log(JSON.stringify({verifiedGames:r.games}))).catch(e=>{console.error(e);process.exitCode=1;});
}
