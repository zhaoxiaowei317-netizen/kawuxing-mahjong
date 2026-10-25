import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {projectRoot} from '../provenance.mjs';
import {save} from '../tile-q/collect.mjs';
import {worker} from '../tile-q/study.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {pooled} from '../strong-pool/config.mjs';
import {generate,load,counts,add} from './collect.mjs';
import {simulate} from './groups.mjs';
import {aggregate,trainSpec,checkTraining} from './study.mjs';
import {exactZeroHead} from './policy.mjs';
import {VERSION,check,jobsFor,read,hash} from './config.mjs';
export async function auditPart({path,plan:p,split}){
  check(p);const {m,episodes}=load(path,p,split),c=counts();let index=0;
  for await(const e of generate({plan:p,split,startHand:m.startHand,hands:m.hands,cacheCapacity:0})){assert.deepEqual(e,episodes[index++]);add(c,e);}
  assert.equal(index,episodes.length);return {path,split,...c,sha256:m.sha256,allHandsAndBranchesRecomputed:true,cacheDisabled:true};
}
export async function auditGroup({path,plan:p,job,models}){
  check(p);const g=read(resolve(path,'group.json')),file=resolve(path,'replays.jsonl.gz');assert.equal(g.replaysSha256,hash(file));
  const episodes=gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let index=0;
  const r=await simulate({plan:p,job,models,cacheCapacity:0,onEpisode:e=>assert.deepEqual(e,episodes[index++])});assert.equal(index,episodes.length);
  const {cacheMetrics,...expected}=g,{cacheMetrics:actualCache,...actual}=r;assert.equal(actualCache.hits,0);assert.deepEqual(expected,{...actual,replaysSha256:hash(file)});
  return {jobId:job.id,games:g.games,groupSha256:hash(resolve(path,'group.json')),replaysSha256:hash(file),allEpisodesRedealtAndPoliciesAndExactTracesMatched:true,cacheDisabled:true};
}
export async function verify({out,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(resolve(out,'verification.json')))throw Error('Verification exists');const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json')),t=read(resolve(out,'training.json')),models=read(resolve(out,'models.json'));check(p);
  assert.equal(s.version,VERSION);assert.equal(s.planSha256,hash(resolve(out,'plan.json')));assert.equal(s.productionPolicy,'H0');assert.deepEqual(models,s.models);
  assert.equal(s.trainingHands,p.budget.trainingHands);assert.equal(s.validationHands,p.budget.validationHands);
  const audit=resolve(out,'.audit');if(existsSync(audit))throw Error('Audit exists');mkdirSync(audit);const data=[];
  const parts=['training','validation'].flatMap(split=>t.datasets[split].parts.map(path=>({path,plan:p,split})));
  await pooled(parts,p.budget.workers,async(part,i)=>{const id=`data-${part.split}-${part.path.split(/[\\/]/).at(-1)}`,spec=resolve(audit,id+'.json'),result=spec+'.result.json';save(spec,{...part,result});
    await worker(process.execPath,[fileURLToPath(import.meta.url),'data',spec]);data.push(read(result));onProgress({stage:'audit-data',completedParts:data.length,totalParts:parts.length,hands:data.reduce((n,x)=>n+x.hands,0)});});
  for(const split of ['training','validation']){const {m}=load(resolve(out,split),p,split);assert.deepEqual(m,t.datasets[split]);assert.equal(m.hands,p.budget[split+'Hands']);
    assert.deepEqual(readFileSync(resolve(out,split,'episodes.jsonl.gz')),Buffer.concat(m.parts.map(path=>readFileSync(resolve(path,'episodes.jsonl.gz')))));}
  assert.equal(s.trainingSamples,t.datasets.training.roots);let snapshots=0;
  if(t.trained){
    const spec=resolve(audit,'training.json');save(spec,{...trainSpec(out,p),verify:true});await worker(p.python,[resolve(projectRoot,'ai/paired-tile/train.py'),spec],q=>onProgress({stage:'audit-training',...q}));
    assert.deepEqual(checkTraining(out,p),t.trained);assert.deepEqual(models.learned,t.trained.model);snapshots=p.budget.epochs+1;assert.equal(s.optimizationUpdates,t.trained.training.optimizationUpdates);
    assert.equal(s.status,t.trained.training.selected.epoch===0?'zero-selected':'evaluated');
  }else{assert.equal(s.status,'no-eligible-roots');assert.ok(!t.datasets.training.roots||!t.datasets.validation.roots);assert.equal(s.optimizationUpdates,0);}
  const audited=[];let evaluation={games:0,contrasts:{}};
  if(s.status==='evaluated'){
    const jobs=jobsFor(p),groups=jobs.map(j=>read(resolve(out,'groups',j.id,'group.json')));evaluation=aggregate(p,models,groups);assert.deepEqual(s.evaluation,evaluation);
    await pooled(jobs,p.budget.workers,async job=>{const spec=resolve(audit,job.id+'.json'),result=spec+'.result.json';save(spec,{path:resolve(out,'groups',job.id),plan:p,job,models,result});
      await worker(process.execPath,[fileURLToPath(import.meta.url),'group',spec]);audited.push(read(result));onProgress({stage:'audit-games',completedGroups:audited.length,totalGroups:jobs.length});});
  }else{
    assert.equal(readdirSync(resolve(out,'groups')).length,0);assert.equal(s.games,0);if(s.status==='zero-selected')assert.ok(exactZeroHead(loadQ(models.learned.path).model));
  }
  assert.deepEqual(s.evaluation,evaluation);assert.equal(s.games,evaluation.games);
  const primary=Object.fromEntries(Object.entries(evaluation.contrasts).map(([k,r])=>[k,r.statistics.session.overall]));assert.deepEqual(s.primary,primary);
  const outcomes=Object.fromEntries(Object.entries(primary).map(([k,x])=>[k,x.ci95[0]>0?'positive':x.ci95[1]<0?'negative':'inconclusive']));assert.deepEqual(s.outcomes,outcomes);
  assert.equal(s.learningEvidence,outcomes.improvement==='positive'&&outcomes.selection==='positive');assert.equal(s.positiveJointEvidence,Object.keys(outcomes).length===3&&Object.values(outcomes).every(x=>x==='positive'));check(p);
  const v={completedAt:new Date().toISOString(),planSha256:s.planSha256,summarySha256:hash(resolve(out,'summary.json')),sourceMap:p.sourceMap,data,
    trainingSnapshotsRecomputed:snapshots,trainingHands:s.trainingHands,validationHands:s.validationHands,games:s.games,allGroupsRecomputedWithoutScoreCache:true,
    groups:audited.sort((a,b)=>a.jobId.localeCompare(b.jobId))};save(resolve(out,'verification.json'),v);return v;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2],spec=['data','group'].includes(mode)?read(process.argv[3]):null;
  const task=spec?(mode==='data'?auditPart(spec):auditGroup(spec)).then(v=>save(spec.result,v)):verify({out:mode,onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))});
  task.then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
}
