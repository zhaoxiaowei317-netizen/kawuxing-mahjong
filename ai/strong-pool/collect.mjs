import assert from 'node:assert/strict';
import {writeFileSync,appendFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {MahjongEnvironment} from '../environment.mjs';
import {deriveSeed,seededRandom} from '../random.mjs';
import {DATA_VERSION,save,rankTarget,loadData} from '../tile-q/collect.mjs';
import {SCHEMA,encodePublic,legalActionIds,actionId,kongNet} from '../tile-q/encoding.mjs';
import {VERSION,rolesFor,selector,sources,hash,read} from './config.mjs';

export function behavior(role,o,legal,rng,epsilon){
  const teacher=selector(role.id)(o,legal);
  const action=legal.length>1&&rng(0x100000000)/0x100000000<epsilon?legal[rng(legal.length)]:teacher;
  return {action,teacher};
}
export async function collect({out,hands,seed,split='training',startHand=0,sessionHands=16,epsilon=.05,onProgress=()=>{}}){
  assert.ok(['training','validation'].includes(split)&&seed);
  for(const n of [hands,sessionHands])assert.ok(Number.isSafeInteger(n)&&n>0);
  assert.ok(Number.isSafeInteger(startHand)&&startHand>=0&&startHand%sessionHands===0&&hands%sessionHands===0);
  assert.ok(Number.isFinite(epsilon)&&epsilon>=0&&epsilon<=1);
  out=resolve(out);if(existsSync(out))throw Error('Dataset exists');mkdirSync(out,{recursive:true});
  const frozen=sources(),file=resolve(out,'episodes.jsonl.gz');writeFileSync(file,gzipSync(''));
  let samples=0,actions=0,huOffered=0,huMissed=0,previous=null;const teachers={};
  for(let local=0;local<hands;local++){
    const hand=startHand+local,environmentSeed=deriveSeed(VERSION,split,seed,hand),roles=rolesFor(hand,sessionHands);
    if(hand%sessionHands===0)previous=null;
    const before=previous?[...previous.totals]:[0,0,0],env=new MahjongEnvironment({seed:environmentSeed,previous}),rows=[];
    const rngs=[0,1,2].map(i=>seededRandom(deriveSeed(environmentSeed,'behavior',i)));let decisions=0;
    while(!env.done){
      if(decisions>=500)throw Error('Collection action limit');
      const seat=env.actor,o=env.observation(),legal=env.legalActions(),{action,teacher}=behavior(roles[seat],o,legal,rngs[seat],epsilon);
      if(legal.length>1){
        rows.push({decision:decisions,seat,encoded:encodePublic(o,legal),legalIds:legalActionIds(legal),
          actionId:actionId(action),teacherId:actionId(teacher),pastKong:kongNet(o)});
        teachers[roles[seat].id]=(teachers[roles[seat].id]||0)+1;
        if(legal.some(a=>a.type==='hu')){huOffered++;huMissed+=Number(action.type!=='hu');}
      }
      env.step(action);decisions++;
    }
    const r=env.result(),totals=before.map((v,i)=>v+r.delta[i]);
    for(const row of rows){row.target=(r.delta[row.seat]-row.pastKong)/16;row.rank=rankTarget(totals,row.seat);}
    previous={dealer:r.next.dealer,seats:r.next.seats,totals,round:hand%sessionHands+2};
    appendFileSync(file,gzipSync(JSON.stringify({hand,environmentSeed,roles,rows,replay:env.replay()})+'\n'));
    samples+=rows.length;actions+=decisions;
    if((local+1)%100===0||local+1===hands){onProgress({hands:local+1,total:hands,split,startHand,samples});await new Promise(r=>setImmediate(r));}
  }
  assert.deepEqual(frozen,sources());
  const m={version:DATA_VERSION,behaviorVersion:VERSION,schema:SCHEMA,split,seed,startHand,hands,sessionHands,epsilon,
    samples,actions,huOffered,huMissed,teachers,modelHashes:{},sources:frozen.core,driverSources:frozen.drivers,sha256:hash(file),
    target:'Undiscounted terminal net less settled kong net /16; labels are each acting seat\'s fixed teacher, no policy IDs in network input'};
  save(resolve(out,'manifest.json'),m);return m;
}
export function load(path,split){
  const d=loadData(path,split);assert.equal(d.manifest.behaviorVersion,VERSION);assert.deepEqual(d.manifest.driverSources,sources().drivers);return d;
}
export function merge({out,parts,split}){
  const loaded=parts.map(path=>({path,...load(path,split)})).sort((a,b)=>a.manifest.startHand-b.manifest.startHand);
  assert.ok(loaded.length);const first=loaded[0].manifest,m={...first,startHand:0,hands:0,samples:0,actions:0,huOffered:0,huMissed:0,teachers:{},shards:loaded.length},chunks=[];
  for(const d of loaded){
    assert.equal(d.manifest.startHand,m.hands);
    for(const key of ['seed','sessionHands','epsilon','behaviorVersion'])assert.equal(d.manifest[key],first[key]);
    for(const key of ['hands','samples','actions','huOffered','huMissed'])m[key]+=d.manifest[key];
    for(const [id,n]of Object.entries(d.manifest.teachers))m.teachers[id]=(m.teachers[id]||0)+n;
    chunks.push(readFileSync(resolve(d.path,'episodes.jsonl.gz')));
  }
  out=resolve(out);if(existsSync(out))throw Error('Merged dataset exists');mkdirSync(out,{recursive:true});
  writeFileSync(resolve(out,'episodes.jsonl.gz'),Buffer.concat(chunks));m.sha256=hash(resolve(out,'episodes.jsonl.gz'));save(resolve(out,'manifest.json'),m);return m;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))collect({...read(process.argv[2]),onProgress:p=>console.log(JSON.stringify(p))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
