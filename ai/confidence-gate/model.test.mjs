import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {SCHEMA,extractFeatures} from './features.mjs';
import {GainGate,loadGate,MODEL_VERSION} from './model.mjs';
import {MahjongEnvironment} from '../environment.mjs';
import {encodePublic,legalActionIds} from '../tile-q/encoding.mjs';
import {seededRandom} from '../random.mjs';
import {sha256} from '../provenance.mjs';
import {worker} from '../tile-q/study.mjs';

test('confidence gate accepts only public feature vectors and full-mask teacher scores',()=>{
  const env=new MahjongEnvironment({seed:'teacher-confidence-test'}),legal=env.legalActions(),ids=legalActionIds(legal),encoded=encodePublic(env.observation(),legal),pair=ids.filter(id=>id<21),baselineId=pair[0],alternativeId=pair.at(-1),root={encoded,legalIds:ids,baselineId,alternativeId,privateWorld:'ignored'};
  let calls=0;const teacher=multiplier=>({forward(input,mask){assert.equal(input,encoded);assert.equal(mask,ids);calls++;return {q:Array.from({length:88},(_,i)=>i*multiplier)};}}),models={short:teacher(-.5),long:teacher(.25)},features=extractFeatures(root,models);
  assert.equal(calls,2);assert.equal(features.length,SCHEMA.names.length);assert.equal(new Set(SCHEMA.names).size,SCHEMA.names.length);assert.equal(features[SCHEMA.names.indexOf('short.scoreMargin')],(alternativeId-baselineId)*-.5);
  assert.deepEqual(extractFeatures({...root,privateWorld:'different',gain:1000},models),features);
  const data={version:MODEL_VERSION,schema:SCHEMA,mean:features.map(()=>0),scale:features.map(()=>1),weights:features.map(()=>0),intercept:0};
  assert.equal(new GainGate(data).predict(features),0);assert.equal(new GainGate(data).constantChoice(),'baseline');assert.equal(new GainGate({...data,intercept:.1}).constantChoice(),'alternative');
  assert.throws(()=>new GainGate({...data,scale:features.map(()=>0)}));assert.throws(()=>extractFeatures({...root,alternativeId:baselineId},models));
});

test('fixed ridge training fits a known signal, exports parity, exactly reruns and rejects changed data',async()=>{
  mkdirSync('.tmp/confidence-gate-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/confidence-gate-tests/run-')),sources=Object.fromEntries(['features.mjs','model.mjs','train.py'].map(name=>['ai/confidence-gate/'+name,sha256(readFileSync(new URL(name,import.meta.url)))]));
  for(const [split,n]of [['training',128],['validation',64]]){const rng=seededRandom('ridge-'+split),rows=Array.from({length:n},()=>{const features=SCHEMA.names.map((_,i)=>i>10?0:(rng(2001)-1000)/1000);return {features,gain:.2*features[0]-.15*features[7]+.06};}),path=resolve(root,split);mkdirSync(path);const bytes=gzipSync(rows.map(JSON.stringify).join('\n')+'\n');writeFileSync(resolve(path,'rows.jsonl.gz'),bytes);
    writeFileSync(resolve(path,'manifest.json'),JSON.stringify({split,schema:SCHEMA,sources,roots:n,sha256:sha256(bytes)}));}
  const spec={out:resolve(root,'model'),schema:SCHEMA,sources,trainingData:resolve(root,'training'),validationData:resolve(root,'validation'),lambdas:[.001,.01,.1,1,10,100],tieTolerance:1e-12},path=resolve(root,'train.json');writeFileSync(path,JSON.stringify(spec));
  await worker('python',[resolve('ai/confidence-gate/train.py'),path]);const summary=JSON.parse(readFileSync(resolve(root,'model/summary.json'),'utf8'));assert.ok(summary.selected.name.startsWith('ridge-'));assert.equal(summary.closedFormFits,6);assert.equal(summary.gradientUpdates,0);
  const gate=loadGate(summary.selected.path).model,parity=JSON.parse(readFileSync(resolve(root,'model/parity.json'),'utf8'));assert.equal(gate.constantChoice(),null);for(const f of parity.fixtures)assert.ok(Math.abs(gate.predict(f.features)-f.prediction)<1e-10);
  assert.ok(summary.selected.validationMse<summary.history[0].validation.mse*.001);writeFileSync(resolve(root,'audit.json'),JSON.stringify({...spec,verify:true}));await worker('python',[resolve('ai/confidence-gate/train.py'),resolve(root,'audit.json')]);
  const data=resolve(root,'validation/rows.jsonl.gz'),bytes=readFileSync(data);writeFileSync(data,Buffer.concat([bytes,Buffer.from('tampered')]));await assert.rejects(worker('python',[resolve('ai/confidence-gate/train.py'),resolve(root,'audit.json')]));writeFileSync(data,bytes);
});
