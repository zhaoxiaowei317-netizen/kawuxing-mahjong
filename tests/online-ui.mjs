import {chromium} from '../../node_modules/playwright/index.mjs';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'8793',DATA_DIR:'artifacts/online-test-data'},stdio:'pipe'});
await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exited '+c)));});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const pages=await Promise.all(Array.from({length:4},async()=>{const context=await browser.newContext({viewport:{width:1280,height:720}});return context.newPage();}));const errors=[];pages.forEach(p=>p.on('pageerror',e=>errors.push(e.message)));
 await pages[0].goto('http://127.0.0.1:8793');await pages[0].locator('[name="name"]').fill('甲');await pages[0].locator('[name="size"]').selectOption('4');await pages[0].locator('[value="create"]').click();await pages[0].locator('[data-ready]').waitFor();const code=(await pages[0].locator('h1').innerText()).match(/\d{6}/)[0];
 for(let i=1;i<4;i++){await pages[i].goto('http://127.0.0.1:8793');await pages[i].locator('[name="name"]').fill('玩家'+i);await pages[i].locator('[name="code"]').fill(code);await pages[i].locator('[value="join"]').click();await pages[i].locator('[data-ready]').waitFor();}
 await pages[0].waitForTimeout(1200);
 for(const p of pages){await p.locator('[data-ready]').click();await p.waitForTimeout(1200);}
 for(const p of pages)await p.locator('.hand-dock').waitFor();await pages[0].waitForTimeout(3200);
 assert.equal(await pages[0].locator('.hand-dock .tile').count(),14);assert.equal(await pages[1].locator('.hand-dock .tile').count(),13);
 const identity=await pages[1].evaluate(()=>localStorage.getItem('kwx-online'));
 await pages[1].context().setOffline(true);await pages[1].locator('#connection-status').waitFor();
 await pages[1].context().setOffline(false);await pages[1].locator('#connection-status').waitFor({state:'detached',timeout:20000});
 assert.equal(await pages[1].evaluate(()=>localStorage.getItem('kwx-online')),identity);
 assert.equal(await pages[1].locator('.hand-dock .tile').count(),13);
 await pages[3].locator('[data-watch="1"]').click();assert.equal(await pages[3].locator('[data-watch="1"]').getAttribute('aria-pressed'),'true');assert.ok(await pages[3].locator('[data-tile-index="0"]').isDisabled());
 await pages[0].locator('[data-tile-index="0"]').click({button:'right'});await pages[0].waitForTimeout(1200);await pages[1].reload();await pages[1].locator('.hand-dock').waitFor();
 for(const viewport of [{width:1920,height:1080},{width:390,height:844}]){await pages[0].setViewportSize(viewport);await pages[0].waitForTimeout(400);const sizes=await pages[0].evaluate(()=>{const c=document.querySelector('canvas'),h=document.querySelector('#scene-host');return {cw:c.clientWidth,ch:c.clientHeight,hw:h.clientWidth,hh:h.clientHeight};});assert.equal(sizes.cw,sizes.hw);assert.equal(sizes.ch,sizes.hh);await pages[0].screenshot({path:`artifacts/online-${viewport.width}.png`});}
 await pages[0].setViewportSize({width:1280,height:720});await pages[0].locator('[data-ledger]').click();await pages[0].locator('#live-ledger[open]').waitFor();assert.match(await pages[0].locator('#live-ledger').innerText(),/暂无/);await pages[0].locator('[data-ledger-close]').click();
 await pages[0].locator('[data-action="sound"]').click();assert.equal(await pages[0].locator('[data-action="sound"]').getAttribute('aria-pressed'),'false');
 await pages[0].screenshot({path:'artifacts/online-table.png'});
 pages[0].once('dialog',d=>d.accept());await pages[0].locator('[data-room-exit]').click();await pages[0].locator('#entry').waitFor();await pages[1].getByText('本桌已结束',{exact:true}).waitFor();
 await pages[0].locator('[name="name"]').fill('新房');await pages[0].locator('[value="create"]').click();await pages[0].locator('[data-ready]').waitFor();assert.notEqual((await pages[0].locator('h1').innerText()).match(/\d{6}/)[0],code);
 await pages[0].locator('[data-exit]').click();await pages[0].locator('#entry').waitFor();
 assert.deepEqual(errors,[]);console.log('Four clients: play, spectator, right-click, ledger, mute, exit synchronization and new room passed');
}finally{await browser.close();child.kill();}
