import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLocalGame} from '../src/local-state.js';
import {newGame,RULES_VERSION} from '../src/engine.js';
function store(value,fail=false){const values=new Map([['kwx-lab-v1',value]]);return {values,getItem:k=>values.get(k),setItem:(k,v)=>{if(fail)throw Error('quota');values.set(k,v);}};}
test('current-version state resumes exactly, including private opportunity and pass restrictions',()=>{const g=newGame({}, {dealer:0});g.players[0].passedHu=['p3'];g.players[0].buOpportunities=['s8'];const storage=store(JSON.stringify(g)),r=loadLocalGame(storage);assert.deepEqual(r.game,g);assert.equal(r.migrated,false);assert.equal(r.writable,true);});
test('legacy live state is backed up exactly and previous settled history retained',()=>{const g=newGame({}, {dealer:0});delete g.config.rulesVersion;g.config.cap=32;g.history=[{round:1,delta:[1,-1,0],seats:[0,1,2]}];const original=JSON.stringify(g),storage=store(original),r=loadLocalGame(storage);assert.equal(storage.values.get('kwx-lab-legacy-v1'),original);assert.equal(storage.values.get('kwx-lab-v1'),original);assert.equal(r.game.config.rulesVersion,RULES_VERSION);assert.deepEqual(r.game.history,g.history);assert.equal(r.migrated,true);});
test('backup failure or corrupt data forbids overwriting the original save',()=>{for(const raw of [JSON.stringify({players:[],config:{cap:32}}),'{broken']){const storage=store(raw,true),r=loadLocalGame(storage);assert.equal(r.writable,false);assert.equal(storage.values.get('kwx-lab-v1'),raw);}});
