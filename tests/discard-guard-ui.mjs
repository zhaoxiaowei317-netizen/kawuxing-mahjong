import {chromium} from '../../node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {newGame,parseHand} from '../src/engine.js';
const b=await chromium.launch({headless:true,channel:'msedge'});
for(const mode of ['safe','all','revealed']){
 const g=newGame({base:1,cap:32,mode:'three'});
 g.players[0].hand=mode==='all'?['z5','z6']:mode==='revealed'?['s8','z5']:['z5','s8'];
 g.players[0].melds=['p1','p2','p3','s9'].map(tile=>({kind:'peng',tile}));
 g.players[0].liang=mode==='revealed';g.drawTile=g.players[0].hand.at(-1);
 for(const i of [1,2]){g.players[i].hand=parseHand('p456789s123456'+(i===1?'z5':'z6'));g.players[i].liang=true;}
 const p=await b.newPage({viewport:{width:1440,height:810}});
 await p.addInitScript(g=>localStorage.setItem('kwx-lab-v1',JSON.stringify(g)),g);
 await p.goto('http://127.0.0.1:8789/');await p.locator('#scene-host canvas').waitFor();
 await p.locator('[data-tile-index="0"]').click();
 assert.equal(await p.locator('[data-action="discard"]').isDisabled(),mode!=='all');
 assert.equal(await p.locator('.discard-locked').count(),mode==='all'?0:1);
 if(mode==='safe'){await p.locator('[data-action="liang"]').click();assert.equal(await p.locator('[data-tile-index="1"]').getAttribute('aria-pressed'),'true');await p.locator('[data-action="liang-cancel"]').click();await p.locator('[data-tile-index="0"]').click();}
 await p.waitForFunction(()=>Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0));
 await p.screenshot({path:`artifacts/discard-${mode}.png`});
 if(mode!=='all')await p.locator('[data-tile-index="1"]').click();
 assert.equal(await p.locator('[data-action="discard"]').isEnabled(),true);
 await p.locator('[data-action="discard"]').click();
 const saved=await p.evaluate(()=>JSON.parse(localStorage.getItem('kwx-lab-v1')));
 assert.equal(saved.players[0].river.at(-1),mode==='safe'?'s8':'z5');
 await p.close();
}
await b.close();console.log('Guard UI passed: forbidden discard/reveal, all-danger exception, revealed forced discard.');
