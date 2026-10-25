import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ActorCritic} from '../ai/training/network.mjs';
import {INPUT_SIZE, ACTION_SIZE} from '../ai/training/encoding.mjs';
import {makeCheckpoint, saveCheckpoint} from '../ai/training/checkpoint.mjs';

test('evaluation CLI loads frozen model files, records hashes and replays identical-policy games', () => {
  mkdirSync('.tmp', {recursive:true});
  const folder = mkdtempSync(resolve('.tmp', 'kwx-model-cli-'));
  const file = resolve(folder, 'checkpoint.json'), out = resolve(folder, 'evaluation');
  const model = new ActorCritic({inputSize:INPUT_SIZE, actionSize:ACTION_SIZE, hiddenSize:4, seed:'cli-model'});
  const hash = saveCheckpoint(file, makeCheckpoint(model, {counters:{learnerDecisions:123}}, {kind:'snapshot', iteration:1}));
  execFileSync(process.execPath, ['ai/evaluate.mjs', '--candidate-model', file, '--incumbent-model', file,
    '--groups', '1', '--session-groups', '0', '--bootstrap', '20', '--out', out], {encoding:'utf8'});
  const report = JSON.parse(readFileSync(resolve(out, 'report.json'), 'utf8'));
  assert.equal(report.models.candidate.sha256, hash);
  assert.equal(report.models.incumbent.sha256, hash);
  assert.equal(report.models.candidate.trainingSteps, 123);
  assert.equal(report.statistics.independent.overall.deltaPer100, 0);
  assert.equal(report.illegalActions, 0); assert.equal(report.descriptiveOnly, true);
  assert.match(readFileSync(resolve(out, 'report.md'), 'utf8'), /不能作为可靠显著性或晋级证据/);
  const replayed = execFileSync(process.execPath, ['ai/evaluate.mjs', '--replay', resolve(out, 'replays.jsonl.gz')], {encoding:'utf8'});
  assert.match(replayed, /Replayed 24 episodes/);
  assert.throws(() => execFileSync(process.execPath, ['ai/evaluate.mjs', '--candidate', 'H0', '--candidate-model', file],
    {stdio:'pipe'}), /failed/);
});
