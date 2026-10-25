import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHand as H,evaluate as E,amount,drawSettlement,winSettlement,nextSeats,newGame,botStep,counts,discard,respond,finish,kong,reactionOptions,autoPass} from '../src/engine.js';
const config={base:1,cap:32,mode:'bots'};
const p=(s,liang=false,melds=[])=>({hand:H(s),liang,melds});
const ready='p111s222333444z7',bad='p13579s13579z567';
test('point wins require two; ordinary self draw may win unrevealed (rules 13–14)',()=>{
 const h=H('p123456789s123z77');
 assert.equal(E(h).legal,false);
 assert.equal(E(h,[],{liang:true,self:true}).raw,2);
 assert.equal(E(h,[],{otherLiang:true,self:true}).legal,true);
 assert.equal(E(h,[],{liang:true,otherLiang:true}).raw,4);
 assert.equal(E(h,[],{winTile:'p9'}).raw,1);
 assert.equal(E(h,[],{winTile:'s8'}),null);
});
test('house hand values and multiplicative factors',()=>{
 assert.equal(E(H('p12346s123789z77p5'),[],{winTile:'p5'}).raw,2);
 assert.equal(E(H('p11122233344455')).raw,8);
 assert.equal(E(H('p112233s445566z77')).raw,4);
 assert.equal(E(H('p111122s334455z77')).raw,8);
 assert.equal(E(H('p11112222s3344z77')).raw,16);
 assert.equal(E(H('p123s456z55666777')).raw,4);
 assert.equal(E(H('p123s55z555666777')).raw,8);
 assert.equal(E(H('p111123s456789z77'),[],{winTile:'p1'}).raw,4);
 assert.equal(E(H('p123s456789z77'),[{kind:'peng',tile:'p1'}],{winTile:'p1'}).raw,2);
 assert.equal(E(H('p11122233344455'),[],{liang:true,self:true,gang:2,sea:true}).raw,128);
 assert.equal(amount(128,config),16);assert.equal(amount(128,{base:1,cap:16}),16);assert.equal(amount(128,{base:1,cap:0}),16);
});
test('draw settlement always preserves kongs under all readiness states',()=>{
 const ks=[{from:1,to:0,amount:3}];
 const mixed=drawSettlement([p(ready),p(bad),p(bad)],ks,config);
 assert.equal(mixed.keepKongs,true);assert.deepEqual(mixed.delta,[7,-5,-2]);
 const all=drawSettlement([p(ready,true),p(ready),p(ready)],ks,config);
 assert.equal(all.keepKongs,true);assert.deepEqual(all.delta,[-5,1,4]);
 const none=drawSettlement([p(bad),p(bad),p(bad)],ks,config);
 assert.equal(none.keepKongs,true);assert.deepEqual(none.delta,[3,-3,0]);
 assert.deepEqual(drawSettlement([p(ready,true),p(ready,true),p(ready)],ks,config).delta,[-1,-7,8]);
});
test('self draw full payment, multi-ron only discarder pays',()=>{
 const sc={legal:true,raw:8,factors:[{name:'test',n:8}]};
 assert.deepEqual(winSettlement([], [0],null,{0:{1:sc,2:sc}},[],config).delta,[16,-8,-8]);
 assert.deepEqual(winSettlement([], [1,2],0,{1:{0:sc},2:{0:sc}},[],config).delta,[-16,8,8]);
});
test('fixed seats, winner dealer, multi-ron source dealer and draw retains dealer',()=>{
 assert.deepEqual(nextSeats([0,1,2],3,[1],0,2),{seats:[0,1,2],bench:null,dealer:1});
 assert.deepEqual(nextSeats([0,1,2],3,[1,2],0,2),{seats:[0,1,2],bench:null,dealer:0});
 assert.equal(nextSeats([0,1,2],3,[],null,2).dealer,2);
 assert.equal(nextSeats([0,1,2],null,[2],0,1).dealer,2);
});
test('wait for both responders before settling simultaneous wins',()=>{
 const g=newGame(config,{dealer:0});g.players=[p('p123456789s123z5z7',true),p(ready,true),p(ready,true)];g.drawTile='z7';
 g.players.forEach(p=>p.river=[]);g.turn=0;discard(g,13);
 respond(g,1,'hu');assert.equal(g.phase,'react');respond(g,2,'hu');
 assert.equal(g.phase,'ended');assert.deepEqual(g.result.winners,[1,2]);assert.equal(g.result.next.dealer,0);
});
test('kong payments and replacement draws',()=>{
 const g=newGame(config,{dealer:0});g.players[0].hand=H('p1111s123456z5577');
 kong(g,'p1','an');assert.equal(g.kongs.length,2);assert.equal(g.kongs[0].amount,2);assert.equal(g.players[0].hand.length,11);assert.equal(g.gangChain,1);
 const h=newGame(config,{dealer:0});h.players[0].hand=H('p1s123456z5577');h.players[0].melds=[{kind:'peng',tile:'p1'}];h.drawTile='p1';h.players[1].hand=[];h.players[2].hand=[];
 kong(h,'p1','bu');assert.equal(h.kongs[0].amount,1);assert.equal(h.players[0].melds[0].kind,'bu');
});
test('full robot rounds end, conserve all 84 tiles and zero-sum score',()=>{
 for(let r=0;r<5;r++){
  const g=newGame(config,{dealer:0});let moves=0;
  while(g.phase!=='ended'&&moves++<350){
   const seat=g.phase==='react'?[0,1,2].find(i=>i!==g.pending.source&&!g.pending.responses[i]):g.turn;
   botStep(g,seat);
   const all=[...g.wall,...g.players.flatMap(p=>[...p.hand,...p.river,...p.melds.flatMap(m=>Array(m.kind==='peng'?3:4).fill(m.tile))])];
   assert.equal(all.length,84);assert.ok(Object.values(counts(all)).every(n=>n===4));
  }
  assert.equal(g.phase,'ended');assert.equal(g.result.delta.reduce((a,b)=>a+b),0);
 }
});
test('no legal response automatically proceeds to next draw',()=>{
 const g=newGame(config,{dealer:0});g.players=[p(bad+'z5'),p(bad),p(bad)];g.players.forEach(p=>p.river=[]);g.turn=0;
 const length=g.wall.length;discard(g,13);assert.equal(g.phase,'discard');assert.equal(g.turn,1);assert.equal(g.wall.length,length-1);assert.equal(g.pending,null);
});
test('pung opportunity pauses only its owner; pass then advances',()=>{
 const g=newGame(config,{dealer:0});g.players=[p(bad+'p5'),p('p55s123456789z67'),p(bad)];g.players.forEach(p=>p.river=[]);g.turn=0;
 discard(g,13);assert.equal(g.phase,'react');assert.deepEqual(reactionOptions(g,1),['peng']);assert.equal(g.pending.responses[2],'pass');
 respond(g,1,'pass');assert.equal(g.phase,'discard');assert.equal(g.turn,1);
});
test('revealed player with no win auto-passes despite matching pair',()=>{
 const g=newGame(config,{dealer:0});g.players=[p(bad+'p5'),p('p55s123456789z67',true),p(bad)];g.players.forEach(p=>p.river=[]);g.turn=0;
 discard(g,13);assert.equal(g.phase,'discard');assert.equal(g.turn,1);
});
test('last discard with no claims still settles draw',()=>{
 const g=newGame(config,{dealer:0});g.players=[p(bad+'z5'),p(bad),p(bad)];g.players.forEach(p=>p.river=[]);g.turn=0;g.wall=[];
 discard(g,13);assert.equal(g.phase,'ended');assert.deepEqual(g.result.winners,[]);
});
