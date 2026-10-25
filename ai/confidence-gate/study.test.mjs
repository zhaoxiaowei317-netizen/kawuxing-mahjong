import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {buildParent} from '../../tests/helpers/paired-tile-parent.mjs';
import {run as paired} from '../paired-tile/study.mjs';
import {verify as verifyPaired} from '../paired-tile/verify.mjs';
import {run as wall} from '../wall-average/study.mjs';
import {verify as verifyWall} from '../wall-average/verify.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {runEvaluation} from '../runner.mjs';
import {save} from '../tile-q/collect.mjs';
import {SCHEMA} from './features.mjs';
import {GainGate,MODEL_VERSION} from './model.mjs';
import {run} from './study.mjs';
import {verify,auditGroup} from './verify.mjs';
import {verifyPrepared,deriveRows} from './data.mjs';
import {factories} from './policy.mjs';
import {playGroup} from './groups.mjs';
import {check,jobsFor,read,hash} from './config.mjs';
async function parent(){
  if(process.env.KWX_CONFIDENCE_TEST_PARENT)return resolve(process.env.KWX_CONFIDENCE_TEST_PARENT);
  const old=await buildParent(),pair=resolve(dirname(old),'confidence-paired'),out=resolve(dirname(old),'confidence-wall');
  await paired({out:pair,previous:old,trainingHands:72,validationHands:36,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:64});await verifyPaired({out:pair});
  await wall({out,previous:pair,trainingHands:72,validationHands:36,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:64,wallSamples:2});await verifyWall({out});return out;
}
test('public confidence readout reuses only parent learning data, audits fitting and matches five-arm runner',async()=>{
  const previous=await parent();mkdirSync('.tmp/confidence-study-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/confidence-study-tests/run-')),out=resolve(root,'study'),options={out,previous,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:64},s=await run(options),p=read(resolve(out,'plan.json'));check(p);
  assert.equal(Object.keys(p.sourceMap).length,92);assert.equal(s.newTrainingHands,0);assert.equal(s.newValidationHands,0);assert.equal(s.gradientUpdates,0);assert.equal(s.closedFormFits,6);assert.ok([0,90].includes(s.games));assert.equal(s.reusedTrainingHands,read(resolve(previous,'training/manifest.json')).hands);
  assert.throws(()=>check({...p,primary:'exam replacement'}));const v=await verify({out});assert.equal(v.games,s.games);assert.ok(v.parentRawDataAuditInherited&&v.allDerivedPublicFeaturesRecomputed&&v.allEightFitsRecomputed);
  const path=resolve(out,'training/rows.jsonl.gz'),bytes=readFileSync(path),manifest=read(resolve(out,'training/manifest.json')),rows=gunzipSync(bytes).toString('utf8').trim().split('\n').map(JSON.parse);rows[0].features[0]+=.1;writeFileSync(path,gzipSync(rows.map(JSON.stringify).join('\n')+'\n'));save(resolve(out,'training/manifest.json'),{...manifest,sha256:hash(path)});
  assert.throws(()=>verifyPrepared({out:resolve(out,'training'),plan:p,split:'training'}));writeFileSync(path,bytes);save(resolve(out,'training/manifest.json'),manifest);
  const rawPath=resolve(previous,'training/episodes.jsonl.gz'),rawManifestPath=resolve(previous,'training/manifest.json'),rawBytes=readFileSync(rawPath),rawManifest=readFileSync(rawManifestPath),rawRows=gunzipSync(rawBytes).toString('utf8').trim().split('\n').map(JSON.parse);
  try{rawRows[0].hand+=1000;writeFileSync(rawPath,gzipSync(rawRows.map(JSON.stringify).join('\n')+'\n'));save(rawManifestPath,{...JSON.parse(rawManifest),sha256:hash(rawPath)});assert.throws(()=>deriveRows(p,'training'));}
  finally{writeFileSync(rawPath,rawBytes);writeFileSync(rawManifestPath,rawManifest);}
  // Fixed synthetic readout tests the gameplay branch even when genuine
  // validation selects an exact constant and correctly skips that exam.
  const d={version:MODEL_VERSION,schema:SCHEMA,mean:SCHEMA.names.map(()=>0),scale:SCHEMA.names.map(()=>1),weights:SCHEMA.names.map(n=>n==='delta.outs'?.3:0),intercept:.02},gatePath=resolve(root,'synthetic-gate.json');save(gatePath,d);
  const models={...p.models,gate:{path:gatePath,sha256:hash(gatePath)}},job=jobsFor(p)[0],groupPath=resolve(root,'group'),g=await playGroup({out:groupPath,plan:p,job,models});assert.equal(g.games,30);assert.ok((await auditGroup({path:groupPath,plan:p,job,models})).cacheDisabled);
  const loaded={...Object.fromEntries(Object.entries(p.models).map(([k,m])=>[k,loadQ(m.path).model])),gate:new GainGate(d)};
  for(const control of ['average','baseline','always','reference']){const expected=await runEvaluation({candidate:'gate',incumbent:control,seed:p.seeds.evaluation,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:1,opponentPairs:[job.pair],bootstrapSamples:30,policyFactories:factories(loaded,0).policies});assert.deepEqual(expected.records[0].candidate,g.record.arms.gate);assert.deepEqual(expected.records[0].incumbent,g.record.arms[control]);}
  await assert.rejects(run(options),/exists/);await assert.rejects(verify({out}),/exists/);
});
