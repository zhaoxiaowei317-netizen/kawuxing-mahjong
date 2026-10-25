import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {sha256, projectRoot, verifyFrozenBaseline} from '../provenance.mjs';
import {deriveSeed} from '../random.mjs';
import {mergeData} from './data.mjs';
import {trainGain, trainRidge, trainingSources} from './train.mjs';
import {evaluateGain} from './evaluate.mjs';

export const STUDY_VERSION = 'kwx-paired-realized-gain-study-1';
export const ARMS = Object.freeze(['ridge', 'mlp-0', 'mlp-1', 'mlp-2']);
export const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
function runWorker(script,args,onProgress) {
  return new Promise((resolveJob,rejectJob)=>{
    const child=spawn(process.execPath,[resolve(projectRoot,script),...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let buffer='',errors='';child.stdout.on('data',chunk=>{
      buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        if(line.trim()){try{const p=JSON.parse(line);if(!p.complete)onProgress(p);}catch(e){errors+=e.stack+'\n';}}}
    });child.stderr.on('data',c=>{errors+=c;});child.on('error',rejectJob);
    child.on('close',code=>code===0&&!errors?resolveJob():rejectJob(Error(`${script} failed: ${errors}`)));
  });
}
async function settle(jobs) {
  const results=await Promise.allSettled(jobs),failed=results.filter(r=>r.status==='rejected');
  if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'Local workers failed');
  return results.map(r=>r.value);
}
async function evaluateWorker(spec,stage,out,onProgress) {
  const path=resolve(out,`${stage}.spec.json`);save(path,spec);
  await runWorker('ai/paired-value/evaluate.mjs',[path],p=>onProgress({stage,...p}));
  return JSON.parse(readFileSync(resolve(spec.out,'report.json'),'utf8'));
}
export function studySources() {
  return {...trainingSources(), ...Object.fromEntries(['ai/paired-value/evaluate.mjs', 'ai/paired-value/study.mjs',
    'ai/paired-value/verify.mjs'].map(p => [p, sha256(readFileSync(resolve(projectRoot, p)))]))};
}
export function selectCandidate(rows) {
  if (rows.length !== ARMS.length || ARMS.some(arm => rows.filter(r => r.arm === arm).length !== 1) ||
    rows.some(r => !Number.isFinite(r.delta))) throw Error('Incomplete development results');
  const sorted = [...rows].sort((a,b) => b.delta - a.delta || ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm));
  return sorted[0].delta > 1e-9 ? sorted[0].arm : null;
}
export async function runStudy({out, trainingHands = 6000, validationHands = 1200, epochs = 20,
  developmentGroups = 4, developmentSessionGroups = 2, sealedGroups = 16, sealedSessionGroups = 8,
  sessionHands = 16, bootstrapSamples = 5000, onProgress = console.log} = {}) {
  out = resolve(out); if (existsSync(out)) throw Error('Study output exists');
  for (const n of [trainingHands, validationHands, epochs, developmentGroups, developmentSessionGroups,
    sealedGroups, sealedSessionGroups, sessionHands, bootstrapSamples]) if (!Number.isInteger(n) || n < 1) throw Error('Invalid fixed budget');
  const nonce = randomBytes(32).toString('hex');
  const plan = {version:STUDY_VERSION, createdAt:new Date().toISOString(), baseline:verifyFrozenBaseline(),
    sourceHashes:studySources(), arms:ARMS, seeds:Object.fromEntries(['training','validation','development','sealed']
      .map(split => [split, deriveSeed(STUDY_VERSION, nonce, split)])),
    budget:{trainingHands, validationHands, epochs, developmentGroups, developmentSessionGroups, sealedGroups,
      sealedSessionGroups, sessionHands, bootstrapSamples},
    collection:{trainingWorkers:Math.min(3,trainingHands),validationWorkers:1,range:'Disjoint contiguous global hand indices; shard-independent seeds'},
    models:{ridge:{lambda:1}, mlp:{hiddenSize:8, learningRate:0.002, batchSize:128, seeds:3}},
    target:'First H0/two-draw disagreement per target seat per training deal; actual-world alternative minus H0 terminal net score. Own continuation H0. Two actual preset opponent types balanced.',
    input:'64 public features only; private world is used for offline terminal reward labels only.',
    selection:'Each MLP uses minimum validation MSE epoch including exact-H0 epoch 0; earliest tie. Four models share training/validation deals. Highest development session paired delta vs H0, fixed arm-order tie break; H0 if all nonpositive.',
    primary:'Fresh sealed session net score per 100 hands vs H0, opponent pairs equal-weight, group paired bootstrap.',
    secondary:'One separately seeded sealed comparison vs proposal-once to isolate the learned filter.',
    stopping:'Fixed budgets, no interim stopping, no extension, no sealed-data training or selection. Default H0 unchanged.'};
  mkdirSync(out, {recursive:true}); save(resolve(out, 'plan.json'), plan); onProgress({stage:'plan', budget:plan.budget});
  const trainingData = resolve(out, 'training'), validationData = resolve(out, 'validation');
  const datasets = {};
  // Three training shards plus an independent validation worker use four local CPU processes.
  const jobs=[], parts={training:[],validation:[]};
  for (const [split,hands,count] of [['training',trainingHands,Math.min(3,trainingHands)],['validation',validationHands,1]]) {
    let startHand=0;
    for(let part=0;part<count;part++) {
      const size=Math.floor(hands/count)+Number(part<hands%count), path=resolve(out,'.collect',`${split}-${part}`);
      parts[split].push(path); const offset=startHand;startHand+=size;
      jobs.push(runWorker('ai/paired-value/collect.mjs',[path,String(size),plan.seeds[split],split,String(offset)],
        p=>onProgress({stage:'data',worker:`${split}-${part}`,...p})));
    }
  }
  await settle(jobs);
  for(const [split,path] of [['training',trainingData],['validation',validationData]])datasets[split]=mergeData({out:path,parts:parts[split],split});
  const fitted = {};
  fitted.ridge = trainRidge({out:resolve(out, 'model-ridge'), trainingData, validationData, lambda:1});
  for (let i = 0; i < 3; i++) {
    const arm = `mlp-${i}`, r = await trainGain({out:resolve(out, `model-${arm}`), trainingData, validationData,
      seed:deriveSeed(plan.seeds.training, 'model', i), epochs, ...plan.models.mlp,
      onProgress:p => onProgress({stage:`train-${arm}`, ...p})});
    fitted[arm] = {path:r.selected.path, epoch:r.selected.epoch, validationMse:r.selected.validationMse};
  }
  save(resolve(out, 'models.json'), fitted);
  const development = await settle(ARMS.map(async arm => {
    const r = await evaluateWorker({out:resolve(out, `development-${arm}`), candidate:arm, checkpoint:fitted[arm].path,
      seed:plan.seeds.development, split:'development', independentGroups:developmentGroups, sessionGroups:developmentSessionGroups,
      sessionHands, bootstrapSamples},`development-${arm}`,out,onProgress);
    return {arm, delta:r.statistics.session.overall.deltaPer100, ci95:r.statistics.session.overall.ci95,
      games:r.totalGames, counts:r.counts};
  }));
  const selected = selectCandidate(development);
  save(resolve(out, 'selection.json'), {selected, development, modelsSha256:sha256(readFileSync(resolve(out, 'models.json')))});
  onProgress({stage:'selection', selected, development});
  const sealed = {};
  if (selected) {
    const comparisons=await settle(['H0','proposal-once'].map(async incumbent=>{
    const r = await evaluateWorker({out:resolve(out, `sealed-vs-${incumbent}`), candidate:selected, checkpoint:fitted[selected].path,
      incumbent, seed:deriveSeed(plan.seeds.sealed, incumbent), split:'sealed', independentGroups:sealedGroups,
      sessionGroups:sealedSessionGroups, sessionHands, bootstrapSamples},`sealed-vs-${incumbent}`,out,onProgress);
    return [incumbent,{primary:r.statistics.session.overall, independent:r.statistics.independent.overall,
      byOpponentPair:r.statistics.session.byOpponentPair, games:r.totalGames, counts:r.counts}];
    }));for(const [id,result] of comparisons)sealed[id]=result;
  }
  if (JSON.stringify(studySources()) !== JSON.stringify(plan.sourceHashes)) throw Error('Study sources changed');
  const summary = {version:STUDY_VERSION, completedAt:new Date().toISOString(), planSha256:sha256(readFileSync(resolve(out, 'plan.json'))),
    datasets, fitted, development, selected, sealed, productionPolicy:'H0', trainingDeals:trainingHands,
    validationDeals:validationHands, branches:datasets.training.counterfactualBranches + datasets.validation.counterfactualBranches,
    games:development.reduce((s,r) => s + r.games, 0) + Object.values(sealed).reduce((s,r) => s + r.games, 0),
    positiveSealedEvidence:!!(sealed.H0 && sealed.H0.primary.ci95[0] > 0)};
  save(resolve(out, 'summary.json'), summary); onProgress({stage:'complete', games:summary.games, selected}); return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]; if (!out) throw Error('Usage: node ai/paired-value/study.mjs NEW_OUTPUT_DIR');
  runStudy({out, onProgress:p => console.log(JSON.stringify({at:new Date().toISOString(), ...p}))})
    .catch(e => {console.error(e); process.exitCode = 1;});
}
