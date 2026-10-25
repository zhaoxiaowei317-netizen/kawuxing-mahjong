import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectData} from './data.mjs';

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [out,hands,seed,split,startHand='0']=process.argv.slice(2);
  collectData({out,hands:Number(hands),seed,split,startHand:Number(startHand),
    onProgress:p=>console.log(JSON.stringify(p))}).then(m=>console.log(JSON.stringify({complete:true,...m})))
    .catch(e=>{console.error(e);process.exitCode=1;});
}
