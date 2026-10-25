import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {runEvaluation} from '../runner.mjs';
import {replayEpisode} from '../environment.mjs';
import {sha256} from '../provenance.mjs';
import {loadQ,qFactory} from './model.mjs';
import {sources,assertSources} from './sources.mjs';
import {save} from './collect.mjs';
export async function evaluate({out,candidate,checkpoint,seed,split='development',independentGroups=4,sessionGroups=2,sessionHands=16,bootstrapSamples=5000,onProgress}){
  const loaded=loadQ(checkpoint),sourceHashes=sources();
  out=resolve(out);if(existsSync(out))throw Error('Evaluation exists');mkdirSync(out,{recursive:true});
  const path=resolve(out,'replays.jsonl.gz');writeFileSync(path,gzipSync(''));let games=0;
  const r=await runEvaluation({candidate,incumbent:'H0',seed,split,independentGroups,sessionGroups,sessionHands,bootstrapSamples,
    policyFactories:{[candidate]:qFactory(loaded.model)},validate:true,onProgress,onEpisode:e=>{
      replayEpisode(e.replay);appendFileSync(path,gzipSync(JSON.stringify(e)+'\n'));games++;
    }});
  assertSources(sourceHashes);if(loadQ(checkpoint).sha256!==loaded.sha256)throw Error('Model changed during evaluation');
  Object.assign(r,{checkpoint:resolve(checkpoint),checkpointSha256:loaded.sha256,sources:sourceHashes,
    artifacts:{replays:{games,replayed:games,sha256:sha256(readFileSync(path))}}});
  save(resolve(out,'report.json'),r);return r;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const spec=JSON.parse(readFileSync(process.argv[2]));evaluate({...spec,onProgress:p=>console.log(JSON.stringify(p))})
    .then(r=>console.log(JSON.stringify({complete:true,games:r.totalGames}))).catch(e=>{console.error(e);process.exitCode=1;});
}
