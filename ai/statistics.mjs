/**
 * Paired, stratified evaluation statistics.
 *
 * A record is one complete opening-seed group, including all six seating
 * permutations (or all six 16-hand sessions). Those hands share randomness;
 * they are never treated as separate bootstrap observations.
 */

const SUITES = ['independent', 'session'];
const PAIR_WEIGHTING = 'Each opening-seed group has equal weight within its opponent pair.';
const OVERALL_WEIGHTING = 'Opponent pairs have equal weight; opening-seed groups have equal weight within each pair.';

function finite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${path} must be a positive safe integer`);
  }
  return value;
}

function normalizedZero(value) {
  return value === 0 ? 0 : value;
}

function mean(values) {
  // Dividing before summing also avoids an unnecessarily large intermediate sum.
  return normalizedZero(finite(values.reduce((sum, value) => sum + value / values.length, 0), 'mean'));
}

function percentile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const left = Math.floor(position);
  const fraction = position - left;
  if (fraction === 0) return normalizedZero(sorted[left]);
  return normalizedZero(sorted[left] * (1 - fraction) + sorted[left + 1] * fraction);
}

function confidenceInterval(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return [percentile(sorted, 0.025), percentile(sorted, 0.975)];
}

// FNV-1a seed mixing followed by Mulberry32. This RNG is only for bootstrap
// reproducibility, not game dealing or security-sensitive randomness.
function randomSource(seed) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    state = Math.imul(state ^ seed.charCodeAt(index), 16777619) >>> 0;
  }
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function rate(score, hands, base, path) {
  return normalizedZero(finite(score / hands / base * 100, path));
}

function validateRecord(record, index, base, seen) {
  const path = `records[${index}]`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`${path} must be an object`);
  }
  if (!SUITES.includes(record.suite)) {
    throw new RangeError(`${path}.suite must be independent or session`);
  }
  for (const field of ['opponentPair', 'seed']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new TypeError(`${path}.${field} must be a nonempty string`);
    }
  }
  const identity = JSON.stringify([record.suite, record.opponentPair, record.seed]);
  if (seen.has(identity)) {
    throw new RangeError(`${path} repeats an opening-seed group in the same suite and opponent pair`);
  }
  seen.add(identity);
  const sides = {};
  for (const side of ['candidate', 'incumbent']) {
    if (!record[side] || typeof record[side] !== 'object') {
      throw new TypeError(`${path}.${side} must be an object`);
    }
    const hands = positiveInteger(record[side].hands, `${path}.${side}.hands`);
    const score = finite(record[side].score, `${path}.${side}.score`);
    sides[side] = { hands, per100: rate(score, hands, base, `${path}.${side} normalized score`) };
  }
  if (sides.candidate.hands !== sides.incumbent.hands) {
    throw new RangeError(`${path} must have the same number of paired hands on both sides`);
  }
  return {
    suite: record.suite,
    opponentPair: record.opponentPair,
    seed: record.seed,
    hands: sides.candidate.hands,
    candidatePer100: sides.candidate.per100,
    incumbentPer100: sides.incumbent.per100,
    deltaPer100: normalizedZero(finite(sides.candidate.per100 - sides.incumbent.per100, `${path} paired difference`)),
  };
}

function summarizePair(records, bootstrapSamples, seed, suite, pair) {
  const differences = records.map(record => record.deltaPer100);
  const random = randomSource(JSON.stringify([seed, suite, pair]));
  const samples = Array.from({ length: bootstrapSamples }, () => {
    let average = 0;
    for (let draw = 0; draw < records.length; draw++) {
      average += differences[Math.floor(random() * records.length)] / records.length;
    }
    return normalizedZero(finite(average, 'bootstrap paired difference'));
  });
  const hands = records.reduce((sum, record) => sum + record.hands, 0);
  positiveInteger(hands, 'total paired hands');
  return {
    summary: {
      groups: records.length,
      hands,
      candidatePer100: mean(records.map(record => record.candidatePer100)),
      incumbentPer100: mean(records.map(record => record.incumbentPer100)),
      deltaPer100: mean(differences),
      ci95: confidenceInterval(samples),
      bootstrapSamples,
      weighting: PAIR_WEIGHTING,
    },
    samples,
  };
}

/**
 * Summarize candidate versus incumbent by suite and opponent pair.
 *
 * `ci95` is the percentile bootstrap interval for deltaPer100, not for either
 * absolute score. Sampling always keeps a candidate/incumbent seed group
 * together, and is independent within each opponent-pair stratum. `hands`
 * counts candidate hands (the incumbent plays the same number again).
 *
 * A one-group stratum has a degenerate bootstrap interval: it cannot estimate
 * unseen opening-seed variation. Small pilot intervals are descriptive only.
 * Empty input returns both suites with overall=null and no pair summaries.
 * Invalid/incomplete or duplicated groups throw instead of being dropped.
 */
export function summarizePaired(records, { bootstrapSamples = 2000, seed = 'kawuxing-bootstrap-v1', base = 1 } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  positiveInteger(bootstrapSamples, 'bootstrapSamples');
  if (typeof seed !== 'string') throw new TypeError('seed must be a string');
  finite(base, 'base');
  if (base <= 0) throw new RangeError('base must be greater than zero');
  const seen = new Set();
  const validated = records.map((record, index) => validateRecord(record, index, base, seen));
  return Object.fromEntries(SUITES.map(suite => {
    const suiteRecords = validated.filter(record => record.suite === suite);
    if (suiteRecords.length === 0) {
      return [suite, { overall: null, byOpponentPair: {} }];
    }
    const names = [...new Set(suiteRecords.map(record => record.opponentPair))].sort();
    const pairs = names.map(pair => [pair, summarizePair(
      suiteRecords.filter(record => record.opponentPair === pair), bootstrapSamples, seed, suite, pair,
    )]);
    const summaries = pairs.map(([, result]) => result.summary);
    const overallSamples = Array.from({ length: bootstrapSamples }, (_, index) => mean(
      pairs.map(([, result]) => result.samples[index]),
    ));
    const hands = summaries.reduce((sum, summary) => sum + summary.hands, 0);
    positiveInteger(hands, 'total suite paired hands');
    return [suite, {
      overall: {
        groups: suiteRecords.length,
        hands,
        candidatePer100: mean(summaries.map(summary => summary.candidatePer100)),
        incumbentPer100: mean(summaries.map(summary => summary.incumbentPer100)),
        deltaPer100: mean(summaries.map(summary => summary.deltaPer100)),
        ci95: confidenceInterval(overallSamples),
        bootstrapSamples,
        weighting: OVERALL_WEIGHTING,
      },
      byOpponentPair: Object.fromEntries(pairs.map(([pair, result]) => [pair, result.summary])),
    }];
  }));
}
