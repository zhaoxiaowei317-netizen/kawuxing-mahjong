import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FEATURE_NAMES} from '../action-scorer/features.mjs';
import {CONTEXT_NAMES} from '../tile-q/encoding.mjs';
import {load} from './collect.mjs';
import {check,read,hash} from './config.mjs';
const fi=new Map(FEATURE_NAMES.map((n,i)=>[n,i])),ci=new Map(CONTEXT_NAMES.map((n,i)=>[n,i]));
const empty=()=>({roots:0,originalGainSum:0,averagedGainSum:0,withinVarianceSum:0,positiveMean:0,zeroMean:0,negativeMean:0});
const sign=x=>x>0?'positive':x<0?'negative':'zero';
const add=(r,ss)=>{const gain=ss.reduce((n,s)=>n+s.gain,0)/ss.length;r.roots++;r.originalGainSum+=ss[0].gain;r.averagedGainSum+=gain;r.withinVarianceSum+=ss.reduce((n,s)=>n+(s.gain-gain)**2,0)/(ss.length-1);r[sign(gain)+'Mean']++;};
export function diagnoseTraining(out){
  out=resolve(out);const p=read(resolve(out,'plan.json'));check(p);const total=empty(),buckets={},confusion={},files=[];let hands=0,branches=0;
  for(let part=0;part<p.budget.workers;part++){
    const path=resolve(out,'.collect','training-'+part),{m,episodes}=load(path,p,'training');assert.equal(m.hands,p.budget.trainingHands/p.budget.workers);hands+=m.hands;branches+=m.extraBranches;
    files.push({path,manifestSha256:hash(resolve(path,'manifest.json')),episodesSha256:m.sha256});
    for(const e of episodes)if(e.root){const r=e.root,ss=e.samples;assert.equal(ss.length,p.budget.wallSamples);add(total,ss);
      const candidates=new Map(r.encoded.candidates.map(c=>[c.id,c.values])),b=candidates.get(r.baselineId),a=candidates.get(r.alternativeId),delta=n=>a[fi.get(n)]-b[fi.get(n)],
        context=n=>r.encoded.context[ci.get(n)],wall=Math.round(44*context('wall')),mean=ss.reduce((n,s)=>n+s.gain,0)/ss.length;
      const keys=['distance.'+(delta('negativeDistance')>0?'improves':delta('negativeDistance')<0?'worsens':'same'),
        'publicOuts.'+(delta('outs')>0?'increases':delta('outs')<0?'decreases':'same'),
        'readyOuts.'+(delta('readyOuts')>0?'increases':delta('readyOuts')<0?'decreases':'same'),
        'opponentReveal.'+(context('p1.liang')+context('p2.liang')>0?'present':'absent'),'wall.'+(wall<=12?'0-12':wall<=28?'13-28':'29+')];
      for(const key of keys){buckets[key]??=empty();add(buckets[key],ss);}const key=sign(ss[0].gain)+'->'+sign(mean);confusion[key]=(confusion[key]??0)+1;
    }
  }
  assert.equal(hands,p.budget.trainingHands);const summarize=r=>({...r,originalRawMeanPerRoot:r.originalGainSum*16/r.roots,averagedRawMeanPerRoot:r.averagedGainSum*16/r.roots,averageWithinNormalizedVariance:r.withinVarianceSum/r.roots});
  return {createdAt:new Date().toISOString(),sourceSha256:hash(fileURLToPath(import.meta.url)),planSha256:hash(resolve(out,'plan.json')),trainingFiles:files,
    purpose:'Posthoc descriptive exploration of TRAINING DATA ONLY. No validation or exam read. Not used to alter frozen wall-average or confidence-gate sources, selection, thresholds or budgets. Subgroups unadjusted and in-sample; not causal deployment rules.',
    target:'Equal average of wall-paired alternative-minus-baseline terminal net /16 conditional on actual complete opponent hands. Public outs are visible-count estimates, not known wall counts.',hands,roots:total.roots,extraBranches:branches,
    total:summarize(total),buckets:Object.fromEntries(Object.entries(buckets).sort(([a],[b])=>a.localeCompare(b)).map(([k,r])=>[k,summarize(r)])),originalToMeanSignCounts:confusion,
    averagedBranchGainPer100MainHands:total.averagedGainSum*1600/hands,
    limitation:'The per-100-hand branch number is an in-sample, first-intervention, same-hand continuation diagnostic on Short trajectories. Actual Always sessions can change future dealers/totals and visited states. It is not an independent strength estimate or confidence interval.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [out,path]=process.argv.slice(2),r=diagnoseTraining(out);if(path)writeFileSync(path,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({hands:r.hands,roots:r.roots,extraBranches:r.extraBranches,trainingOnly:true}));
}
