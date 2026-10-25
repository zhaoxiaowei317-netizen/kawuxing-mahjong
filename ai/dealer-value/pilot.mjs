import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {load} from '../wall-average/collect.mjs';
import {check,read,hash} from '../wall-average/config.mjs';
import {fitDealerValue,sessionRows,evaluateDealerValue,correctedRootGain} from './model.mjs';
export function pilot(out){
  out=resolve(out);const p=read(resolve(out,'plan.json')),t=read(resolve(out,'training.json'));check(p);const data=Object.fromEntries(['training','validation'].map(split=>[split,load(resolve(out,split),p,split)]));
  for(const split of ['training','validation'])assert.deepEqual(data[split].m,t.datasets[split]);
  const rows=Object.fromEntries(Object.entries(data).map(([split,d])=>[split,sessionRows(d.episodes,p.budget.sessionHands)])),model=fitDealerValue(rows.training,{horizon:p.budget.sessionHands,pseudoCount:1});
  const corrections={};for(const split of ['training','validation']){const rr=data[split].episodes.map(e=>correctedRootGain(e,model,p.budget.sessionHands)).filter(Boolean);
    corrections[split]={roots:rr.length,signChanges:rr.filter(r=>Math.sign(r.correctedGain)!==Math.sign(r.currentGain)).length,meanAbsoluteRawCorrection:rr.reduce((n,r)=>n+Math.abs(r.futureDealerCorrection)*16,0)/rr.length,
      meanRawCorrection:rr.reduce((n,r)=>n+r.futureDealerCorrection*16,0)/rr.length,maxAbsoluteRawCorrection:Math.max(...rr.map(r=>Math.abs(r.futureDealerCorrection)*16))};}
  const sourcePaths=['model.mjs','pilot.mjs','model.test.mjs'];return {at:new Date().toISOString(),purpose:'Exploratory frozen-Short future-score approximation, not deployed and not used by either frozen study. Training-only fit; validation diagnostics are correlated within sessions. No new hands, no policy-strength games, no claimed Suphx replication.',
    sourceHashes:Object.fromEntries(sourcePaths.map(name=>['ai/dealer-value/'+name,hash(new URL(name,import.meta.url))])),parentPlanSha256:hash(resolve(out,'plan.json')),
    dataSha256:Object.fromEntries(Object.entries(data).map(([split,d])=>[split,d.m.sha256])),parentFullAuditAvailableAtPilot:existsSync(resolve(out,'verification.json')),model,
    training:evaluateDealerValue(model,rows.training),validation:evaluateDealerValue(model,rows.validation),corrections,
    limitation:'Two-state dealer Markov approximation ignores hand quality, score/history-dependent Short decisions and opponent style. Lower forecast MSE or a changed label is not evidence of higher policy reward. Any policy adoption needs a new frozen protocol and independent games.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [out,path]=process.argv.slice(2),r=pilot(out);if(path)writeFileSync(path,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({complete:true,validation:r.validation,corrections:r.corrections}));
}
