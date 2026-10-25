import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {pipeline} from 'node:stream/promises';
import {DATA_VERSION} from '../tile-q/collect.mjs';
import {SCHEMA} from '../tile-q/encoding.mjs';
import {assertSources} from '../tile-q/sources.mjs';
import {VERSION,read,hash,sources} from './config.mjs';

export function metadata(path,split){
  const m=read(resolve(path,'manifest.json'));assert.equal(m.version,DATA_VERSION);assert.equal(m.behaviorVersion,VERSION);
  assert.equal(m.split,split);assert.deepEqual(m.schema,SCHEMA);assert.equal(m.sha256,hash(resolve(path,'episodes.jsonl.gz')));
  assertSources(m.sources);assert.deepEqual(m.driverSources,sources().drivers);return m;
}
// Do not materialize the complete decompressed file or episode list. One line is
// one hand, so total dataset size no longer encounters V8's string-size limit.
export async function* episodes(path){
  const compressed=createReadStream(resolve(path,'episodes.jsonl.gz')),uncompressed=createGunzip(),lines=createInterface({input:uncompressed,crlfDelay:Infinity});
  let failure=null;const pumping=pipeline(compressed,uncompressed).catch(error=>{failure=error;lines.close();});
  try{
    for await(const line of lines)if(line.trim())yield JSON.parse(line);
    await pumping;if(failure)throw failure;
  }finally{lines.close();compressed.destroy();uncompressed.destroy();await pumping;}
}
