// Import-only mirrors keep frozen historical modules untouched. Generated files
// must be exactly reproducible; semantic arithmetic is not rewritten here.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {sha256,projectRoot} from '../provenance.mjs';
const mirrors=[
  ['ai/environment.mjs','environment.mjs',{"'../src/engine.js'":"'./geometry.mjs'","'./random.mjs'":"'../random.mjs'"}],
  ['ai/policies/h0.mjs','h0.mjs',{"'../../src/engine.js'":"'./geometry.mjs'"}],
  ['ai/policies/index.mjs','policies.mjs',{"'../../src/engine.js'":"'./geometry.mjs'"}],
  ['ai/action-scorer/features.mjs','features.mjs',{"'../../src/engine.js'":"'./geometry.mjs'"}],
  ['ai/tile-q/encoding.mjs','encoding.mjs',{"'../../src/engine.js'":"'./geometry.mjs'","'../action-scorer/features.mjs'":"'./features.mjs'"}],
  ['ai/decision-components/policy.mjs','components.mjs',{"'../tile-q/encoding.mjs'":"'./encoding.mjs'"}],
  ['ai/wall-average/collect.mjs','collect.mjs',{"'../environment.mjs'":"'./environment.mjs'","'../tile-q/encoding.mjs'":"'./encoding.mjs'","'../decision-components/policy.mjs'":"'./components.mjs'","'../strong-pool/config.mjs'":"'./selector.mjs'","'./policy.mjs'":"'../wall-average/policy.mjs'","'./worlds.mjs'":"'../wall-average/worlds.mjs'","'./config.mjs'":"'../wall-average/config.mjs'"}],
];
export function build({verify=false}={}){
  const rows=[];for(const [reference,name,replacements]of mirrors){let source=readFileSync(resolve(projectRoot,reference),'utf8');const referenceSha256=sha256(source);
    for(const [from,to]of Object.entries(replacements)){assert.ok(source.includes(from),`Missing import ${from} in ${reference}`);source=source.replaceAll(from,to);}
    const bytes=`// GENERATED import-only mirror of ${reference}; see build.mjs.\n`+source,path=fileURLToPath(new URL(name,import.meta.url));
    if(verify)assert.equal(readFileSync(path,'utf8'),bytes);else writeFileSync(path,bytes);rows.push({reference,referenceSha256,path:'ai/simulator-fast/'+name,sha256:sha256(bytes)});
  }
  const manifest={purpose:'Optional geometry memoization backend; not used in frozen experiments. Import-only mirrors preserve rules and algorithms.',mirrors:rows};
  const path=fileURLToPath(new URL('manifest.json',import.meta.url));if(verify)assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),manifest);else writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(build({verify:process.argv.includes('--verify')})));
