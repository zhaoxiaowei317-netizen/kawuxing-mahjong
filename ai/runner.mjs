import {performance} from 'node:perf_hooks';
import {MahjongEnvironment} from './environment.mjs';
import {policyById} from './policies/index.mjs';
import {deriveSeed, seededRandom} from './random.mjs';
import {summarizePaired} from './statistics.mjs';
import {verifyFrozenBaseline} from './provenance.mjs';

export const PROTOCOL_VERSION = 'kwx-paired-v1';
// Values name the role occupying each seat. P and Q remain distinct instances even when IDs match.
export const SEAT_PERMUTATIONS = Object.freeze([
  ['C', 'P', 'Q'], ['C', 'Q', 'P'], ['P', 'C', 'Q'],
  ['Q', 'C', 'P'], ['P', 'Q', 'C'], ['Q', 'P', 'C']
].map(Object.freeze));
export const DEFAULT_OPPONENT_PAIRS = Object.freeze([
  {id:'H0+H0', policies:['H0', 'H0']},
  {id:'H0+greedy-speed-v1', policies:['H0', 'greedy-speed-v1']}
]);

export function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
}
function emptyArm() {
  return {hands:0, score:0, wins:0, selfDraws:0, dealIns:0, draws:0,
    huScore:0, kongScore:0, drawScore:0, revealHands:0, revealedScore:0,
    sessionFirstCredit:0, sessionLastCredit:0, sessions:0, sessionScores:[], largeLosses:0};
}
function accumulate(arm, result, seat) {
  arm.hands++; arm.score += result.delta[seat];
  arm.largeLosses += Number(result.delta[seat] <= -16 * result.config.base);
  const won = result.winners.includes(seat);
  arm.wins += Number(won); arm.selfDraws += Number(won && result.source === null);
  arm.dealIns += Number(result.winners.length > 0 && result.source === seat);
  arm.draws += Number(result.winners.length === 0);
  const net = lines => lines.reduce((sum, l) => sum + (l.to === seat ? l.amount : 0) - (l.from === seat ? l.amount : 0), 0);
  const kongScore = net(result.kongs);
  arm.kongScore += kongScore;
  arm[result.winners.length ? 'huScore' : 'drawScore'] += result.delta[seat] - kongScore;
  if (result.players[seat].liang) { arm.revealHands++; arm.revealedScore += result.delta[seat]; }
}

export function playEpisode({env, policyIds, policySeeds, policyFactories={}, maxActions=500,
  timings={}, onEpisode=null, context={}}) {
  if (policyIds.length !== 3 || policySeeds.length !== 3) throw Error('Three independent policy instances are required');
  const rngs = policySeeds.map(seededRandom);
  const policies = policyIds.map(id => {
    // Built-ins are stateless. Stateful plugins must construct a fresh instance for each seat/episode.
    const policy = Object.hasOwn(policyFactories, id) ? policyFactories[id]() : policyById(id);
    if (typeof policy !== 'function') throw Error(`Policy factory must return a selector: ${id}`);
    return policy;
  });
  let decisions = 0;
  try {
    while (!env.done) {
      if (++decisions > maxActions) throw Error(`Episode exceeded ${maxActions} decisions`);
      const seat = env.actor, observation = env.observation(), actions = env.legalActions();
      if (seat === null || !actions.length) throw Error('No legal action for active player');
      const start = performance.now();
      const action = policies[seat](observation, actions, rngs[seat]);
      (timings[policyIds[seat]] ??= []).push(performance.now() - start);
      env.step(action);
    }
  } catch (error) {
    // Preserve the last valid state and attempted action context for diagnosis.
    error.episodeContext = {...context, policyIds, policySeeds};
    error.partialReplay = env.replay();
    throw error;
  }
  const result = env.result();
  onEpisode?.({...context, policyIds, policySeeds, decisions, replay:env.replay()});
  return {result, decisions};
}

