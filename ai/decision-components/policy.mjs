import assert from 'node:assert/strict';
import {encodePublic,legalActionIds,actionId,decodeAction} from '../tile-q/encoding.mjs';

// Order: other-action controller / reveal flag / discard tile.
export const MIX=Object.freeze({short:'sss',long:'lll',tile:'ssl',reveal:'sls',other:'lss'});
export const ARMS=Object.freeze(Object.keys(MIX)),COMPONENTS=Object.freeze(['tile','reveal','other']);
export function best(ids,q){
  assert.ok(ids.length);assert.ok(ids.every(id=>Number.isFinite(q[id])));
  let id=ids[0];for(const next of ids)if(q[next]>q[id])id=next;return id;
}
export function componentChoice({code,legal,getQ}){
  assert.match(code,/^[sl]{3}$/);const ids=legalActionIds(legal);assert.ok(ids.length);
  const controller=best(ids,getQ(code[0])),base=decodeAction(controller,legal);
  if(base.type!=='discard')return base;
  const discards=ids.filter(id=>id<42),flags=[...new Set(discards.map(id=>id>=21))];
  const reveal=flags.length===1?flags[0]:best(discards,getQ(code[1]))>=21;
  const tiles=discards.filter(id=>(id>=21)===reveal);
  return decodeAction(tiles.length===1?tiles[0]:best(tiles,getQ(code[2])),legal);
}
export function scorer(models,capacity=2048){
  assert.ok(Number.isSafeInteger(capacity)&&capacity>=0);const cache=new Map(),metrics={requests:0,hits:0,shortForwards:0,longForwards:0};
  return {metrics,view(o,legal){
    const ids=legalActionIds(legal),encoded=encodePublic(o,legal),key=JSON.stringify([ids,encoded]);metrics.requests++;
    let entry=capacity?cache.get(key):null;
    if(entry)metrics.hits++;else{entry={};if(capacity){if(cache.size>=capacity)cache.delete(cache.keys().next().value);cache.set(key,entry);}}
    return {getQ(origin){assert.ok(origin==='s'||origin==='l');const name=origin==='s'?'short':'long';
      if(!entry[name]){entry[name]=models[name].forward(encoded,ids).q;metrics[name+'Forwards']++;}
      return entry[name];}};
  }};
}
export const empty=()=>({choices:0,changedFromShort:0,changedDiscardTile:0,changedReveal:0,changedOther:0,huOffered:0,huDeclined:0});
export function factories(models,{capacity=2048}={}){
  const scores=scorer(models,capacity),counters=Object.fromEntries(ARMS.map(a=>[a,empty()]));
  return {scores,counters,policies:Object.fromEntries(ARMS.map(arm=>[arm,()=>(o,legal)=>{
    if(legal.length===1)return legal[0];const c=counters[arm];c.choices++;
    const view=scores.view(o,legal),action=componentChoice({code:MIX[arm],legal,getQ:view.getQ});
    if(legal.some(a=>a.type==='hu')){c.huOffered++;c.huDeclined+=Number(action.type!=='hu');}
    if(COMPONENTS.includes(arm)){
      const base=decodeAction(best(legalActionIds(legal),view.getQ('s')),legal),changed=actionId(base)!==actionId(action);c.changedFromShort+=Number(changed);
      if(changed){
        if(arm==='tile'){assert.equal(base.type,'discard');assert.equal(action.type,'discard');assert.equal(base.reveal,action.reveal);c.changedDiscardTile++;}
        if(arm==='reveal'){assert.equal(base.type,'discard');assert.equal(action.type,'discard');assert.notEqual(base.reveal,action.reveal);c.changedReveal++;}
        if(arm==='other')c.changedOther++;
      }
    }return action;
  }]))};
}
