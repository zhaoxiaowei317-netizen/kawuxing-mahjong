import {policyById} from './policies.mjs';
import {selectAction as h0} from './h0.mjs';
export const N='h0-never';
const never=(o,legal)=>{const base=legal.length===1?legal[0]:h0(o,legal);if(base.type!=='discard'||!base.reveal)return base;
  const paired=legal.filter(a=>a.type==='discard'&&a.tile===base.tile);return paired.some(a=>a.reveal)&&paired.some(a=>!a.reveal)?paired.find(a=>!a.reveal):base;};
export const selector=id=>id===N?never:policyById(id);
