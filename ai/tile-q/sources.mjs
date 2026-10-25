import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sourceHashes,sha256,projectRoot} from '../provenance.mjs';
export const VERSION='kwx-tile-q-study-1';
export function sources(){
  return {...sourceHashes(),'ai/action-scorer/features.mjs':sha256(readFileSync(resolve(projectRoot,'ai/action-scorer/features.mjs'))),...Object.fromEntries(['encoding.mjs','sources.mjs','model.mjs','collect.mjs','evaluate.mjs',
    'study.mjs','verify.mjs','network.py','train.py'].map(p=>[`ai/tile-q/${p}`,sha256(readFileSync(resolve(projectRoot,'ai/tile-q',p)))]))};
}
export function assertSources(expected){if(JSON.stringify(sources())!==JSON.stringify(expected))throw Error('Tile-Q sources changed');}
