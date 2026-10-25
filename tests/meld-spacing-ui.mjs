import {chromium} from '../../node_modules/playwright/index.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {newGame} from '../src/engine.js';
import {createSession} from '../src/session.js';
const game=newGame();game.wall=game.wall.slice(0,20);game.turn=0;
game.players.forEach(p=>{p.melds=[{kind:'peng',tile:'p3'},{kind:'ming',tile:'s5'},{kind:'peng',tile:'z6'},{kind:'an',tile:'p8'}];p.hand=['z7'];});
game.players[0].hand.push('p1');game.drawTile='p1';
const session=createSession('bots',16,0);session.started=true;
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(new URL('../dist'+(path==='/'?'/index.html':path),import.meta.url)));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();await page.addInitScript(({game,session})=>{localStorage.setItem('kwx-lab-v1',JSON.stringify(game));localStorage.setItem('kwx-session-v1',JSON.stringify(session));},{game,session});
 await page.goto(`http://localhost:${server.address().port}`);await page.locator('.own-meld').first().waitFor();
 for(const viewport of [{width:1280,height:720},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.waitForTimeout(1000);
  assert.equal(await page.locator('.own-meld').count(),4);
  assert.equal(await page.locator('.own-melds').evaluate(el=>getComputedStyle(el).gap),'26px');
  const pixels=await page.locator('canvas').evaluate(c=>{const gl=c.getContext('webgl2'),p=new Uint8Array(4);gl.readPixels(c.width/2,c.height/2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return [...p];});assert.ok(pixels.slice(0,3).some(v=>v>0));
  await page.screenshot({path:`artifacts/meld-spacing-${viewport.width}.png`});
 }
 console.log('Four exposed sets rendered with spacing on desktop and mobile; canvas nonblank');
}finally{await browser.close();server.close();}
