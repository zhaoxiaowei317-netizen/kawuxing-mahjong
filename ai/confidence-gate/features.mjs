import assert from 'node:assert/strict';
import {FEATURE_NAMES} from '../action-scorer/features.mjs';
import {CONTEXT_NAMES} from '../tile-q/encoding.mjs';
export const VERSION='kwx-teacher-confidence-features-1';
const baseNames=['negativeDistance','outs','readyOuts','waitKinds','potentialFan','discard.pair','discard.triplet','discard.honor'];
const contextNames=['wall','gangChain','p0.liang','p1.liang','p2.liang','p0.meldSize','p1.meldSize','p2.meldSize','p0.size','p1.hidden','p2.hidden','p0.total','p1.total','p2.total'];
const fi=new Map(FEATURE_NAMES.map((n,i)=>[n,i])),ci=new Map(CONTEXT_NAMES.map((n,i)=>[n,i]));
export const SCHEMA=Object.freeze({version:VERSION,names:Object.freeze([
  ...FEATURE_NAMES.map(n=>'delta.'+n),...baseNames.map(n=>'baseline.'+n),'short.scoreMargin','long.scoreMargin',...contextNames,
  'short.marginXwall','long.marginXwall','delta.outsXwall','delta.readyOutsXwall','delta.fanXotherLiang',
])});
// Teacher scores are fixed public computations, NOT calibrated expected points.
// All scores use the original complete legal mask. No wall, opponent hand,
// realized score, policy ID or label is accepted by this feature interface.
export function extractFeatures(root,models){
  const {encoded,legalIds,baselineId,alternativeId}=root;
  assert.ok(baselineId!==alternativeId&&baselineId<21&&alternativeId<21&&baselineId>=0&&alternativeId>=0);
  assert.ok(legalIds.includes(baselineId)&&legalIds.includes(alternativeId));
  const candidates=new Map(encoded.candidates.map(c=>[c.id,c.values])),b=candidates.get(baselineId),a=candidates.get(alternativeId);
  assert.equal(b.length,FEATURE_NAMES.length);assert.equal(a.length,FEATURE_NAMES.length);
  const delta=a.map((x,i)=>x-b[i]),q=Object.fromEntries(['short','long'].map(k=>[k,models[k].forward(encoded,legalIds).q])),sm=q.short[alternativeId]-q.short[baselineId],lm=q.long[alternativeId]-q.long[baselineId],
    get=n=>encoded.context[ci.get(n)],wall=get('wall'),otherLiang=get('p1.liang')+get('p2.liang');
  const features=[...delta,...baseNames.map(n=>b[fi.get(n)]),sm,lm,...contextNames.map(get),sm*wall,lm*wall,delta[fi.get('outs')]*wall,delta[fi.get('readyOuts')]*wall,delta[fi.get('potentialFan')]*otherLiang];
  assert.equal(features.length,SCHEMA.names.length);assert.ok(features.every(Number.isFinite));return features.map(x=>x===0?0:x);
}
