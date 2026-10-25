import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {prepareConfirmation, runConfirmation, finalizeConfirmation} from '../ai/action-scorer/confirm.mjs';
import {ActionScorer} from '../ai/action-scorer/model.mjs';
import {saveScorer} from '../ai/action-scorer/io.mjs';
import {encodeCandidates} from '../ai/action-scorer/features.mjs';
import {MahjongEnvironment} from '../ai/environment.mjs';
import {selectAction as h0} from '../ai/policies/h0.mjs';
import {actionId} from '../ai/training/encoding.mjs';
import {writeAtomicJson} from '../ai/training/checkpoint.mjs';
import {sha256} from '../ai/provenance.mjs';

test('fixed confirmation pins a fresh budget, models and seed; reports the new batch separately', async () => {
  mkdirSync('.tmp', {recursive:true}); const dir = mkdtempSync(join('.tmp', 'fixed-confirmation-'));
  const parentPath = resolve(dir, 'parent.json'), candidatePath = resolve(dir, 'candidate.json');
  const parent = new ActionScorer('confirm-parent'), candidate = ActionScorer.fromJSON(parent.toJSON());
  const env = new MahjongEnvironment({seed:'confirm-fixture', record:false}), o = env.observation(), legal = env.legalActions();
  candidate.update([{...encodeCandidates(o, legal), actionId:actionId(h0(o, legal))}]);
  const parentHash = saveScorer(parentPath, parent), candidateHash = saveScorer(candidatePath, candidate);
  const study = join(dir, 'study'), out = join(dir, 'confirmation'), prior = {session:{overall:{deltaPer100:0, ci95:[-1, 1], groups:1}}};
  writeAtomicJson(join(study, 'manifest.json'), {parent:{path:parentPath, sha256:parentHash}});
  writeAtomicJson(join(study, 'summary.json'), {status:'complete', selection:{selected:{arm:'fixture-bc', path:candidatePath, sha256:candidateHash}},
    sealed:{vsH0:prior, vsParent:prior}});
  const plan = prepareConfirmation({study, out, independentGroups:1, sessionGroups:1, sessionHands:2, bootstrapSamples:100});
  assert.equal(plan.candidate.sha256, candidateHash); assert.equal(plan.seedCommitment, sha256(plan.seed));
  assert.throws(() => prepareConfirmation({study, out}), /new/);
  await assert.rejects(() => runConfirmation({out, against:'unknown'}), /H0 or parent/);
  const reports = await Promise.all(['H0', 'parent'].map(against => runConfirmation({out, against})));
  const result = finalizeConfirmation(out);
  assert.equal(result.totalGames, 144); assert.equal(result.stratifiedReplays, 96);
  assert.equal(result.defaultGamePolicy, 'H0');
  for (const r of reports) {
    assert.equal(r.manifest.seed, plan.seed); assert.equal(r.manifest.candidate.sha256, candidateHash);
    assert.ok(Date.parse(r.manifest.startedAt) >= Date.parse(plan.preparedAt));
  }
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'summary.json'))).plan.priorStatistics, {vsH0:prior, vsParent:prior});
  assert.throws(() => finalizeConfirmation(out), /overwrite/);
});
