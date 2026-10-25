import assert from 'node:assert/strict';
import {createReadStream, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGunzip, gunzipSync} from 'node:zlib';
import {createInterface} from 'node:readline';
import * as E from '../../src/engine.js';
import {MahjongEnvironment, actionKey} from '../environment.mjs';
import {deriveSeed, seededRandom} from '../random.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {summarizePaired} from '../statistics.mjs';
import {sha256} from '../provenance.mjs';
import {ARMS, rolloutSources, selectDevelopment} from './study.mjs';
import {proposeActions, analyzeNetScore, comparePairedScores, ROLLOUT_VERSION} from './policy.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const episodeKey = e => JSON.stringify([e.suite, e.opponentPair, e.group, e.permutation, e.arm, e.hand]);
export async function verifyStudy({out, write = true, auditsPerStratum = 2, onProgress = () => {}}) {
  out = resolve(out);
  if (write && existsSync(resolve(out, 'verification.json'))) throw Error('Verification exists');
  if (!Number.isInteger(auditsPerStratum) || auditsPerStratum < 1) throw Error('Invalid audit count');
  const plan = read(resolve(out, 'plan.json')), summary = read(resolve(out, 'summary.json')), selection = read(resolve(out, 'selection.json'));
  assert.deepEqual(rolloutSources(), plan.sourceHashes);
  assert.deepEqual(summary.sourceHashes, plan.sourceHashes);
  assert.deepEqual(plan.arms, ARMS);
  assert.equal(summary.planSha256, sha256(readFileSync(resolve(out, 'plan.json'))));
  assert.equal(summary.selectionSha256, sha256(readFileSync(resolve(out, 'selection.json'))));
  assert.equal(selection.planSha256, summary.planSha256);
  assert.equal(selectDevelopment(selection.rows), summary.selected);
  assert.equal(selection.selected, summary.selected);
  assert.deepEqual(selection.rows, summary.development);
  const expectedSealed = summary.selected ? ['H0', ...(summary.selected !== 'proposal-once' ? ['proposal-once'] : [])] : [];
  assert.deepEqual(Object.keys(summary.sealed), expectedSealed);
  const stages = [...ARMS.map(arm => `development-${arm}`), ...expectedSealed.map(id => `sealed-vs-${id}`)];
  let totalGames = 0, totalTraces = 0, totalAudited = 0, hypotheticalGames = 0; const stagesVerified = [];
  for (const stage of stages) {
    const r = read(resolve(out, stage, 'report.json')), b = plan.budget, sealed = stage.startsWith('sealed-');
    const groups = sealed ? b.sealedGroups : b.developmentGroups, sessions = sealed ? b.sealedSessionGroups : b.developmentSessionGroups;
    const incumbent = sealed ? stage.slice('sealed-vs-'.length) : 'H0';
    assert.equal(r.candidate, sealed ? summary.selected : stage.slice('development-'.length));
    assert.equal(r.incumbent, incumbent); assert.equal(r.independentGroups, groups); assert.equal(r.sessionGroups, sessions);
    assert.equal(r.sessionHands, b.sessionHands); assert.equal(r.split, sealed ? 'sealed' : 'development');
    assert.equal(r.seed, sealed ? deriveSeed(plan.sealedSeed, incumbent) : plan.developmentSeed);
    assert.equal(r.totalGames, 24 * (groups + sessions * b.sessionHands));
    assert.equal(r.illegalActions, 0); assert.equal(r.conservationCheckedEveryAction, true);
    assert.deepEqual(r.sourceHashes, plan.sourceHashes);
    for (const [id, config] of Object.entries(r.configs)) assert.deepEqual(config, plan.configs[id]);
    assert.deepEqual(r.statistics, summarizePaired(r.records, {bootstrapSamples:b.bootstrapSamples,
      seed:deriveSeed(r.seed, 'bootstrap'), base:r.base}));
    if (sealed) {
      assert.deepEqual(summary.sealed[incumbent].primary, r.statistics.session.overall);
      assert.deepEqual(summary.sealed[incumbent].independent, r.statistics.independent.overall);
      assert.deepEqual(summary.sealed[incumbent].byOpponentPair, r.statistics.session.byOpponentPair);
    } else assert.equal(selection.rows.find(x => x.arm === r.candidate).delta, r.statistics.session.overall.deltaPer100);
    const searchBytes = readFileSync(resolve(out, stage, 'searches.jsonl.gz'));
    assert.equal(sha256(searchBytes), r.artifacts.decisions.sha256);
    const traces = gunzipSync(searchBytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse), traceMap = new Map();
    for (const t of traces) { const key = episodeKey(t); assert.ok(!traceMap.has(key)); traceMap.set(key, t); }
    assert.equal(traces.length, r.artifacts.decisions.recorded);
    assert.equal(traces.length, Object.values(r.search).reduce((s, x) => s + x.proposals, 0));
    const replayPath = resolve(out, stage, 'replays.jsonl.gz');
    assert.equal(sha256(readFileSync(replayPath)), r.artifacts.replays.sha256);
    const scores = new Map(), previous = new Map(), seen = new Set(), auditedByStratum = new Map(), counts = {};
    for (const id of Object.keys(r.configs)) counts[id] = {decisions:0, proposals:0, searches:0, changed:0, hypotheticalGames:0, hypotheticalDecisions:0};
    let games = 0, decisions = 0, tracesMatched = 0, audited = 0;
    const lines = createInterface({input:createReadStream(replayPath).pipe(createGunzip()), crlfDelay:Infinity});
    for await (const line of lines) {
      if (!line.trim()) continue;
      const e = JSON.parse(line), key = episodeKey(e);
      assert.ok(!seen.has(key)); seen.add(key);
      assert.ok(['independent', 'session'].includes(e.suite)); assert.ok(['candidate', 'incumbent'].includes(e.arm));
      assert.ok(Number.isInteger(e.group) && e.group >= 0 && e.group < (e.suite === 'independent' ? groups : sessions));
      assert.ok(Number.isInteger(e.hand) && e.hand >= 0 && e.hand < (e.suite === 'independent' ? 1 : b.sessionHands));
      assert.deepEqual(e.roles, r.seatPermutations[e.permutation]);
      const pair = r.opponentPairs.find(p => p.id === e.opponentPair); assert.ok(pair);
      const id = e.arm === 'candidate' ? r.candidate : r.incumbent;
      const rolePolicies = {C:id, P:pair.policies[0], Q:pair.policies[1]};
      assert.deepEqual(e.policyIds, e.roles.map(role => rolePolicies[role]));
      const groupSeed = deriveSeed(PROTOCOL_VERSION, r.split, r.seed, e.suite, e.opponentPair, e.group);
      assert.equal(e.groupSeed, groupSeed);
      const environmentSeed = deriveSeed(groupSeed, 'environment', e.hand); assert.equal(e.replay.seed, environmentSeed);
      const sessionKey = JSON.stringify([e.suite, e.opponentPair, e.group, e.permutation, e.arm]);
      const last = previous.get(sessionKey); if (e.hand) assert.equal(last?.hand, e.hand - 1);
      const initial = E.newGame({base:r.base, mode:'bots'}, e.hand ? last.next : null, seededRandom(environmentSeed));
      assert.deepEqual(e.replay.initialState, initial);
      const env = new MahjongEnvironment({initialState:initial, record:false}), target = e.roles.indexOf('C');
      const trace = traceMap.get(key); let ownDecision = 0;
      for (const entry of e.replay.actions) {
        assert.equal(env.actor, entry.seat);
        if (entry.seat === target) {
          ownDecision++; if (counts[id]) counts[id].decisions++;
          if (trace?.ownDecision === ownDecision) {
            tracesMatched++; assert.equal(trace.policy, id); assert.ok(counts[id]);
            const o = env.observation(), legal = env.legalActions(), a = trace.analysis, config = r.configs[id];
            assert.deepEqual(o, trace.observation); assert.deepEqual(legal, trace.legal);
            assert.equal(actionKey(entry.action), actionKey(a.action));
            const proposal = proposeActions(o, legal, config); assert.equal(proposal.proposed, true);
            assert.deepEqual(proposal.baseline, a.baseline); assert.deepEqual(proposal.alternative, a.alternative);
            assert.deepEqual(a.config, config);
            const count = counts[id]; count.proposals++; count.searches += Number(a.searched);
            count.changed += Number(a.action.tile !== a.baseline.tile);
            if (id === 'proposal-once') assert.deepEqual(a, proposal);
            else {
              assert.equal(a.searched, true); assert.equal(a.worlds.length, config.worlds);
              assert.equal(a.publicSeed, deriveSeed(ROLLOUT_VERSION, config.searchSeed, o));
              assert.deepEqual(a.comparison, comparePairedScores(a.worlds, config.uncertaintyPenalty));
              assert.deepEqual(a.action, a.comparison.chooseAlternative ? a.alternative : a.baseline);
              a.worlds.forEach((w, i) => {
                assert.equal(w.seed, deriveSeed(a.publicSeed, i));
                const opponents = config.opponentModel === 'mixed' && i % 2 === 1
                  ? (i % 4 === 1 ? ['H0', 'greedy-speed-v1'] : ['greedy-speed-v1', 'H0']) : ['H0', 'H0'];
                assert.deepEqual(w.opponentIds, opponents);
                for (const x of [w.baseline, w.alternative]) {
                  assert.equal(x.score, x.huScore + x.kongScore + x.drawScore);
                  count.hypotheticalGames++; count.hypotheticalDecisions += x.decisions;
                }
              });
              const stratum = JSON.stringify([e.suite, e.opponentPair, id]);
              const done = auditedByStratum.get(stratum) || 0;
              if (done < auditsPerStratum) {
                assert.deepEqual(analyzeNetScore(o, legal, config), a);
                auditedByStratum.set(stratum, done + 1); audited++;
              }
            }
          }
        }
        env.step(entry.action);
      }
      const result = env.result(); assert.deepEqual(result, e.replay.result);
      assert.equal(e.decisions, e.replay.actions.length); decisions += e.decisions;
      previous.set(sessionKey, {hand:e.hand, next:{dealer:result.next.dealer, seats:result.next.seats,
        totals:initial.totals.map((n, i) => n + result.delta[i]), round:e.hand + 2}});
      const scoreKey = JSON.stringify([e.suite, e.opponentPair, groupSeed, e.arm]);
      const accumulator = scores.get(scoreKey) || {hands:0, score:0};
      accumulator.hands++; accumulator.score += result.delta[target]; scores.set(scoreKey, accumulator);
      games++; if (games % 1000 === 0) onProgress({stage, games, tracesMatched, audited});
    }
    assert.equal(games, r.totalGames); assert.equal(games, r.artifacts.replays.recorded);
    assert.equal(decisions, r.totalDecisions); assert.equal(tracesMatched, traces.length);
    for (const record of r.records) for (const arm of ['candidate', 'incumbent']) assert.deepEqual(
      scores.get(JSON.stringify([record.suite, record.opponentPair, record.seed, arm])), {hands:record[arm].hands, score:record[arm].score});
    for (const [id, count] of Object.entries(counts)) for (const [field, n] of Object.entries(count)) assert.equal(n, r.search[id][field]);
    const hypothetical = Object.values(counts).reduce((s, x) => s + x.hypotheticalGames, 0);
    hypotheticalGames += hypothetical; totalGames += games; totalTraces += tracesMatched; totalAudited += audited;
    stagesVerified.push({stage, games, traces:tracesMatched, tracesFullyRecomputed:audited, hypotheticalGames:hypothetical,
      replaySha256:r.artifacts.replays.sha256, searchesSha256:r.artifacts.decisions.sha256});
    onProgress({stage, complete:true, games, tracesMatched, audited});
  }
  assert.equal(totalGames, summary.games);
  assert.equal(summary.positiveSealedEvidence, !!(summary.sealed.H0 && summary.sealed.H0.primary.ci95[0] > 0));
  assert.equal(summary.positiveRolloutFilterEvidence, !!(summary.sealed['proposal-once'] && summary.sealed['proposal-once'].primary.ci95[0] > 0));
  assert.deepEqual(rolloutSources(), plan.sourceHashes);
  const verification = {verifiedAt:new Date().toISOString(), games:totalGames, traces:totalTraces,
    tracesFullyRecomputed:totalAudited, hypotheticalGames, stages:stagesVerified,
    checks:['All actual games redealt from seeds and continued from actual previous winners',
      'All actual actions, conservation and settlement replayed', 'All search inputs matched to actual public observations',
      'All score aggregates and paired bootstrap recomputed', 'Stratified subset of full hypothetical rollouts recomputed'],
    verifierSha256:sha256(readFileSync(fileURLToPath(import.meta.url)))};
  if (write) writeFileSync(resolve(out, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
  return verification;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') throw Error('Use --out study-directory');
  console.log(JSON.stringify(await verifyStudy({out:process.argv[3], onProgress:p => console.log(JSON.stringify(p))})));
}
