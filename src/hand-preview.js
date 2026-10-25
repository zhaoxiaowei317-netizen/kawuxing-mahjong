import {TYPES,counts,waits,discardPolicy,amount,visibleCounts} from './engine.js';
// Only the viewer's hand and public information may enter the counter.
export function remainingTiles(g,view){
 const c=visibleCounts(g,view);return Object.fromEntries(TYPES.map(t=>[t,Math.max(0,4-(c[t]||0))]));
}
export function discardPreviews(g,view){
 if(g.phase!=='discard'||g.turn!==view)return [];
 const p=g.players[view],left=remainingTiles(g,view),policy=discardPolicy(g,view),cache=new Map();
 return p.hand.map((t,i)=>{
  if(!cache.has(t))cache.set(t,waits(p.hand.filter((_,j)=>j!==i),p.melds,true).map(w=>({...w,remaining:left[w.tile],points:amount(w.score.raw,g.config)})));
  const ready=cache.get(t);return {index:i,tile:t,allowed:policy.allowed.includes(i),ready,total:ready.reduce((n,w)=>n+w.remaining,0)};
 });
}
