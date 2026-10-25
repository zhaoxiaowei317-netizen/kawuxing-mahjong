import assert from 'node:assert/strict';
import {actionId,encodePublic,legalActionIds} from '../tile-q/encoding.mjs';
import {componentChoice,scorer} from '../decision-components/policy.mjs';
import {proposal} from '../paired-tile/policy.mjs';
import {selector,N} from '../strong-pool/config.mjs';
import {extractFeatures} from './features.mjs';
const empty=()=>({choices:0,opportunities:0,interventions:0,events:[]});
export function factories(models,capacity=2048){
  const scores=scorer(models,capacity),counters=Object.fromEntries(['gate','average','always','baseline'].map(k=>[k,empty()]));
  return {scores,counters,policies:{[N]:()=>selector(N),reference:()=>selector(N),...Object.fromEntries(Object.keys(counters).map(arm=>[arm,()=>{
    let used=false;return (o,legal)=>{if(legal.length===1)return legal[0];const c=counters[arm];c.choices++;const v=scores.view(o,legal);
      if(used)return componentChoice({code:'sss',legal,getQ:v.getQ});const d=proposal(legal,v.getQ);if(!d.eligible)return d.baseline;used=true;c.opportunities++;
      const baselineId=actionId(d.baseline),alternativeId=actionId(d.alternative),root={encoded:encodePublic(o,legal),legalIds:legalActionIds(legal),baselineId,alternativeId};let predicted=null;
      if(arm==='average'){const q=models.average.forward(root.encoded,root.legalIds).q;predicted=q[alternativeId]-q[baselineId];}
      if(arm==='gate')predicted=models.gate.predict(extractFeatures(root,{short:{forward:()=>({q:v.getQ('s')})},long:{forward:()=>({q:v.getQ('l')})}}));
      assert.ok(predicted===null||Number.isFinite(predicted));const accept=arm==='always'||['gate','average'].includes(arm)&&predicted>0;c.interventions+=Number(accept);
      c.events.push({choice:c.choices,baseId:baselineId,altId:alternativeId,predicted,selectedId:accept?alternativeId:baselineId});return accept?d.alternative:d.baseline;
    };
  }]))}};
}
