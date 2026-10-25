import {selectAction as h0} from '../policies/h0.mjs';
import {encodePublic,legalActionIds,actionId} from '../tile-q/encoding.mjs';

export const VARIANTS=Object.freeze(['h0-never','h0-q-gate','q-h0-gate']);
export const ARMS=Object.freeze([...VARIANTS,'q-reference']);
export function decide(id,model,o,legal){
  if(!ARMS.includes(id))throw Error('Unknown reveal intervention');
  if(!legal.length)throw Error('No legal actions');
  const base=legal.length===1?legal[0]:id.startsWith('h0-')?h0(o,legal):model.select(o,legal);
  let action=base,margin=null;
  const paired=base.type==='discard'?legal.filter(a=>a.type==='discard'&&a.tile===base.tile):[];
  const opportunity=paired.some(a=>a.reveal)&&paired.some(a=>!a.reveal);
  if(opportunity){
    if(id==='h0-never')action=paired.find(a=>!a.reveal);
    else if(id==='h0-q-gate'){
      // Evaluate the original full legal mask. Restrict only the final choice,
      // preserving both the original H0 discard tile and Q's action context.
      const {q}=model.forward(encodePublic(o,legal),legalActionIds(legal));
      const plain=paired.find(a=>!a.reveal),reveal=paired.find(a=>a.reveal);
      margin=q[actionId(reveal)]-q[actionId(plain)];action=margin>0?reveal:plain;
    }else if(id==='q-h0-gate'){
      // H0 is asked about this one tile; its ordinary full-hand discard may be
      // different and must not be substituted into this intervention.
      action=h0(o,paired);
    }
  }
  if(!legal.includes(action))throw Error('Intervention invented an action');
  if(action.type!==base.type||action.type==='discard'&&action.tile!==base.tile)throw Error('Intervention changed the base action');
  return {action,base,opportunity,changed:action!==base,margin};
}
export const policyFor=(id,model)=>(o,legal)=>decide(id,model,o,legal).action;
