import test from 'node:test';
import assert from 'node:assert/strict';
import {newGame,parseHand as H,discard,respond,evaluate,scoresFor,draw} from '../src/engine.js';
function fixture(cap=32){const g=newGame({base:1,cap,mode:'three'},{dealer:0});g.players[0].hand=H('p123456789s123z77');g.players[0].hand[0]='s6';g.players[1].hand=H('s2345566');g.players[1].melds=[{kind:'peng',tile:'s2'},{kind:'peng',tile:'s7'}];g.players[2].hand=H('p13579s13579z567');g.kongs=[{from:1,to:0,amount:3,why:'明杠 1条'}];g.gangChain=1;g.turn=0;g.phase='discard';return g;}
test('screenshot: pure suit + kong discard is 8; fourth was not the winning tile',()=>{
 const g=fixture();discard(g,0);assert.equal(g.pending.gangShot,1);assert.equal(scoresFor(g,1,0)[0].raw,8);respond(g,1,'hu');
 assert.equal(g.phase,'ended');assert.deepEqual(g.result.delta,[-5,5,0]);assert.ok(g.result.lines.some(l=>l.amount===8&&l.why.includes('杠上炮×2')));
});
test('normal discard stays 4; kong discard uses normal cap and reveal multiplication',()=>{
 const hand=H('s23455666'),melds=[{kind:'peng',tile:'s2'},{kind:'peng',tile:'s7'}];
 assert.equal(evaluate(hand,melds,{winTile:'s6'}).raw,4);
 assert.equal(evaluate(hand,melds,{winTile:'s6',gangShot:true,liang:true}).raw,16);
 const g=fixture(16);g.players[1].liang=true;g.players[0].hand=['s6'];discard(g,0);respond(g,1,'hu');assert.equal(g.result.lines.at(-1).amount,16);
});
test('subsequent regular draw does not carry kong discard multiplier',()=>{
 const g=fixture();g.players[1].hand=H('p13579s13579z567');discard(g,0);while(g.phase==='react'){const seat=[0,1,2].find(i=>i!==g.pending.source&&!g.pending.responses[i]);respond(g,seat,'pass');}
 assert.equal(g.gangChain,0);draw(g,0);discard(g,g.players[0].hand.length-1);assert.ok(!g.pending?.gangShot);
});
