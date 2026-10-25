import test from 'node:test';
import assert from 'node:assert/strict';
import {newGame,parseHand,discardPolicy,discard,respond,botStep} from '../src/engine.js';
export function fixture(all=false){
 const g=newGame({base:1,cap:32,mode:'three'},{dealer:0});
 g.players[0].hand=all?['z5','z6']:['z5','s8'];
 g.players[0].melds=['p1','p2','p3','s9'].map(tile=>({kind:'peng',tile}));
 for(const i of [1,2]){g.players[i].hand=parseHand('p456789s123456'+(i===1?'z5':'z6'));g.players[i].liang=true;}
 g.drawTile=g.players[0].hand.at(-1);return g;
}
test('safe tile forces avoidance of revealed waits and blocked actions do not mutate state',()=>{
 const g=fixture();assert.deepEqual(discardPolicy(g).allowed,[1]);
 const before=structuredClone(g);assert.throws(()=>discard(g,0),/安全牌/);assert.deepEqual(g,before);
 assert.throws(()=>discard(g,0,true),/安全牌/,'cannot bypass by declaring reveal on this discard');
 discard(g,1);assert.equal(g.players[0].river.at(-1),'s8');
});
test('all danger uses union of both revealed waits and ordinary ron payment',()=>{
 const g=fixture(true);assert.equal(discardPolicy(g).allDangerous,true);assert.deepEqual(discardPolicy(g).allowed,[0,1]);
 discard(g,0);assert.equal(g.phase,'react');respond(g,1,'hu');
 assert.equal(g.phase,'ended');assert.deepEqual(g.result.winners,[1]);assert.deepEqual(g.result.delta,[-2,2,0]);
});
test('revealed player must discard drawn danger tile, even when a safe tile is held',()=>{
 const g=fixture();g.players[0].hand=['s8','z5'];g.players[0].liang=true;g.drawTile='z5';
 assert.deepEqual(discardPolicy(g).allowed,[1]);assert.throws(()=>discard(g,0),/摸切/);
 discard(g,1);respond(g,1,'hu');assert.deepEqual(g.result.delta,[-4,4,0]);
});
test('computer only chooses legal safe discards but proceeds if all tiles are danger',()=>{
 for(const all of [false,true]){const g=fixture(all);botStep(g,0);assert.equal(g.players[0].river.length,1);assert.ok((all?['z5','z6']:['s8']).includes(g.players[0].river[0]));}
});
test('unrevealed opponents do not expose their waits through restrictions',()=>{
 const g=fixture();g.players[1].liang=false;g.players[2].liang=false;
 assert.deepEqual(discardPolicy(g).allowed,[0,1]);assert.deepEqual(discardPolicy(g).dangerous,[]);
});
