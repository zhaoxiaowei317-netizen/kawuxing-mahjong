import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '../../node_modules/playwright/index.mjs';

const files=process.argv.slice(2);
if(!files.length)throw Error('Provide one or more audio files');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage();
for(const file of files){
 const base64=(await readFile(resolve(file))).toString('base64');
 const analysis=await page.evaluate(async base64=>{
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  const context=new AudioContext();
  const buffer=await context.decodeAudioData(bytes.buffer);
  const samples=buffer.getChannelData(0),rate=buffer.sampleRate,step=Math.max(1,Math.round(rate*.01));
  const energy=[];
  for(let i=0;i<samples.length;i+=step){let sum=0;const end=Math.min(samples.length,i+step);for(let j=i;j<end;j++)sum+=samples[j]*samples[j];energy.push(Math.sqrt(sum/(end-i)));}
  const sorted=[...energy].sort((a,b)=>a-b),noise=sorted[Math.floor(sorted.length*.2)]||0,peak=sorted[Math.floor(sorted.length*.995)]||1;
  const threshold=Math.max(noise*4,peak*.035,.0025),active=energy.map(v=>v>threshold);
  const spans=[];let start=-1;
  for(let i=0;i<=active.length;i++){if(active[i]&&start<0)start=i;if((!active[i]||i===active.length)&&start>=0){spans.push([start,i]);start=-1;}}
  const merged=[];
  for(const span of spans){const prev=merged.at(-1);if(prev&&span[0]-prev[1]<=18)prev[1]=span[1];else merged.push(span);}
  const segments=merged.filter(([a,b])=>b-a>=12).map(([a,b])=>({start:Math.max(0,a*.01-.06),end:Math.min(buffer.duration,b*.01+.10)}));
  await context.close();
  return {duration:buffer.duration,sampleRate:buffer.sampleRate,noise,peak,threshold,segments};
 },base64);
 console.log(JSON.stringify({file,...analysis},null,2));
}
await browser.close();
