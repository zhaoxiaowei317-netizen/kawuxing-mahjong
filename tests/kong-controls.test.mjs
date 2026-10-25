import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newGame,parseHand,kong} from '../src/engine.js';
import {gameTable} from '../src/game-table.js';
const render=g=>gameTable(g,0,-1,false,false,false,()=>'',()=>'',()=>'',false);
test('nine circles concealed kong appears without selecting a tile and pays both opponents',()=>{
 const g=newGame(undefined,{dealer:0});g.turn=0;g.players[0].hand=parseHand('p9999s123456789z5');
 assert.match(render(g),/data-kong-tile="p9" data-kong-kind="an">暗杠 · 9筒/);
 const wall=g.wall.length;kong(g,'p9','an');assert.equal(g.wall.length,wall-1);assert.deepEqual(g.players[0].melds,[{kind:'an',tile:'p9'}]);assert.equal(g.kongs.length,2);assert.ok(g.kongs.every(k=>k.amount===2));
});
test('supplementary kong is explicit; no kong when revealed waits change, on another turn, or empty wall',()=>{
 const g=newGame(undefined,{dealer:0});g.turn=0;g.players[0].hand=parseHand('p9123s456789z5');g.players[0].melds=[{kind:'peng',tile:'p9'}];g.drawTile='p9';
 assert.match(render(g),/data-kong-tile="p9" data-kong-kind="bu">补杠/);
 g.players[0].liang=true;g.players[0].liangWaits=[{tile:'s1'}];assert.doesNotMatch(render(g),/data-kong-tile/);g.players[0].liang=false;g.turn=1;assert.doesNotMatch(render(g),/data-kong-tile/);g.turn=0;g.wall=[];assert.doesNotMatch(render(g),/data-kong-tile/);
});
