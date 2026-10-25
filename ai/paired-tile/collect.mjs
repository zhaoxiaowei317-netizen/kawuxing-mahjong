import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {MahjongEnvironment} from '../environment.mjs';
import {deriveSeed} from '../random.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {encodePublic,legalActionIds,actionId} from '../tile-q/encoding.mjs';
import {componentChoice,scorer} from '../decision-components/policy.mjs';
import {selector} from '../strong-pool/config.mjs';
import {save} from '../tile-q/collect.mjs';
import {proposal} from './policy.mjs';
import {VERSION,check,rolesFor,read,hash} from './config.mjs';
export const counts=()=>({hands:0,roots:0,nonzeroGains:0,extraBranches:0,actions:0});
export const add=(c,e)=>{c.hands++;c.actions+=e.replay.actions.length;c.roots+=Number(!!e.root);c.nonzeroGains+=Number(!!e.root&&e.root.gain!==0);c.extraBranches+=Number(!!e.alternativeReplay);};
export async function* generate({plan:p,split,startHand,hands,cacheCapacity=p.budget.cacheCapacity}){
  check(p);assert.ok(['training','validation'].includes(split));assert.equal(startHand%p.budget.sessionHands,0);assert.equal(hands%p.budget.sessionHands,0);
  const models=Object.fromEntries(['short','long'].map(k=>[k,loadQ(p.models[k].path).model]));let previous=null;
  for(let local=0;local<hands;local++){
    const hand=startHand+local,seed=deriveSeed(VERSION,split,p.seeds[split],hand),schedule=rolesFor(p,hand),scores=scorer(models,cacheCapacity);
    if(hand%p.budget.sessionHands===0)previous=null;const before=previous?[...previous.totals]:[0,0,0],env=new MahjongEnvironment({seed,previous});
    let root=null,world=null,decisions=0;
    const select=(e)=>{const legal=e.legalActions(),o=e.observation();if(e.actor!==schedule.target)return selector(schedule.policyIds[e.actor])(o,legal);
      if(legal.length===1)return legal[0];const v=scores.view(o,legal);return componentChoice({code:'sss',legal,getQ:v.getQ});};
    while(!env.done){
      assert.ok(decisions<500);const legal=env.legalActions(),o=env.observation();let action;
      if(env.actor===schedule.target&&!root&&legal.length>1){const d=proposal(legal,scores.view(o,legal).getQ);action=d.baseline;
        if(d.eligible){root={decision:decisions,encoded:encodePublic(o,legal),legalIds:legalActionIds(legal),baselineId:actionId(d.baseline),alternativeId:actionId(d.alternative)};world=env.auditState();}
      }else action=select(env);env.step(action);decisions++;
    }
    const result=env.result();let alternativeReplay=null;
    if(root){const alt=new MahjongEnvironment({initialState:world,seed:deriveSeed(seed,'alternative')}),first=alt.legalActions().find(a=>actionId(a)===root.alternativeId);assert.ok(first);alt.step(first);let n=1;
      while(!alt.done){assert.ok(n++<500);alt.step(select(alt));}
      root.baselineScore=result.delta[schedule.target];root.alternativeScore=alt.result().delta[schedule.target];root.gain=(root.alternativeScore-root.baselineScore)/16;alternativeReplay=alt.replay();
    }
    const totals=before.map((x,i)=>x+result.delta[i]);previous={dealer:result.next.dealer,seats:result.next.seats,totals,round:hand%p.budget.sessionHands+2};
    yield {hand,seed,schedule,root,replay:env.replay(),alternativeReplay};await new Promise(r=>setImmediate(r));
  }check(p);
}
export async function collect({out,plan:p,split,startHand,hands,onProgress=()=>{}}){
  out=resolve(out);if(existsSync(out))throw Error('Dataset exists');mkdirSync(out,{recursive:true});const path=resolve(out,'episodes.jsonl.gz');writeFileSync(path,gzipSync(''));const c=counts();
  for await(const e of generate({plan:p,split,startHand,hands})){appendFileSync(path,gzipSync(JSON.stringify(e)+'\n'));add(c,e);if(c.hands%100===0||c.hands===hands)onProgress({split,startHand,total:hands,...c});}
  const m={version:VERSION,schema:p.schema,split,startHand,seed:p.seeds[split],sessionHands:p.budget.sessionHands,sourceMap:p.sourceMap,...c,sha256:hash(path)};save(resolve(out,'manifest.json'),m);return m;
}
export function load(path,p,split){const m=read(resolve(path,'manifest.json'));assert.equal(m.version,VERSION);assert.equal(m.split,split);assert.equal(m.seed,p.seeds[split]);assert.deepEqual(m.sourceMap,p.sourceMap);assert.equal(m.sha256,hash(resolve(path,'episodes.jsonl.gz')));
  const episodes=gunzipSync(readFileSync(resolve(path,'episodes.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse),c=counts();episodes.forEach(e=>add(c,e));for(const k of Object.keys(c))assert.equal(c[k],m[k]);return {m,episodes};}
export function merge({out,parts,plan:p,split}){if(existsSync(out))throw Error('Merged data exists');mkdirSync(out,{recursive:true});const rows=parts.map(path=>({path,...load(path,p,split)})).sort((a,b)=>a.m.startHand-b.m.startHand),c=counts();
  for(const d of rows){assert.equal(d.m.startHand,c.hands);for(const k of Object.keys(c))c[k]+=d.m[k];}
  writeFileSync(resolve(out,'episodes.jsonl.gz'),Buffer.concat(rows.map(d=>readFileSync(resolve(d.path,'episodes.jsonl.gz')))));
  const m={...rows[0].m,...c,startHand:0,parts:rows.map(d=>resolve(d.path)),sha256:hash(resolve(out,'episodes.jsonl.gz'))};save(resolve(out,'manifest.json'),m);return m;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))collect({...read(process.argv[2]),onProgress:p=>console.log(JSON.stringify(p))}).then(()=>console.log(JSON.stringify({complete:true}))).catch(e=>{console.error(e);process.exitCode=1;});
