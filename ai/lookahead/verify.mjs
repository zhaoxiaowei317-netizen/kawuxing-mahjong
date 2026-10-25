import assert from 'node:assert/strict';
import {createReadStream, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import * as E from '../../src/engine.js';
import {replayEpisode} from '../environment.mjs';
import {deriveSeed, seededRandom} from '../random.mjs';
import {summarizePaired} from '../statistics.mjs';
import {PROTOCOL_VERSION} from '../runner.mjs';
import {sha256} from '../provenance.mjs';
import {studySources, selectDevelopment} from './study.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
export async function verifyStudy({out, write = true, onProgress = () => {}}) {
  out = resolve(out);
  if (write && existsSync(resolve(out, 'verification.json'))) throw Error('Verification exists');
  const plan = read(resolve(out, 'plan.json')), summary = read(resolve(out, 'summary.json'));
  const selection = read(resolve(out, 'selection.json'));
  assert.deepEqual(studySources(), plan.sourceHashes);
  assert.deepEqual(summary.sourceHashes, plan.sourceHashes);
  assert.equal(summary.planSha256, sha256(readFileSync(resolve(out, 'plan.json'))));
  assert.equal(selection.planSha256, summary.planSha256);
  assert.equal(summary.selectionSha256, sha256(readFileSync(resolve(out, 'selection.json'))));
  assert.equal(selectDevelopment(selection.rows), selection.selected);
  assert.equal(summary.selected, selection.selected);
  assert.notEqual(plan.sealedSeed, plan.developmentSeed);
  const stages = ['development-ties', 'development-same-shanten', ...(summary.selected ? ['sealed'] : [])];
  let total = 0; const verified = [];
  for (const stage of stages) {
    const report = read(resolve(out, stage, 'report.json'));
    assert.deepEqual(report.sourceHashes, plan.sourceHashes);
    const sealed = stage === 'sealed', budget = plan.budget;
    const groups = sealed ? budget.sealedGroups : budget.developmentGroups;
    const sessions = sealed ? budget.sealedSessionGroups : budget.developmentSessionGroups;
    assert.equal(report.independentGroups, groups);
    assert.equal(report.sessionGroups, sessions);
    assert.equal(report.sessionHands, budget.sessionHands);
    assert.equal(report.split, sealed ? 'sealed' : 'development');
    assert.equal(report.seed, sealed ? plan.sealedSeed : plan.developmentSeed);
    assert.equal(report.mode, sealed ? summary.selected : stage.slice('development-'.length));
    assert.equal(report.illegalActions, 0);
    assert.equal(report.conservationCheckedEveryAction, true);
    assert.equal(report.totalGames, 24 * (groups + sessions * budget.sessionHands));
    assert.deepEqual(report.statistics, summarizePaired(report.records,
      {seed:deriveSeed(report.seed, 'bootstrap'), bootstrapSamples:budget.bootstrapSamples, base:report.base}));
    if (!sealed) {
      const row = selection.rows.find(r => r.mode === report.mode);
      assert.equal(row.delta, report.statistics.session.overall.deltaPer100);
      assert.deepEqual(summary.development.find(r => r.mode === report.mode), row);
    } else {
      assert.deepEqual(summary.sealed.primary, report.statistics.session.overall);
      assert.deepEqual(summary.sealed.independent, report.statistics.independent.overall);
      assert.equal(summary.positiveSealedEvidence, report.statistics.session.overall.ci95[0] > 0);
    }
    const gzipPath = resolve(out, stage, 'replays.jsonl.gz');
    assert.equal(sha256(readFileSync(gzipPath)), report.replayArtifact.sha256);
    const seen = new Set(), previous = new Map(), scores = new Map();
    let games = 0, decisions = 0;
    const lines = createInterface({input:createReadStream(gzipPath).pipe(createGunzip()), crlfDelay:Infinity});
    for await (const line of lines) {
      if (!line.trim()) continue;
      const episode = JSON.parse(line), {suite, opponentPair, group, permutation, roles, arm, hand, replay} = episode;
      assert.ok(['independent', 'session'].includes(suite));
      assert.ok(['candidate', 'incumbent'].includes(arm));
      assert.ok(Number.isInteger(group) && group >= 0 && group < (suite === 'independent' ? groups : sessions));
      assert.ok(Number.isInteger(hand) && hand >= 0 && hand < (suite === 'independent' ? 1 : budget.sessionHands));
      assert.deepEqual(roles, report.seatPermutations[permutation]);
      const pair = report.opponentPairs.find(p => p.id === opponentPair); assert.ok(pair);
      const rolePolicies = {C:arm === 'candidate' ? report.candidate : report.incumbent, P:pair.policies[0], Q:pair.policies[1]};
      assert.deepEqual(episode.policyIds, roles.map(role => rolePolicies[role]));
      const groupSeed = deriveSeed(PROTOCOL_VERSION, report.split, report.seed, suite, opponentPair, group);
      assert.equal(episode.groupSeed, groupSeed);
      const environmentSeed = deriveSeed(groupSeed, 'environment', hand);
      assert.equal(replay.seed, environmentSeed);
      const identity = JSON.stringify([suite, opponentPair, group, permutation, arm, hand]);
      assert.ok(!seen.has(identity)); seen.add(identity);
      const sessionKey = JSON.stringify([suite, opponentPair, group, permutation, arm]);
      const last = previous.get(sessionKey);
      if (hand) assert.equal(last?.hand, hand - 1);
      // Verify dealing from the published RNG and the actual previous winner,
      // in addition to replaying the recorded actions and settlement.
      const initial = E.newGame({base:report.base, mode:'bots'}, hand ? last.next : null, seededRandom(environmentSeed));
      assert.deepEqual(replay.initialState, initial);
      const result = replayEpisode(replay);
      assert.equal(episode.decisions, replay.actions.length);
      decisions += episode.decisions;
      previous.set(sessionKey, {hand, next:{dealer:result.next.dealer, seats:result.next.seats,
        totals:initial.totals.map((n, i) => n + result.delta[i]), round:hand + 2}});
      const scoreKey = JSON.stringify([suite, opponentPair, groupSeed, arm]);
      const accumulator = scores.get(scoreKey) || {hands:0, score:0};
      accumulator.hands++; accumulator.score += result.delta[roles.indexOf('C')]; scores.set(scoreKey, accumulator);
      games++;
      if (games % 1000 === 0) onProgress({stage, games});
    }
    assert.equal(games, report.totalGames);
    assert.equal(games, report.replayArtifact.recorded);
    assert.equal(decisions, report.totalDecisions);
    for (const record of report.records) for (const arm of ['candidate', 'incumbent']) {
      const actual = scores.get(JSON.stringify([record.suite, record.opponentPair, record.seed, arm]));
      assert.deepEqual(actual, {hands:record[arm].hands, score:record[arm].score});
    }
    total += games; verified.push({stage, games, decisions, replaySha256:report.replayArtifact.sha256});
    onProgress({stage, complete:true, games});
  }
  assert.equal(total, summary.games);
  assert.deepEqual(studySources(), plan.sourceHashes);
  const result = {verifiedAt:new Date().toISOString(), games:total, stages:verified,
    checks:['Source and plan hashes', 'Fixed budgets and development selection', 'Separate seeded dealing and real continuation',
      'Every recorded action, conservation and settlement', 'Recomputed candidate scores and paired bootstrap'],
    verifierSha256:sha256(readFileSync(fileURLToPath(import.meta.url)))};
  if (write) writeFileSync(resolve(out, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') throw Error('Use --out study-directory');
  console.log(JSON.stringify(await verifyStudy({out:process.argv[3], onProgress:p => console.log(JSON.stringify(p))})));
}
