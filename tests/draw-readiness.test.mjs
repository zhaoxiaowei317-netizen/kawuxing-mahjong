import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHand,waits,drawSettlement,evaluate} from '../src/engine.js';
const p=(s,liang=false)=>({hand:parseHand(s),melds:[],liang});
const ordinary='p123456789s123z7',ready='p111s222333444z7',bad='p13579s13579z567';
test('ordinary unrevealed ready player receives from both revealed players, not vice versa',()=>{
 const players=[p(ordinary),p(ready,true),p(ready,true)];
 assert.equal(waits(players[0].hand).length,0);
 assert.equal(waits(players[0].hand,[],false,1).length,1);
 assert.equal(evaluate([...players[0].hand,'z7'],[],{self:true}).legal,true);
 const r=drawSettlement(players,[{from:0,to:1,amount:3}],{base:1,cap:32});
 assert.deepEqual(r.delta,[1,1,-2]);assert.equal(r.keepKongs,true);
 assert.deepEqual(r.lines.map(l=>[l.from,l.to,l.amount]),[[0,1,3],[1,0,2],[2,0,2]]);
 assert.match(r.lines[1].why,/普通胡×1.*赔付翻倍×2/);
});
test('all ready pays largest available hand, doubles before applying cap, from each revealed player',()=>{
 const players=[p('p1112223334445'),p(ready,true),p(ready,true)];
 const rs=waits(players[0].hand,[],false,1),raws=rs.map(x=>x.score.raw);
 assert.ok(new Set(raws).size>1);
 for(const cap of [16,32,0]){
  const expected=Math.min(Math.max(...raws)*2,16)*3;
  const r=drawSettlement(players,[],{base:3,cap});
  assert.deepEqual(r.delta,[2*expected,-expected,-expected]);
  assert.ok(r.lines.every(l=>l.to===0&&l.amount===expected));
  assert.match(r.lines[0].why,/最大听牌/);
 }
});
test('mixed readiness still preserves kongs; all unrevealed/all revealed do not pay each other',()=>{
 const k=[{from:0,to:2,amount:3}];
 const mixed=drawSettlement([p(ordinary),p(bad),p(ready,true)],k,{base:1,cap:32});
 assert.equal(mixed.keepKongs,true);assert.ok(mixed.lines.some(l=>l.from===1&&l.to===0&&l.amount===1));
 for(const liang of [true,false])assert.deepEqual(drawSettlement([p(ordinary,liang),p(ready,liang),p(ready,liang)],k,{base:1,cap:32}).delta,[-3,0,3]);
});
