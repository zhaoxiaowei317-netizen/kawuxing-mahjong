import {chromium} from '../../node_modules/playwright/index.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {newGame,finish,parseHand} from '../src/engine.js';
import {createSession} from '../src/session.js';
const game=newGame();game.players[0].hand=parseHand('p112233s445566z77');game.drawTile='z7';finish(game,[0]);
const session=createSession('bots',16,0);session.started=true;
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(new URL('../dist'+(path==='/'?'/index.html':path),import.meta.url)));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});
try{const page=await browser.newPage({viewport:{width:1280,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(({game,session})=>{localStorage.setItem('kwx-lab-v1',JSON.stringify(game));localStorage.setItem('kwx-session-v1',JSON.stringify(session));},{game,session});await page.goto(`http://localhost:${server.address().port}`);await page.locator('.win-celebration').waitFor();assert.match(await page.locator('.win-celebration').innerText(),/七对/);await page.screenshot({path:'artifacts/seven-pairs-effect.png'});await page.waitForTimeout(3100);await page.locator('[data-ledger]').click();await page.locator('#live-ledger[open]').waitFor();await page.locator('#live-ledger .history-round>summary').click();assert.match(await page.locator('#live-ledger').innerText(),/七对/);await page.screenshot({path:'artifacts/ledger-dialog.png'});assert.deepEqual(errors,[]);console.log('Seven-pairs winner effect and expanded past-round ledger passed');}finally{await browser.close();server.close();}
