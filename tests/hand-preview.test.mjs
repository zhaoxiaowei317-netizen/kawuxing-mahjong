import test from 'node:test';
import assert from 'node:assert/strict';
import {newGame,parseHand} from '../src/engine.js';
import {remainingTiles,discardPreviews} from '../src/hand-preview.js';
test('remaining count excludes private hands and wall but includes publicly identified kongs',()=>{
 const g=newGame(undefined,{dealer:0});g.players.forEach(p=>{p.hand=[];p.river=[];p.melds=[];});
 g.players[0].hand=['p1'];g.players[1].hand=['p1','p1'];g.wall=['p1'];
 assert.equal(remainingTiles(g,0).p1,3);
 g.players[1].river=['p1'];assert.equal(remainingTiles(g,0).p1,2);
 g.players[1].liang=true;assert.equal(remainingTiles(g,0).p1,0);
 g.players[2].melds=[{kind:'an',tile:'s1'}];assert.equal(remainingTiles(g,0).s1,0);
 g.players[2].melds[0].kind='ming';assert.equal(remainingTiles(g,0).s1,0);
});
test('discard choice changes waits, sums and capped reveal score without mutation',()=>{
 const g=newGame({base:2,cap:16,mode:'bots'},{dealer:0});g.players[0].hand=parseHand('p11223344556678');
 const before=structuredClone(g),v=discardPreviews(g,0);
 assert.deepEqual(v[0].ready.map(x=>x.tile),['p2','p5','p8']);assert.equal(v[0].total,7);
 assert.deepEqual(v[12].ready.map(x=>x.tile),['p8']);assert.equal(v[12].total,3);
 for(const choice of v)for(const w of choice.ready){assert.ok(w.score.factors.some(f=>f.name==='亮倒'));assert.equal(w.points,Math.min(w.score.raw,16)*2);}
 assert.deepEqual(g,before);
});
