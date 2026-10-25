import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {loadQ} from '../tile-q/model.mjs';
import {load,projectEpisode} from '../wall-average/collect.mjs';
import {save} from '../tile-q/collect.mjs';
import {SCHEMA,extractFeatures} from './features.mjs';
import {VERSION,check,read,hash} from './config.mjs';
export function deriveRows(p,split){
  check(p);assert.ok(['training','validation'].includes(split));const parent=read(resolve(p.previous.path,'plan.json')),raw=resolve(p.previous.path,split),{m,episodes}=load(raw,parent,split),
    teachers=Object.fromEntries(['short','long'].map(k=>[k,loadQ(p.models[k].path).model])),rows=[];
  // Bind the consumed merged file to the parent's pinned audited snapshot,
  // not merely to a mutable adjacent manifest and its self-reported checksum.
  assert.deepEqual(m,read(resolve(p.previous.path,'training.json')).datasets[split]);
  for(const e of episodes)if(e.root){const r=projectEpisode(e,'average').root;rows.push({hand:e.hand,features:extractFeatures(r,teachers),gain:r.gain});}
  assert.equal(rows.length,m.roots);assert.ok(rows.length);const bytes=gzipSync(rows.map(JSON.stringify).join('\n')+'\n');
  return {bytes,manifest:{version:VERSION,schema:SCHEMA,sources:p.sourceMap,split,hands:m.hands,roots:rows.length,parentRawSha256:m.sha256,parentPlanSha256:p.previous.files['plan.json'],
    teacherHashes:Object.fromEntries(['short','long'].map(k=>[k,p.models[k].sha256]))}};
}
export function prepare({out,plan:p,split}){assert.ok(!existsSync(out));mkdirSync(out,{recursive:true});const {bytes,manifest}=deriveRows(p,split);writeFileSync(resolve(out,'rows.jsonl.gz'),bytes);
  const m={...manifest,sha256:hash(resolve(out,'rows.jsonl.gz'))};save(resolve(out,'manifest.json'),m);return m;}
export function verifyPrepared({out,plan:p,split}){const {bytes,manifest}=deriveRows(p,split);assert.deepEqual(readFileSync(resolve(out,'rows.jsonl.gz')),bytes);const m={...manifest,sha256:hash(resolve(out,'rows.jsonl.gz'))};assert.deepEqual(read(resolve(out,'manifest.json')),m);return m;}
