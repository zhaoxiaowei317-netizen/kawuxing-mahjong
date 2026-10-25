import assert from 'node:assert/strict';
import {actionId,encodePublic,legalActionIds} from '../tile-q/encoding.mjs';
import {componentChoice,scorer} from '../decision-components/policy.mjs';
import {selector,N} from '../strong-pool/config.mjs';
export function proposal(legal,getQ){
  const baseline=componentChoice({code:'sss',legal,getQ});
  if(baseline.type!=='discard'||baseline.reveal)return {baseline,eligible:false};
  const alternative=componentChoice({code:'ssl',legal,getQ});
  assert.equal(alternative.type,'discard');assert.equal(alternative.reveal,baseline.reveal);
  return {baseline,alternative,eligible:actionId(baseline)!==actionId(alternative)};
}
export function exactZeroHead(model){return ['actionHead.weight','actionHead.bias','valueHead.weight','valueHead.bias'].every(k=>model.data.weights[k].values.every(x=>x===0));}
const empty=()=>({choices:0,opportunities:0,interventions:0,events:[]});
export function factories(models,capacity=2048){
  const scores=scorer(models,capacity),counters=Object.fromEntries(['learned','always','baseline'].map(a=>[a,empty()]));
  return {scores,counters,policies:{[N]:()=>selector(N),reference:()=>selector(N),...Object.fromEntries(Object.keys(counters).map(arm=>[arm,()=>{
    let used=false;return (o,legal)=>{
      if(legal.length===1)return legal[0];const c=counters[arm];c.choices++;const view=scores.view(o,legal);
      if(used)return componentChoice({code:'sss',legal,getQ:view.getQ});
      const d=proposal(legal,view.getQ);if(!d.eligible)return d.baseline;used=true;c.opportunities++;
      const baseId=actionId(d.baseline),altId=actionId(d.alternative),q=arm==='learned'?models.learned.forward(encodePublic(o,legal),legalActionIds(legal)).q:null,
        predicted=q?q[altId]-q[baseId]:null,accept=arm==='always'||arm==='learned'&&predicted>0;
      assert.ok(predicted===null||Number.isFinite(predicted));c.interventions+=Number(accept);c.events.push({choice:c.choices,baseId,altId,predicted,selectedId:accept?altId:baseId});
      return accept?d.alternative:d.baseline;
    };
  }]))}};
}
