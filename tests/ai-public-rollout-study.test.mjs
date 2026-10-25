import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {ARMS, selectDevelopment, runStudy, evaluateArm} from '../ai/public-rollout/study.mjs';
import {replayEpisode} from '../ai/environment.mjs';
import {sha256} from '../ai/provenance.mjs';
import {verifyStudy} from '../ai/public-rollout/verify.mjs';
import {diagnoseStudy} from '../ai/public-rollout/diagnose.mjs';
import {finishStudy, runSealedComparison} from '../ai/public-rollout/finish.mjs';

test('net-score development selection includes H0 and proposal control and uses fixed stable ties', () => {
  const rows = ARMS.map(arm => ({arm, delta:0}));
  assert.equal(selectDevelopment(rows), null);
  assert.equal(selectDevelopment(rows.map(r => ({...r, delta:1}))), 'proposal-once');
  assert.equal(selectDevelopment(rows.map(r => ({...r, delta:r.arm === 'ev-mixed' ? 2 : 1}))), 'ev-mixed');
  assert.throws(() => selectDevelopment(rows.slice(1)), /Missing/);
});

test('bounded net-score study freezes plans and records public search traces and complete games for both arms', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'kwx-net-score-study-')), out = resolve(root, 'study');
  const summary = await runStudy({out, developmentSeed:'net-score-study-test', worlds:2,
    developmentGroups:0, developmentSessionGroups:1, sealedGroups:0, sealedSessionGroups:1,
    sessionHands:2, bootstrapSamples:50, onProgress:() => {}});
  const plan = JSON.parse(readFileSync(resolve(out, 'plan.json')));
  assert.equal(summary.planSha256, sha256(readFileSync(resolve(out, 'plan.json'))));
  assert.equal(summary.selectionSha256, sha256(readFileSync(resolve(out, 'selection.json'))));
  assert.notEqual(plan.developmentSeed, plan.sealedSeed);
  assert.deepEqual(plan.arms, ARMS);
  assert.equal(plan.common.worlds, 2);
  assert.equal(plan.common.uncertaintyPenalty, 0);
  assert.equal(summary.trainingHands, 0);
  const extra = resolve(root, 'ablation');
  await evaluateArm({candidate:'ev-mixed', incumbent:'proposal-once', common:plan.common,
    out:extra, seed:'net-score-ablation-test', split:'development', independentGroups:0,
    sessionGroups:1, sessionHands:2, bootstrapSamples:50});
  let actualGames = 0, traces = 0;
  const paths = [...ARMS.map(a => resolve(out, `development-${a}`)),
    ...Object.keys(summary.sealed).map(a => resolve(out, `sealed-vs-${a}`)), extra];
  for (const path of paths) {
    const report = JSON.parse(readFileSync(resolve(path, 'report.json')));
    const bytes = readFileSync(resolve(path, 'replays.jsonl.gz'));
    assert.equal(sha256(bytes), report.artifacts.replays.sha256);
    const episodes = gunzipSync(bytes).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(episodes.length, 48);
    for (const e of episodes) replayEpisode(e.replay);
    assert.equal(report.illegalActions, 0);
    const searchBytes = readFileSync(resolve(path, 'searches.jsonl.gz'));
    assert.equal(sha256(searchBytes), report.artifacts.decisions.sha256);
    const searches = gunzipSync(searchBytes).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(searches.length, Object.values(report.search).reduce((s, r) => s + r.proposals, 0));
    for (const s of searches) {
      assert.ok(s.ownDecision > 0);
      assert.equal(s.observation.players.filter(p => p.hand).length, 1);
      assert.equal(s.observation.wall, undefined);
      assert.equal(s.analysis.proposed, true);
      assert.equal(s.analysis.worlds?.length || 0, s.analysis.searched ? 2 : 0);
    }
    traces += searches.length;
    if (path !== extra) actualGames += report.totalGames;
  }
  assert.ok(traces > 0);
  assert.equal(actualGames, summary.games);
  const verified = await verifyStudy({out, write:false});
  assert.equal(verified.games, summary.games);
  const audit = await diagnoseStudy({out, write:false});
  assert.equal(audit.roots, verified.traces);
  assert.equal(audit.hypotheticalAuditGames, audit.roots * 2);
  for (const stage of audit.stages) for (const row of stage.rows)
    assert.equal(row.realizedChosenGain, row.selectedAlternative ? row.realizedAlternativeGain : 0);
  assert.ok(!JSON.stringify(audit).includes('"wall":'));
  const developmentAudit = await diagnoseStudy({out, write:false, developmentOnly:true});
  assert.equal(developmentAudit.scope, 'development');
  assert.deepEqual(developmentAudit.stages, audit.stages.slice(0, 3));
  const resumed = finishStudy({out, write:false});
  const {completedAt:originalTime, ...originalRest} = summary;
  const {completedAt:resumedTime, ...resumedRest} = resumed;
  assert.deepEqual(resumedRest, originalRest);
  assert.ok(resumedTime >= originalTime);
  assert.throws(() => finishStudy({out}), /already exists/);
  await assert.rejects(runSealedComparison({out, against:'unplanned'}), /not declared/);
  const tamperedPath = resolve(out, 'development-proposal-once', 'report.json');
  const tampered = JSON.parse(readFileSync(tamperedPath)); tampered.records[0].candidate.score++;
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(verifyStudy({out, write:false}));
  assert.throws(() => finishStudy({out, write:false}));
  await assert.rejects(runStudy({out}), /exists/);
});
