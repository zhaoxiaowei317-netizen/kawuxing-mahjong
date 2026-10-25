import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePaired } from '../ai/statistics.mjs';

function group(seed, candidateScore, incumbentScore = 0, { pair = 'P+Q', hands = 6, suite = 'independent' } = {}) {
  return {
    suite, opponentPair: pair, seed,
    candidate: { hands, score: candidateScore },
    incumbent: { hands, score: incumbentScore },
  };
}

test('paired score normalization uses configured base and includes negative scores', () => {
  const result = summarizePaired([group('s0', 12, -6)], { base: 2, bootstrapSamples: 20 });
  assert.equal(result.independent.overall.candidatePer100, 100);
  assert.equal(result.independent.overall.incumbentPer100, -50);
  assert.equal(result.independent.overall.deltaPer100, 150);
  assert.deepEqual(result.independent.overall.ci95, [150, 150]);
  assert.equal(result.independent.overall.groups, 1);
  assert.equal(result.independent.overall.hands, 6);
  assert.equal(result.session.overall, null);
});

test('opponent pairs stay equally weighted even when one pair has more seed groups', () => {
  const result = summarizePaired([
    group('a', 6, 0, { pair: 'easy' }),
    group('b', 6, 0, { pair: 'easy' }),
    group('c', 6, 0, { pair: 'easy' }),
    group('d', -6, -3, { pair: 'hard' }),
  ], { bootstrapSamples: 50 });
  const overall = result.independent.overall;
  assert.equal(overall.groups, 4);
  assert.equal(overall.hands, 24);
  assert.equal(overall.candidatePer100, 0, 'pooled-hand weighting would incorrectly report +50');
  assert.equal(overall.incumbentPer100, -25);
  assert.equal(overall.deltaPer100, 25);
  assert.deepEqual(overall.ci95, [25, 25]);
  assert.equal(result.independent.byOpponentPair.easy.candidatePer100, 100);
  assert.equal(result.independent.byOpponentPair.hard.candidatePer100, -100);
});

test('six correlated seat permutations are resampled as a whole opening-seed group', () => {
  const result = summarizePaired([
    group('all-six-win', 6),
    group('all-six-lose', -6),
  ], { seed: 'known-two-groups', bootstrapSamples: 2000 });
  assert.equal(result.independent.overall.deltaPer100, 0);
  assert.equal(result.independent.overall.groups, 2);
  assert.equal(result.independent.overall.hands, 12);
  assert.deepEqual(result.independent.overall.ci95, [-100, 100]);
});

test('paired bootstrap cancels shared luck, preserving an exact zero difference for identical policies', () => {
  const result = summarizePaired([
    group('s1', 600, 600), group('s2', -300, -300), group('s3', 12, 12),
    group('s4', 1, 1, { pair: 'R+S' }),
  ], { seed: 'paired-luck', bootstrapSamples: 100 });
  assert.equal(result.independent.overall.deltaPer100, 0);
  assert.deepEqual(result.independent.overall.ci95, [0, 0]);
  for (const summary of Object.values(result.independent.byOpponentPair)) {
    assert.equal(summary.deltaPer100, 0);
    assert.deepEqual(summary.ci95, [0, 0]);
  }
});

test('independent games and 16-hand sessions have separate summaries and normalizations', () => {
  const result = summarizePaired([
    group('same-key', 6),
    group('same-key', -96, 96, { suite: 'session', hands: 96 }),
  ], { bootstrapSamples: 20 });
  assert.equal(result.independent.overall.deltaPer100, 100);
  assert.equal(result.session.overall.candidatePer100, -100);
  assert.equal(result.session.overall.incumbentPer100, 100);
  assert.equal(result.session.overall.deltaPer100, -200);
  assert.equal(result.session.overall.hands, 96);
});

test('fixed bootstrap seed is reproducible and result can be serialized', () => {
  const records = [group('a', 2, 1), group('b', 5, -2), group('c', -4, -3)];
  const options = { seed: 'reproducible', bootstrapSamples: 137 };
  const first = summarizePaired(records, options);
  assert.deepEqual(first, summarizePaired(records, options));
  assert.deepEqual(first, JSON.parse(JSON.stringify(first)));
  assert.ok(first.independent.overall.ci95.every(Number.isFinite));
  assert.ok(first.independent.overall.ci95[0] <= first.independent.overall.ci95[1]);
});

test('bootstrap for a pair is unchanged when another opponent pair is added', () => {
  const records = [group('a', 2), group('b', -3), group('c', 7)];
  const options = { seed: 'stable-pair-stream', bootstrapSamples: 300 };
  const first = summarizePaired(records, options);
  const withExtra = summarizePaired([...records, group('a', 6, 0, { pair: 'A+B' })], options);
  assert.deepEqual(first.independent.byOpponentPair['P+Q'], withExtra.independent.byOpponentPair['P+Q']);
});

test('empty input yields explicit absent suite summaries without nonfinite values', () => {
  assert.deepEqual(summarizePaired([]), {
    independent: { overall: null, byOpponentPair: {} },
    session: { overall: null, byOpponentPair: {} },
  });
});

test('invalid or duplicate paired groups fail loudly instead of silently changing the sample', () => {
  const invalidScores = [NaN, Infinity, -Infinity, undefined, '1'];
  for (const score of invalidScores) {
    assert.throws(() => summarizePaired([group('a', score)]), /candidate.score.*finite/);
  }
  assert.throws(() => summarizePaired([group('a', 0, 0, { hands: 0 })]), /hands.*positive/);
  assert.throws(() => summarizePaired([{ ...group('a', 1), incumbent: { hands: 96, score: 0 } }]), /same number/);
  assert.throws(() => summarizePaired([group('a', 1), group('a', 2)]), /repeats an opening-seed group/);
  assert.throws(() => summarizePaired([group('a', 1, 0, { suite: 'unknown' })]), /suite/);
  assert.throws(() => summarizePaired([group('', 1)]), /seed.*nonempty/);
  assert.throws(() => summarizePaired([group('a', 1, 0, { pair: '' })]), /opponentPair.*nonempty/);
  assert.throws(() => summarizePaired({}, {}), /records.*array/);
});

test('invalid bootstrap settings and unusable normalized numbers are rejected', () => {
  for (const bootstrapSamples of [0, -1, 1.2, Infinity]) {
    assert.throws(() => summarizePaired([], { bootstrapSamples }), /bootstrapSamples.*positive/);
  }
  for (const base of [0, -1, Infinity, NaN]) {
    assert.throws(() => summarizePaired([], { base }), /base/);
  }
  assert.throws(() => summarizePaired([], { seed: 123 }), /seed.*string/);
  assert.throws(() => summarizePaired([group('a', Number.MAX_VALUE)], { base: Number.MIN_VALUE }), /normalized score.*finite/);
});

test('opponent pair names remain safe dictionary keys', () => {
  const result = summarizePaired([group('a', 6, 0, { pair: '__proto__' })], { bootstrapSamples: 20 });
  assert.ok(Object.hasOwn(result.independent.byOpponentPair, '__proto__'));
  assert.equal(result.independent.byOpponentPair.__proto__.deltaPer100, 100);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
});
