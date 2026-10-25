import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {collectPairedData, diagnostics, normalizeConfig, selectArm, runStudy} from '../ai/action-scorer/experiment.mjs';
import {ActionScorer} from '../ai/action-scorer/model.mjs';
import {sha256} from '../ai/provenance.mjs';
import {diagnose} from '../ai/action-scorer/diagnose.mjs';
import {evaluateScorer} from '../ai/action-scorer/evaluate.mjs';
import {gunzipSync} from 'node:zlib';
import {replayEpisode} from '../ai/environment.mjs';
test('candidate study rejects unknown or invalid budgets', () => {
  for (const c of [{seeds:0}, {epochs:1.5}, {seed:''}, {rawLearningRate:NaN}, {unknown:1}]) assert.throws(() => normalizeConfig(c));
});
test('paired teacher data shares legal IDs and targets in both representations', async () => {
  const data = await collectPairedData({hands:2, seed:'paired-test'});
  assert.equal(data.raw.length, data.structured.length);
  for (let i = 0; i < data.raw.length; i++) {
    assert.deepEqual(data.structured[i].candidates.map(c => c.id), data.raw[i].legalIds);
    assert.equal(data.structured[i].actionId, data.raw[i].actionId);
  }
  const d = diagnostics(new ActionScorer(), data.structured, 'structured');
  assert.ok(d.choices > 0 && d.choices < d.samples); assert.ok(Number.isFinite(d.crossEntropy));
});
test('candidate study selection uses only development scores with deterministic tie breaks', () => {
  const row = (arm, seed, score, secondary) => ({arm, seed, statistics:{session:{overall:{deltaPer100:score}}, independent:{overall:{deltaPer100:secondary}}}});
  const rows = [row('raw', 0, 999, 999), row('structured', 2, 1, 2), row('structured', 1, 1, 2), row('structured', 0, 1, 1)];
  assert.equal(selectArm(rows, 'structured').seed, 1); assert.equal(selectArm(rows, 'raw').seed, 0);
});
test('candidate study completes both training arms, frozen selection and sealed paired evaluation', async () => {
  mkdirSync('.tmp', {recursive:true}); const out = mkdtempSync(join('.tmp', 'candidate-study-'));
  const report = await runStudy({out, config:{seeds:1, trainingHands:2, validationHands:2, epochs:1,
    checkpointEvery:1, developmentGroups:1, developmentSessionGroups:1, sealedGroups:1, sealedSessionGroups:1,
    sessionHands:2, bootstrapSamples:100}});
  assert.equal(report.status, 'complete'); assert.equal(report.totalEvaluationGames, 288);
  assert.equal(report.replayed, 192); assert.equal(report.defaultGamePolicy, 'H0');
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json')));
  assert.equal(sha256(readFileSync(join(out, 'sealed-seed.txt'), 'utf8').trim()), manifest.sealedSeedCommitment);
  assert.ok(report.selected.structured.sha256); assert.ok(report.selected.raw.sha256);
  const diagnostic = await diagnose({path:report.selected.structured.path, arm:'structured', hands:2});
  assert.ok(diagnostic.distributions.H0.choices > 0 && diagnostic.distributions.model.choices > 0);
  assert.equal(diagnostic.model.sha256, report.selected.structured.sha256);
  const evaluationFolder = join(out, 'standalone');
  const evaluated = await evaluateScorer({model:report.selected.structured.path, incumbent:report.selected.raw.path,
    out:evaluationFolder, seed:'standalone-test', independentGroups:1, sessionGroups:1, sessionHands:2, bootstrapSamples:100});
  const replayBytes = readFileSync(join(evaluationFolder, 'replays.jsonl.gz'));
  const episodes = gunzipSync(replayBytes).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(evaluated.recorded, 72); assert.equal(episodes.length, evaluated.totalGames);
  assert.equal(sha256(replayBytes), evaluated.replaySha256);
  for (const e of episodes) assert.deepEqual(replayEpisode(e.replay), e.replay.result);
  await assert.rejects(() => runStudy({out}), /new empty directory/);
});
