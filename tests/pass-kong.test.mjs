import test from 'node:test';
import assert from 'node:assert/strict';
import {newGame,parseHand as H,respond,kong,reactionOptions} from '../src/engine.js';

function fixture(copies=3){
 const g=newGame({base:1,cap:32,mode:'three'},{dealer:0});
 g.players[1].hand=[...Array(copies).fill('p9'),...H('p123s123456z7').slice(0,13-copies)];
 g.players[0].river=['p9'];g.turn=0;g.phase='react';
 g.pending={tile:'p9',source:0,responses:{2:'pass'}};
 return g;
}
test('choosing pung instead of exposed kong permanently forbids supplemental kong',()=>{
 const g=fixture();
 assert.ok(reactionOptions(g,1).includes('peng'));
 assert.ok(reactionOptions(g,1).includes('ming'));
 respond(g,1,'peng');
 assert.equal(g.players[1].melds[0].supplementForbidden,true);
 const restored=JSON.parse(JSON.stringify(g)),before=JSON.stringify(restored);
 assert.throws(()=>kong(restored,'p9','bu'),/放弃杠/);
 assert.equal(JSON.stringify(restored),before);
});
test('ordinary pung from two copies still permits a later supplemental kong',()=>{
 const g=fixture(2);respond(g,1,'peng');
 assert.ok(!g.players[1].melds[0].supplementForbidden);
 g.players[1].hand.push('p9');g.drawTile='p9';g.players[0].hand=[];g.players[2].hand=[];kong(g,'p9','bu');
 assert.equal(g.players[1].melds[0].kind,'bu');
 assert.deepEqual(g.kongs.map(k=>k.amount),[1,1]);
});
test('taking the exposed kong immediately is still allowed',()=>{
 const g=fixture();respond(g,1,'ming');
 assert.equal(g.players[1].melds[0].kind,'ming');
 assert.equal(g.kongs[0].amount,2);
});
