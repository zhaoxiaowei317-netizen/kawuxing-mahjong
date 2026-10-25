import {chromium} from '../../node_modules/playwright/index.mjs';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Rooms} from '../server/rooms.js';
import {newGame,finish,parseHand as H,reservedKongTiles} from '../src/engine.js';
const rooms=new Rooms();
function fixture(self){
 const users=[rooms.create({name:'甲'} )];users.push(rooms.join(users[0].code,{name:'乙'}),rooms.join(users[0].code,{name:'丙'}));const r=rooms.rooms.get(users[0].code);
 const previous=newGame();previous.players[0].hand=H('p112233s445566z77');previous.drawTile='z7';finish(previous,[0]);
 const g=newGame({base:1,cap:32,mode:'three'},{history:previous.history,totals:previous.totals,round:2});r.game=g;r.autoAt=0;
 g.players[0].hand=H('p12999s123456z77');g.players[0].liang=true;g.players[0].liangKongTiles=reservedKongTiles(g.players[0]);
 g.players[1].melds=[{kind:'an',tile:'p8'},{kind:'ming',tile:'s7'}];g.players[1].hand=H('p456s123z5');
 g.players[2].hand=H('p14567s123459z56');g.wall=['s8','s9','p5'];
 if(self){g.turn=0;g.drawTile='p9';g.players[0].hand.push('p9');}
 else{g.turn=2;g.phase='react';g.pending={source:2,tile:'p9',responses:{1:'pass'}};g.players[2].river=['p9'];}
 return users;
}
const self=fixture(true),exposed=fixture(false);await mkdir('artifacts/reveal-ui-data',{recursive:true});await writeFile('artifacts/reveal-ui-data/rooms.json',JSON.stringify([...rooms.rooms]));
const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'8791',DATA_DIR:'artifacts/reveal-ui-data'},stdio:'pipe'});
await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const errors=[];
 async function pageFor(user){const context=await browser.newContext({viewport:{width:1280,height:720}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(u=>{if(!sessionStorage.getItem('fixture-loaded')){localStorage.setItem('kwx-online',JSON.stringify({code:u.code,token:u.token}));sessionStorage.setItem('fixture-loaded','1');}},user);await page.goto('http://127.0.0.1:8791');await page.locator('#arena').waitFor();return page;}
 const a=await pageFor(self[0]),b=await pageFor(self[1]);
 await a.locator('[data-kong-kind=an]').waitFor();await a.waitForTimeout(1600);assert.equal(await a.locator('[data-kong-kind=an]').count(),1);
 await b.screenshot({path:'artifacts/revealed-triplet-hidden.png'});
 await a.locator('[data-ledger]').click();const summary=a.locator('#live-ledger .history-round>summary');assert.match(await summary.innerText(),/甲 \+8分/);assert.match(await summary.innerText(),/乙 -4分/);
 await summary.click();await a.waitForTimeout(1000);assert.equal(await a.locator('#live-ledger .history-round').getAttribute('open'),'');await a.locator('[data-ledger-close]').click();
 await a.locator('[data-kong-kind=an]').click();await a.locator('.own-meld .face-down').waitFor();assert.equal(await a.locator('.own-meld .face-down').count(),1);assert.equal(await a.locator('.own-meld .tile:not(.face-down)').count(),3);
 await a.waitForTimeout(1000);await a.screenshot({path:'artifacts/kong-one-covered.png'});
 a.once('dialog',d=>d.accept());await a.locator('[data-room-exit]').click();await a.locator('#entry').waitFor();await b.getByText('本桌已结束',{exact:true}).waitFor();assert.match(await b.locator('.match-totals').innerText(),/\+8分/);
 await a.locator('[data-archives]').click();assert.match(await a.locator('.archived-room').innerText(),/甲/);await a.reload();await a.locator('[data-archives]').click();await a.locator('.history-round>summary').click();assert.match(await a.locator('.detailed-result').innerText(),/七对/);await a.screenshot({path:'artifacts/persistent-history.png'});
 const c=await pageFor(exposed[0]);await c.locator('[data-choice=ming]').waitFor();await c.waitForTimeout(1200);assert.equal(await c.locator('[data-choice=peng]').count(),0);
 const gap=await c.evaluate(()=>{const a=document.querySelector('[data-choice=pass]').getBoundingClientRect(),b=document.querySelector('[data-choice=ming]').getBoundingClientRect();return b.left-a.right;});assert.ok(gap>=60);
 await c.screenshot({path:'artifacts/revealed-kong-choice-desktop.png'});await c.setViewportSize({width:390,height:844});await c.waitForTimeout(400);await c.screenshot({path:'artifacts/revealed-kong-choice-mobile.png'});
 await c.locator('[data-choice=ming]').click();await c.locator('.own-meld').waitFor();assert.equal(await c.locator('.own-meld .tile').count(),4);
 assert.deepEqual(errors,[]);console.log('Revealed kong choices, one covered tile, wider controls, summaries and persistent archives passed');
}finally{await browser.close();child.kill();}
