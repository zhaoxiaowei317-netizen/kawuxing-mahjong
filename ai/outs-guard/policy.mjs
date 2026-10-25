import assert from 'node:assert/strict';
import {encodePublic,legalActionIds,actionId,decodeAction} from '../tile-q/encoding.mjs';
import {FEATURE_NAMES} from '../action-scorer/features.mjs';
import {selector,N} from '../strong-pool/config.mjs';

export const GUARDED='q-outs-guard',RAW='q-reference';
export const ARMS=Object.freeze(['guarded','raw','reference']);
const DISTANCE=FEATURE_NAMES.indexOf('negativeDistance'),OUTS=FEATURE_NAMES.indexOf('outs');
assert.ok(DISTANCE>=0&&OUTS>=0);
export function guardChoice({q,legal,encoded}){
  const ids=legalActionIds(legal);assert.ok(ids.length);assert.ok(ids.every(id=>Number.isFinite(q[id])));
  let best=ids[0];for(const id of ids)if(q[id]>q[best])best=id;
  const base=decodeAction(best,legal);
  if(base.type!=='discard')return {action:base,base,changed:false,eligible:false};
  const features=new Map(encoded.candidates.map(c=>[c.id,c.values]));
  const shape=id=>{const v=features.get(id);assert.ok(v&&Number.isFinite(v[DISTANCE])&&Number.isFinite(v[OUTS]));
    return {distance:Math.round(-6*v[DISTANCE]),outs:Math.round(12*v[OUTS])};};
  const before=shape(best),eligible=legal.filter(a=>a.type==='discard'&&a.reveal===base.reveal&&shape(actionId(a)).distance===before.distance);
  assert.ok(eligible.length);const maximum=Math.max(...eligible.map(a=>shape(actionId(a)).outs));
  const frontier=eligible.map(actionId).filter(id=>shape(id).outs===maximum).sort((a,b)=>a-b);
  let chosen=frontier[0];for(const id of frontier)if(q[id]>q[chosen])chosen=id;
  const action=decodeAction(chosen,legal),after=shape(chosen);
  assert.equal(action.type,base.type);assert.equal(action.reveal,base.reveal);assert.equal(after.distance,before.distance);assert.ok(after.outs>=before.outs);
  return {action,base,changed:chosen!==best,eligible:maximum>before.outs,before,after};
}
export function decide(model,o,legal){
  if(legal.length===1)return {action:legal[0],base:legal[0],changed:false,eligible:false};
  const encoded=encodePublic(o,legal),ids=legalActionIds(legal),{q}=model.forward(encoded,ids);
  return guardChoice({q,legal,encoded});
}
export const emptyIntervention=()=>({choices:0,baseDiscards:0,eligible:0,changed:0,outsGain:0});
export function factories(model,counters=emptyIntervention()){
  return {[N]:()=>selector(N),[RAW]:()=>(o,legal)=>model.select(o,legal),[GUARDED]:()=>(o,legal)=>{
    const d=decide(model,o,legal);if(legal.length>1)counters.choices++;
    if(d.before)counters.baseDiscards++;if(d.eligible)counters.eligible++;
    if(d.changed){counters.changed++;counters.outsGain+=d.after.outs-d.before.outs;}return d.action;
  }};
}
