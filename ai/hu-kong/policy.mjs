import assert from 'node:assert/strict';
import {legalActionIds,decodeAction,actionId} from '../tile-q/encoding.mjs';
import {best,componentChoice,scorer} from '../decision-components/policy.mjs';
import {selector,N} from '../strong-pool/config.mjs';
export const ARMS=Object.freeze(['patched','base','short','reference']);
export const NEURAL=Object.freeze(['patched','base','short']);
export const isKong=a=>a.type==='kong'||a.type==='ming';
export function choose({arm,legal,getQ}){
  assert.ok(NEURAL.includes(arm));
  const base=componentChoice({code:arm==='short'?'sss':'lss',legal,getQ});
  const short=legal.some(a=>a.type==='hu')?decodeAction(best(legalActionIds(legal),getQ('s')),legal):null;
  const conflict=arm!=='short'&&short?.type==='hu'&&isKong(base);
  const action=arm==='patched'&&conflict?short:base;
  if(actionId(action)!==actionId(base)){assert.ok(conflict&&arm==='patched');assert.equal(action.type,'hu');}
  return {action,base,short,conflict};
}
const empty=()=>({choices:0,huOffered:0,huDeclined:0,conflicts:0,overrides:0,byKind:{an:0,bu:0,ming:0},events:[]});
export function factories(models,capacity=2048){
  const scores=scorer(models,capacity),counters=Object.fromEntries(NEURAL.map(a=>[a,empty()]));
  return {scores,counters,policies:{[N]:()=>selector(N),reference:()=>selector(N),...Object.fromEntries(NEURAL.map(arm=>[arm,()=>(o,legal)=>{
    if(legal.length===1)return legal[0];const c=counters[arm];c.choices++;
    const view=scores.view(o,legal),d=choose({arm,legal,getQ:view.getQ});
    if(legal.some(a=>a.type==='hu')){c.huOffered++;c.huDeclined+=Number(d.action.type!=='hu');}
    if(d.conflict){const kind=d.base.type==='ming'?'ming':d.base.kind;c.conflicts++;c.byKind[kind]++;
      const overridden=actionId(d.base)!==actionId(d.action);c.overrides+=Number(overridden);
      c.events.push({choice:c.choices,kind,base:d.base,selected:d.action,short:d.short,overridden});
    }return d.action;
  }]))}};
}
