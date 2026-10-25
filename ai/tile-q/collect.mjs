import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {MahjongEnvironment} from '../environment.mjs';
import {policyById} from '../policies/index.mjs';
import {deriveSeed,seededRandom} from '../random.mjs';
import {sha256} from '../provenance.mjs';
import {sources,assertSources} from './sources.mjs';
import {SCHEMA,encodePublic,actionId,legalActionIds,kongNet} from './encoding.mjs';
import {loadQ} from './model.mjs';
export const DATA_VERSION='kwx-tile-q-episodes-1';
export const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
export function rankTarget(delta,seat){
  const before=delta.filter(v=>v>delta[seat]).length,tied=delta.filter(v=>v===delta[seat]).length;
  return [0,1,2].map(i=>i>=before&&i<before+tied?1/tied:0);
}
export function rolesFor(hand,online,history=[]){
  if(!online)return Array.from({length:3},()=>({id:'mixture',learner:true}));
  if(hand%4===0)return Array.from({length:3},()=>({id:'current',learner:true}));
  const seat=hand%3,other=[0,1,2].filter(i=>i!==seat),mode=Math.floor(hand/4)%3;
  const ids=mode===1?['H0','greedy-speed-v1']:mode===2&&history.length?[`history-${Math.floor(hand/12)%history.length}`,'H0']:['H0','H0'];
  if(Math.floor(hand/4)%2)ids.reverse();
  return [0,1,2].map(i=>i===seat?{id:'current',learner:true}:{id:ids[other.indexOf(i)],learner:false});
}
export function selectBehavior(id,o,legal,rng,models,epsilon=.1){
  if(legal.length===1)return legal[0];
  if(id==='mixture'){
    const roll=rng(10000);if(roll<500)return legal[rng(legal.length)];
    return policyById(roll<1500?'greedy-speed-v1':'H0')(o,legal);
  }
  if(models[id])return models[id].select(o,legal,rng,id==='current'?epsilon:0);
  return policyById(id)(o,legal);
}
export async function collect({out,hands,seed,split='training',startHand=0,checkpoint=null,history=[],epsilon=.1,sessionHands=1,onProgress=()=>{}}){
  if(!['training','validation'].includes(split)||!Number.isInteger(hands)||hands<1||!Number.isInteger(startHand)||startHand<0||!seed)throw Error('Invalid collection configuration');
  if(split==='validation'&&checkpoint)throw Error('Validation behavior is fixed');
  if(!Number.isInteger(sessionHands)||sessionHands<1||startHand%sessionHands!==0)throw Error('Shard must start at a complete session boundary');
  out=resolve(out);if(existsSync(out))throw Error('Dataset exists');mkdirSync(out,{recursive:true});
  const sourceHashes=sources(),models={},modelHashes={};
  if(checkpoint){const l=loadQ(checkpoint);models.current=l.model;modelHashes.current={path:resolve(checkpoint),sha256:l.sha256};}
  for(let i=0;i<history.length;i++){const l=loadQ(history[i]);models[`history-${i}`]=l.model;modelHashes[`history-${i}`]={path:resolve(history[i]),sha256:l.sha256};}
  const path=resolve(out,'episodes.jsonl.gz');writeFileSync(path,gzipSync(''));
  let samples=0,actions=0,huOffered=0,huMissed=0,previous=null;
  for(let local=0;local<hands;local++){
    const hand=startHand+local,environmentSeed=deriveSeed(DATA_VERSION,split,seed,hand),roles=rolesFor(hand,!!checkpoint,history);
    const rngs=[0,1,2].map(i=>seededRandom(deriveSeed(environmentSeed,'behavior',i)));
    if(hand%sessionHands===0)previous=null;
    const before=previous?[...previous.totals]:[0,0,0];
    const env=new MahjongEnvironment({seed:environmentSeed,previous}),rows=[];let decisions=0;
    while(!env.done){
      if(decisions>=500)throw Error('Collection action limit');
      const seat=env.actor,o=env.observation(),legal=env.legalActions();
      const a=selectBehavior(roles[seat].id,o,legal,rngs[seat],models,epsilon);
      if(roles[seat].learner&&legal.length>1){
        const teacher=policyById('H0')(o,legal);
        rows.push({decision:decisions,seat,encoded:encodePublic(o,legal),legalIds:legalActionIds(legal),actionId:actionId(a),teacherId:actionId(teacher),pastKong:kongNet(o)});
        if(legal.some(a=>a.type==='hu')){huOffered++;huMissed+=Number(a.type!=='hu');}
      }
      env.step(a);decisions++;
    }
    const result=env.result();
    const totals=before.map((v,i)=>v+result.delta[i]);
    for(const row of rows){row.target=(result.delta[row.seat]-row.pastKong)/16;row.rank=rankTarget(totals,row.seat);}
    previous={dealer:result.next.dealer,seats:result.next.seats,totals,round:hand%sessionHands+2};
    appendFileSync(path,gzipSync(JSON.stringify({hand,environmentSeed,roles,rows,replay:env.replay()})+'\n'));
    samples+=rows.length;actions+=decisions;
    if((local+1)%100===0||local+1===hands){onProgress({hands:local+1,total:hands,startHand,split,samples});await new Promise(r=>setImmediate(r));}
  }
  assertSources(sourceHashes);
  const m={version:DATA_VERSION,schema:SCHEMA,split,seed,startHand,hands,sessionHands,samples,actions,huOffered,huMissed,epsilon,
    modelHashes,sources:sourceHashes,sha256:sha256(readFileSync(path)),target:'Undiscounted terminal net less already settled kong net, divided by 16; gamma=1'};
  save(resolve(out,'manifest.json'),m);return m;
}
export function loadData(out,split){
  const m=JSON.parse(readFileSync(resolve(out,'manifest.json'))),bytes=readFileSync(resolve(out,'episodes.jsonl.gz'));
  if(m.version!==DATA_VERSION||m.split!==split||JSON.stringify(m.schema)!==JSON.stringify(SCHEMA)||sha256(bytes)!==m.sha256)throw Error('Dataset version/split/hash mismatch');
  assertSources(m.sources);
  const episodes=gunzipSync(bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  if(episodes.length!==m.hands||episodes.reduce((s,e)=>s+e.rows.length,0)!==m.samples)throw Error('Dataset counts differ');
  return {manifest:m,episodes};
}
export function merge({out,parts,split}){
  const loaded=parts.map(p=>({path:p,...loadData(p,split)})).sort((a,b)=>a.manifest.startHand-b.manifest.startHand);
  if(!loaded.length)throw Error('No shards');
  const m={...loaded[0].manifest,startHand:0,hands:0,samples:0,actions:0,huOffered:0,huMissed:0},chunks=[];
  for(const d of loaded){
    if(d.manifest.startHand!==m.hands||d.manifest.sessionHands!==m.sessionHands||d.manifest.seed!==m.seed||JSON.stringify(d.manifest.modelHashes)!==JSON.stringify(m.modelHashes))throw Error('Shard gap/overlap/config mismatch');
    for(const k of ['hands','samples','actions','huOffered','huMissed'])m[k]+=d.manifest[k];
    chunks.push(readFileSync(resolve(d.path,'episodes.jsonl.gz')));
  }
  out=resolve(out);if(existsSync(out))throw Error('Merged dataset exists');mkdirSync(out,{recursive:true});
  const all=Buffer.concat(chunks);m.sha256=sha256(all);m.shards=parts.length;writeFileSync(resolve(out,'episodes.jsonl.gz'),all);save(resolve(out,'manifest.json'),m);return m;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const spec=JSON.parse(readFileSync(process.argv[2]));collect({...spec,onProgress:p=>console.log(JSON.stringify(p))})
    .then(m=>console.log(JSON.stringify({complete:true,hands:m.hands,samples:m.samples}))).catch(e=>{console.error(e);process.exitCode=1;});
}
