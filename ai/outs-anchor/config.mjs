import assert from 'node:assert/strict';
import {resolve,relative} from 'node:path';
import {randomBytes} from 'node:crypto';
import {deriveSeed} from '../random.mjs';
import {projectRoot} from '../provenance.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {loadQ} from '../tile-q/model.mjs';
import {check as oldCheck,sources as oldSources} from '../outs-distill/config.mjs';
import {read,hash,PAIRS,N} from '../strong-pool/config.mjs';
export {read,hash,PAIRS,N};
export const VERSION='kwx-outs-anchor-1';
export const STUDENTS=Object.freeze(['anchor','plain']),NEURAL=Object.freeze([...STUDENTS,'raw']),ARMS=Object.freeze([...NEURAL,'reference']);
export const CONTRASTS=Object.freeze({objective:'plain',improvement:'raw',strength:'reference'});
export const sources=()=>({previous:oldSources(),drivers:Object.fromEntries(['config.mjs','groups.mjs','study.mjs','verify.mjs','train.py'].map(f=>[f,hash(new URL(f,import.meta.url))]))});
export function sourceMap(s=sources()){
  const distill=s.previous,guard=distill.previous,confirm=guard.previous,pool=confirm.previous,result={};
  const add=(entries,base)=>{for(const [path,sha]of Object.entries(entries)){const name=relative(projectRoot,resolve(base,path));if(result[name])assert.equal(result[name],sha);result[name]=sha;}};
  add(pool.core,projectRoot);add(pool.drivers,projectRoot);add(confirm.driver,resolve(projectRoot,'ai/strong-confirm'));add(guard.driver,resolve(projectRoot,'ai/outs-guard'));
  add(distill.drivers,resolve(projectRoot,'ai/outs-distill'));add(s.drivers,resolve(projectRoot,'ai/outs-anchor'));return result;
}
export function check(p){
  assert.equal(p.version,VERSION);assert.deepEqual(p.sources,sources());assert.deepEqual(p.sourceMap,sourceMap());
  assert.deepEqual(p.pairs,PAIRS);assert.deepEqual(p.arms,ARMS);assert.deepEqual(p.contrasts,CONTRASTS);assert.deepEqual(p.constraint,{weight:1,temperature:1,scope:'uncorrected'});
  for(const n of ['plan','summary','verification'])assert.equal(hash(resolve(p.previous.path,n+'.json')),p.previous[n+'Sha256']);
  const old=read(resolve(p.previous.path,'plan.json'));oldCheck(old);oldCheck(p.protocol);assert.deepEqual(p.protocol.sources,old.sources);
  assert.deepEqual(p.protocol.model,old.model);assert.deepEqual(p.model,old.model);assert.equal(p.modelStateSha256,old.modelStateSha256);
  assert.deepEqual(p.protocol.seeds,p.seeds);assert.deepEqual(p.protocol.budget,p.budget);assert.equal(p.protocol.createdAt,p.createdAt);
  assert.deepEqual(p.protocol.previous,old.previous);assert.deepEqual(p.protocol.optimizer,old.optimizer);assert.equal(p.protocol.epsilon,old.epsilon);
  assert.deepEqual(p.network,old.network);assert.deepEqual(p.schema,old.schema);assert.deepEqual(p.coreSources,old.coreSources);assert.deepEqual(p.optimizer,old.optimizer);
  assert.equal(loadQ(p.model.path).sha256,p.model.sha256);assert.equal(hash(p.model.state),p.modelStateSha256);
  assert.notEqual(p.seeds.training,old.seeds.training);assert.notEqual(p.seeds.validation,old.seeds.validation);assert.notEqual(p.seeds.evaluation,old.seeds.evaluation);
}
export function makePlan({previous,python='python',trainingHands=4608,validationHands=576,epochs=8,groupsPerPair=16,sessionHands=16,workers=4,bootstrapSamples=5000}){
  previous=resolve(previous);const old=read(resolve(previous,'plan.json')),s=read(resolve(previous,'summary.json')),v=read(resolve(previous,'verification.json'));oldCheck(old);
  assert.equal(s.planSha256,hash(resolve(previous,'plan.json')));assert.equal(v.planSha256,s.planSha256);assert.equal(v.games,s.games);assert.deepEqual(v.sources,old.sources);
  const nonce=randomBytes(32).toString('hex'),createdAt=new Date().toISOString(),seeds=Object.fromEntries(['training','validation','model','evaluation'].map(k=>[k,deriveSeed(VERSION,nonce,k)])),
    budget={trainingHands,validationHands,epochs,groupsPerPair,sessionHands,workers,bootstrapSamples},protocol={...old,createdAt,seeds,budget};
  const p={version:VERSION,createdAt,sources:sources(),sourceMap:sourceMap(),python,protocol,
    previous:{path:previous,...Object.fromEntries(['plan','summary','verification'].map(n=>[n+'Sha256',hash(resolve(previous,n+'.json'))]))},
    model:old.model,modelStateSha256:old.modelStateSha256,network:old.network,schema:old.schema,coreSources:old.coreSources,optimizer:old.optimizer,
    pairs:PAIRS,arms:ARMS,contrasts:CONTRASTS,budget,seeds,constraint:{weight:1,temperature:1,scope:'uncorrected'},
    data:'Reuse frozen paired-label collector with a fully saved compatible nested protocol and fresh seeds. Raw learner behavior, 5% learner-only uniform legal exploration, three pairs/six seats/whole sessions. Both students consume the SAME corrected dataset, public inputs and minibatches. Canonical and self-label copies retained for audit.',
    training:'Both initialize original raw PT weights, reset Adam, same RNG/optimizer/epochs. Plain minimizes corrected CE. Anchor adds mean-over-all-rows 1{unchanged} * KL(softmax(raw Q) || softmax(student Q)), temperature=1, weight=1. Frozen teacher sees the identical full public input/mask. No anchor on corrected rows. No terminal-return/rank loss.',
    selection:'Both select minimum validation corrected-label cross entropy including epoch 0, earliest ties. Anchor objective is logged separately and is NOT the selection criterion. Fixed 8 epochs by default, no tuning/threshold search or game-score selection.',
    primary:'Joint claim requires anchor-minus-plain AND anchor-minus-raw two-sided 95% complete-group bootstrap intervals strictly above zero (intersection-union). Equal pair weights, 5000 fixed resamples by default. Individual games/seats are not independent samples.',
    secondary:'Anchor-minus-h0-never and all subgroup/behavior/retention metrics are descriptive without multiplicity correction. All contrasts share anchor, not independent replications. Direct same-batch strength scores, no cross-batch subtraction.',
    stopping:'Complete all prespecified budgets regardless of interim scores. Fresh training/validation/evaluation seeds, no released exam episodes in training, no automatic promotion. Three networks select own full-legal Q without guard/H0 fallback; fourth reference is h0-never. Production H0.'};check(p);return p;
}
export const jobsFor=p=>p.pairs.flatMap((pair,i)=>Array.from({length:p.budget.groupsPerPair},(_,group)=>({id:`pair-${i}-${String(group).padStart(3,'0')}`,pair,group})));
export const jobSeed=(p,j)=>deriveSeed(PROTOCOL_VERSION,'sealed',p.seeds.evaluation,'session',j.pair.id,j.group);
export function trainSpec(out,p,arm){assert.ok(STUDENTS.includes(arm));return {out:resolve(out,`model-${arm}`),schema:p.schema,sources:p.coreSources,experimentSources:p.sourceMap,
  seed:p.seeds.model,trainingData:resolve(out,'training','corrected'),validationData:resolve(out,'validation','corrected'),
  trainingCanonical:resolve(out,'training','canonical'),validationCanonical:resolve(out,'validation','canonical'),network:p.network,
  config:{...p.optimizer,anchorWeight:arm==='anchor'?1:0,temperature:1},mode:arm,epochs:p.budget.epochs,initialize:p.model.state};}
