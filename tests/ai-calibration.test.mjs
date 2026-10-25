import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {trainBc, runCalibration, selectCalibration, normalizeConfig} from '../ai/action-scorer/calibration.mjs';
import {trainScorer} from '../ai/action-scorer/train.mjs';
import {ActionScorer} from '../ai/action-scorer/model.mjs';
import {FEATURE_SIZE} from '../ai/action-scorer/features.mjs';
import {saveScorer, loadScorer} from '../ai/action-scorer/io.mjs';
import {writeAtomicJson} from '../ai/training/checkpoint.mjs';
import {deriveSeed} from '../ai/random.mjs';

function fixture(name) { mkdirSync('.tmp', {recursive:true}); return mkdtempSync(join('.tmp', name)); }
test('BC-only preserves critic and exact continuation of Adam, policy and sampling', async () => {
  const dir = fixture('bc-calibration-'), parent = join(dir, 'parent.json'), model = new ActionScorer('bc-parent');
  model.parameters[FEATURE_SIZE] = 0.3; saveScorer(parent, model);
  const config = {seed:'bc-resume', handsPerIteration:3, epochs:2, batchSize:8};
  const whole = await trainBc({out:join(dir, 'whole'), initializeFrom:parent, iterations:2, config});
  const first = await trainBc({out:join(dir, 'first'), initializeFrom:parent, iterations:1, config});
  const resumed = await trainBc({out:join(dir, 'resumed'), resume:first.finalCheckpoint.path, iterations:2, config});
  const loaded = loadScorer(whole.finalCheckpoint.path);
  assert.deepEqual(loaded.model.toJSON(), loadScorer(resumed.finalCheckpoint.path).model.toJSON());
  assert.deepEqual(loaded.model.parameters.slice(FEATURE_SIZE), model.parameters.slice(FEATURE_SIZE));
  assert.deepEqual(whole.history, resumed.history); assert.equal(whole.counters.hands, 6);
  await assert.rejects(() => trainBc({out:join(dir, 'bad'), resume:first.finalCheckpoint.path, iterations:2,
    config:{...config, learningRate:0.01}}), /Incompatible exact/);
});
test('calibration selection uses arm means, requires complete grids and tolerates roundoff ties', () => {
  const row = (arm, seed, score, independent=score) => ({arm, seed,
    statistics:{session:{overall:{deltaPer100:score}}, independent:{overall:{deltaPer100:independent}}}});
  const rows = [row('parent', -1, 5), row('ppo-low', 0, 20), row('ppo-low', 1, -20),
    row('bc-only', 0, 5 + 1e-12, 5), row('bc-only', 1, 5, 5), row('ppo-fast', 0, 0), row('ppo-fast', 1, 0)];
  assert.equal(selectCalibration(rows, 2).selected.arm, 'parent');
  rows[6] = row('ppo-fast', 1, 14); assert.equal(selectCalibration(rows, 2).selected.seed, 1);
  assert.throws(() => selectCalibration(rows.slice(1), 2), /Incomplete/);
  for (const c of [{unknown:1}, {fastLearningRate:0}, {sessionHands:0}]) assert.throws(() => normalizeConfig(c));
});
test('calibration reuses a genuine low-step endpoint and freezes selection before heldout games', async () => {
  const dir = fixture('step-calibration-'), parent = join(dir, 'parent.json');
  const hash = saveScorer(parent, new ActionScorer('calibration-parent'));
  const reference = join(dir, 'reference'), seed = 'calibration-ref';
  const low = await trainScorer({out:join(reference, 'low'), initializeFrom:parent, iterations:1,
    config:{seed:deriveSeed(seed, 'training', 0), handsPerIteration:2, bcCoef:0}});
  writeAtomicJson(join(reference, 'manifest.json'), {parent:{path:resolve(parent), sha256:hash}});
  writeAtomicJson(join(reference, 'summary.json'), {format:'kwx-scorer-ppo-comparison-1', status:'complete',
    config:{seed, seeds:1, iterations:1, handsPerIteration:2}, trainings:[{seed:0, arm:'ppo', finalCheckpoint:low.finalCheckpoint}]});
  const out = join(dir, 'study');
  const result = await runCalibration({out, referenceStudy:reference, config:{developmentGroups:1,
    developmentSessionGroups:1, sealedGroups:1, sealedSessionGroups:1, sessionHands:2, bootstrapSamples:100}});
  assert.equal(result.trainingHands, 4); assert.equal(result.reusedTrainingHands, 2);
  assert.ok(result.trainings.every(t => t.trainingConfig.learningRate === 0.01));
  for (const t of result.trainings) {
    const metadata = loadScorer(t.path).checkpoint.metadata;
    const state = metadata.bcOnlyTraining || metadata.training;
    assert.deepEqual(state.history[0].rollout, low.history[0].rollout);
  }
  assert.equal(result.totalEvaluationGames, result.selection.selected.arm === 'parent' ? 360 : 432);
  const rows = JSON.parse(readFileSync(join(out, 'development.json')));
  assert.equal(rows.find(r => r.arm === 'ppo-low').sha256, low.finalCheckpoint.sha256);
  const frozen = JSON.parse(readFileSync(join(out, 'selection-frozen.json')));
  const report = JSON.parse(readFileSync(join(out, 'sealed-vs-H0/report.json')));
  assert.ok(Date.parse(frozen.frozenAt) <= Date.parse(report.manifest.startedAt));
  assert.equal(report.manifest.candidate.sha256, frozen.selected.sha256);
});
