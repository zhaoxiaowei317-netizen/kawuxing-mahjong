import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {verifyFrozenBaseline,sha256,projectRoot} from '../provenance.mjs';
import {sources,assertSources,VERSION} from './sources.mjs';
import {SCHEMA} from './encoding.mjs';
import {save,merge,loadData} from './collect.mjs';
import {loadQ} from './model.mjs';
export const ARMS=Object.freeze(['features-bc','tiles-bc','tiles-offline','tiles-online']);
export function worker(executable,args,onProgress=()=>{}){
  return new Promise((done,fail)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],cwd:projectRoot});let buffer='',errors='';
    child.stdout.on('data',c=>{buffer+=c;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
      if(line.trim()){try{const p=JSON.parse(line);if(!p.complete)onProgress(p);}catch(e){errors+=line+'\n';}}}});
    child.stderr.on('data',c=>{errors+=c;});child.on('error',fail);
    child.on('close',code=>code===0?done():fail(Error(`${executable} ${args[0]} failed (${code}): ${errors}`)));
  });
}
export async function parallel(jobs){const r=await Promise.allSettled(jobs);const bad=r.filter(x=>x.status==='rejected');if(bad.length)throw new AggregateError(bad.map(x=>x.reason));return r.map(x=>x.value);}
export function select(rows){
  if(rows.length!==ARMS.length||ARMS.some(a=>rows.filter(r=>r.arm===a).length!==1)||rows.some(r=>!Number.isFinite(r.delta)))throw Error('Incomplete candidate results');
  const ordered=[...rows].sort((a,b)=>b.delta-a.delta||ARMS.indexOf(a.arm)-ARMS.indexOf(b.arm));return ordered[0].delta>1e-9?ordered[0].arm:null;
}
export async function runStudy({out,python='python',initialHands=2400,validationHands=480,bcEpochs=12,offlineEpochs=8,
  onlineRounds=2,onlineHands=600,onlineEpochs=4,developmentGroups=4,developmentSessions=2,sealedGroups=16,sealedSessions=8,
  sessionHands=16,trainingSessionHands=16,bootstrapSamples=5000,onProgress=console.log}={}){
  out=resolve(out);if(existsSync(out))throw Error('Study exists');
  const budget={initialHands,validationHands,bcEpochs,offlineEpochs,onlineRounds,onlineHands,onlineEpochs,developmentGroups,
    developmentSessions,sealedGroups,sealedSessions,sessionHands,trainingSessionHands,bootstrapSamples};
  for(const v of Object.values(budget))if(!Number.isInteger(v)||v<1)throw Error('Invalid budget');
  const nonce=randomBytes(32).toString('hex'),seeds=Object.fromEntries(['training','validation','model','development','sealed',
    ...Array.from({length:onlineRounds},(_,i)=>`online-${i}`)].map(k=>[k,deriveSeed(VERSION,nonce,k)]));
  const plan={version:VERSION,createdAt:new Date().toISOString(),baseline:verifyFrozenBaseline(),sources:sources(),schema:SCHEMA,
    arms:ARMS,budget,seeds,network:{channels:24,blocks:2,globalSize:64,localSize:32,useTiles:true},
    optimizer:{learningRate:.001,batchSize:256,maxGradNorm:5,cqlWeight:.05,bcWeight:.1,auxWeight:.1},
    python,epsilon:.1,
    reference:'Independent compact adaptation of Mortal-style residual tile encoding, masked dueling action values, Monte Carlo return regression, offline CQL and auxiliary rank prediction. No imported Mortal code or weights.',
    changes:'21 tile types; suit/honor separation; shared action-conditioned head also receives existing 34 public efficiency features; no normalization/attention; gamma=1 and net-score objective; full legal action set.',
    selection:'BC: minimum fixed validation CE+aux loss. Offline Q: minimum validation composite loss. Online: fixed final epoch each round. Highest development session net delta vs H0, H0 if none positive, fixed arm-order ties.',
    primary:'Independent sealed 16-hand session net-score difference vs H0; six seat permutations, equal opponent-pair weights, paired group bootstrap.',
    stopping:'All four fixed development budgets; one sealed comparison only if a candidate passes development. No budget extension or sealed-data training. Game default H0.'};
  mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'.collect'));save(resolve(out,'plan.json'),plan);onProgress({stage:'plan',budget});
  const read=p=>JSON.parse(readFileSync(resolve(out,p),'utf8'));
  const collectJobs=[],parts={training:[],validation:[]};
  const trainingWorkers=initialHands%(3*trainingSessionHands)===0?3:1;
  for(const [split,hands,count]of [['training',initialHands,trainingWorkers],['validation',validationHands,1]]){
    let offset=0;for(let i=0;i<count;i++){
      const size=Math.floor(hands/count)+Number(i<hands%count),path=resolve(out,'.collect',`${split}-${i}`),spec=resolve(out,`collect-${split}-${i}.json`);
      save(spec,{out:path,hands:size,startHand:offset,seed:seeds[split],split,sessionHands:trainingSessionHands});offset+=size;parts[split].push(path);
      collectJobs.push(worker(process.execPath,[resolve(projectRoot,'ai/tile-q/collect.mjs'),spec],p=>onProgress({stage:'collect',worker:`${split}-${i}`,...p})));
    }
  }
  await parallel(collectJobs);
  const datasets={};for(const split of ['training','validation'])datasets[split]=merge({out:resolve(out,split),parts:parts[split],split});
  const train=async(name,spec)=>{
    const path=resolve(out,`train-${name}.spec.json`);save(path,{out:resolve(out,`model-${name}`),schema:SCHEMA,sources:plan.sources,
      seed:seeds.model,trainingData:resolve(out,'training'),validationData:resolve(out,'validation'),network:plan.network,config:plan.optimizer,...spec});
    await worker(python,[resolve(projectRoot,'ai/tile-q/train.py'),path],p=>onProgress({stage:`train-${name}`,...p}));
    const r=read(`model-${name}/summary.json`);loadQ(r.selected.path);return r;
  };
  const fitted={};
  fitted['features-bc']=await train('features-bc',{mode:'bc',epochs:bcEpochs,network:{...plan.network,useTiles:false}});
  fitted['tiles-bc']=await train('tiles-bc',{mode:'bc',epochs:bcEpochs});
  fitted['tiles-offline']=await train('tiles-offline',{mode:'q',epochs:offlineEpochs,initialize:fitted['tiles-bc'].selected.state});
  let current=fitted['tiles-offline'];const online=[];
  for(let i=0;i<onlineRounds;i++){
    const name=`online-${i}`,dataset=resolve(out,name),spec=resolve(out,`collect-${name}.json`);
    save(spec,{out:dataset,hands:onlineHands,seed:seeds[name],split:'training',sessionHands:trainingSessionHands,checkpoint:current.selected.path,
      history:[fitted['tiles-bc'].selected.path,fitted['tiles-offline'].selected.path],epsilon:plan.epsilon});
    await worker(process.execPath,[resolve(projectRoot,'ai/tile-q/collect.mjs'),spec],p=>onProgress({stage:`collect-${name}`,...p}));
    const m=loadData(dataset,'training').manifest;
    current=await train(name,{mode:'q',epochs:onlineEpochs,initialize:current.selected.state,trainingData:dataset,
      select:'last',seed:seeds[name],config:{...plan.optimizer,cqlWeight:0,bcWeight:.02}});
    online.push({dataset:m,selected:current.selected,training:current});
  }
  fitted['tiles-online']=current;save(resolve(out,'models.json'),Object.fromEntries(ARMS.map(a=>[a,fitted[a].selected])));
  const evalStage=async(stage,candidate,checkpoint,sealed)=>{
    const spec=resolve(out,`${stage}.spec.json`);save(spec,{out:resolve(out,stage),candidate,checkpoint,
      seed:sealed?seeds.sealed:seeds.development,split:sealed?'sealed':'development',
      independentGroups:sealed?sealedGroups:developmentGroups,sessionGroups:sealed?sealedSessions:developmentSessions,
      sessionHands,bootstrapSamples});
    await worker(process.execPath,[resolve(projectRoot,'ai/tile-q/evaluate.mjs'),spec],p=>onProgress({stage,...p}));return read(`${stage}/report.json`);
  };
  const development=await parallel(ARMS.map(async arm=>{
    const r=await evalStage(`development-${arm}`,arm,fitted[arm].selected.path,false);
    return {arm,delta:r.statistics.session.overall.deltaPer100,ci95:r.statistics.session.overall.ci95,games:r.totalGames};
  }));
  const selected=select(development);save(resolve(out,'selection.json'),{selected,development});onProgress({stage:'selection',selected,development});
  let sealed=null;
  if(selected){const r=await evalStage('sealed-vs-H0',selected,fitted[selected].selected.path,true);
    sealed={primary:r.statistics.session.overall,independent:r.statistics.independent.overall,byOpponentPair:r.statistics.session.byOpponentPair,games:r.totalGames};}
  assertSources(plan.sources);
  const summary={version:VERSION,completedAt:new Date().toISOString(),planSha256:sha256(readFileSync(resolve(out,'plan.json'))),
    datasets,online,fitted,development,selected,sealed,trainingHands:initialHands+onlineRounds*onlineHands,validationHands,
    games:development.reduce((s,r)=>s+r.games,0)+(sealed?.games||0),productionPolicy:'H0',
    positiveSealedEvidence:!!(sealed&&sealed.primary.ci95[0]>0)};
  save(resolve(out,'summary.json'),summary);onProgress({stage:'complete',games:summary.games,selected});return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runStudy({out:process.argv[2],
  onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))}).catch(e=>{console.error(e);process.exitCode=1;});
