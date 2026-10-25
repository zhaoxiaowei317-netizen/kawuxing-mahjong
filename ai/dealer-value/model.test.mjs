import test from 'node:test';
import assert from 'node:assert/strict';
import {fitDealerValue,forecast,sessionRows,evaluateDealerValue,correctedRootGain} from './model.mjs';
test('dealer value recursion has exact terminal boundary and correct score units',()=>{
  const rows=[{state:0,nextState:0,reward:1},{state:0,nextState:1,reward:1},{state:1,nextState:0,reward:3},{state:1,nextState:1,reward:3}],m=fitDealerValue(rows,{horizon:3});
  assert.deepEqual(m.matrix,[[.5,.5],[.5,.5]]);assert.deepEqual(m.values,[[0,0],[1,3],[3,5],[5,7]]);assert.equal(forecast(m,0,1),0);assert.equal(forecast(m,3,1),7);assert.throws(()=>forecast(m,4,1));
  const episode={hand:0,schedule:{target:0},root:{},replay:{result:{next:{dealer:1}}},samples:[{gain:.25,baselineReplay:null,alternativeReplay:{result:{next:{dealer:0}}}}]};
  assert.deepEqual(correctedRootGain(episode,m,3),{currentGain:.25,futureDealerCorrection:.125,correctedGain:.375});episode.hand=2;assert.equal(correctedRootGain(episode,m,3).futureDealerCorrection,0);
});
test('future labels include current hand once, stop at session boundary and do not fit on validation',()=>{
  const episodes=[1,2,3,4,5,6].map((reward,hand)=>({hand,schedule:{target:0},replay:{initialState:{dealer:hand%2},result:{delta:[reward,-reward,0],next:{dealer:(hand+1)%2}}}}));
  const rows=sessionRows(episodes,3);assert.deepEqual(rows.map(r=>r.futureNet),[6,5,3,15,11,6]);assert.deepEqual(rows.map(r=>r.horizon),[3,2,1,3,2,1]);
  const m=fitDealerValue(rows.slice(0,3),{horizon:3}),saved=structuredClone(m),e=evaluateDealerValue(m,rows.slice(3));assert.deepEqual(m,saved);assert.equal(e.sessions,1);assert.equal(e.hands,3);assert.ok(Number.isFinite(e.dealerMse));
});
