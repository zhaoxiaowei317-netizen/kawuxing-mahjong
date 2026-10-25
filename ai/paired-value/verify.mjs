import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync, createGunzip} from 'node:zlib';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {MahjongEnvironment, actionKey} from '../environment.mjs';
import {policyById} from '../policies/index.mjs';
import {deriveSeed} from '../random.mjs';
import {sha256} from '../provenance.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {summarizePaired} from '../statistics.mjs';
import {simulateToEnd, proposalOnceFactory} from '../public-rollout/policy.mjs';
import {loadData, DATA_VERSION} from './data.mjs';
import {describeRoot, GATE_CONFIG} from './features.mjs';
import {loadGain} from './io.mjs';
import {learnedGainFactory} from './policy.mjs';
import {diagnostics, GainRegressor, fitRidge} from './model.mjs';
import {trainingSources} from './train.mjs';
import {ARMS, studySources, selectCandidate, save} from './study.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const key = e => JSON.stringify([e.suite,e.opponentPair,e.group,e.permutation,e.arm,e.hand]);
const tick = () => new Promise(resolve => setImmediate(resolve));
export async function verifyData(path, split, onProgress = () => {}) {
  const {manifest:m, rows} = loadData(path, split), seen = new Set();
  let nonzero = 0, sum = 0, audited = 0;
  for (const r of rows) {
    assert.ok(Number.isInteger(r.hand) && r.hand >= 0 && r.hand < m.hands && !seen.has(r.hand)); seen.add(r.hand);
    assert.equal(r.environmentSeed, deriveSeed(DATA_VERSION, split, m.seed, r.hand));
    assert.equal(r.seat, r.hand % 3);
    const mixed = Math.floor(r.hand / 3) % 2 === 1;
    const expectedOpponents = mixed ? (Math.floor(r.hand / 6) % 2 ? ['greedy-speed-v1','H0'] : ['H0','greedy-speed-v1']) : ['H0','H0'];
    assert.deepEqual(r.opponentIds, expectedOpponents);
    const others = [0,1,2].filter(s => s !== r.seat);
    const policies = [0,1,2].map(s => policyById(s === r.seat ? 'H0' : expectedOpponents[others.indexOf(s)]));
    const env = new MahjongEnvironment({seed:r.environmentSeed, record:false});
    for (const e of r.prefix) {
      assert.equal(env.actor, e.seat); const o = env.observation(), legal = env.legalActions();
      if (e.seat === r.seat) assert.equal(describeRoot(o, legal).proposed, false, 'Must label the first proposal');
      assert.equal(actionKey(e.action), actionKey(policies[e.seat](o, legal))); env.step(e.action);
    }
    assert.equal(env.actor, r.seat); assert.deepEqual(env.observation(), r.observation); assert.deepEqual(env.legalActions(), r.legal);
    const root = describeRoot(r.observation, r.legal); assert.equal(root.proposed, true);
    assert.deepEqual(root.features, r.features); assert.deepEqual(root.baseline, r.baseline); assert.deepEqual(root.alternative, r.alternative);
    const baseline = simulateToEnd(env.auditState(), r.baseline, r.seat, {opponentIds:r.opponentIds});
    const alternative = simulateToEnd(env.auditState(), r.alternative, r.seat, {opponentIds:r.opponentIds});
    assert.deepEqual({baseline, alternative}, r.terminal);
    assert.equal(r.gain, (alternative.score - baseline.score) / r.observation.config.base);
    sum += r.gain; nonzero += Number(r.gain !== 0); audited++;
    if (audited % 50 === 0) {onProgress({stage:`audit-${split}`, audited, rows:rows.length}); await tick();}
  }
  assert.equal(sum, m.gainSum); assert.equal(nonzero, m.nonzeroLabels); assert.equal(m.counterfactualBranches, rows.length * 2);
  return {hands:m.hands, roots:rows.length, labelsRecomputed:audited, counterfactualBranchesRecomputed:2*audited, sha256:m.rowsSha256};
}
function accumulate(a, r, seat) {
  const net = lines => lines.reduce((s,l) => s + (l.to === seat ? l.amount : 0) - (l.from === seat ? l.amount : 0), 0);
  a.hands++; a.score += r.delta[seat]; a.kongScore += net(r.kongs);
  a[r.winners.length ? 'huScore' : 'drawScore'] += r.delta[seat] - net(r.kongs);
  const won = r.winners.includes(seat); a.wins += Number(won); a.selfDraws += Number(won && r.source === null);
  a.dealIns += Number(r.winners.length > 0 && r.source === seat); a.draws += Number(r.winners.length === 0);
  a.largeLosses += Number(r.delta[seat] <= -16 * r.config.base);
  if (r.players[seat].liang) {a.revealHands++; a.revealedScore += r.delta[seat];}
}
export async function verifyEvaluation(path, bootstrapSamples, onProgress = () => {}) {
  const r = read(resolve(path, 'report.json')), {model, sha256:modelSha} = loadGain(r.checkpoint);
  assert.equal(modelSha, r.checkpointSha256);
  const traceBytes = readFileSync(resolve(path, 'decisions.jsonl.gz'));
  assert.equal(sha256(traceBytes), r.artifacts.decisions.sha256);
  const traces = new Map();
  for (const line of gunzipSync(traceBytes).toString('utf8').split('\n').filter(Boolean)) {
    const t = JSON.parse(line); assert.ok(!traces.has(key(t))); traces.set(key(t), t);
  }
  const replayPath = resolve(path, 'replays.jsonl.gz'); assert.equal(sha256(readFileSync(replayPath)), r.artifacts.replays.sha256);
  const previous = new Map(), seen = new Set(), aggregates = new Map();
  const scalarKeys = ['hands','score','wins','selfDraws','dealIns','draws','huScore','kongScore','drawScore','revealHands','revealedScore','largeLosses'];
  let games = 0, accepted = 0, matched = 0;
  for await (const line of createInterface({input:createReadStream(replayPath).pipe(createGunzip()), crlfDelay:Infinity})) {
    if (!line) continue; const e = JSON.parse(line); assert.ok(!seen.has(key(e))); seen.add(key(e));
    const groups = e.suite === 'independent' ? r.independentGroups : r.sessionGroups;
    assert.ok(['independent','session'].includes(e.suite) && ['candidate','incumbent'].includes(e.arm));
    assert.ok(Number.isInteger(e.group) && e.group >= 0 && e.group < groups);
    assert.ok(Number.isInteger(e.hand) && e.hand >= 0 && e.hand < (e.suite === 'independent' ? 1 : r.sessionHands));
    assert.deepEqual(e.roles, r.seatPermutations[e.permutation]);
    const pair = r.opponentPairs.find(x => x.id === e.opponentPair); assert.ok(pair);
    const id = e.arm === 'candidate' ? r.candidate : r.incumbent;
    const roleIds = {C:id,P:pair.policies[0],Q:pair.policies[1]}; assert.deepEqual(e.policyIds, e.roles.map(role => roleIds[role]));
    const groupSeed = deriveSeed(PROTOCOL_VERSION, r.split, r.seed, e.suite, e.opponentPair, e.group);
    assert.equal(e.groupSeed, groupSeed);
    const seed = deriveSeed(groupSeed, 'environment', e.hand); assert.equal(e.replay.seed, seed);
    const sessionKey = JSON.stringify([e.suite,e.opponentPair,e.group,e.permutation,e.arm]);
    const last = previous.get(sessionKey); if (e.hand) assert.equal(last?.hand, e.hand-1);
    const env = new MahjongEnvironment({seed, config:{base:r.base,mode:'bots'}, previous:e.hand ? last.next : null, record:false});
    assert.deepEqual(env.auditState(), e.replay.initialState);
    let trace = null;
    const learned = learnedGainFactory(model, (analysis, observation, legal) => {
      assert.equal(trace, null); trace = {analysis,observation,legal};
    })(), proposal = proposalOnceFactory(GATE_CONFIG)();
    const policies = e.policyIds.map(p => p === r.candidate ? learned : p === 'proposal-once' ? proposal : policyById(p));
    for (const a of e.replay.actions) {
      assert.equal(env.actor, a.seat);
      assert.equal(actionKey(policies[a.seat](env.observation(), env.legalActions())), actionKey(a.action));
      env.step(a.action);
    }
    assert.equal(env.done, true); const result = env.result(); assert.deepEqual(result, e.replay.result);
    const recorded = traces.get(key(e));
    if (trace) {
      assert.ok(recorded); const {analysis,observation,legal} = recorded; assert.deepEqual(trace,{analysis,observation,legal});
      matched++; accepted += Number(actionKey(analysis.action) === actionKey(analysis.root.alternative));
    } else assert.equal(recorded, undefined);
    const totals = e.hand ? [...last.next.totals] : [0,0,0]; result.delta.forEach((v,i) => totals[i] += v);
    previous.set(sessionKey, {hand:e.hand, next:{dealer:result.next.dealer, seats:result.next.seats, totals, round:e.hand+2}});
    const aggregateKey = JSON.stringify([e.suite,e.opponentPair,groupSeed,e.arm]);
    if (!aggregates.has(aggregateKey)) aggregates.set(aggregateKey, Object.fromEntries(scalarKeys.map(k => [k,0])));
    accumulate(aggregates.get(aggregateKey), result, e.roles.indexOf('C'));
    games++; if (games % 192 === 0) {onProgress({stage:'audit-games', path, games, total:r.totalGames}); await tick();}
  }
  assert.equal(games, r.totalGames); assert.equal(games,24*(r.independentGroups+r.sessionGroups*r.sessionHands));
  assert.equal(matched, traces.size); assert.equal(matched,r.counts.proposals); assert.equal(accepted,r.counts.accepted);
  for (const record of r.records) for (const arm of ['candidate','incumbent']) {
    const a = aggregates.get(JSON.stringify([record.suite,record.opponentPair,record.seed,arm])); assert.ok(a);
    for (const k of scalarKeys) assert.equal(a[k],record[arm][k],`Aggregate ${k}`);
  }
  assert.deepEqual(r.statistics,summarizePaired(r.records,{bootstrapSamples,seed:deriveSeed(r.seed,'bootstrap'),base:r.base}));
  return {games, gamesRedealtAndReplayed:games, decisionsRecomputed:matched, accepted, statisticsRecomputed:true};
}
export async function verifyStudy({out, onProgress = () => {}}) {
  out=resolve(out); if (existsSync(resolve(out,'verification.json'))) throw Error('Verification exists');
  const plan=read(resolve(out,'plan.json')), s=read(resolve(out,'summary.json')), selection=read(resolve(out,'selection.json'));
  assert.deepEqual(studySources(),plan.sourceHashes); assert.equal(sha256(readFileSync(resolve(out,'plan.json'))),s.planSha256);
  assert.equal(selectCandidate(s.development),s.selected); assert.deepEqual(selection.development,s.development); assert.equal(selection.selected,s.selected);
  const data = {};
  for (const split of ['training','validation']) {
    data[split] = await verifyData(resolve(out,split),split,onProgress);
    assert.equal(data[split].hands,plan.budget[`${split}Hands`]);
    const m=loadData(resolve(out,split),split).manifest; assert.equal(m.seed,plan.seeds[split]); assert.deepEqual(m,s.datasets[split]);
  }
  const training = loadData(resolve(out,'training'),'training'), val=loadData(resolve(out,'validation'),'validation');
  const trainSeeds=new Set(training.rows.map(r=>r.environmentSeed)); assert.ok(val.rows.every(r=>!trainSeeds.has(r.environmentSeed)));
  const models=read(resolve(out,'models.json')); assert.deepEqual(models,s.fitted);
  assert.equal(selection.modelsSha256,sha256(readFileSync(resolve(out,'models.json'))));
  const snapshots=[];
  for (const arm of ARMS) {
    const loaded=loadGain(models[arm].path);
    if (arm !== 'ridge') {
      const history=read(resolve(out,`model-${arm}`,'summary.json'));
      assert.equal(history.history.length,plan.budget.epochs+1);
      const expectedConfig={seed:deriveSeed(plan.seeds.training,'model',Number(arm.slice(-1))),
        hiddenSize:plan.models.mlp.hiddenSize,learningRate:plan.models.mlp.learningRate,batchSize:plan.models.mlp.batchSize,
        trainingSha256:training.manifest.rowsSha256,validationSha256:val.manifest.rowsSha256};
      assert.deepEqual(history.config,expectedConfig);assert.deepEqual(history.sources,trainingSources());
      const reconstructed=new GainRegressor(expectedConfig);
      let best=history.history[0];
      for (let epoch=0;epoch<=plan.budget.epochs;epoch++) {
        const loadedEpoch=loadGain(resolve(out,`model-${arm}`,`epoch-${String(epoch).padStart(3,'0')}.json`));
        if(epoch)reconstructed.update(training.rows,{epoch,...expectedConfig});
        assert.deepEqual(loadedEpoch.model.toJSON(),reconstructed.toJSON());
        assert.deepEqual(loadedEpoch.checkpoint.metadata.training.config,expectedConfig);
        assert.deepEqual(loadedEpoch.checkpoint.metadata.training.sources,trainingSources());
        const row=history.history[epoch]; assert.equal(row.epoch,epoch);
        assert.deepEqual(diagnostics(loadedEpoch.model,training.rows,training.manifest.hands),row.training);
        assert.deepEqual(diagnostics(loadedEpoch.model,val.rows,val.manifest.hands),row.validation);
        if (row.validation.mse < best.validation.mse - 1e-12) best=row;
        snapshots.push(loadedEpoch.sha256);
      }
      assert.equal(models[arm].epoch,best.epoch); assert.equal(history.selected.validationMse,best.validation.mse);
      assert.equal(resolve(models[arm].path),resolve(history.selected.path));
    } else {
      assert.deepEqual(loaded.model,fitRidge(training.rows,plan.models.ridge.lambda));
      assert.deepEqual(diagnostics(loaded.model,val.rows,val.manifest.hands),models.ridge.validation);
    }
  }
  const stages={};
  const expectedSealed=s.selected ? ['H0','proposal-once'] : []; assert.deepEqual(Object.keys(s.sealed),expectedSealed);
  for (const stage of [...ARMS.map(a=>`development-${a}`),...expectedSealed.map(a=>`sealed-vs-${a}`)]) {
    const r=read(resolve(out,stage,'report.json')), sealed=stage.startsWith('sealed'), arm=sealed?s.selected:stage.slice(12);
    const incumbent=sealed?stage.slice('sealed-vs-'.length):'H0';
    assert.equal(r.candidate,arm); assert.equal(r.incumbent,incumbent); assert.equal(r.split,sealed?'sealed':'development');
    assert.equal(r.seed,sealed?deriveSeed(plan.seeds.sealed,incumbent):plan.seeds.development);
    assert.equal(r.independentGroups,plan.budget[sealed?'sealedGroups':'developmentGroups']);
    assert.equal(r.sessionGroups,plan.budget[sealed?'sealedSessionGroups':'developmentSessionGroups']); assert.equal(r.sessionHands,plan.budget.sessionHands);
    assert.equal(r.checkpointSha256,loadGain(models[arm].path).sha256);
    if (sealed) assert.deepEqual(r.statistics.session.overall,s.sealed[incumbent].primary);
    else assert.equal(r.statistics.session.overall.deltaPer100,s.development.find(x=>x.arm===arm).delta);
    stages[stage]=await verifyEvaluation(resolve(out,stage),plan.budget.bootstrapSamples,onProgress);
  }
  const games=Object.values(stages).reduce((sum,r)=>sum+r.games,0); assert.equal(games,s.games);
  const result={completedAt:new Date().toISOString(),data,snapshotsVerified:snapshots.length+1,stages,games,
    allActualGamesRedealtAndPolicyRecomputed:true,allStoredLabelsRecomputed:true,sourceHashes:studySources()};
  save(resolve(out,'verification.json'),result); return result;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) verifyStudy({out:process.argv[2],
  onProgress:p=>console.log(JSON.stringify({at:new Date().toISOString(),...p}))}).then(r=>console.log(JSON.stringify({verifiedGames:r.games})))
  .catch(e=>{console.error(e);process.exitCode=1;});
