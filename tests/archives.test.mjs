import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveRoom,loadArchives} from '../src/room-archives.js';
import {historyHTML,totalsHTML} from '../src/settlement.js';
import {Rooms} from '../server/rooms.js';
import {newGame,finish,parseHand} from '../src/engine.js';
test('archive survives leaving, new room and reload with original names and totals',()=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
 const g=newGame(undefined,{dealer:0});g.players[0].hand=parseHand('p112233s445566z77');g.drawTile='z7';finish(g,[0]);
 const state={code:'123456',members:[{name:'A'},{name:'B'},{name:'C'}],game:g};archiveRoom(storage,state);
 state.closed=true;archiveRoom(storage,state);archiveRoom(storage,state);assert.equal(loadArchives(storage).length,1);
 archiveRoom(storage,{...state,code:'222222',members:[{name:'X'},{name:'Y'},{name:'Z'}]});assert.equal(loadArchives(storage).length,2);
 const old=loadArchives(storage).find(r=>r.code==='123456');assert.deepEqual(old.names,['A','B','C']);assert.deepEqual(old.totals,g.totals);
 const html=historyHTML(old.history,old.names);assert.match(html,/<summary>.*A自摸.*A \+8分.*B -4分.*C -4分/s);assert.match(totalsHTML(old.totals,old.names),/A/);
});
test('server retains settled totals and history after exit and idle cleanup',()=>{
 const rooms=new Rooms(),a=rooms.create({name:'A'}),b=rooms.join(a.code,{name:'B'});rooms.join(a.code,{name:'C'});const r=rooms.rooms.get(a.code);r.game=newGame(undefined,{dealer:0});r.game.players[0].hand=parseHand('p112233s445566z77');r.game.drawTile='z7';finish(r.game,[0]);
 const left=rooms.leave(a.code,a.token);assert.equal(left.snapshot.game.history.length,1);const expected=left.snapshot.game.totals;
 r.updated=0;rooms.tick();assert.deepEqual(rooms.view(r,b.token).game.totals,expected);assert.ok(rooms.rooms.has(a.code));
 const restored=new Rooms(JSON.parse(JSON.stringify([...rooms.rooms])));assert.equal(restored.view(restored.rooms.get(a.code),b.token).game.history.length,1);
});
