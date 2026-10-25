import assert from 'node:assert/strict';
import {seededRandom} from '../random.mjs';
import {summarizePaired} from '../statistics.mjs';
export const FAMILY=Object.freeze(['tile','reveal','other']);
const mean=a=>a.reduce((s,v)=>s+v/a.length,0);
function quantile(a,p){const x=(a.length-1)*p,i=Math.floor(x),f=x-i;return f===0?a[i]:a[i]*(1-f)+a[i+1]*f;}
export function familyIntervals(records,{bootstrapSamples=5000,seed='components-family-v1'}={}){
  assert.deepEqual(Object.keys(records).sort(),[...FAMILY].sort());assert.ok(Number.isSafeInteger(bootstrapSamples)&&bootstrapSamples>0);
  const canonical=records.tile.map(r=>[r.opponentPair,r.seed]);assert.ok(canonical.length);
  const points={};for(const arm of FAMILY){
    assert.deepEqual(records[arm].map(r=>[r.opponentPair,r.seed]),canonical);
    points[arm]=summarizePaired(records[arm],{bootstrapSamples:1,seed}).session.overall;
  }
  const pairs=[...new Set(canonical.map(x=>x[0]))].sort(),strata=pairs.map(pair=>canonical.flatMap((v,i)=>v[0]===pair?[i]:[]));
  const deltas=Object.fromEntries(FAMILY.map(arm=>[arm,records[arm].map(r=>100*(r.candidate.score/r.candidate.hands-r.incumbent.score/r.incumbent.hands))]));
  const rng=seededRandom(seed),draws=Object.fromEntries(FAMILY.map(a=>[a,[]]));
  for(let n=0;n<bootstrapSamples;n++){
    const indices=strata.map(stratum=>Array.from({length:stratum.length},()=>stratum[rng(stratum.length)]));
    for(const arm of FAMILY)draws[arm].push(mean(indices.map(group=>mean(group.map(i=>deltas[arm][i])))));
  }
  const alpha=.05/FAMILY.length;
  return Object.fromEntries(FAMILY.map(arm=>{const sorted=draws[arm].sort((a,b)=>a-b),ci=[quantile(sorted,alpha/2),quantile(sorted,1-alpha/2)];
    assert.ok(Math.abs(points[arm].deltaPer100-mean(strata.map(g=>mean(g.map(i=>deltas[arm][i])))))<1e-9);
    return [arm,{deltaPer100:points[arm].deltaPer100,groups:points[arm].groups,hands:points[arm].hands,
      confidence:1-alpha,ciFamily:ci,familySize:FAMILY.length,bootstrapSamples,outcome:ci[0]>0?'positive':ci[1]<0?'negative':'inconclusive',
      adjustment:'Bonferroni: three two-sided percentile bootstrap intervals, family alpha .05; full groups resampled jointly within opponent-pair strata.'}];
  }));
}
