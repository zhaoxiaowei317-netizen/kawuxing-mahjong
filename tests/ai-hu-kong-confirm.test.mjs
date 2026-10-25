import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {save} from '../ai/tile-q/collect.mjs';
import {run as trainFixture} from '../ai/strong-pool/study.mjs';
import {verify as verifyTraining} from '../ai/strong-pool/verify-stream.mjs';
import {run as confirmFixture} from '../ai/strong-confirm/study.mjs';
import {verify as verifyConfirmation} from '../ai/strong-confirm/verify.mjs';
import {diagnose} from '../ai/strong-confirm/diagnose.mjs';
import {run as guardFixture} from '../ai/outs-guard/study.mjs';
import {verify as verifyGuard} from '../ai/outs-guard/verify.mjs';
import {run as distillFixture} from '../ai/outs-distill/study.mjs';
import {verify as verifyDistill} from '../ai/outs-distill/verify.mjs';
import {run as anchorFixture} from '../ai/outs-anchor/study.mjs';
import {verify as verifyAnchor} from '../ai/outs-anchor/verify.mjs';
import {run as durationFixture} from '../ai/outs-duration/study.mjs';
import {verify as verifyDuration} from '../ai/outs-duration/verify.mjs';
import {run as componentFixture} from '../ai/decision-components/study.mjs';
import {verify as verifyComponent} from '../ai/decision-components/verify.mjs';
import {diagnose as diagnoseComponent} from '../ai/decision-components/diagnose.mjs';
import {run as discoveryFixture} from '../ai/hu-kong/study.mjs';
import {verify as verifyDiscovery} from '../ai/hu-kong/verify.mjs';
import {makePlan,check,checkBinding,checkSummary,read,hash} from '../ai/hu-kong-confirm/config.mjs';
import {run} from '../ai/hu-kong-confirm/study.mjs';
import {verify} from '../ai/hu-kong-confirm/verify.mjs';

test('hu-kong confirmation freezes discovery, binds before games, rejects changes and fully audits fresh trials',async()=>{
  mkdirSync('.tmp/hu-kong-confirm-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/hu-kong-confirm-tests/run-')),
    training=resolve(root,'training'),confirmation=resolve(root,'confirmation'),guard=resolve(root,'guard'),distill=resolve(root,'distill'),anchor=resolve(root,'anchor'),duration=resolve(root,'duration'),component=resolve(root,'components'),discovery=resolve(root,'discovery'),out=resolve(root,'replication');
  await trainFixture({out:training,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});await verifyTraining({out:training});
  await confirmFixture({out:confirmation,previous:training,evaluationGroups:1,bootstrapSamples:30,workers:2});await verifyConfirmation({out:confirmation});diagnose({out:confirmation});
  await guardFixture({out:guard,previous:confirmation,groupsPerPair:1,bootstrapSamples:30,workers:2});await verifyGuard({out:guard});
  await distillFixture({out:distill,previous:guard,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDistill({out:distill});
  await anchorFixture({out:anchor,previous:distill,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyAnchor({out:anchor});
  await durationFixture({out:duration,previous:anchor,epochs:2,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDuration({out:duration});
  await componentFixture({out:component,previous:duration,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:128});await verifyComponent({out:component});await diagnoseComponent({out:component});
  await discoveryFixture({out:discovery,previous:component,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:128});await verifyDiscovery({out:discovery});
  const oldHashes=Object.fromEntries(['plan.json','summary.json','verification.json','models.json'].map(f=>[f,hash(resolve(discovery,f))])),p=makePlan({discovery});check(p);
  assert.equal(Object.keys(p.sourceMap).length,69);assert.throws(()=>check({...p,budget:{...p.budget,groupsPerPair:2}}));assert.throws(()=>check({...p,primary:'pick after games'}));
  let boundBeforeGames=false;const s=await run({out,discovery,onProgress:e=>{if(e.stage==='plan'){
    checkBinding(out,read(resolve(out,'plan.json')));assert.equal(readdirSync(resolve(out,'trial/groups')).length,0);boundBeforeGames=true;
  }}});assert.ok(boundBeforeGames);assert.equal(s.games,72);assert.equal(s.optimizationUpdates,0);assert.equal(s.productionPolicy,'H0');
  checkSummary(out);const current=read(resolve(out,'trial/summary.json'));assert.deepEqual(s.primary,current.primary);
  assert.equal(s.mechanismReplicated,p.discoveryPrimary.mechanism.ci95[0]>0&&current.primary.mechanism.ci95[0]>0);
  const binding=read(resolve(out,'binding.json'));save(resolve(out,'binding.json'),{...binding,trialPlanSha256:'tampered'});assert.throws(()=>checkSummary(out));save(resolve(out,'binding.json'),binding);
  const v=await verify({out});assert.equal(v.games,72);assert.equal(v.groups.length,3);assert.ok(v.allGroupsRecomputedWithoutScoreCache);assert.ok(v.groups.every(g=>g.cacheDisabled));
  assert.equal(v.trialVerificationSha256,hash(resolve(out,'trial/verification.json')));for(const [f,sha]of Object.entries(oldHashes))assert.equal(hash(resolve(discovery,f)),sha);
  const original=readFileSync(resolve(discovery,'summary.json'),'utf8');save(resolve(discovery,'summary.json'),{...read(resolve(discovery,'summary.json')),games:999});assert.throws(()=>check(p));
  const {writeFileSync}=await import('node:fs');writeFileSync(resolve(discovery,'summary.json'),original);check(p);
  await assert.rejects(run({out,discovery}),/exists/);await assert.rejects(verify({out}),/exists/);
});
