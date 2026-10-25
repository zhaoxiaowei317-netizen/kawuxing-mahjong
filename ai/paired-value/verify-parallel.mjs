// Run the frozen audit functions in separate CPU workers. The orchestration
// checksum is recorded separately; inference/training/study sources stay frozen.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {ARMS,STUDY_VERSION,selectCandidate,studySources,save} from './study.mjs';
import {verifyData,verifyEvaluation} from './verify.mjs';
import {loadData} from './data.mjs';
import {loadGain,inferenceSources} from './io.mjs';
import {GainRegressor,fitRidge,diagnostics} from './model.mjs';
import {trainingSources} from './train.mjs';
import {deriveSeed} from '../random.mjs';
import {sha256} from '../provenance.mjs';

export async function verifyParallel({out,outputFile='verification.json',onProgress=()=>{}}) {
  out=resolve(out);assert.match(outputFile,/^[a-z-]+\.json$/);
  if(existsSync(resolve(out,outputFile)))throw Error('Verification exists');
  const read=p=>JSON.parse(readFileSync(resolve(out,p),'utf8'));
  const plan=read('plan.json'),s=read('summary.json'),selection=read('selection.json'),models=read('models.json'),b=plan.budget;
  assert.equal(plan.version,STUDY_VERSION);assert.deepEqual(plan.arms,ARMS);assert.deepEqual(plan.sourceHashes,studySources());
  assert.equal(s.planSha256,sha256(readFileSync(resolve(out,'plan.json'))));assert.deepEqual(models,s.fitted);
  assert.deepEqual(selection.development,s.development);assert.equal(selection.selected,s.selected);assert.equal(selectCandidate(s.development),s.selected);
  assert.equal(selection.modelsSha256,sha256(readFileSync(resolve(out,'models.json'))));
  const train=loadData(resolve(out,'training'),'training'),val=loadData(resolve(out,'validation'),'validation');
  for(const [split,data] of [['training',train],['validation',val]]) {
    assert.equal(data.manifest.seed,plan.seeds[split]);assert.equal(data.manifest.hands,b[`${split}Hands`]);assert.deepEqual(data.manifest,s.datasets[split]);
  }
  const seeds=new Set(train.rows.map(r=>r.environmentSeed));assert.ok(val.rows.every(r=>!seeds.has(r.environmentSeed)));
  let snapshotsVerified=1;
  assert.deepEqual(loadGain(models.ridge.path).model,fitRidge(train.rows,plan.models.ridge.lambda));
  assert.deepEqual(diagnostics(loadGain(models.ridge.path).model,val.rows,val.manifest.hands),models.ridge.validation);
  for(let i=0;i<3;i++) {
    const arm=`mlp-${i}`,history=read(`model-${arm}/summary.json`),config={seed:deriveSeed(plan.seeds.training,'model',i),
      hiddenSize:plan.models.mlp.hiddenSize,learningRate:plan.models.mlp.learningRate,batchSize:plan.models.mlp.batchSize,
      trainingSha256:train.manifest.rowsSha256,validationSha256:val.manifest.rowsSha256};
    assert.deepEqual(history.config,config);assert.deepEqual(history.sources,trainingSources());assert.equal(history.history.length,b.epochs+1);
    const model=new GainRegressor(config);let best=history.history[0];
    for(let epoch=0;epoch<=b.epochs;epoch++) {
      const loaded=loadGain(resolve(out,`model-${arm}`,`epoch-${String(epoch).padStart(3,'0')}.json`));
      if(epoch)model.update(train.rows,{epoch,...config});assert.deepEqual(loaded.model.toJSON(),model.toJSON());
      const row=history.history[epoch];assert.equal(row.epoch,epoch);
      assert.deepEqual(loaded.checkpoint.metadata.training.config,config);assert.deepEqual(loaded.checkpoint.metadata.training.sources,trainingSources());
      assert.deepEqual(row.training,diagnostics(model,train.rows,train.manifest.hands));assert.deepEqual(row.validation,diagnostics(model,val.rows,val.manifest.hands));
      if(row.validation.mse<best.validation.mse-1e-12)best=row;snapshotsVerified++;
    }
    assert.equal(models[arm].epoch,best.epoch);assert.equal(models[arm].validationMse,best.validation.mse);
    assert.equal(resolve(models[arm].path),resolve(history.selected.path));
  }
  const controls=s.selected?['H0','proposal-once']:[];assert.deepEqual(Object.keys(s.sealed),controls);
  const stages=[...ARMS.map(a=>`development-${a}`),...controls.map(c=>`sealed-vs-${c}`)];
  for(const stage of stages) {
    const r=read(`${stage}/report.json`),sealed=stage.startsWith('sealed'),arm=sealed?s.selected:stage.slice(12),control=sealed?stage.slice(10):'H0';
    assert.equal(r.candidate,arm);assert.equal(r.incumbent,control);assert.equal(r.split,sealed?'sealed':'development');
    assert.equal(r.seed,sealed?deriveSeed(plan.seeds.sealed,control):plan.seeds.development);
    assert.equal(r.independentGroups,b[sealed?'sealedGroups':'developmentGroups']);assert.equal(r.sessionGroups,b[sealed?'sealedSessionGroups':'developmentSessionGroups']);
    assert.equal(r.sessionHands,b.sessionHands);assert.equal(r.illegalActions,0);assert.equal(r.conservationCheckedEveryAction,true);
    assert.deepEqual(r.sourceHashes,inferenceSources());assert.equal(r.checkpointSha256,loadGain(models[arm].path).sha256);
    if(sealed)assert.deepEqual(s.sealed[control],{primary:r.statistics.session.overall,independent:r.statistics.independent.overall,
      byOpponentPair:r.statistics.session.byOpponentPair,games:r.totalGames,counts:r.counts});
    else assert.deepEqual(s.development.find(x=>x.arm===arm),{arm,delta:r.statistics.session.overall.deltaPer100,
      ci95:r.statistics.session.overall.ci95,games:r.totalGames,counts:r.counts});
  }
  const jobs=[...controls.map(c=>({id:`sealed-vs-${c}`,kind:'evaluation',path:resolve(out,`sealed-vs-${c}`)})),
    ...['training','validation'].map(split=>({id:split,kind:'data',path:resolve(out,split),split})),
    ...ARMS.map(a=>({id:`development-${a}`,kind:'evaluation',path:resolve(out,`development-${a}`)}))];
  const directory=resolve(out,`.${outputFile.slice(0,-5)}-workers`);if(existsSync(directory))throw Error('Worker audit directory exists');mkdirSync(directory);
  let next=0;const results={};
  async function worker() {
    while(next<jobs.length) {
      const job=jobs[next++],specPath=resolve(directory,`${job.id}.spec.json`),resultPath=resolve(directory,`${job.id}.result.json`);
      save(specPath,{...job,resultPath,bootstrapSamples:b.bootstrapSamples});
      await new Promise((done,fail)=>{
        const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'worker',specPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
        let buffer='',errors='';child.stdout.on('data',c=>{buffer+=c;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
          if(line.trim())onProgress({job:job.id,...JSON.parse(line)});}});child.stderr.on('data',c=>{errors+=c;});child.on('error',fail);
        child.on('close',code=>code===0?done():fail(Error(`${job.id}: ${errors}`)));
      });results[job.id]=JSON.parse(readFileSync(resultPath,'utf8'));
    }
  }
  const completed=await Promise.allSettled(Array.from({length:Math.min(4,jobs.length)},worker));
  const failures=completed.filter(r=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason));
  const stageResults=Object.fromEntries(stages.map(stage=>[stage,results[stage]])),games=Object.values(stageResults).reduce((sum,r)=>sum+r.games,0);
  assert.equal(games,s.games);assert.equal(s.trainingDeals,b.trainingHands);assert.equal(s.validationDeals,b.validationHands);
  assert.equal(s.branches,(results.training.roots+results.validation.roots)*2);assert.deepEqual(studySources(),plan.sourceHashes);
  const result={completedAt:new Date().toISOString(),data:{training:results.training,validation:results.validation},snapshotsVerified,
    stages:stageResults,games,allActualGamesRedealtAndPolicyRecomputed:true,allStoredLabelsRecomputed:true,sourceHashes:studySources(),
    orchestration:{workers:4,auditSourcesSha256:sha256(readFileSync(fileURLToPath(import.meta.url))),
      frozenVerifierSha256:sha256(readFileSync(new URL('./verify.mjs',import.meta.url)))}};
  save(resolve(out,outputFile),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='worker'){
    const job=JSON.parse(readFileSync(process.argv[3],'utf8')),progress=p=>console.log(JSON.stringify(p));
    (job.kind==='data'?verifyData(job.path,job.split,progress):verifyEvaluation(job.path,job.bootstrapSamples,progress))
      .then(r=>save(job.resultPath,r)).catch(e=>{console.error(e);process.exitCode=1;});
  }else verifyParallel({out:process.argv[2],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
    .then(r=>console.log(JSON.stringify({verifiedGames:r.games}))).catch(e=>{console.error(e);process.exitCode=1;});
}