export async function runEvaluation({candidate='H0', incumbent='H0', seed='m0-development-v1',
  split='development', independentGroups=8, sessionGroups=1, sessionHands=16,
  opponentPairs=DEFAULT_OPPONENT_PAIRS, base=1, bootstrapSamples=2000,
  policyFactories={}, validate=true, onEpisode=null, onProgress=null} = {}) {
  verifyFrozenBaseline();
  if (!['training', 'development', 'sealed'].includes(split)) throw Error('Unknown seed split');
  for (const [name, n] of Object.entries({independentGroups, sessionGroups}))
    if (!Number.isInteger(n) || n < 0) throw Error(`${name} must be a nonnegative integer`);
  if (!independentGroups && !sessionGroups) throw Error('At least one suite is required');
  if (!Number.isInteger(sessionHands) || sessionHands < 1 || sessionHands > 1000) throw Error('Invalid sessionHands');
  if (!Number.isInteger(base) || base < 1 || base > 100) throw Error('Invalid base');
  if (!Number.isSafeInteger(bootstrapSamples) || bootstrapSamples < 1) throw Error('Invalid bootstrapSamples');
  if (!opponentPairs.length || new Set(opponentPairs.map(p => p.id)).size !== opponentPairs.length)
    throw Error('Opponent pairs must have unique IDs');
  for (const pair of opponentPairs) {
    if (pair.policies.length !== 2) throw Error('Each pair needs two policies');
    for (const id of pair.policies) if (!Object.hasOwn(policyFactories, id)) policyById(id);
  }
  for (const id of [candidate, incumbent]) if (!Object.hasOwn(policyFactories, id)) policyById(id);
  for (const [id, factory] of Object.entries(policyFactories))
    if (typeof factory !== 'function') throw Error(`Invalid policy factory: ${id}`);
  const records = [], timings = {}, started = performance.now();
  let totalGames = 0, totalDecisions = 0;
  for (const [suite, count, handsPerSession] of [
    ['independent', independentGroups, 1], ['session', sessionGroups, sessionHands]
  ]) for (const pair of opponentPairs) for (let group = 0; group < count; group++) {
    const groupSeed = deriveSeed(PROTOCOL_VERSION, split, seed, suite, pair.id, group);
    const record = {suite, opponentPair:pair.id, seed:groupSeed, candidate:emptyArm(), incumbent:emptyArm()};
    for (let permutation = 0; permutation < SEAT_PERMUTATIONS.length; permutation++) {
      const roles = SEAT_PERMUTATIONS[permutation], candidateSeat = roles.indexOf('C');
      for (const arm of ['candidate', 'incumbent']) {
        const rolePolicies = {C:arm === 'candidate' ? candidate : incumbent, P:pair.policies[0], Q:pair.policies[1]};
        const policyIds = roles.map(role => rolePolicies[role]);
        let previous = null;
        const totals = [0, 0, 0];
        for (let hand = 0; hand < handsPerSession; hand++) {
          // No arm/permutation in dealing: all six seats receive the same opening.
          // In sessions the actual next dealer is retained; hand RNG never depends on extra kongs.
          const environmentSeed = deriveSeed(groupSeed, 'environment', hand);
          const policySeeds = roles.map((role, seat) => deriveSeed(groupSeed, 'policy', permutation, hand,
            seat, role, rolePolicies[role]));
          const env = new MahjongEnvironment({seed:environmentSeed, config:{base, mode:'bots'}, previous, validate});
          const context = {suite, opponentPair:pair.id, group, groupSeed, permutation, roles, arm, hand};
          const {result, decisions} = playEpisode({env, policyIds, policySeeds, policyFactories,
            timings, onEpisode, context});
          accumulate(record[arm], result, candidateSeat);
          result.delta.forEach((v, i) => totals[i] += v);
          previous = {dealer:result.next.dealer, seats:result.next.seats, totals:[...totals], round:hand + 2};
          totalGames++; totalDecisions += decisions;
        }
        if (suite === 'session') {
          const target = record[arm], score = totals[candidateSeat], high = Math.max(...totals), low = Math.min(...totals);
          target.sessions++; target.sessionScores.push(score);
          target.sessionFirstCredit += score === high ? 1 / totals.filter(x => x === high).length : 0;
          target.sessionLastCredit += score === low ? 1 / totals.filter(x => x === low).length : 0;
        }
      }
    }
    records.push(record);
    onProgress?.({suite, opponentPair:pair.id, group:group + 1, groups:count, totalGames,
      totalDecisions, seconds:(performance.now() - started) / 1000});
    await new Promise(resolve => setImmediate(resolve));
  }
  const seconds = (performance.now() - started) / 1000;
  const latency = Object.fromEntries(Object.entries(timings).map(([id, values]) => [id, {
    decisions:values.length, meanMs:values.reduce((a, b) => a + b, 0) / values.length,
    p50Ms:percentile(values, 0.5), p95Ms:percentile(values, 0.95), maxMs:values.reduce((a, b) => Math.max(a, b), 0)
  }]));
  return {protocolVersion:PROTOCOL_VERSION, split, seed, candidate, incumbent, base,
    independentGroups, sessionGroups, sessionHands, opponentPairs, seatPermutations:SEAT_PERMUTATIONS,
    totalGames, totalDecisions, seconds, gamesPerSecond:totalGames / seconds,
    decisionsPerSecond:totalDecisions / seconds, illegalActions:0,
    conservationCheckedEveryAction:validate, records, latency,
    statistics:summarizePaired(records, {bootstrapSamples, seed:deriveSeed(seed, 'bootstrap'), base})};
}
