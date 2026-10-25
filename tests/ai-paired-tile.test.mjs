import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {MahjongEnvironment} from '../ai/environment.mjs';
import {actionId,encodePublic,legalActionIds} from '../ai/tile-q/encoding.mjs';
import {loadQ} from '../ai/tile-q/model.mjs';
import {save} from '../ai/tile-q/collect.mjs';
import {worker} from '../ai/tile-q/study.mjs';
import {runEvaluation} from '../ai/runner.mjs';
import {proposal,factories,exactZeroHead} from '../ai/paired-tile/policy.mjs';
import {makePlan,check,read,hash,jobsFor} from '../ai/paired-tile/config.mjs';
import {playGroup} from '../ai/paired-tile/groups.mjs';
import {run,trainSpec,checkTraining} from '../ai/paired-tile/study.mjs';
import {verify,auditPart,auditGroup} from '../ai/paired-tile/verify.mjs';
import {buildParent} from './helpers/paired-tile-parent.mjs';

test('paired tile policy only changes its first eligible non-reveal discard and preserves ties',()=>{
  const env=new MahjongEnvironment({seed:'paired-policy-boundaries'}),o=env.observation(),legal=env.legalActions(),discards=legal.filter(a=>a.type==='discard'&&!a.reveal),baseId=actionId(discards[0]),altId=actionId(discards.at(-1));assert.notEqual(baseId,altId);
  const s=Array(88).fill(-10),l=[...s],v=Array(88).fill(0);s[baseId]=10;l[altId]=10;v[altId]=1;
  const model=q=>({forward:()=>({q})}),models={short:model(s),long:model(l),learned:model(v)};
  const f=factories(models,0),learned=f.policies.learned(),always=f.policies.always(),baseline=f.policies.baseline();
  assert.equal(actionId(learned(o,legal)),altId);assert.equal(actionId(learned(o,legal)),baseId);assert.equal(actionId(f.policies.learned()(o,legal)),altId);
  assert.equal(actionId(always(o,legal)),altId);assert.equal(actionId(always(o,legal)),baseId);assert.equal(actionId(baseline(o,legal)),baseId);
  models.learned=model(Array(88).fill(0));assert.equal(actionId(factories(models).policies.learned()(o,legal)),baseId);
  const special=[{type:'hu'},{type:'kong',tile:'p1',kind:'an'},{type:'discard',tile:'p1',reveal:false},{type:'discard',tile:'p2',reveal:true}];
  for(const id of [84,42,22]){const q=Array(88).fill(-20);q[id]=100;assert.equal(proposal(special,()=>q).eligible,false);}
});

