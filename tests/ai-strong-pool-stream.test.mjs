import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {save} from '../ai/tile-q/collect.mjs';
import {read} from '../ai/strong-pool/config.mjs';
import {run} from '../ai/strong-pool/study.mjs';
import {verify as original,verifyData as originalData} from '../ai/strong-pool/verify.mjs';
import {verify,verifyData} from '../ai/strong-pool/verify-stream.mjs';
import {episodes} from '../ai/strong-pool/stream-data.mjs';

test('streamed gzip JSONL handles member/chunk boundaries and rejects corrupt compression or JSON',async()=>{
  mkdirSync('.tmp/strong-pool-stream-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/strong-pool-stream-tests/stream-'));
  const expected=Array.from({length:40},(_,i)=>({i,text:'卡五星'.repeat(16000)}));
  const file=resolve(root,'episodes.jsonl.gz');writeFileSync(file,Buffer.concat(expected.map((e,i)=>gzipSync(JSON.stringify(e)+(i<expected.length-1?'\n':'')))));
  const actual=[];for await(const e of episodes(root))actual.push(e);assert.deepEqual(actual,expected);
  writeFileSync(file,gzipSync('{not-json}\n'));await assert.rejects(async()=>{for await(const e of episodes(root)){}},SyntaxError);
  const valid=gzipSync(JSON.stringify({ok:true})+'\n');writeFileSync(file,valid.subarray(0,valid.length-6));
  await assert.rejects(async()=>{for await(const e of episodes(root)){}},/end|unexpected|buffer/i);
});
test('streaming full audit matches frozen original audit and rejects altered dataset counts',async()=>{
  const root=mkdtempSync(resolve('.tmp/strong-pool-stream-tests/integration-')),out=resolve(root,'study');
  await run({out,trainingHands:24,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});
  assert.deepEqual(await verifyData({path:resolve(out,'training'),split:'training'}),await originalData({path:resolve(out,'training'),split:'training'}));
  const a=await verify({out});assert.equal(a.auditExtension.version,'kwx-strong-pool-stream-audit-1');
  renameSync(resolve(out,'verification.json'),resolve(out,'verification-stream.json'));
  const b=await original({out});for(const key of ['data','parity','groups','games','snapshotsVerified','sources','planSha256'])assert.deepEqual(a[key],b[key]);
  const meta=resolve(out,'training/manifest.json'),m=read(meta);save(meta,{...m,hands:m.hands+1});
  await assert.rejects(verifyData({path:resolve(out,'training'),split:'training'}));save(meta,m);
  await assert.rejects(verify({out}),/exists/);
});
