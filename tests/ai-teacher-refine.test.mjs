import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ActorCritic} from '../ai/training/network.mjs';
import {INPUT_SIZE, ACTION_SIZE, encodeObservation, legalActionIds, actionId} from '../ai/training/encoding.mjs';
import {saveCheckpoint, makeCheckpoint} from '../ai/training/checkpoint.mjs';
import {chooseModelAction} from '../ai/training/policy.mjs';
import {collectTeacherCorrections, runTeacherRefinement} from '../ai/teacher-refine.mjs';
import {MahjongEnvironment} from '../ai/environment.mjs';
import {deriveSeed} from '../ai/random.mjs';
import {policyById} from '../ai/policies/index.mjs';

test('teacher corrections label model-induced states without pretending the teacher action was executed', async () => {
  const model = new ActorCritic({inputSize:INPUT_SIZE, actionSize:ACTION_SIZE, hiddenSize:4, seed:'correction-test'});
  const seed = 'correction-test', round = 1;
  const data = await collectTeacherCorrections({model, episodes:1, seed, round, teacherFraction:0});
  const env = new MahjongEnvironment({seed:deriveSeed('teacher-refinement', seed, round, 0), record:false});
  const h0 = policyById('H0'); let index = 0, disagreements = 0;
  while (!env.done) {
    const o = env.observation(), legal = env.legalActions();
    const executed = chooseModelAction(model, o, legal, null, {deterministic:true}).action, label = h0(o, legal);
    assert.deepEqual(data.samples[index++], {features:encodeObservation(o), legalIds:legalActionIds(legal),
      actionId:actionId(label), executedActionId:actionId(executed), driver:'model'});
    disagreements += Number(actionId(label) !== actionId(executed)); env.step(executed);
  }
  assert.equal(index, data.samples.length); assert.ok(disagreements > 0);
  assert.equal(disagreements, data.stats.disagreements);
});

test('refinement pilot preserves the parent and freezes selection before independent evaluation', async () => {
  mkdirSync(resolve('.tmp'), {recursive:true});
  const root = mkdtempSync(resolve('.tmp', 'kwx-refine-test-')), parent = resolve(root, 'parent.json');
  const model = new ActorCritic({inputSize:INPUT_SIZE, actionSize:ACTION_SIZE, hiddenSize:4, seed:'refine-test'});
  saveCheckpoint(parent, makeCheckpoint(model, {counters:{learnerDecisions:0}}, {kind:'snapshot'}));
  const before = readFileSync(parent, 'utf8'), out = resolve(root, 'run');
  const result = await runTeacherRefinement({parent, out, rounds:1, episodes:4, epochs:1,
    validationEpisodes:2, groups:1, sessionGroups:1, sessionHands:1, bootstrapSamples:20});
  assert.equal(result.status, 'complete'); assert.equal(result.totalEpisodes, 4);
  assert.equal(readFileSync(parent, 'utf8'), before);
  assert.equal(result.history[1].stats.teacherEpisodes, 2); assert.equal(result.history[1].stats.modelEpisodes, 2);
  const events = readFileSync(resolve(out, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.findIndex(e => e.phase === 'evaluation') > events.findIndex(e => e.phase === 'selection-frozen'));
});
