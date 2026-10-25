// Continue a predeclared study after worker startup failure. This never creates
// new seeds, changes budgets, overwrites completed stages, or edits frozen code.
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {studySources,ARMS,selectCandidate,save,STUDY_VERSION} from './study.mjs';
import {mergeData,loadData} from './data.mjs';
import {trainGain,trainRidge} from './train.mjs';
import {loadGain} from './io.mjs';
import {deriveSeed} from '../random.mjs';
import {sha256,projectRoot} from '../provenance.mjs';

export async function recoverStudy({out,onProgress=console.log,verifyOnly=false}) {
  out=resolve(out);const read=p=>JSON.parse(readFileSync(resolve(out,p),'utf8'));
  const plan=read('plan.json'),b=plan.budget;assert.deepEqual(studySources(),plan.sourceHashes);
  assert.equal(plan.version,STUDY_VERSION);
  const completed=existsSync(resolve(out,'summary.json'))?read('summary.json'):null;
  if(completed&&!verifyOnly)throw Error('Study already complete');
  if(verifyOnly&&!completed)throw Error('Verification-only mode requires a completed study');
  const datasets={};
  for(const split of ['training','validation']) {
    const count=split==='training'?plan.collection.trainingWorkers:plan.collection.validationWorkers;
    const parts=Array.from({length:count},(_,i)=>resolve(out,'.collect',`${split}-${i}`));
    // All existing shard hashes/ranges are checked before any fitting starts.
    let total=0;for(const part of parts){const {manifest:m}=loadData(part,split);assert.equal(m.seed,plan.seeds[split]);
      assert.equal(m.startHand,total);total+=m.hands;}
    assert.equal(total,b[`${split}Hands`]);
    const path=resolve(out,split);datasets[split]=existsSync(path)?loadData(path,split).manifest:mergeData({out:path,parts,split});
    assert.equal(datasets[split].hands,total);
  }
  const trainingData=resolve(out,'training'),validationData=resolve(out,'validation'),fitted={};
  const ridgePath=resolve(out,'model-ridge','ridge.json');
  if(existsSync(ridgePath)) {
    const loaded=loadGain(ridgePath);assert.equal(loaded.checkpoint.metadata.training.trainingSha256,datasets.training.rowsSha256);
    assert.equal(loaded.checkpoint.metadata.training.validationSha256,datasets.validation.rowsSha256);
    const {diagnostics}=await import('./model.mjs'), val=loadData(validationData,'validation');
    fitted.ridge={path:ridgePath,validation:diagnostics(loaded.model,val.rows,val.manifest.hands)};
  }else fitted.ridge=trainRidge({out:resolve(out,'model-ridge'),trainingData,validationData,lambda:plan.models.ridge.lambda});
  for(let i=0;i<3;i++) {
    const arm=`mlp-${i}`,path=resolve(out,`model-${arm}`),summary=resolve(path,'summary.json');
    const r=existsSync(summary)?JSON.parse(readFileSync(summary,'utf8')):await trainGain({out:path,trainingData,validationData,
      seed:deriveSeed(plan.seeds.training,'model',i),epochs:b.epochs,...plan.models.mlp,
      onProgress:p=>onProgress({stage:`train-${arm}`,...p})});
    assert.equal(r.config.trainingSha256,datasets.training.rowsSha256);assert.equal(r.config.validationSha256,datasets.validation.rowsSha256);
    assert.equal(r.history.length,b.epochs+1);loadGain(r.selected.path);
    fitted[arm]={path:r.selected.path,epoch:r.selected.epoch,validationMse:r.selected.validationMse};
  }
  const modelsPath=resolve(out,'models.json');if(existsSync(modelsPath))assert.deepEqual(read('models.json'),fitted);else save(modelsPath,fitted);
  async function evaluation(stage,arm,incumbent,sealed) {
    const path=resolve(out,stage),report=resolve(path,'report.json'),spec={out:path,candidate:arm,checkpoint:fitted[arm].path,
      incumbent,seed:sealed?deriveSeed(plan.seeds.sealed,incumbent):plan.seeds.development,split:sealed?'sealed':'development',
      independentGroups:b[sealed?'sealedGroups':'developmentGroups'],sessionGroups:b[sealed?'sealedSessionGroups':'developmentSessionGroups'],
      sessionHands:b.sessionHands,bootstrapSamples:b.bootstrapSamples};
    if(!existsSync(report)) {
      if(existsSync(path))throw Error(`Incomplete evaluation ${stage}; do not silently replace it`);
      const specPath=resolve(out,`${stage}.spec.json`);save(specPath,spec);
      await new Promise((done,fail)=>{
        const child=spawn(process.execPath,[resolve(projectRoot,'ai/paired-value/evaluate.mjs'),specPath],
          {windowsHide:true,stdio:['ignore','pipe','pipe']});let buffer='',errors='';
        child.stdout.on('data',c=>{buffer+=c;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
          if(line.trim()){const p=JSON.parse(line);if(!p.complete)onProgress({stage,...p});}}});
        child.stderr.on('data',c=>{errors+=c;});child.on('error',fail);
        child.on('close',code=>code===0?done():fail(Error(`${stage}: ${errors}`)));
      });
    }
    const r=JSON.parse(readFileSync(report,'utf8'));
    for(const k of ['candidate','incumbent','seed','split','independentGroups','sessionGroups','sessionHands'])assert.equal(r[k],spec[k]);
    assert.equal(r.totalGames,24*(spec.independentGroups+spec.sessionGroups*spec.sessionHands));
    assert.equal(r.checkpointSha256,loadGain(spec.checkpoint).sha256);return r;
  }
  const results=await Promise.allSettled(ARMS.map(arm=>evaluation(`development-${arm}`,arm,'H0',false)));
  const failures=results.filter(r=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason));
  const development=results.map((result,i)=>{const r=result.value;return {arm:ARMS[i],delta:r.statistics.session.overall.deltaPer100,
    ci95:r.statistics.session.overall.ci95,games:r.totalGames,counts:r.counts};});
  const selected=selectCandidate(development),selection={selected,development,modelsSha256:sha256(readFileSync(modelsPath))};
  if(existsSync(resolve(out,'selection.json')))assert.deepEqual(read('selection.json'),selection);else save(resolve(out,'selection.json'),selection);
  onProgress({stage:'selection',...selection});
  const sealed={};
  if(selected){
    const controls=['H0','proposal-once'],checks=await Promise.allSettled(controls.map(c=>evaluation(`sealed-vs-${c}`,selected,c,true)));
    const failed=checks.filter(r=>r.status==='rejected');if(failed.length)throw new AggregateError(failed.map(r=>r.reason));
    checks.forEach((result,i)=>{const r=result.value;sealed[controls[i]]={primary:r.statistics.session.overall,independent:r.statistics.independent.overall,
      byOpponentPair:r.statistics.session.byOpponentPair,games:r.totalGames,counts:r.counts};});
  }
  assert.deepEqual(studySources(),plan.sourceHashes);
  const summary={version:STUDY_VERSION,completedAt:new Date().toISOString(),planSha256:sha256(readFileSync(resolve(out,'plan.json'))),
    datasets,fitted,development,selected,sealed,productionPolicy:'H0',trainingDeals:b.trainingHands,validationDeals:b.validationHands,
    branches:datasets.training.counterfactualBranches+datasets.validation.counterfactualBranches,
    games:development.reduce((sum,r)=>sum+r.games,0)+Object.values(sealed).reduce((sum,r)=>sum+r.games,0),
    positiveSealedEvidence:!!(sealed.H0&&sealed.H0.primary.ci95[0]>0)};
  if(verifyOnly){
    const {completedAt:oldTime,...oldResult}=completed,{completedAt:newTime,...newResult}=summary;
    assert.deepEqual(newResult,oldResult);return summary;
  }
  save(resolve(out,'summary.json'),summary);save(resolve(out,'recovery.json'),{completedAt:new Date().toISOString(),
    reason:'Initial training-0 child failed with EPERM creating its directory. The exact predeclared shard was rerun after the parent existed; all successful shards reused.',
    planSha256:summary.planSha256,recoverySourceSha256:sha256(readFileSync(new URL('./recover.mjs',import.meta.url))),
    changedSeeds:false,changedBudgets:false,changedInferenceOrTrainingSources:false});
  onProgress({stage:'complete',games:summary.games,selected});return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))recoverStudy({out:process.argv[2],
  onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))}).catch(e=>{console.error(e);process.exitCode=1;});
