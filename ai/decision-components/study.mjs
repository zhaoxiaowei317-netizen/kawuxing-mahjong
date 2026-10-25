import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from '../provenance.mjs';
import {deriveSeed} from '../random.mjs';
import {summarizePaired} from '../statistics.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {familyIntervals} from './statistics.mjs';
import {VERSION,COMPONENTS,makePlan,check,jobsFor,jobSeed,read,hash} from './config.mjs';
export function aggregate(p,groups){
  const jobs=jobsFor(p);assert.deepEqual(groups.map(g=>g.job.id).sort(),jobs.map(j=>j.id).sort());
  const ordered=jobs.map(j=>{const g=groups.find(g=>g.job.id===j.id);assert.deepEqual(g.job,j);assert.equal(g.groupSeed,jobSeed(p,j));
    assert.deepEqual(g.modelHashes,Object.fromEntries(['short','long'].map(a=>[a,p.models[a].sha256])));assert.equal(g.games,30*p.budget.sessionHands);return g;});
  const contrasts=Object.fromEntries([...COMPONENTS,'long'].map(arm=>{
    const records=ordered.map(g=>({suite:'session',opponentPair:g.record.opponentPair,seed:g.record.seed,candidate:g.record.arms[arm],incumbent:g.record.arms.short}));
    return [arm,{records,statistics:summarizePaired(records,{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seed,'descriptive-bootstrap',arm),base:1})}];
  }));
  const family=familyIntervals(Object.fromEntries(COMPONENTS.map(a=>[a,contrasts[a].records])),{bootstrapSamples:p.budget.bootstrapSamples,seed:deriveSeed(p.seed,'family-bootstrap')});
  return {games:ordered.reduce((n,g)=>n+g.games,0),contrasts,family};
}
export async function run({out,onProgress=()=>{},...options}){
  out=resolve(out);if(existsSync(out))throw Error('Study output exists');const p=makePlan(options);
  mkdirSync(out,{recursive:true});mkdirSync(resolve(out,'.specs'));mkdirSync(resolve(out,'groups'));save(resolve(out,'plan.json'),p);save(resolve(out,'models.json'),p.models);
  onProgress({stage:'plan',budget:p.budget,newUniqueTrainingHands:0,newUniqueValidationHands:0});
  const jobs=jobsFor(p),groups=[];await pooled(jobs,p.budget.workers,async job=>{
    const spec=resolve(out,'.specs',job.id+'.json');save(spec,{out:resolve(out,'groups',job.id),plan:p,job,models:p.models});
    await worker(process.execPath,[resolve(projectRoot,'ai/decision-components/groups.mjs'),spec]);groups.push(read(resolve(out,'groups',job.id,'group.json')));
    onProgress({stage:'evaluation',completedGroups:groups.length,totalGroups:jobs.length,games:groups.reduce((n,g)=>n+g.games,0)});
  });check(p);const evaluation=aggregate(p,groups),s={version:VERSION,completedAt:new Date().toISOString(),planSha256:hash(resolve(out,'plan.json')),models:p.models,
    games:evaluation.games,evaluation,outcomes:Object.fromEntries(COMPONENTS.map(a=>[a,evaluation.family[a].outcome])),newUniqueTrainingHands:0,newUniqueValidationHands:0,
    productionPolicy:'H0',scope:'Conditional one-component substitutions, not a decomposition of long-short loss or a strength/promotion test.'};
  save(resolve(out,'summary.json'),s);onProgress({stage:'complete',games:s.games,outcomes:s.outcomes});return s;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run({out:process.argv[2],previous:process.argv[3],onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
