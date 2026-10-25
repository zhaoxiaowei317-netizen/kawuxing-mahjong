import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import * as Core from '../core/engine.js';
import {Rooms} from '../core/rooms.js';
import {remainingTiles} from '../src/hand-preview.js';
import {gameTable} from '../src/game-table.js';
const H=E.parseHand,bad='p13579s13579z567',ordinary='p123456789s123z77';
function rng(seed){return max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};}
function game(){const g=E.newGame({mode:'three'},{dealer:0},rng(7));g.players.forEach(p=>Object.assign(p,{hand:H(bad),river:[],melds:[],liang:false}));g.wall=['s8','p8','s9','p9'];return g;}
function reaction(g,tile,source=0,extra={}){g.phase='react';g.turn=source;g.pending={tile,source,responses:{},...extra};}
function robFixture(chain=0,double=false){const g=game();g.players[0].hand=H('p3789s23467z55');g.players[0].melds=[{kind:'peng',tile:'p3'}];g.drawTile='p3';g.gangChain=chain;g.players[1].hand=H('p12s123456789z77');if(double)g.players[2].hand=H('p12s123456789z77');return g;}
const render=g=>gameTable(g,0,-1,false,false,false,()=>'',()=>'',()=>'',false);

test('all entry points share rules, configuration always fixes three players and 16 cap',()=>{
 assert.equal(Core.newGame,E.newGame);
 for(const cap of [0,16,32]){const g=E.newGame({cap,mode:'rotate'},{dealer:0});assert.equal(g.config.cap,16);assert.equal(g.config.rulesVersion,E.RULES_VERSION);assert.equal(g.config.mode,'three');assert.equal(g.bench,null);assert.equal(g.totals.length,3);assert.equal(E.amount(100,{base:3,cap}),48);}
 assert.throws(()=>E.newGame({base:0}));assert.throws(()=>E.newGame({}, {seats:[0,1,3]}));
});
test('opening random dealer covers every seat and deterministic random input replays the full deal',()=>{
 const dealers=new Set();for(let seed=1;seed<=30;seed++){const a=E.newGame({},null,rng(seed)),b=E.newGame({},null,rng(seed));assert.equal(a.dealer,b.dealer);assert.deepEqual(a.players,b.players);assert.deepEqual(a.wall,b.wall);dealers.add(a.dealer);assert.equal(a.players[a.dealer].hand.length,14);for(let i=0;i<3;i++)if(i!==a.dealer)assert.equal(a.players[i].hand.length,13);assert.equal(a.turn,a.dealer);assert.equal(a.wall.length,44);}assert.equal(dealers.size,3);
});
test('draw retains actual dealer, regardless of the last drawer',()=>{const g=game();g.dealer=2;g.lastDraw=1;E.finish(g);assert.equal(g.result.next.dealer,2);assert.deepEqual(g.result.next.seats,[0,1,2]);});
test('ordinary self draw pays 1 each, or independently 2/4 for revealed payer pairs',()=>{
 for(const [own,other,expected] of [[false,false,[2,-1,-1]],[false,true,[3,-2,-1]],[true,false,[4,-2,-2]],[true,true,[6,-4,-2]]]){const g=game();g.players[0].hand=H(ordinary);g.drawTile='z7';g.players[0].liang=own;g.players[1].liang=other;E.finish(g,[0]);assert.deepEqual(g.result.delta,expected);}
});
test('point ordinary needs 2; revealed source grants eligibility, self has no separate multiplier',()=>{
 const g=game();g.players[1].hand=H('p123456789s123z7');reaction(g,'z7');assert.equal(E.canWin(g,1,0),false);g.players[0].liang=true;assert.equal(E.canWin(g,1,0),true);assert.equal(E.scoresFor(g,1,0)[0].raw,2);
 const h=H('p111s222333444z77');assert.equal(E.evaluate(h,[],{self:true,winTile:'z7'}).raw,2);
});
test('all seven-pair levels are legal, including three quads; quad counts as two pairs in distance',()=>{
 for(const [hand,raw] of [['p112233s445566z77',4],['p111122s334455z77',8],['p11112222s3344z77',16],['p111122223333s55',32]]){const score=E.evaluate(H(hand),[],{self:true,winTile:H(hand).at(-1)});assert.equal(score.raw,raw);assert.equal(score.legal,true);assert.equal(score.warning,null);assert.equal(E.distance(H(hand)),-1);assert.equal(E.distance(H(hand).slice(0,-1)),0);assert.ok(!score.factors.some(f=>f.name==='暗四归'));}
});
test('four-return only applies when the fourth copy is the winning tile',()=>{
 const h=H('p111123s456789z77');assert.equal(E.evaluate(h,[],{winTile:'p1'}).raw,4);assert.equal(E.evaluate(h,[],{winTile:'z7'}).raw,1);
 const m=[{kind:'peng',tile:'p1'}],hand=H('p123s456789z77');assert.equal(E.evaluate(hand,m,{winTile:'p1'}).raw,2);assert.equal(E.evaluate(hand,m,{winTile:'z7'}).raw,1);
});
test('all-exposed hand is 4, includes pung hand, and excludes concealed kong',()=>{
 const m=['p1','p3','s7','z7'].map(tile=>({kind:'peng',tile}));for(const self of [true,false]){const s=E.evaluate(H('s55'),m,{winTile:'s5',self});assert.equal(s.raw,4);assert.ok(!s.factors.some(f=>f.name==='碰碰胡'));}
 m[0].kind='an';assert.equal(E.evaluate(H('s55'),m,{winTile:'s5'}).raw,2);
});
test('three successive concealed kongs increase each fee 2/4/8 and kong-open factor 2/4/8',()=>{
 const g=game();g.players[0].hand=H('p111122223333z55');g.wall=['s8','s9','s7','s6'];
 for(const [i,t] of ['p1','p2','p3'].entries()){E.kong(g,t,'an');assert.equal(g.gangChain,i+1);assert.deepEqual(g.kongs.slice(i*2).map(k=>k.amount),[2**(i+1),2**(i+1)]);}
 const h=H(ordinary);for(let n=1;n<=4;n++)assert.equal(E.evaluate(h,[],{self:true,gang:n,winTile:'z7'}).raw,2**n);
});
test('next player direct kong continues chain, pung and ordinary draw break it',()=>{
 const g=game();g.players[1].hand=H('p333s123456z5577');g.players[0].river=['p3'];reaction(g,'p3',0,{gangShot:2,responses:{2:'pass'}});E.respond(g,1,'ming');assert.equal(g.gangChain,3);assert.equal(g.kongs[0].amount,8);
 const h=game();h.players[1].hand=H('p33s1234567z5577');h.players[0].river=['p3'];reaction(h,'p3',0,{gangShot:2,responses:{2:'pass'}});E.respond(h,1,'peng');assert.equal(h.gangChain,0);E.draw(g,2);assert.equal(g.gangChain,0);
});
test('rob supplement cancels only attempted kong, preserves previous fees and identifies source dealer',()=>{
 const g=robFixture(1);g.kongs=[{from:1,to:0,amount:2,why:'此前暗杠'}];const beforeWall=[...g.wall];E.kong(g,'p3','bu');assert.equal(g.phase,'react');assert.equal(g.pending.kind,'robKong');assert.deepEqual(E.reactionOptions(g,1),['hu']);assert.equal(E.scoresFor(g,1,0)[0].raw,4);E.respond(g,1,'hu');assert.equal(g.phase,'ended');assert.equal(g.players[0].melds[0].kind,'peng');assert.equal(g.kongs.length,1);assert.deepEqual(g.wall,beforeWall);assert.deepEqual(g.result.delta,[-2,2,0]);assert.equal(g.result.next.dealer,1);assert.equal(g.players[0].river.at(-1),'p3');
});
test('two robbers both receive from supplement actor; actor is next dealer',()=>{
 const g=robFixture(0,true);E.kong(g,'p3','bu');E.respond(g,1,'hu');assert.equal(g.phase,'react');E.respond(g,2,'hu');assert.deepEqual(g.result.winners,[1,2]);assert.deepEqual(g.result.delta,[-4,2,2]);assert.equal(g.result.next.dealer,0);assert.equal(g.kongs.length,0);
});
test('declined rob finishes supplement and draws once, with correct consecutive fee',()=>{
 const g=robFixture(2);const length=g.wall.length;E.kong(g,'p3','bu');E.respond(g,1,'pass');assert.equal(g.players[0].melds[0].kind,'bu');assert.equal(g.gangChain,3);assert.deepEqual(g.kongs.map(k=>k.amount),[4,4]);assert.equal(g.wall.length,length-1);assert.equal(g.drawTile,'s8');assert.ok(g.players[1].passedHu.includes('p3'));
});
test('cannot supplement a revealed opponent wait, even if they previously passed it',()=>{
 const g=robFixture();g.players[1].liang=true;g.players[1].passedHu=['p3'];assert.ok(!E.selfKongOptions(g).some(o=>o.tile==='p3'));const before=structuredClone(g);assert.throws(()=>E.kong(g,'p3','bu'));assert.deepEqual(g,before);
});
test('same-turn supplement opportunity survives intervening concealed kong and replacement draws',()=>{
 const g=game();g.players[0].hand=H('p3s9999p789z55s1');g.players[0].melds=[{kind:'peng',tile:'p3'}];g.drawTile='p3';g.wall=['s8','s7','s6'];g.players[0].buOpportunities=['p3'];E.kong(g,'s9','an');assert.ok(E.selfKongOptions(g).some(o=>o.tile==='p3'));const restored=JSON.parse(JSON.stringify(g));E.kong(restored,'p3','bu');assert.equal(restored.players[0].melds[0].kind,'bu');assert.equal(restored.gangChain,2);assert.deepEqual(restored.kongs.slice(-2).map(k=>k.amount),[2,2]);
});
test('unused supplement expires on discard and stays forbidden across reload',()=>{
 const g=game();g.players[0].hand=H('p3p789s23467z55');g.players[0].melds=[{kind:'peng',tile:'p3'}];g.drawTile='p3';g.players[0].buOpportunities=['p3'];E.discard(g,g.players[0].hand.indexOf('p7'));assert.equal(g.players[0].melds[0].supplementForbidden,true);const copy=JSON.parse(JSON.stringify(g));copy.phase='discard';copy.turn=0;copy.drawTile='p3';const before=structuredClone(copy);assert.throws(()=>E.kong(copy,'p3','bu'));assert.deepEqual(copy,before);
});
test('pass hu locks only that kind for point and rob claims until own next draw',()=>{
 const g=game();g.players[1].hand=H('p12345s123567z55');g.players[2].hand=H('p33s13579p789z567');g.players[0].river=['p3'];reaction(g,'p3',0,{gangShot:1});E.respond(g,1,'pass');E.respond(g,2,'peng');assert.ok(g.players[1].passedHu.includes('p3'));
 reaction(g,'p3',2,{gangShot:2});assert.equal(E.canWin(g,1,2),false);g.pending.kind='robKong';g.pending.gangCount=3;assert.equal(E.canWin(g,1,2),false);g.pending.tile='p6';assert.equal(E.canWin(g,1,2),true);
 g.wall=['p6','p6'];E.draw(g,1,true);assert.deepEqual(g.players[1].passedHu,[]);assert.equal(E.canWin(g,1),true);
});
test('pass pung locks same kind; replacement draw clears it; blocked request is immutable',()=>{
 const g=game();g.players[2].hand=H('p33s13579p789z567');reaction(g,'p3',0,{responses:{1:'pass'}});E.respond(g,2,'pass');assert.equal(g.turn,1);assert.ok(g.players[2].passedPeng.includes('p3'));reaction(g,'p3',1);assert.ok(!E.reactionOptions(g,2).includes('peng'));const before=structuredClone(g);assert.throws(()=>E.respond(g,2,'peng'));assert.deepEqual(g,before);E.draw(g,2,true);assert.deepEqual(g.players[2].passedPeng,[]);reaction(g,'p3',1);assert.ok(E.reactionOptions(g,2).includes('peng'));
});
test('revealed player can pass point hu; passing self draw also locks that tile',()=>{
 const g=game();g.players[2].hand=H('p12s123456789z77');g.players[2].liang=true;reaction(g,'p3',0,{responses:{1:'pass'}});E.respond(g,2,'pass');assert.ok(g.players[2].passedHu.includes('p3'));
 const h=game();h.players[0].hand=H(ordinary);h.drawTile='z7';E.discard(h,0);assert.ok(h.players[0].passedHu.includes('z7'));
});
test('pung cannot turn an available ron into a self draw in engine or rendered controls',()=>{
 const g=game();g.players[1].hand=H('p1112223334445');reaction(g,'p1',0,{responses:{2:'pass'}});E.respond(g,1,'peng');assert.equal(g.drawTile,null);assert.equal(E.canWin(g,1),false);const before=structuredClone(g);assert.throws(()=>E.finish(g,[1]));assert.deepEqual(g,before);assert.ok(!gameTable(g,1,-1,false,false,false,()=>'',()=>'',()=>'',false).includes('data-action="win"'));
});
test('dead waits may reveal, reveal is immediate for the declaration discard, and cannot be repeated',()=>{
 const g=game();g.players[0].hand=H('p123456789s123z7s8');g.players[1].river=['z7','z7','z7'];g.players[2].hand=H('p123456789s123s8');E.discard(g,13,true);assert.equal(g.players[0].liang,true);assert.equal(g.phase,'react');assert.equal(E.canWin(g,2,0),true);assert.equal(E.scoresFor(g,2,0)[0].raw,2);E.respond(g,2,'hu');assert.deepEqual(g.result.delta,[-2,0,2]);
 const h=game();h.players[0].liang=true;h.drawTile=h.players[0].hand.at(-1);assert.throws(()=>E.discard(h,12,true),/重新宣告/);
});
test('last replacement win and shot both combine sea with consecutive kong factor',()=>{
 const h=H(ordinary);assert.equal(E.evaluate(h,[],{winTile:'z7',self:true,gang:3,sea:true}).raw,16);assert.equal(E.evaluate(h,[],{winTile:'z7',gangShot:3,sea:true}).raw,16);
 const g=game();g.players[0].hand=H('z6666p123456s12z55');g.wall=['s3'];E.kong(g,'z6','an');assert.equal(g.wall.length,0);assert.equal(E.scoresFor(g,0)[1].raw,4);assert.equal(E.canWin(g,0),true);assert.deepEqual(E.selfKongOptions(g),[]);
});
test('mixed draw doubles revealed receiver once, includes dead waits and no fictitious sea/kong factor',()=>{
 const ps=[{hand:H('p123456789s123z7'),melds:[],liang:true},{hand:H(bad),melds:[],liang:false},{hand:H(bad),melds:[],liang:false}];ps[1].river=['z7','z7','z7'];const result=E.drawSettlement(ps,[],{base:1,cap:32});assert.deepEqual(result.delta,[4,-2,-2]);assert.equal(result.ready[0][0],'z7');assert.ok(result.lines.every(l=>!l.why.includes('海底')&&!l.why.includes('杠上')));
});
test('revealing oneself never grants opponent hands, hidden triples or private decision state',()=>{
 const rooms=new Rooms(),clients=[rooms.create({name:'A'})];for(const name of ['B','C'])clients.push(rooms.join(clients[0].code,{name}));const r=rooms.rooms.get(clients[0].code);r.game=game();const g=r.game;g.players[0].liang=true;g.players[1].hand=H('p111s123456789z5');g.players[1].liang=true;g.players[1].passedHu=['p8'];g.players[1].buOpportunities=['p8'];g.players[2].hand=H('p123456789s123z7');
 const first=rooms.view(r,clients[0].token);assert.ok(first.game.players[1].hand.slice(0,3).every(t=>t==='?'));assert.ok(first.game.players[2].hand.every(t=>t==='?'));assert.equal(first.game.players[1].passedHu,undefined);assert.equal(first.game.players[1].buOpportunities,undefined);assert.equal(first.game.players[1].dealHand,undefined);assert.ok(first.game.wall.every(t=>t==='?'));
 const visible=E.visibleCounts(g,0),remaining=remainingTiles(g,0),choice=E.chooseDiscard(g.players[0],g.drawTile,null,g,0);
 g.players[1].hand=H('p222s123456789z5');g.players[2].hand.reverse();g.wall.reverse();g.players[1].passedHu=['s8'];g.players[1].buOpportunities=['s8'];
 assert.deepEqual(E.visibleCounts(g,0),visible);assert.deepEqual(remainingTiles(g,0),remaining);assert.deepEqual(E.chooseDiscard(g.players[0],g.drawTile,null,g,0),choice);assert.deepEqual(rooms.view(r,clients[0].token),first);
});
test('public counter identifies completed concealed kong and pending supplement but not unrevealed hands',()=>{
 const g=robFixture();g.players[2].melds=[{kind:'an',tile:'z6'}];E.kong(g,'p3','bu');const vis=E.visibleCounts(g,1);assert.equal(vis.z6,4);assert.equal(vis.p3,4);assert.equal(E.visibleCounts(g,0).p3,4);
});
test('100 reproducible complete games conserve 84 tiles and settle zero-sum scores',()=>{
 for(let seed=1;seed<=100;seed++){
  const g=E.newGame({mode:'bots'},null,rng(seed));let moves=0;
  while(g.phase!=='ended'&&moves++<400){const seat=g.phase==='react'?[0,1,2].find(i=>i!==g.pending.source&&!g.pending.responses[i]):g.turn;E.botStep(g,seat);const all=[...g.wall,...g.players.flatMap(p=>[...p.hand,...p.river,...p.melds.flatMap(m=>Array(m.kind==='peng'?3:4).fill(m.tile))])];assert.equal(all.length,84,'seed '+seed);assert.ok(Object.values(E.counts(all)).every(n=>n===4),'seed '+seed);}
  assert.equal(g.phase,'ended','seed '+seed);assert.equal(g.result.delta.reduce((a,b)=>a+b),0);assert.equal(g.totals.reduce((a,b)=>a+b),0);
 }
});
test('16 cap is per payer and per winner, with kong ledger added separately',()=>{
 const score={legal:true,raw:128,factors:[{name:'组合牌型',n:128}]},config={base:1,cap:32};
 assert.deepEqual(E.winSettlement([], [0],null,{0:{1:score,2:score}},[],config).delta,[32,-16,-16]);
 assert.deepEqual(E.winSettlement([], [1,2],0,{1:{0:score},2:{0:score}},[{from:0,to:1,amount:64}],config).delta,[-96,80,16]);
});
test('pung after the final draw keeps play alive and its subsequent shot gets sea only',()=>{
 const g=game();g.wall=[];g.players[0].river=['p3'];g.players[1].hand=H('p33s13579p789z567');g.players[2].hand=H('p123456789s123z7');reaction(g,'p3',0,{gangShot:2,responses:{2:'pass'}});
 E.respond(g,1,'peng');assert.equal(g.phase,'discard');assert.equal(g.gangChain,0);E.discard(g,g.players[1].hand.indexOf('z7'));assert.equal(g.pending.gangShot,0);assert.equal(E.scoresFor(g,2,1)[1].raw,2);E.respond(g,2,'hu');assert.deepEqual(g.result.delta,[0,-2,2]);
});
test('fourth kong does not abort the hand and charges consecutive fee without hu cap',()=>{
 const g=game();g.players[0].hand=H('p1111z5');g.players[0].melds=['p2','p3','p4'].map(tile=>({kind:'an',tile}));g.gangChain=3;g.wall=['z6','z7'];
 E.kong(g,'p1','an');assert.equal(g.phase,'discard');assert.equal(g.players[0].melds.length,4);assert.equal(g.gangChain,4);assert.deepEqual(g.kongs.map(k=>k.amount),[16,16]);assert.equal(g.wall.length,1);
});
test('unrevealed bot decisions do not change when opponent reserved triplets change identity',()=>{
 const g=game();g.players[0].hand=H('p12345s1235679z55');g.drawTile='s9';g.players[1].hand=H('p111s123456789z5');g.players[1].liang=true;
 const allowed=E.discardPolicy(g,0).allowed,visible=E.visibleCounts(g,0),choice=E.chooseDiscard(g.players[0],g.drawTile,allowed,g,0);
 g.players[1].hand=H('p222s123456789z5');assert.deepEqual(E.discardPolicy(g,0).allowed,allowed);assert.deepEqual(E.visibleCounts(g,0),visible);assert.deepEqual(E.chooseDiscard(g.players[0],g.drawTile,allowed,g,0),choice);
});
