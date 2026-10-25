import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {sources as coreSources,assertSources} from '../tile-q/sources.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {save} from '../tile-q/collect.mjs';
import {parallel,worker} from '../tile-q/study.mjs';
import {projectRoot,sha256,verifyFrozenBaseline} from '../provenance.mjs';
import {deriveSeed} from '../random.mjs';
import {runEvaluation} from '../runner.mjs';
import {replayEpisode} from '../environment.mjs';
import {summarizePaired} from '../statistics.mjs';
import {ARMS,VARIANTS,policyFor} from './policies.mjs';

export const VERSION='kwx-reveal-interventions-1';
export const hash=p=>sha256(readFileSync(p));
export const read=p=>JSON.parse(readFileSync(p,'utf8'));
export function sources(){return {core:coreSources(),driver:Object.fromEntries(['policies.mjs','study.mjs','verify.mjs'].map(p=>[p,hash(new URL(p,import.meta.url))]))};}
export function check(p){assert.equal(p.version,VERSION);assertSources(p.sources.core);assert.deepEqual(sources(),p.sources);
  assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.variants,VARIANTS);assert.equal(loadQ(p.checkpoint).sha256,p.checkpointSha256);}
export function select(rows){
  assert.deepEqual(rows.map(r=>r.arm).sort(),[...ARMS].sort());assert.ok(rows.every(r=>Number.isFinite(r.delta)));
  const order=VARIANTS.map(arm=>rows.find(r=>r.arm===arm)).sort((a,b)=>b.delta-a.delta||VARIANTS.indexOf(a.arm)-VARIANTS.indexOf(b.arm));
  return order[0].delta>1e-9?order[0].arm:null;
}
export function contrasts(reports,bootstrapSamples,seed){
  const reference=reports['q-reference'];
  return Object.fromEntries(VARIANTS.map(id=>{
    const rows=reports[id].records.map((r,i)=>{const q=reference.records[i];assert.equal(r.seed,q.seed);assert.equal(r.opponentPair,q.opponentPair);assert.equal(r.suite,q.suite);
      assert.deepEqual(r.incumbent,q.incumbent);return {...r,incumbent:q.candidate};});
    return [id,summarizePaired(rows,{bootstrapSamples,seed:deriveSeed(seed,'vs-reference'),base:reference.base}).session];
  }));
}
export async function evaluate({out,plan,arm,sealed=false,onProgress=()=>{}}){
  check(plan);assert.ok(ARMS.includes(arm));out=resolve(out);if(existsSync(out))throw Error('Evaluation exists');mkdirSync(out,{recursive:true});
  const replay=resolve(out,'replays.jsonl.gz');writeFileSync(replay,gzipSync(''));let games=0;
  const model=loadQ(plan.checkpoint).model;
  const r=await runEvaluation({candidate:arm,incumbent:'H0',seed:plan.seeds[sealed?'sealed':'development'],split:sealed?'sealed':'development',
    independentGroups:0,sessionGroups:sealed?plan.budget.sealedGroups:plan.budget.developmentGroups,sessionHands:plan.budget.sessionHands,
    bootstrapSamples:plan.budget.bootstrapSamples,policyFactories:{[arm]:()=>policyFor(arm,model)},validate:true,onProgress,
    onEpisode:e=>{replayEpisode(e.replay);appendFileSync(replay,gzipSync(JSON.stringify(e)+'\n'));games++;}});
  check(plan);Object.assign(r,{checkpoint:plan.checkpoint,checkpointSha256:plan.checkpointSha256,sources:plan.sources,
    artifacts:{replays:{games,replayed:games,sha256:hash(replay)}}});save(resolve(out,'report.json'),r);return r;
}
export async function run({out,checkpoint,developmentGroups=2,sealedGroups=16,sessionHands=16,bootstrapSamples=5000,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(out))throw Error('Study exists');
  const budget={developmentGroups,sealedGroups,sessionHands,bootstrapSamples};for(const n of Object.values(budget))assert.ok(Number.isSafeInteger(n)&&n>0);
  const nonce=randomBytes(32).toString('hex'),loaded=loadQ(checkpoint),plan={version:VERSION,createdAt:new Date().toISOString(),
    baseline:verifyFrozenBaseline(),sources:sources(),checkpoint:resolve(checkpoint),checkpointSha256:loaded.sha256,budget,
    arms:ARMS,variants:VARIANTS,seeds:Object.fromEntries(['development','sealed'].map(k=>[k,deriveSeed(VERSION,nonce,k)])),
    interventions:'Keep the base policy action type and discard tile. Only switch legal reveal/non-reveal twins. h0-never retains H0 discard selection even though it originally prioritized reveal.',
    primary:'One fixed selected intervention vs H0 on fresh 16-hand sessions; positive evidence only if the full two-sided 95% paired-group interval is above zero.',
    secondary:'Development differences vs H0 and Q reference, by-opponent subgroups and behavior are descriptive; not multiplicity-adjusted causal confirmation. Interventions may alter all later trajectories.',
    selection:'Highest strictly positive development session delta vs H0 among three interventions only; listed variant order breaks ties. Original Q is a reference, not a candidate to reselect.',
    stopping:'Exactly four development budgets, and one sealed budget only if selected. No tuning, no more games to chase significance, no new training. Default H0 remains.'};
  mkdirSync(out,{recursive:true});save(resolve(out,'plan.json'),plan);onProgress({stage:'plan',budget});
  const reports={};await parallel(ARMS.map(async arm=>{
    const spec=resolve(out,`${arm}.spec.json`);save(spec,{out:resolve(out,`development-${arm}`),plan,arm});
    await worker(process.execPath,[fileURLToPath(import.meta.url),'evaluate',spec],p=>onProgress({stage:`development-${arm}`,...p}));
    reports[arm]=read(resolve(out,`development-${arm}`,'report.json'));
  }));
  const development=ARMS.map(arm=>({arm,delta:reports[arm].statistics.session.overall.deltaPer100,ci95:reports[arm].statistics.session.overall.ci95,games:reports[arm].totalGames}));
  const selected=select(development),vsReference=contrasts(reports,bootstrapSamples,plan.seeds.development);
  save(resolve(out,'selection.json'),{selected,development,vsReference});onProgress({stage:'selection',selected,development});
  let sealed=null;
  if(selected){const spec=resolve(out,'sealed.spec.json');save(spec,{out:resolve(out,'sealed'),plan,arm:selected,sealed:true});
    await worker(process.execPath,[fileURLToPath(import.meta.url),'evaluate',spec],p=>onProgress({stage:'sealed',...p}));const r=read(resolve(out,'sealed/report.json'));
    sealed={primary:r.statistics.session.overall,byOpponentPair:r.statistics.session.byOpponentPair,games:r.totalGames};}
  check(plan);const summary={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),development,vsReference,selected,sealed,
    games:development.reduce((s,r)=>s+r.games,0)+(sealed?.games||0),trainingHands:0,productionPolicy:'H0',positiveSealedEvidence:!!sealed&&sealed.primary.ci95[0]>0};
  save(resolve(out,'summary.json'),summary);onProgress({stage:'complete',games:summary.games});return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const progress=p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}));
  const task=process.argv[2]==='evaluate'?evaluate({...read(process.argv[3]),onProgress:progress}):run({out:process.argv[2],checkpoint:process.argv[3],onProgress:progress});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
