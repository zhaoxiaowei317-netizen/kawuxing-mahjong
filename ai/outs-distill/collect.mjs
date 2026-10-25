import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {MahjongEnvironment} from '../environment.mjs';
import {deriveSeed,seededRandom} from '../random.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {encodePublic,legalActionIds,actionId,kongNet} from '../tile-q/encoding.mjs';
import {DATA_VERSION,rankTarget,save} from '../tile-q/collect.mjs';
import {guardChoice} from '../outs-guard/policy.mjs';
import {selector} from '../strong-pool/config.mjs';
import {VERSION,STUDENTS,check,rolesFor,read,hash} from './config.mjs';

export function labeledDecision(model,o,legal,rng,epsilon){
  if(legal.length===1)return {action:legal[0]};
  const encoded=encodePublic(o,legal),ids=legalActionIds(legal),{q}=model.forward(encoded,ids),guard=guardChoice({q,legal,encoded});
  const action=rng(0x100000000)/0x100000000<epsilon?legal[rng(legal.length)]:guard.base;
  return {action,encoded,legalIds:ids,teachers:{self:actionId(guard.base),corrected:actionId(guard.action)},changed:guard.changed};
}
export async function* generate({plan:p,split,startHand,hands}){
  check(p);assert.ok(['training','validation'].includes(split));assert.ok(Number.isSafeInteger(startHand)&&startHand>=0);
  assert.ok(Number.isSafeInteger(hands)&&hands>0);assert.equal(startHand%p.budget.sessionHands,0);assert.equal(hands%p.budget.sessionHands,0);
  const model=loadQ(p.model.path).model;let previous=null;
  for(let local=0;local<hands;local++){
    const hand=startHand+local,environmentSeed=deriveSeed(VERSION,split,p.seeds[split],hand),schedule=rolesFor(p,hand);
    if(hand%p.budget.sessionHands===0)previous=null;
    const before=previous?[...previous.totals]:[0,0,0],env=new MahjongEnvironment({seed:environmentSeed,previous}),rows=[];
    const rng=seededRandom(deriveSeed(environmentSeed,'behavior',schedule.target));let decisions=0;
    while(!env.done){
      assert.ok(decisions<500,'Collection action limit');const seat=env.actor,o=env.observation(),legal=env.legalActions();let action;
      if(seat===schedule.target){const d=labeledDecision(model,o,legal,rng,p.epsilon);action=d.action;
        if(legal.length>1)rows.push({decision:decisions,seat,encoded:d.encoded,legalIds:d.legalIds,actionId:actionId(action),teachers:d.teachers,pastKong:kongNet(o),changed:d.changed});
      }else action=selector(schedule.policyIds[seat])(o,legal);
      env.step(action);decisions++;
    }
    const r=env.result(),totals=before.map((v,i)=>v+r.delta[i]);for(const row of rows){row.target=(r.delta[row.seat]-row.pastKong)/16;row.rank=rankTarget(totals,row.seat);}
    previous={dealer:r.next.dealer,seats:r.next.seats,totals,round:hand%p.budget.sessionHands+2};
    yield {hand,environmentSeed,schedule,rows,replay:env.replay()};await new Promise(r=>setImmediate(r));
  }check(p);
}
export function studentEpisode(e,arm){assert.ok(STUDENTS.includes(arm));return {...e,rows:e.rows.map(({teachers,changed,...row})=>({...row,teacherId:teachers[arm]}))};}
export const emptyCounts=()=>({hands:0,samples:0,actions:0,correctedLabels:0});
export function count(c,e){c.hands++;c.samples+=e.rows.length;c.actions+=e.replay.actions.length;c.correctedLabels+=e.rows.filter(r=>r.changed).length;}
export async function collect({out,plan:p,split,startHand,hands,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(out))throw Error('Dataset exists');check(p);mkdirSync(out,{recursive:true});
  for(const arm of ['canonical',...STUDENTS]){mkdirSync(resolve(out,arm));writeFileSync(resolve(out,arm,'episodes.jsonl.gz'),gzipSync(''));}
  const counts=emptyCounts();for await(const e of generate({plan:p,split,startHand,hands})){
    for(const arm of ['canonical',...STUDENTS])appendFileSync(resolve(out,arm,'episodes.jsonl.gz'),gzipSync(JSON.stringify(arm==='canonical'?e:studentEpisode(e,arm))+'\n'));
    count(counts,e);if(counts.hands%100===0||counts.hands===hands)onProgress({split,startHand,total:hands,...counts});
  }
  const common={version:DATA_VERSION,behaviorVersion:VERSION,schema:p.schema,split,seed:p.seeds[split],startHand,sessionHands:p.budget.sessionHands,epsilon:p.epsilon,
    sources:p.coreSources,driverSources:p.sources,modelHashes:{raw:p.model},...counts};
  for(const arm of ['canonical',...STUDENTS])save(resolve(out,arm,'manifest.json'),{...common,label:arm,sha256:hash(resolve(out,arm,'episodes.jsonl.gz'))});
  check(p);return common;
}
export function merge({out,parts,plan:p,split}){
  out=resolve(out);if(existsSync(out))throw Error('Merged dataset exists');mkdirSync(out,{recursive:true});const result={};
  for(const arm of ['canonical',...STUDENTS]){
    const loaded=parts.map(path=>({path:resolve(path,arm),m:read(resolve(path,arm,'manifest.json'))})).sort((a,b)=>a.m.startHand-b.m.startHand);
    assert.ok(loaded.length);const first=loaded[0].m,c=emptyCounts(),chunks=[];
    for(const {path,m}of loaded){assert.equal(m.startHand,c.hands);assert.equal(m.label,arm);assert.equal(m.seed,p.seeds[split]);assert.equal(m.split,split);
      assert.deepEqual(m.driverSources,p.sources);assert.equal(m.sha256,hash(resolve(path,'episodes.jsonl.gz')));
      for(const k of Object.keys(c))c[k]+=m[k];chunks.push(readFileSync(resolve(path,'episodes.jsonl.gz')));}
    const path=resolve(out,arm);mkdirSync(path);writeFileSync(resolve(path,'episodes.jsonl.gz'),Buffer.concat(chunks));
    result[arm]={...first,...c,startHand:0,parts:loaded.map(d=>d.path),sha256:hash(resolve(path,'episodes.jsonl.gz'))};save(resolve(path,'manifest.json'),result[arm]);
  }check(p);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))collect({...read(process.argv[2]),onProgress:p=>console.log(JSON.stringify(p))})
  .then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
