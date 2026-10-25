import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {selectDevelopment, runStudy} from '../ai/lookahead/study.mjs';
import {replayEpisode} from '../ai/environment.mjs';
import {sha256} from '../ai/provenance.mjs';
import {verifyStudy} from '../ai/lookahead/verify.mjs';

test('development selection includes H0, requires all planned candidates and has stable ties', () => {
  assert.equal(selectDevelopment([{mode:'ties', delta:-1}, {mode:'same-shanten', delta:0}]), null);
  assert.equal(selectDevelopment([{mode:'same-shanten', delta:1}, {mode:'ties', delta:1}]), 'ties');
  assert.equal(selectDevelopment([{mode:'ties', delta:1}, {mode:'same-shanten', delta:2}]), 'same-shanten');
  assert.throws(() => selectDevelopment([{mode:'ties', delta:1}]), /declared modes/);
});

test('bounded study predeclares budgets and sources, preserves artifacts and replays full development games', async () => {
  const out = resolve(mkdtempSync(resolve(tmpdir(), 'kwx-lookahead-')), 'study');
  const summary = await runStudy({out, developmentSeed:'lookahead-study-test', developmentGroups:0,
    developmentSessionGroups:1, sealedGroups:0, sealedSessionGroups:1, sessionHands:1,
    bootstrapSamples:50, onProgress:() => {}});
  const plan = JSON.parse(readFileSync(resolve(out, 'plan.json')));
  const selection = JSON.parse(readFileSync(resolve(out, 'selection.json')));
  assert.equal(summary.planSha256, sha256(readFileSync(resolve(out, 'plan.json'))));
  assert.equal(summary.selectionSha256, sha256(readFileSync(resolve(out, 'selection.json'))));
  assert.deepEqual(summary.sourceHashes, plan.sourceHashes);
  assert.equal(plan.budget.sealedSessionGroups, 1);
  assert.equal(plan.trainingHands, 0);
  assert.notEqual(plan.developmentSeed, plan.sealedSeed);
  assert.ok(selection.createdAt >= plan.createdAt);
  let games = 0;
  for (const stage of ['development-ties', 'development-same-shanten', ...(summary.selected ? ['sealed'] : [])]) {
    const report = JSON.parse(readFileSync(resolve(out, stage, 'report.json')));
    const compressed = readFileSync(resolve(out, stage, 'replays.jsonl.gz'));
    assert.equal(sha256(compressed), report.replayArtifact.sha256);
    const episodes = gunzipSync(compressed).toString('utf8').trim().split('\n').map(JSON.parse);
    assert.equal(episodes.length, 24);
    for (const episode of episodes) replayEpisode(episode.replay);
    assert.equal(report.illegalActions, 0);
    assert.equal(report.replayArtifact.audited, 24);
    games += report.totalGames;
  }
  assert.equal(summary.games, games);
  const verification = await verifyStudy({out, write:false});
  assert.equal(verification.games, games);
  const tamperedPath = resolve(out, 'development-ties', 'report.json');
  const tampered = JSON.parse(readFileSync(tamperedPath));
  tampered.records[0].candidate.score++;
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(verifyStudy({out, write:false}));
  await assert.rejects(runStudy({out}), /exists/);
});
