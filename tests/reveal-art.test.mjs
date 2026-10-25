import test from 'node:test';
import assert from 'node:assert/strict';
import {newGame,parseHand,revealedWaits,waits,TYPES} from '../src/engine.js';
import {tileArtwork} from '../src/tile-art.js';
import {gameTable} from '../src/game-table.js';

test('revealed waits are private until reveal and stable through a draw',()=>{
 const g=newGame(undefined,{dealer:0}); const p=g.players[1];
 p.hand=parseHand('p1112223334445');p.melds=[];
 assert.deepEqual(revealedWaits(g,1),[]);
 p.liang=true;
 const expected=waits(p.hand,[],true);
 assert.ok(expected.length>1);
 assert.deepEqual(revealedWaits(g,1),expected);
 g.turn=1;g.drawTile='p5';p.hand.push('p5');
 assert.deepEqual(revealedWaits(g,1),expected);
 assert.equal(p.hand.length,14,'display must not mutate hand');
 p.hand.pop();g.phase='react';g.turn=0;
 assert.deepEqual(revealedWaits(g,1),expected);
});
test('revealed waits support melds and never suggest a fifth copy',()=>{
 const g=newGame(undefined,{dealer:0});const p=g.players[2];p.liang=true;
 p.melds=[{kind:'peng',tile:'p1'}];p.hand=parseHand('p123s456789z7');
 assert.deepEqual(revealedWaits(g,2).map(x=>x.tile),['z7']);
 p.melds=[];p.hand=parseHand('p111123s456789z7');
 assert.ok(!revealedWaits(g,2).some(x=>x.tile==='p1'));
});
test('both opponents show every wait but concealed hands show none',()=>{
 const g=newGame(undefined,{dealer:0});
 for(const seat of [1,2]){g.players[seat].hand=parseHand('p1112223334445');g.players[seat].liang=true;}
 const render=()=>gameTable(g,0,-1,false,true,false,()=>'',()=>'',()=> '');
 let html=render();
 for(const seat of [1,2]){assert.ok(html.includes(`data-wait-seat="${seat}"`));for(const x of revealedWaits(g,seat))assert.ok(html.includes(`data-wait-tile="${x.tile}"`));}
 g.players[1].liang=false;html=render();assert.ok(!html.includes('data-wait-seat="1"'));
});
test('all 21 faces use the reviewed reference ink palette',()=>{
 const G='#07512f',R='#b51d27',K='#171c25';
 const expected={p1:[G,R],p2:[K,G],p3:[G,R],p4:[K,G],p5:[G,K,R],p6:[G,R],p7:[G,R],p8:[K],p9:[K,R,G],s1:[G,R],s2:[G],s3:[G],s4:[G],s5:[G,R],s6:[G],s7:[R,G],s8:[G],s9:[G,R],z5:[K],z6:[G],z7:[R]};
 for(const t of TYPES){const svg=tileArtwork(t);assert.ok(svg.includes('viewBox="0 0 96 132"'));assert.deepEqual([G,R,K].filter(c=>svg.includes(c)).sort(),[...expected[t]].sort(),t);}
 assert.equal((tileArtwork('s8').match(/fill="#07512f"/g)||[]).length,8);
 assert.equal((tileArtwork('p8').match(/<circle/g)||[]).length,24);
});
