import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {MahjongEnvironment,actionKey} from '../ai/environment.mjs';
import {selectAction as h0} from '../ai/policies/h0.mjs';
import {decide,ARMS,VARIANTS} from '../ai/reveal-study/policies.mjs';
import {run,select,check} from '../ai/reveal-study/study.mjs';
import {verify} from '../ai/reveal-study/verify.mjs';
import {collect,save} from '../ai/tile-q/collect.mjs';
import {sources} from '../ai/tile-q/sources.mjs';
import {SCHEMA,actionId} from '../ai/tile-q/encoding.mjs';
import {worker} from '../ai/tile-q/study.mjs';

test('reveal interventions keep base type and discard tile, and Q uses the complete legal mask',()=>{
  let opportunities=0,changed=0,checked=0,differentTiles=0;
  for(let hand=0;hand<4;hand++){
    const env=new MahjongEnvironment({seed:`reveal-contract-${hand}`,record:false});
    while(!env.done){
      const o=env.observation(),legal=env.legalActions(),before=structuredClone(legal),base=h0(o,legal);
      const fake={select:()=>base,forward:(_input,ids)=>{
        assert.deepEqual(ids,[...new Set(legal.map(actionId))].sort((a,b)=>a-b));
        return {q:Array.from({length:88},(_,i)=>i>=21&&i<42?1:0)};
      }};
      for(const id of ARMS){
        const d=decide(id,fake,o,legal);assert.ok(legal.includes(d.action));assert.equal(d.action.type,base.type);
        if(base.type==='discard')assert.equal(d.action.tile,base.tile);
        if(id==='h0-never'&&d.opportunity)assert.equal(d.action.reveal,false);
        if(id==='h0-q-gate'&&d.opportunity)assert.equal(d.action.reveal,true);
        if(id==='q-reference'||id==='q-h0-gate')assert.equal(actionKey(d.action),actionKey(base));
        opportunities+=Number(d.opportunity);changed+=Number(d.changed);checked++;
      }
      const alternative=legal.find(a=>a.type==='discard'&&a.tile!==base.tile&&legal.some(b=>b.type==='discard'&&b.tile===a.tile&&b.reveal!==a.reveal));
      if(alternative){
        const d=decide('q-h0-gate',{...fake,select:()=>alternative},o,legal);
        assert.equal(d.action.tile,alternative.tile);
        assert.equal(actionKey(d.action),actionKey(h0(o,legal.filter(a=>a.type==='discard'&&a.tile===alternative.tile))));differentTiles++;
      }
      assert.deepEqual(legal,before);env.step(base);
    }
  }
  assert.ok(opportunities>0&&changed>0&&checked>100&&differentTiles>0);assert.throws(()=>decide('unknown',null,{},[]));
});
test('reveal selection excludes the reference and uses fixed intervention tie order',()=>{
  const rows=ARMS.map(arm=>({arm,delta:arm==='q-reference'?999:0}));assert.equal(select(rows),null);
  assert.equal(select(rows.map(r=>({...r,delta:r.arm==='q-reference'?999:1}))),VARIANTS[0]);
  assert.throws(()=>select(rows.slice(1)));
});
test('bounded intervention study saves all comparisons and audits actual decisions and gate cases',async()=>{
  mkdirSync('.tmp/reveal-study-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/reveal-study-tests/run-'));
  const training=resolve(root,'training'),validation=resolve(root,'validation');
  await collect({out:training,hands:8,seed:'reveal-fixture-training'});await collect({out:validation,hands:4,seed:'reveal-fixture-validation',split:'validation'});
  const spec=resolve(root,'train.json');save(spec,{out:resolve(root,'model'),schema:SCHEMA,sources:sources(),seed:'reveal-fixture-model',
    trainingData:training,validationData:validation,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true},
    config:{learningRate:.001,batchSize:32,maxGradNorm:5,cqlWeight:.05,bcWeight:.1,auxWeight:.1},mode:'q',epochs:1});
  await worker('python',[resolve('ai/tile-q/train.py'),spec]);const checkpoint=JSON.parse(readFileSync(resolve(root,'model/summary.json'),'utf8')).selected.path;
  const out=resolve(root,'study'),s=await run({out,checkpoint,developmentGroups:1,sealedGroups:1,sessionHands:1,bootstrapSamples:30});
  const p=JSON.parse(readFileSync(resolve(out,'plan.json'),'utf8'));check(p);assert.notEqual(p.seeds.development,p.seeds.sealed);
  assert.equal(s.trainingHands,0);assert.equal(s.games,s.selected?120:96);assert.equal(s.productionPolicy,'H0');
  const v=await verify({out});assert.equal(v.games,s.games);assert.equal(v.evaluation['development-h0-never'].diagnostics.chosenReveals,0);
  assert.equal(v.evaluation['development-q-reference'].diagnostics.changed,0);
  await assert.rejects(run({out,checkpoint}),/exists/);await assert.rejects(verify({out}),/exists/);
});
