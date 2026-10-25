import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {verifyFrozenBaseline,projectRoot} from '../provenance.mjs';
import {SCHEMA} from '../tile-q/encoding.mjs';
import {save} from '../tile-q/collect.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {worker,parallel} from '../tile-q/study.mjs';
import {merge} from './collect.mjs';
import {evaluate} from './evaluate.mjs';
import {VERSION,N,ARMS,TABLES,PAIRS,sources,hash,read,check} from './config.mjs';

export function makePlan({previous=null,python='python',trainingHands=4800,validationHands=576,bcEpochs=12,offlineEpochs=8,
  evaluationGroups=8,sessionHands=16,trainingSessionHands=16,bootstrapSamples=5000,workers=4,
  network={channels:24,blocks:2,globalSize:64,localSize:32,useTiles:true}}={}){
  const budget={trainingHands,validationHands,bcEpochs,offlineEpochs,evaluationGroups,sessionHands,trainingSessionHands,bootstrapSamples,workers};
  for(const n of Object.values(budget))assert.ok(Number.isSafeInteger(n)&&n>0);assert.ok(workers<=8);
  assert.equal(trainingHands%(workers*trainingSessionHands),0,'Training workers require whole sessions');
  assert.equal(validationHands%trainingSessionHands,0,'Validation requires whole sessions');
  let origin=null;
  if(previous){
    previous=resolve(previous);const s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json'));
    assert.equal(s.version,'kwx-reveal-generalization-1');assert.equal(s.positiveReplication,true);assert.equal(s.games,v.games);
    assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));assert.equal(v.planSha256,s.planSha256);
    origin={path:previous,...Object.fromEntries(['plan','summary','verification'].map(n=>[n+'Sha256',hash(resolve(previous,n+'.json'))]))};
  }
  const nonce=randomBytes(32).toString('hex');
  return {version:VERSION,createdAt:new Date().toISOString(),baseline:verifyFrozenBaseline(),sources:sources(),previous:origin,
    tables:TABLES,pairs:PAIRS,arms:ARMS,incumbent:N,primaryArm:'offline',python,budget,schema:SCHEMA,network,
    optimizer:{learningRate:.001,batchSize:256,maxGradNorm:5,cqlWeight:.05,bcWeight:.1,auxWeight:.1},epsilon:.05,
    seeds:Object.fromEntries(['training','validation','model','evaluation'].map(k=>[k,deriveSeed(VERSION,nonce,k)])),
    data:'Four session-fixed tables, rotated over seats; all seats contribute. Expected role fractions over a 12-session cycle: never 7/12, H0 4/12, greedy 1/12. Each seat has its own teacher and 5% uniform legal exploration. Validation is a fresh, equally scheduled set. Neither policy IDs nor private opponent tiles enter inputs.',
    selection:'BC minimum validation CE+rank loss, offline minimum validation composite loss; include epoch 0, earliest ties. Offline initializes selected BC. No choice based on games; both candidates are frozen before the first evaluation.',
    primary:'Prespecified offline network vs h0-never in three equally weighted opponent pairs on new continuous 16-hand sessions; positive only if full two-sided 95% paired-group interval is above zero.',
    secondary:'BC vs h0-never and all opponent subgroups are descriptive diagnostics without multiplicity correction. BC cannot replace the primary candidate after seeing scores.',
    pairing:'Both candidates use identical new openings and a separate h0-never control. Controls/openings are repeated across candidates, not independent strength evidence. Six seat permutations remain one group.',
    stopping:'Complete both fixed evaluation budgets, no tuning or extra games after results, no evaluation data in training, no automatic promotion. Production default remains H0.'};
}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');
  const p=makePlan(options),b=p.budget;mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'.collect'));save(resolve(out,'plan.json'),p);check(p);
  onProgress({stage:'plan',budget:b});const parts={training:[],validation:[]},jobs=[];
  for(const [split,hands,count]of [['training',b.trainingHands,b.workers],['validation',b.validationHands,1]])for(let i=0;i<count;i++){
    const path=resolve(out,'.collect',`${split}-${i}`),spec=resolve(out,`collect-${split}-${i}.json`);
    save(spec,{out:path,hands:hands/count,startHand:i*hands/count,seed:p.seeds[split],split,sessionHands:b.trainingSessionHands,epsilon:p.epsilon});
    parts[split].push(path);jobs.push(worker(process.execPath,[resolve(projectRoot,'ai/strong-pool/collect.mjs'),spec],q=>onProgress({stage:'collect',worker:`${split}-${i}`,...q})));
  }
  await parallel(jobs);check(p);
  const datasets=Object.fromEntries(['training','validation'].map(split=>[split,merge({out:resolve(out,split),parts:parts[split],split})]));
  const fitted={};
  for(const arm of ARMS){
    check(p);const spec=resolve(out,`train-${arm}.json`);
    save(spec,{out:resolve(out,`model-${arm}`),schema:p.schema,sources:p.sources.core,seed:p.seeds.model,trainingData:resolve(out,'training'),
      validationData:resolve(out,'validation'),network:p.network,config:p.optimizer,mode:arm==='bc'?'bc':'q',
      epochs:arm==='bc'?b.bcEpochs:b.offlineEpochs,...(arm==='offline'?{initialize:fitted.bc.selected.state}:{})});
    await worker(p.python,[resolve(projectRoot,'ai/tile-q/train.py'),spec],q=>onProgress({stage:`train-${arm}`,...q}));
    fitted[arm]=read(resolve(out,`model-${arm}/summary.json`));loadQ(fitted[arm].selected.path);
  }
  const models=Object.fromEntries(ARMS.map(arm=>[arm,{...fitted[arm].selected,sha256:hash(fitted[arm].selected.path)}]));
  save(resolve(out,'training.json'),{datasets,fitted});save(resolve(out,'models.json'),models);
  onProgress({stage:'models-frozen',models});const evaluations=await evaluate({out,plan:p,models,onProgress});check(p);
  const summary={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),models,
    trainingHands:b.trainingHands,validationHands:b.validationHands,trainingSamples:datasets.training.samples,evaluations,
    games:Object.values(evaluations).reduce((n,r)=>n+r.games,0),productionPolicy:'H0',positivePrimaryEvidence:evaluations.offline.statistics.session.overall.ci95[0]>0};
  save(resolve(out,'summary.json'),summary);onProgress({stage:'complete',games:summary.games,positivePrimaryEvidence:summary.positivePrimaryEvidence});return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
