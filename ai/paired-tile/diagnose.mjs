// Posthoc prediction diagnostic only; never imported by collection, training or selection.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {read,hash,check} from './config.mjs';
export function predictionDiagnostic(out){
  out=resolve(out);const p=read(resolve(out,'plan.json'));check(p);
  const values=split=>gunzipSync(readFileSync(resolve(out,split,'episodes.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.root).map(e=>e.root.gain),train=values('training'),val=values('validation'),mean=train.reduce((a,b)=>a+b,0)/train.length,
    t=read(resolve(out,'model/summary.json')),modelMse=t.history[t.selected.epoch].validation.mse,constantMse=val.reduce((s,y)=>s+(y-mean)**2,0)/val.length;
  assert.ok(train.length&&val.length);
  return {kind:'posthoc-descriptive-prediction-diagnostic',planSha256:hash(resolve(out,'plan.json')),trainingSha256:hash(resolve(out,'training/episodes.jsonl.gz')),validationSha256:hash(resolve(out,'validation/episodes.jsonl.gz')),
    trainingRoots:train.length,validationRoots:val.length,trainingMeanNormalizedGain:mean,trainingMeanRawGain:16*mean,validationZeroMse:val.reduce((s,y)=>s+y*y,0)/val.length,
    validationTrainingMeanConstantMse:constantMse,validationSelectedNetworkMse:modelMse,networkRelativeMseReductionVsConstant:1-modelMse/constantMse,
    use:'Computed only after frozen evaluation. No model, epoch, threshold, sample-budget or primary-inference changes; not a new tested candidate or formal strength comparison.'};
}
export function verifyPredictionDiagnostic(out){const d=read(resolve(out,'constant-baseline-diagnostic.json')),{createdAt,sourceSha256,...fields}=d;assert.deepEqual(fields,predictionDiagnostic(out));assert.equal(sourceSha256,hash(new URL(import.meta.url)));assert.ok(createdAt);return d;}
