import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from '../../node_modules/playwright/index.mjs';
await build({entryPoints:[resolve('src/tile-review.js')],bundle:true,outfile:resolve('dist/tile-review.js'),tsconfigRaw:{},plugins:[{name:'resolve-files',setup(b){b.onResolve({filter:/.*/},a=>({path:createRequire(a.importer||resolve('build.mjs')).resolve(a.path),namespace:'files'}));b.onLoad({filter:/.*/,namespace:'files'},async a=>({contents:await readFile(a.path,'utf8'),loader:'js'}));}}]});
await writeFile('dist/tile-review.html',`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>牌面实际效果评审</title><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="game.css"><style>.review-toolbar{position:absolute;z-index:9;top:24px;left:160px;right:160px;display:flex;align-items:center;justify-content:space-between;color:white}.review-toolbar nav{display:flex;gap:8px}.review-toolbar span{font-size:12px}.review-toolbar button{padding:6px 12px}.hand-dock .hand .tile{flex:0 0 calc((100% - 45px)/14)}</style><body class="playing"><main id="app"></main><script src="tile-review.js"></script></body></html>`);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});await page.goto('http://localhost:8794/tile-review.html');
 for(const key of ['p','s','z']){await page.evaluate(k=>window.review(k),key);await page.waitForTimeout(800);await page.screenshot({path:`artifacts/review-${key}.png`});}
 await page.evaluate(()=>window.review('s'));await page.waitForTimeout(300);
 await page.locator('.hand-dock .hand').screenshot({path:'artifacts/review-bamboo-detail.png'});
 const pixels=await page.evaluate(()=>{const c=document.querySelector('canvas'),target=document.createElement('canvas');target.width=64;target.height=36;const ctx=target.getContext('2d');ctx.drawImage(c,0,0,64,36);const data=ctx.getImageData(0,0,64,36).data;return new Set(Array.from({length:2304},(_,i)=>`${data[i*4]},${data[i*4+1]},${data[i*4+2]}`)).size;});if(pixels<20)throw Error('Blank canvas');
 console.log('Captured 21 live tile faces and 3D rivers; canvas colors:',pixels);
}finally{await browser.close();}
