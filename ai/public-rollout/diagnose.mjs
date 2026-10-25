// OFFLINE AUDIT ONLY. This file may inspect recorded private state after play.
// Policy/sampler/study never import it and never receive its counterfactual labels.
import assert from 'node:assert/strict';
import {readFileSync, createReadStream, existsSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGunzip, gunzipSync} from 'node:zlib';
import {createInterface} from 'node:readline';
import {MahjongEnvironment, actionKey} from '../environment.mjs';
import {sha256} from '../provenance.mjs';
import {ARMS, rolloutSources} from './study.mjs';
import {simulateToEnd} from './policy.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const key = e => JSON.stringify([e.suite, e.opponentPair, e.group, e.permutation, e.arm, e.hand]);
export async function diagnoseStudy({out, write = true, developmentOnly = false, onProgress = () => {}}) {
  out = resolve(out);
  const name = developmentOnly ? 'development-counterfactual-audit.json' : 'counterfactual-audit.json';
  if (write && existsSync(resolve(out, name))) throw Error('Audit exists');
  const plan = read(resolve(out, 'plan.json'));
  const summary = developmentOnly ? {sealed:{}} : read(resolve(out, 'summary.json'));
  assert.deepEqual(rolloutSources(), plan.sourceHashes);
  const stages = [...ARMS.map(arm => `development-${arm}`), ...Object.keys(summary.sealed).map(id => `sealed-vs-${id}`)];
  const results = []; let total = 0;
  for (const stage of stages) {
    const report = read(resolve(out, stage, 'report.json'));
    const searchBytes = readFileSync(resolve(out, stage, 'searches.jsonl.gz'));
    assert.equal(sha256(searchBytes), report.artifacts.decisions.sha256);
    const traces = gunzipSync(searchBytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    const map = new Map(traces.map(t => [key(t), t])), rows = [], byPolicy = {};
    const replayPath = resolve(out, stage, 'replays.jsonl.gz');
    assert.equal(sha256(readFileSync(replayPath)), report.artifacts.replays.sha256);
    const lines = createInterface({input:createReadStream(replayPath).pipe(createGunzip()), crlfDelay:Infinity});
    for await (const line of lines) {
      if (!line.trim()) continue;
      const e = JSON.parse(line), trace = map.get(key(e)); if (!trace) continue;
      const seat = e.roles.indexOf('C'), env = new MahjongEnvironment({initialState:e.replay.initialState, record:false});
      let ownDecision = 0, found = false;
      for (const entry of e.replay.actions) {
        if (entry.seat === seat && ++ownDecision === trace.ownDecision) {
          assert.deepEqual(env.observation(), trace.observation);
          assert.equal(actionKey(entry.action), actionKey(trace.analysis.action));
          const state = env.auditState(); // Private state stays inside this offline auditor.
          const opponentIds = e.policyIds.filter((_, i) => i !== seat);
          assert.ok(opponentIds.every(id => ['H0', 'greedy-speed-v1'].includes(id)));
          const baseline = simulateToEnd(state, trace.analysis.baseline, seat, {opponentIds});
          const alternative = simulateToEnd(state, trace.analysis.alternative, seat, {opponentIds});
          const changed = trace.analysis.action.tile !== trace.analysis.baseline.tile;
          // One-search quota makes the actually chosen branch exactly reproducible:
          // subsequent own decisions are H0, matching the audit continuation.
          assert.equal((changed ? alternative : baseline).score, e.replay.result.delta[seat]);
          const gain = (alternative.score - baseline.score) / report.base;
          const predicted = trace.analysis.comparison ? trace.analysis.comparison.mean / report.base : null;
          const row = {suite:e.suite, opponentPair:e.opponentPair, group:e.group, permutation:e.permutation,
            arm:e.arm, hand:e.hand, policy:trace.policy, selectedAlternative:changed,
            predictedGain:predicted, realizedAlternativeGain:gain, realizedChosenGain:changed ? gain : 0};
          rows.push(row);
          const stats = byPolicy[trace.policy] ||= {roots:0, accepted:0, predictedRoots:0, predictedGainSum:0,
            realizedAlternativeGainSum:0, realizedChosenGainSum:0, keptH0InsteadOfProposalGainSum:0,
            acceptedOutcomes:{positive:0, zero:0, negative:0}, rejectedOutcomes:{positive:0, zero:0, negative:0}};
          stats.roots++; stats.accepted += Number(changed);
          if (predicted !== null) { stats.predictedRoots++; stats.predictedGainSum += predicted; }
          stats.realizedAlternativeGainSum += gain; stats.realizedChosenGainSum += changed ? gain : 0;
          stats.keptH0InsteadOfProposalGainSum += changed ? 0 : -gain;
          stats[changed ? 'acceptedOutcomes' : 'rejectedOutcomes'][gain > 0 ? 'positive' : gain < 0 ? 'negative' : 'zero']++;
          found = true; break;
        }
        env.step(entry.action);
      }
      assert.equal(found, true);
    }
    assert.equal(rows.length, traces.length);
    total += rows.length; results.push({stage, roots:rows.length, byPolicy, rows});
    onProgress({stage, roots:rows.length});
  }
  assert.deepEqual(rolloutSources(), plan.sourceHashes);
  const audit = {createdAt:new Date().toISOString(), scope:developmentOnly ? 'development' : 'all-completed',
    purpose:'Offline actual-world counterfactual diagnosis only; never policy input or training data.',
    roots:total, hypotheticalAuditGames:total * 2, stages:results, sourceHashes:plan.sourceHashes,
    limitations:['Each recorded private world is one realized outcome, not the true conditional expected value.',
      'Root populations differ by policy; these conditional diagnostics are not full-policy causal strength tests.',
      'All evaluation splits remain excluded from training. Actual hidden states are not serialized into this audit.'],
    diagnosticSha256:sha256(readFileSync(fileURLToPath(import.meta.url)))};
  if (write) writeFileSync(resolve(out, name), JSON.stringify(audit, null, 2) + '\n');
  return audit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (![4, 6].includes(process.argv.length) || process.argv[2] !== '--out' ||
    process.argv.length === 6 && (process.argv[4] !== '--development-only' || process.argv[5] !== 'true')) throw Error('Use --out study-directory [--development-only true]');
  const result = await diagnoseStudy({out:process.argv[3], developmentOnly:process.argv.length === 6,
    onProgress:p => console.log(JSON.stringify(p))});
  console.log(JSON.stringify({roots:result.roots, hypotheticalAuditGames:result.hypotheticalAuditGames}));
}
