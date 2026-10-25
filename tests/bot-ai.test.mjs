import test from 'node:test';
import assert from 'node:assert/strict';
import {newGame,parseHand,visibleCounts,chooseDiscard} from '../src/engine.js';

test('visibleCounts aggregates self hand, all rivers, all melds and revealed opponent hands',()=>{
 const g=newGame({base:1,cap:32,mode:'three'},{dealer:0});
 g.players[0].hand=['p1','p2','p3','s5'];
 g.players[0].river=['z5'];
 g.players[1].river=['z5','s1'];
 g.players[1].melds=[{kind:'peng',tile:'p9'}];
 g.players[2].hand=['z7','z7','z7'];
 g.players[2].liang=true;
 g.players[2].melds=[{kind:'ming',tile:'s2'}];
 const vis=visibleCounts(g,0);
 assert.equal(vis.p1,1);
 assert.equal(vis.p2,1);
 assert.equal(vis.p3,1);
 assert.equal(vis.s5,1);
 assert.equal(vis.z5,2);
 assert.equal(vis.s1,1);
 assert.equal(vis.p9,3);
 assert.equal(vis.s2,4);
 assert.equal(vis.z7,3);
});

test('chooseDiscard rational reveal gating avoids dead waits, tail wall, and bad oppLiang trades',()=>{
 // Hand: p123 s123 s567 z55 p45 s9 (14 tiles). Discarding s9 leaves 13 tiles waiting on p3, p6
 const hand=parseHand('p12345s1235679z55');
 const p={hand:[...hand],melds:[],river:[],liang:false};

 // Fallback without g: normal reveal when readyOuts >= 2
 const resNoG=chooseDiscard(p,'s9');
 assert.equal(resNoG.reveal,true);

 // 1. Tail wall (wall.length < 10): must NOT reveal
 const gTail=newGame({base:1,cap:32,mode:'three'},{dealer:0});
 gTail.players[0].hand=[...hand];
 gTail.wall=Array(9).fill('p1');
 const resTail=chooseDiscard(gTail.players[0],'s9',null,gTail,0);
 assert.equal(resTail.reveal,false,'should not reveal when wall < 10');

 // 2. Dead waits (readyOuts < 2): all p3 and p6 are visible in rivers/melds
 const gDead=newGame({base:1,cap:32,mode:'three'},{dealer:0});
 gDead.players[0].hand=[...hand];
 gDead.players[1].river=['p3','p3','p3','p3'];
 gDead.players[2].river=['p6','p6','p6'];
 // only 1 p6 left, readyOuts = 1 < 2
 const resDead=chooseDiscard(gDead.players[0],'s9',null,gDead,0);
 assert.equal(resDead.reveal,false,'should not reveal when readyOuts < 2');

 // 3. Opponent already revealed (oppLiang): ordinary 2-point hand with readyOuts = 3 < 4 must NOT reveal
 const gOpp=newGame({base:1,cap:32,mode:'three'},{dealer:0});
 gOpp.players[0].hand=[...hand]; // waiting p3, p6 (ordinary pinghu/liangdao, maxRaw = 2)
 gOpp.players[1].liang=true;
 gOpp.players[1].hand=['s1','s2','s3'];
 gOpp.players[2].river=['p3','p3','p3','p6','p6']; // 1 p3 left + 2 p6 left = 3 outs (< 4)
 const resOpp=chooseDiscard(gOpp.players[0],'s9',null,gOpp,0);
 assert.equal(resOpp.reveal,false,'ordinary hand with < 4 outs should not counter-reveal against oppLiang');

 // 4. Opponent revealed, but outs >= 4: CAN counter-reveal
 const gOppGood=newGame({base:1,cap:32,mode:'three'},{dealer:0});
 gOppGood.players[0].hand=[...hand];
 gOppGood.players[1].liang=true;
 gOppGood.players[1].hand=['s1','s2','s3'];
 // full 8 outs available for p3, p6
 const resOppGood=chooseDiscard(gOppGood.players[0],'s9',null,gOppGood,0);
 assert.equal(resOppGood.reveal,true,'should reveal against oppLiang when readyOuts >= 4');

 // 5. Opponent revealed, big hand (pengpenghu, maxRaw >= 4) with readyOuts >= 2: CAN counter-reveal
 // Hand: p111 p222 p333 s11 z55 s9 (14 tiles). Discarding s9 leaves waiting on s1, z5
 const bigHand=parseHand('p111222333s119z55');
 const gBig=newGame({base:1,cap:32,mode:'three'},{dealer:0});
 gBig.players[0].hand=[...bigHand];
 gBig.players[1].liang=true;
 gBig.players[1].hand=['s2','s3','s4'];
 gBig.players[2].river=['s1','z5']; // s1 has 1 visible outside (+2 in hand = 3 visible, 1 left); z5 has 1 visible outside (+2 in hand = 3 visible, 1 left) -> readyOuts = 2 >= 2
 const resBig=chooseDiscard(gBig.players[0],'s9',null,gBig,0);
 assert.equal(resBig.reveal,true,'big hand (maxRaw >= 4) with >= 2 outs should counter-reveal');
});
