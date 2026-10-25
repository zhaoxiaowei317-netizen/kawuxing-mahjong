import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {Rooms} from '../core/rooms.js';
import {newGame,parseHand,kong} from '../src/engine.js';
import {createSession} from '../src/session.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
await mkdir('.tmp',{recursive:true});
const directory=await mkdtemp(resolve('.tmp/rules-ui-'));
// Use only temporary fixture data; the real desktop room store is never loaded.
const rooms=new Rooms(),users=[rooms.create({name:'补杠者'})];
users.push(rooms.join(users[0].code,{name:'抢胡者'}),rooms.join(users[0].code,{name:'第三家'}));
const room=rooms.rooms.get(users[0].code),g=newGame({mode:'three'},{dealer:0});
g.players[0].hand=parseHand('p3789s23467z55');g.players[0].melds=[{kind:'peng',tile:'p3'}];g.drawTile='p3';
g.players[1].hand=parseHand('p12s123456789z77');g.players[2].hand=parseHand('p13579s13579z567');g.wall=['s8','p8'];
kong(g,'p3','bu');room.game=g;room.autoAt=0;
await writeFile(resolve(directory,'rooms.json'),JSON.stringify([...rooms.rooms]));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(done=>probe.close(done));
const child=spawn(process.execPath,['server/index.js'],{windowsHide:true,env:{...process.env,PORT:String(port),DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
let errors=[],serverErrors='';child.stderr.on('data',b=>serverErrors+=b);
let browser;
try{
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('UI server exited '+code+' '+serverErrors);})]);
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 const url='http://127.0.0.1:'+port;
 async function pageFor(init){const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));if(init)await page.addInitScript(init);return page;}

 // Source settings and actual runtime bundle must agree; ordinary self win costs each opponent one.
 const local=await pageFor();const hand=newGame({mode:'three'},{dealer:0});hand.players[0].hand=parseHand('p123456789s123z77');hand.drawTile='z7';
 const session=createSession('three');session.started=true;session.ready=[true,true,true];
 await local.addInitScript(({hand,session})=>{localStorage.setItem('kwx-lab-v1',JSON.stringify(hand));localStorage.setItem('kwx-session-v1',JSON.stringify(session));},{hand,session});
 await local.goto(url+'/index.html');await local.locator('#arena').waitFor();assert.equal(await local.locator('[data-action="win"]').count(),1);
 await local.locator('[data-action="menu"]').click();await local.locator('[data-nav="rules"]').click();assert.match(await local.locator('main').innerText(),/三人固定/);assert.match(await local.locator('main').innerText(),/普通自摸两家各付1倍/);
 await local.locator('[data-nav="table"]').click();await local.screenshot({path:resolve(directory,'single-table.png')});
 await local.locator('[data-action="win"]').click();await local.locator('.round-overlay').waitFor();const settled=await local.evaluate(()=>JSON.parse(localStorage.getItem('kwx-lab-v1')));assert.deepEqual(settled.result.delta,[2,-1,-1]);

 // Old local state is backed up, its history preserved and its live game never resumed under new rules.
 const legacy=await pageFor();await legacy.addInitScript(({hand})=>{delete hand.config.rulesVersion;hand.config.cap=32;localStorage.setItem('kwx-lab-v1',JSON.stringify(hand));},{hand});
 await legacy.goto(url+'/index.html');await legacy.locator('[data-action="start-session"]').waitFor();const migrated=await legacy.evaluate(()=>({backup:JSON.parse(localStorage.getItem('kwx-lab-legacy-v1')),current:JSON.parse(localStorage.getItem('kwx-lab-v1'))}));assert.equal(migrated.backup.config.cap,32);assert.equal(migrated.current.config.cap,16);assert.equal(migrated.current.config.rulesVersion,'xiaogan-1.0');
 await legacy.locator('[data-action="settings"]').click();assert.equal(await legacy.locator('select[name="cap"]').count(),0);const modes=await legacy.locator('select[name="mode"] option').allTextContents();assert.equal(modes.length,2);assert.ok(!modes.some(s=>/四人|轮换/.test(s)));

 // Three independent browser contexts create, join, prepare and restore one fixed room.
 const pages=[];for(let i=0;i<3;i++){const p=await pageFor();pages.push(p);await p.goto(url+'/online.html');await p.locator('[name="name"]').fill('玩家'+i);assert.equal(await p.locator('[name="cap"]').count(),0);}
 await pages[0].locator('[value="create"]').click();await pages[0].locator('[data-ready]').waitFor();const code=(await pages[0].locator('h1').innerText()).match(/\d{6}/)[0];
 for(let i=1;i<3;i++){await pages[i].locator('[name="code"]').fill(code);await pages[i].locator('[value="join"]').click();await pages[i].locator('[data-ready]').waitFor();}
 for(const p of pages){await p.reload();await p.locator('[data-ready]').waitFor();await p.locator('[data-ready]').click();}
 for(const p of pages)await p.locator('#arena').waitFor();
 const sizes=await Promise.all(pages.map(p=>p.locator('.hand-dock [data-tile-index]').count()));assert.deepEqual([...sizes].sort((a,b)=>a-b),[13,13,14]);
 for(const p of pages)assert.match(await p.locator('.room-tags').innerText(),/16倍封顶/);
 const identity=await pages[1].evaluate(()=>localStorage.getItem('kwx-online'));await pages[1].reload();await pages[1].locator('#arena').waitFor();assert.equal(await pages[1].evaluate(()=>localStorage.getItem('kwx-online')),identity);
 await pages[0].locator('[data-action="menu"]').click();await pages[0].locator('[data-nav="rules"]').click();await pages[0].locator('.rules-dialog[open]').waitFor();assert.match(await pages[0].locator('.rules-dialog').innerText(),/抢杠/);await pages[0].locator('.rules-dialog form button').click();await pages[0].locator('[data-action="menu-close"]').click();
 await pages[0].setViewportSize({width:390,height:844});await pages[0].screenshot({path:resolve(directory,'online-mobile.png')});await pages[0].setViewportSize({width:1440,height:900});await pages[0].screenshot({path:resolve(directory,'online-table.png')});

 // A live robbed supplement must show only hu/pass, settle through the actual HTTP endpoint,
 // and keep the original pung with no new kong fee.
 const robber=await pageFor();await robber.addInitScript(user=>localStorage.setItem('kwx-online',JSON.stringify({code:user.code,token:user.token})),users[1]);
 await robber.goto(url+'/online.html');await robber.locator('[data-choice="hu"]').waitFor();assert.match(await robber.locator('.current-status').innerText(),/申请补杠/);assert.equal(await robber.locator('[data-choice="peng"], [data-choice="ming"]').count(),0);await robber.screenshot({path:resolve(directory,'rob-kong.png')});await robber.locator('[data-choice="hu"]').click();await robber.locator('.round-overlay').waitFor();assert.match(await robber.locator('.round-overlay .detailed-result').innerText(),/抢杠胡/);
 const result=await robber.evaluate(async user=>(await (await fetch('/api/room?code='+user.code,{headers:{Authorization:'Bearer '+user.token}})).json()).game.result,users[1]);assert.deepEqual(result.delta,[-2,2,0]);assert.equal(result.kongs.length,0);assert.equal(result.players[0].melds[0].kind,'peng');
 assert.deepEqual(errors,[]);console.log('Browser checks passed: single win, old-state backup, fixed three clients, reconnect, shared rules, mobile layout, HTTP rob-kong.');console.log('Screenshots:',directory);
}catch(error){
 if(browser){let i=0;for(const context of browser.contexts())for(const page of context.pages()){await page.screenshot({path:resolve(directory,'failure-'+i+'.png')}).catch(()=>{});await writeFile(resolve(directory,'failure-'+i+'.txt'),await page.locator('body').innerText().catch(()=>''));i++;}}
 console.error('Browser errors:',errors);throw error;
}finally{
 await browser?.close();child.kill();
}
