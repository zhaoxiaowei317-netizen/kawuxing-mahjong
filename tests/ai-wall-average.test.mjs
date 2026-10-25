import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {MahjongEnvironment,observationFor,replayEpisode} from '../ai/environment.mjs';
import {actionId} from '../ai/tile-q/encoding.mjs';
import {loadQ} from '../ai/tile-q/model.mjs';
import {runEvaluation} from '../ai/runner.mjs';
import {shuffleFutureWall} from '../ai/wall-average/worlds.mjs';
import {factories} from '../ai/wall-average/policy.mjs';
import {projectEpisode,load,generate} from '../ai/wall-average/collect.mjs';
import {makePlan,check,jobsFor,read,hash} from '../ai/wall-average/config.mjs';
import {run} from '../ai/wall-average/study.mjs';
import {verify,auditPart} from '../ai/wall-average/verify.mjs';
import {save} from '../ai/tile-q/collect.mjs';
import {run as paired} from '../ai/paired-tile/study.mjs';
import {verify as verifyPaired} from '../ai/paired-tile/verify.mjs';
import {buildParent} from './helpers/paired-tile-parent.mjs';

test('future wall shuffle changes only unseen future order and preserves private history flags',()=>{
  const env=new MahjongEnvironment({seed:'wall-shuffle-invariants'}),world=env.auditState(),original=structuredClone(world);
  world.players[1].passedHu=['p1'];world.players[1].passedPeng=['p2'];world.players[1].buOpportunities=['p3'];
  const sampled=shuffleFutureWall(world,'new-future');assert.deepEqual(shuffleFutureWall(world,'new-future'),sampled);assert.notDeepEqual(sampled.wall,world.wall);
  assert.deepEqual(observationFor(sampled,0),observationFor(world,0));assert.deepEqual(sampled.players,world.players);assert.deepEqual(env.auditState(),original);
  const shallow={...world,wall:[]};assert.throws(()=>shuffleFutureWall(shallow,'invalid'));assert.throws(()=>shuffleFutureWall({...world,phase:'react'},'invalid'));
});

test('averaged and single gates preserve one opportunity, ties and public-only projections',()=>{
  const env=new MahjongEnvironment({seed:'wall-gate'}),o=env.observation(),legal=env.legalActions(),discards=legal.filter(a=>a.type==='discard'&&!a.reveal),bid=actionId(discards[0]),aid=actionId(discards.at(-1));
  const short=Array(88).fill(-10),long=[...short],positive=Array(88).fill(0);short[bid]=10;long[aid]=10;positive[aid]=1;
  const model=q=>({forward:()=>({q})}),models={short:model(short),long:model(long),average:model(positive),single:model(Array(88).fill(0))},f=factories(models,0);
  const avg=f.policies.average();assert.equal(actionId(avg(o,legal)),aid);assert.equal(actionId(avg(o,legal)),bid);assert.equal(actionId(f.policies.single()(o,legal)),bid);
  const encoded={public:true},e={hand:1,seed:'x',secret:'MUST-NOT-LEAK',root:{encoded,legalIds:[bid,aid],baselineId:bid,alternativeId:aid,secret:'private'},
    samples:[{baselineScore:1,alternativeScore:5},{baselineScore:-1,alternativeScore:-5}],replay:{secret:'wall'}};
  const a=projectEpisode(e,'average'),s=projectEpisode(e,'single');assert.equal(a.root.gain,0);assert.equal(s.root.gain,.25);
  assert.deepEqual(Object.keys(a).sort(),['hand','root','seed']);assert.deepEqual(Object.keys(a.root).sort(),['alternativeId','alternativeScore','baselineId','baselineScore','encoded','gain','legalIds']);assert.ok(!JSON.stringify(a).includes('private'));assert.throws(()=>projectEpisode(e,'exam-tuned'));
});

test('wall averaging completes paired data, both trainings, five-arm games and uncached full audit',async()=>{
  const old=await buildParent(),previous=resolve(dirname(old),'paired-parent');await paired({out:previous,previous:old,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:64});await verifyPaired({out:previous});
  const out=resolve(dirname(old),'wall-average'),options={out,previous,trainingHands:72,validationHands:36,epochs:2,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:64,wallSamples:2},s=await run(options),p=read(resolve(out,'plan.json'));
  check(p);assert.equal(Object.keys(p.sourceMap).length,83);assert.throws(()=>check({...p,primary:'new exam'}));assert.equal(s.games,90);assert.equal(s.productionPolicy,'H0');assert.equal(Object.keys(s.primary).length,4);assert.equal(jobsFor(p).length,3);
  const t=read(resolve(out,'training.json'));assert.deepEqual(Object.keys(t.trained),['average','single']);assert.equal(t.datasets.training.wallPairs,t.datasets.training.roots*2);assert.equal(t.datasets.training.extraBranches,t.datasets.training.roots*3);
  const {episodes}=load(resolve(out,'validation'),p,'validation');for(const e of episodes){replayEpisode(e.replay);for(const sample of e.samples){if(sample.baselineReplay)replayEpisode(sample.baselineReplay);replayEpisode(sample.alternativeReplay);}}
  const v=await verify({out});assert.equal(v.games,90);assert.equal(v.trainingSnapshotsRecomputed,6);assert.equal(v.data.reduce((n,d)=>n+d.hands,0),108);
  const models=read(resolve(out,'models.json')),loaded=Object.fromEntries(Object.entries(models).map(([key,m])=>[key,loadQ(m.path).model])),job=jobsFor(p)[0],g=read(resolve(out,'groups',job.id,'group.json'));
  for(const control of ['single','baseline','always','reference']){const canonical=await runEvaluation({candidate:'average',incumbent:control,seed:p.seeds.evaluation,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:1,
      opponentPairs:[job.pair],bootstrapSamples:30,policyFactories:factories(loaded,0).policies});assert.deepEqual(canonical.records[0].candidate,g.record.arms.average);assert.deepEqual(canonical.records[0].incumbent,g.record.arms[control]);}
  const part=t.datasets.training.parts[0],file=resolve(part,'episodes.jsonl.gz'),bytes=readFileSync(file),manifest=read(resolve(part,'manifest.json')),rows=gunzipSync(bytes).toString('utf8').trim().split('\n').map(JSON.parse),e=rows.find(x=>x.root);assert.ok(e);
  e.samples[1].alternativeScore+=4;e.samples[1].gain=(e.samples[1].alternativeScore-e.samples[1].baselineScore)/16;writeFileSync(file,gzipSync(rows.map(JSON.stringify).join('\n')+'\n'));save(resolve(part,'manifest.json'),{...manifest,sha256:hash(file)});
  await assert.rejects(auditPart({path:part,plan:p,split:'training'}));writeFileSync(file,bytes);save(resolve(part,'manifest.json'),manifest);
  await assert.rejects(run(options),/exists/);await assert.rejects(verify({out}),/exists/);
});
