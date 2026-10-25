import {policyById} from '../policies/index.mjs';
import {policyFor} from '../reveal-study/policies.mjs';

export const CANDIDATE='h0-never';
export const COHORTS=Object.freeze(['replication','stress']);
export const PAIRS=Object.freeze({
  replication:Object.freeze([
    {id:'H0+H0',policies:['H0','H0']},
    {id:'H0+greedy-speed-v1',policies:['H0','greedy-speed-v1']},
  ]),
  stress:Object.freeze([
    {id:'never+H0',policies:['h0-never','H0']},
    {id:'never+greedy',policies:['h0-never','greedy-speed-v1']},
    {id:'never+never',policies:['h0-never','h0-never']},
    {id:'selective+H0',policies:['h0-q-gate','H0']},
    {id:'neural+H0',policies:['q-reference','H0']},
  ]),
});
export const CUSTOM_IDS=Object.freeze(['h0-never','h0-q-gate','q-reference']);
export const selector=(id,model)=>CUSTOM_IDS.includes(id)?policyFor(id,model):policyById(id);
export const factories=model=>Object.fromEntries(CUSTOM_IDS.map(id=>[id,()=>selector(id,model)]));
