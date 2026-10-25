import * as original from '../../src/engine.js';
export * from '../../src/engine.js';

// Optional process-local memoization of pure geometry. Every semantic input is
// retained, including hand order, meld metadata, liang and minimum. This never
// caches an observation, policy decision, opponent posterior or terminal score.
let capacity=32768;
const maps={distance:new Map(),waits:new Map()},metrics={distance:{requests:0,hits:0,misses:0,evictions:0},waits:{requests:0,hits:0,misses:0,evictions:0}};
export function configureGeometryCache(n){if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid geometry capacity');capacity=n;for(const name of Object.keys(maps)){maps[name].clear();for(const k of Object.keys(metrics[name]))metrics[name][k]=0;}}
export function geometryCacheMetrics(){return {capacity,...Object.fromEntries(Object.keys(maps).map(name=>[name,{...metrics[name],size:maps[name].size}]))};}
function keyFor(args){
  const [hand,melds]=args;if(!Array.isArray(hand)||!hand.every(t=>typeof t==='string')||!Array.isArray(melds))return null;
  try{return JSON.stringify(args);}catch{return null;}
}
function memo(name,args,run){
  const m=metrics[name],cache=maps[name];m.requests++;const key=capacity?keyFor(args):null;
  if(key!==null&&cache.has(key)){m.hits++;const v=cache.get(key);cache.delete(key);cache.set(key,v);return name==='waits'?structuredClone(v):v;}
  m.misses++;const value=run();
  if(key!==null){if(cache.size>=capacity){cache.delete(cache.keys().next().value);m.evictions++;}cache.set(key,name==='waits'?structuredClone(value):value);}
  return value;
}
export function distance(hand,melds=[]){return memo('distance',[hand,melds],()=>original.distance(hand,melds));}
export function waits(hand,melds=[],liang=false,minimum=2){
  if(typeof liang!=='boolean'||typeof minimum!=='number'||!Number.isFinite(minimum))return original.waits(hand,melds,liang,minimum);
  return memo('waits',[hand,melds,liang,minimum],()=>original.waits(hand,melds,liang,minimum));
}