test('paired tile collects fresh branches, learns signed returns, preserves initialization and reaudits all evidence',async()=>{
  const previous=await buildParent(),out=resolve(dirname(previous),'paired-tile'),p=makePlan({previous,trainingHands:144,validationHands:72,epochs:4,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:64});check(p);
  assert.equal(Object.keys(p.sourceMap).length,76);assert.throws(()=>check({...p,primary:'select by exam'}));
  const s=await run({out,previous,trainingHands:144,validationHands:72,epochs:4,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:64});
  assert.equal(s.trainingHands,144);assert.equal(s.validationHands,72);assert.equal(s.productionPolicy,'H0');assert.ok([0,72].includes(s.games));
  const actual=read(resolve(out,'plan.json')),v=await verify({out});assert.equal(v.data.reduce((n,x)=>n+x.hands,0),216);assert.equal(v.games,s.games);assert.ok(v.data.every(x=>x.allHandsAndBranchesRecomputed&&x.cacheDisabled));
  if(s.status==='zero-selected')assert.ok(exactZeroHead(loadQ(s.models.learned.path).model));
  const data=read(resolve(out,'training.json')),part=data.datasets.training.parts[0],file=resolve(part,'episodes.jsonl.gz'),original=readFileSync(file),m=read(resolve(part,'manifest.json')),
    episodes=gunzipSync(original).toString('utf8').split('\n').filter(Boolean).map(JSON.parse),sample=episodes.find(e=>e.root);
  if(sample){const was=sample.root.gain!==0;sample.root.gain+=.25;writeFileSync(file,gzipSync(episodes.map(JSON.stringify).join('\n')+'\n'));save(resolve(part,'manifest.json'),{...m,nonzeroGains:m.nonzeroGains+Number(sample.root.gain!==0)-Number(was),sha256:hash(file)});
    await assert.rejects(auditPart({path:part,plan:actual,split:'training'}));writeFileSync(file,original);save(resolve(part,'manifest.json'),m);}
  // Synthetic fixed public inputs below only test gradient direction and deterministic
  // training/export. They are not admitted to the actual collection/audit pipeline.
  const env=new MahjongEnvironment({seed:'signed-return-gradient'}),legal=env.legalActions(),encoded=encodePublic(env.observation(),legal),ids=legalActionIds(legal),q=loadQ(actual.models.short.path).model.forward(encoded,ids).q,
    ordered=[...ids].sort((a,b)=>q[a]-q[b]),baselineId=ordered[0],alternativeId=ordered.at(-1);assert.notEqual(baselineId,alternativeId);
  for(const gain of [1,-1]){
    const synthetic=resolve(dirname(out),'synthetic-'+gain);mkdirSync(synthetic,{recursive:true});
    for(const [split,hands]of [['training',24],['validation',12]]){const path=resolve(synthetic,split);mkdirSync(path);writeFileSync(resolve(path,'episodes.jsonl.gz'),gzipSync(Array.from({length:hands},(_,hand)=>JSON.stringify({hand,root:{encoded,legalIds:ids,baselineId,alternativeId,baselineScore:0,alternativeScore:gain*16,gain}})).join('\n')+'\n'));
      save(resolve(path,'manifest.json'),{schema:actual.schema,sourceMap:actual.sourceMap,split,hands,roots:hands,sha256:hash(resolve(path,'episodes.jsonl.gz'))});}
    const spec=resolve(synthetic,'train.json');save(spec,trainSpec(synthetic,actual));await worker(actual.python,[resolve('ai/paired-tile/train.py'),spec]);
    const fitted=checkTraining(synthetic,actual);assert.ok(fitted.training.selected.epoch>0);assert.ok(fitted.training.selected.validationLoss<fitted.training.history[0].validation.mse);
    const result=loadQ(fitted.model.path).model.forward(encoded,ids).q;assert.ok((result[alternativeId]-result[baselineId])*gain>0);
    save(resolve(synthetic,'audit.json'),{...trainSpec(synthetic,actual),verify:true});await worker(actual.python,[resolve('ai/paired-tile/train.py'),resolve(synthetic,'audit.json')]);
    if(gain===1){const modelMap={...actual.models,learned:fitted.model},job=jobsFor(actual)[0],path=resolve(dirname(out),'group-parity'),g=await playGroup({out:path,plan:actual,job,models:modelMap});
      assert.equal(g.games,24);assert.ok((await auditGroup({path,plan:actual,job,models:modelMap})).cacheDisabled);
      const loaded=Object.fromEntries(Object.entries(modelMap).map(([key,m])=>[key,loadQ(m.path).model]));
      for(const control of ['baseline','always','reference']){const canonical=await runEvaluation({candidate:'learned',incumbent:control,seed:actual.seeds.evaluation,split:'sealed',independentGroups:0,sessionGroups:1,sessionHands:1,
          opponentPairs:[job.pair],bootstrapSamples:30,policyFactories:factories(loaded,0).policies});
        assert.deepEqual(canonical.records[0].candidate,g.record.arms.learned);assert.deepEqual(canonical.records[0].incumbent,g.record.arms[control]);}
    }
  }
  await assert.rejects(run({out,previous}),/exists/);await assert.rejects(verify({out}),/exists/);
});
