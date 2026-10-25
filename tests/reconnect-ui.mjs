import {chromium} from '../../node_modules/playwright/index.mjs';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'8792',DATA_DIR:'artifacts/reconnect-data'},stdio:'pipe'});
await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext(),page=await context.newPage();
 await page.goto('http://127.0.0.1:8792');await page.locator('[name=name]').fill('重连测试');await page.locator('[value=create]').click();await page.locator('[data-ready]').waitFor();
 const saved=await page.evaluate(()=>localStorage.getItem('kwx-online'));
 await context.setOffline(true);await page.locator('#connection-status').waitFor();
 await context.setOffline(false);await page.locator('#connection-status').waitFor({state:'detached',timeout:20000});
 assert.equal(await page.evaluate(()=>localStorage.getItem('kwx-online')),saved);
 // A lost response must release the request lock after the timeout.
 await page.route('**/api/room?*',async route=>{await new Promise(r=>setTimeout(r,14000));await route.abort().catch(()=>{});});
 await page.reload();await page.locator('#connection-status').waitFor();
 await page.waitForTimeout(12500);await page.unroute('**/api/room?*');
 await page.getByRole('button',{name:'立即重连'}).click();await page.locator('[data-ready]').waitFor({timeout:20000});
 assert.equal(await page.evaluate(()=>localStorage.getItem('kwx-online')),saved);
 await page.reload();await page.locator('[data-ready]').waitFor();
 assert.equal(await page.locator('.ready-player strong').filter({hasText:'重连测试'}).count(),1);
 assert.equal(await page.locator('#entry').count(),0);
 console.log('Offline recovery, request timeout, reload and original seat credentials passed');
}finally{await browser.close();child.kill();}
