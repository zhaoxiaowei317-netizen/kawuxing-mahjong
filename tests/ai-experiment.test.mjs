import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {normalizeExperimentConfig, selectDevelopmentCandidate, runExperiment} from '../ai/experiment.mjs';

test('experiment selects an arm across seeds before selecting its candidate; incomplete grids fail', () => {
  const row = (arm, seed, score) => ({arm, seed, statistics:{
    session:{overall:{deltaPer100:score}}, independent:{overall:{deltaPer100:score}}}});
  const rows = [row('a', 0, 100), row('a', 1, -200), row('b', 0, 10), row('b', 1, 20)];
  assert.equal(selectDevelopmentCandidate(rows).selected.arm, 'b');
  assert.equal(selectDevelopmentCandidate(rows).selected.seed, 1);
  assert.throws(() => selectDevelopmentCandidate(rows.slice(0, 3)), /Incomplete/);
  assert.throws(() => normalizeExperimentConfig({seeds:0}), /Invalid/);
  assert.throws(() => normalizeExperimentConfig({unknown:1}), /Unknown/);
});

test('complete tiny experiment freezes candidate before sealed evaluation and preserves auditable evidence', async () => {
  mkdirSync(resolve('.tmp'), {recursive:true});
  const root = mkdtempSync(resolve('.tmp', 'kwx-experiment-test-'));
  const out = resolve(root, 'run');
  const summary = await runExperiment({out, config:{seeds:1, hiddenSize:4, bcEpisodes:2, validationEpisodes:2,
    bcEpochs:1, checkpointEvery:1, iterations:1, episodesPerIteration:2, ppoEpochs:1,
    developmentGroups:1, developmentSessionGroups:1, sealedGroups:1, sealedSessionGroups:1,
    sessionHands:1, bootstrapSamples:20}});
  assert.equal(summary.status, 'complete');
  assert.equal(summary.defaultGamePolicy, 'H0');
  const events = readFileSync(resolve(out, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const frozen = events.findIndex(e => e.phase === 'selection-frozen');
  assert.ok(frozen > 0);
  assert.ok(events.findIndex(e => e.phase === 'evaluation' && e.name === 'sealed-vs-H0') > frozen);
  const report = JSON.parse(readFileSync(resolve(out, 'sealed-vs-H0.json'), 'utf8'));
  assert.equal(report.split, 'sealed'); assert.equal(report.replayed, 48);
  assert.equal(report.illegalActions, 0);
  const rows = JSON.parse(readFileSync(resolve(out, 'development.json'), 'utf8'));
  assert.equal(rows.length, 3);
});
