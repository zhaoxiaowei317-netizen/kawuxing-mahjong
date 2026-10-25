import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runRlStudy, selectCandidate, normalizeConfig} from '../ai/action-scorer/rl-study.mjs';
import {ActionScorer} from '../ai/action-scorer/model.mjs';
import {saveScorer} from '../ai/action-scorer/io.mjs';
import {sha256} from '../ai/provenance.mjs';
test('RL selection keeps the parent eligible and ranks arm means before best seeds', () => {
  const row = (arm, seed, n) => ({arm, seed, statistics:{session:{overall:{deltaPer100:n}}, independent:{overall:{deltaPer100:n}}}});
  const rows = [row('parent', -1, 5), row('ppo', 0, 20), row('ppo', 1, -20), row('anchored', 0, 5), row('anchored', 1, 5)];
  assert.equal(selectCandidate(rows, 2).selected.arm, 'parent');
  rows[4] = row('anchored', 1, 7);
  assert.equal(selectCandidate(rows, 2).selected.seed, 1); assert.equal(selectCandidate(rows, 2).selected.arm, 'anchored');
  assert.throws(() => selectCandidate(rows.slice(1), 2), /Incomplete/);
  for (const c of [{anchorCoef:0}, {seeds:0}, {selfPlayFraction:2}, {unknown:1}]) assert.throws(() => normalizeConfig(c));
});
test('RL study trains both arms and freezes a candidate before sealed tests', async () => {
  mkdirSync('.tmp', {recursive:true}); const dir = mkdtempSync(join('.tmp', 'scorer-rl-study-')), parent = join(dir, 'parent.json');
  saveScorer(parent, new ActionScorer('rl-study-parent'));
  const folder = join(dir, 'study');
  const s = await runRlStudy({out:folder, parent, config:{seeds:1, iterations:1, handsPerIteration:2,
    developmentGroups:1, developmentSessionGroups:1, sealedGroups:1, sealedSessionGroups:1, sessionHands:2, bootstrapSamples:100}});
  assert.equal(s.status, 'complete'); assert.equal(s.trainingHands, 4); assert.equal(s.trainings.length, 2);
  assert.equal(s.totalEvaluationGames, s.selection.selected.arm === 'parent' ? 288 : 360);
  assert.equal(s.defaultGamePolicy, 'H0');
  const seed = JSON.parse(readFileSync(join(folder, 'sealed-seed.json'))).seed;
  const frozen = JSON.parse(readFileSync(join(folder, 'selection-frozen.json')));
  assert.equal(sha256(seed), frozen.sealedSeedCommitment);
  const report = JSON.parse(readFileSync(join(folder, 'sealed-vs-H0', 'report.json')));
  assert.equal(report.manifest.candidate.sha256, frozen.selected.sha256);
  assert.ok(Date.parse(frozen.frozenAt) <= Date.parse(report.manifest.startedAt));
});
