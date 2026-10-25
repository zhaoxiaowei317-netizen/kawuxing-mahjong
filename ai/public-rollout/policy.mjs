import {MahjongEnvironment, actionKey} from '../environment.mjs';
import {selectAction as h0} from '../policies/h0.mjs';
import {policyById} from '../policies/index.mjs';
import {analyzeDiscards} from '../lookahead/policy.mjs';
import {deriveSeed} from '../random.mjs';
import {sampleWorld, samplingSupport} from './sampler.mjs';

export const ROLLOUT_VERSION = 'kwx-public-net-score-rollout-1';
export const DEFAULT_CONFIG = Object.freeze({worlds:8, minWall:4, maxWall:40, uncertaintyPenalty:1,
  searchSeed:'kwx-net-score-worlds-1', maxActions:500, opponentModel:'H0'});
export function normalizeSearchConfig(options = {}) {
  if (Object.keys(options).some(key => !Object.hasOwn(DEFAULT_CONFIG, key))) throw Error('Unknown search option');
  const c = {...DEFAULT_CONFIG, ...options};
  if (!Number.isInteger(c.worlds) || c.worlds < 2 || c.worlds > 256 ||
    !Number.isInteger(c.minWall) || !Number.isInteger(c.maxWall) || c.minWall < 0 || c.maxWall > 84 || c.minWall > c.maxWall ||
    !Number.isFinite(c.uncertaintyPenalty) || c.uncertaintyPenalty < 0 ||
    typeof c.searchSeed !== 'string' || !c.searchSeed || !Number.isInteger(c.maxActions) || c.maxActions < 1 ||
    !['H0', 'mixed'].includes(c.opponentModel)) throw Error('Invalid search config');
  return c;
}

export function simulateToEnd(game, action, seat, {maxActions = 500, opponentIds = ['H0', 'H0']} = {}) {
  const env = new MahjongEnvironment({initialState:game, record:false});
  if (opponentIds.length !== 2) throw Error('Two rollout opponents required');
  const others = [0, 1, 2].filter(i => i !== seat);
  const policies = [0, 1, 2].map(i => i === seat ? h0 : policyById(opponentIds[others.indexOf(i)]));
  env.step(action); let decisions = 1;
  while (!env.done) {
    if (++decisions > maxActions) throw Error('Hypothetical rollout action limit');
    env.step(policies[env.actor](env.observation(), env.legalActions()));
  }
  const result = env.result(), net = lines => lines.reduce((sum, x) => sum +
    (x.to === seat ? x.amount : 0) - (x.from === seat ? x.amount : 0), 0);
  const kongScore = net(result.kongs);
  return {score:result.delta[seat], kongScore, huScore:result.winners.length ? result.delta[seat] - kongScore : 0,
    drawScore:result.winners.length ? 0 : result.delta[seat] - kongScore, decisions,
    winner:result.winners.includes(seat), opponentWin:result.winners.some(i => i !== seat),
    dealIn:result.source === seat && result.winners.length > 0, draw:result.winners.length === 0};
}

export function comparePairedScores(worlds, uncertaintyPenalty = 1) {
  if (worlds.length < 2) throw Error('At least two sampled worlds required');
  const differences = worlds.map(w => w.alternative.score - w.baseline.score);
  const mean = differences.reduce((s, x) => s + x, 0) / differences.length;
  const variance = differences.reduce((s, x) => s + (x - mean) ** 2, 0) / (differences.length - 1);
  const standardError = Math.sqrt(variance / differences.length);
  return {mean, standardError, margin:mean - uncertaintyPenalty * standardError,
    chooseAlternative:mean - uncertaintyPenalty * standardError > 1e-9};
}

export function proposeActions(o, legal, options = {}) {
  const config = normalizeSearchConfig(options), baseline = h0(o, legal);
  const fallback = reason => ({action:baseline, baseline, searched:false, proposed:false, reason});
  if (baseline.type !== 'discard' || baseline.reveal || o.players[o.seat].liang) return fallback('preserve-H0-special-action');
  if (o.wallCount < config.minWall || o.wallCount > config.maxWall) return fallback('wall-outside-search-range');
  const support = samplingSupport(o); if (!support.supported) return fallback(support.reason);
  const shape = analyzeDiscards(o, legal, {mode:'same-shanten'});
  if (!shape.searched || actionKey(shape.action) === actionKey(baseline)) return fallback('no-structural-disagreement');
  const alternative = shape.action;
  return {action:alternative, baseline, alternative, searched:false, proposed:true, config, reason:'structural-proposal'};
}

export function analyzeNetScore(o, legal, options = {}) {
  const proposal = proposeActions(o, legal, options);
  if (!proposal.proposed) return proposal;
  const {config, baseline, alternative} = proposal;
  const publicSeed = deriveSeed(ROLLOUT_VERSION, config.searchSeed, o);
  const worlds = [];
  for (let world = 0; world < config.worlds; world++) {
    const seed = deriveSeed(publicSeed, world), game = sampleWorld(o, seed);
    const canonical = new MahjongEnvironment({initialState:game, record:false}).legalActions().map(actionKey).sort();
    if (JSON.stringify(canonical) !== JSON.stringify(legal.map(actionKey).sort())) throw Error('Sample changed root legal actions');
    const opponentIds = config.opponentModel === 'mixed' && world % 2 === 1
      ? (world % 4 === 1 ? ['H0', 'greedy-speed-v1'] : ['greedy-speed-v1', 'H0']) : ['H0', 'H0'];
    const rolloutConfig = {...config, opponentIds};
    worlds.push({seed, opponentIds, baseline:simulateToEnd(game, baseline, o.seat, rolloutConfig),
      alternative:simulateToEnd(game, alternative, o.seat, rolloutConfig)});
  }
  const comparison = comparePairedScores(worlds, config.uncertaintyPenalty);
  return {action:comparison.chooseAlternative ? alternative : baseline, baseline, alternative, searched:true, proposed:true,
    reason:'paired-terminal-net-score', comparison, worlds, publicSeed, config};
}

// One search per seat per hand bounds CPU cost. The runner creates a new policy
// instance each hand. Subsequent own decisions use H0; modeled opponents can differ.
export function netScoreFactory(options = {}, onDecision = null) {
  const config = normalizeSearchConfig(options);
  return () => {
    let used = false;
    return (o, legal) => {
      if (used) return h0(o, legal);
      const result = analyzeNetScore(o, legal, config);
      if (result.searched) used = true;
      onDecision?.(result, o, legal);
      return result.action;
    };
  };
}

export function proposalOnceFactory(options = {}, onDecision = null) {
  const config = normalizeSearchConfig(options);
  return () => {
    let used = false;
    return (o, legal) => {
      if (used) return h0(o, legal);
      const result = proposeActions(o, legal, config);
      if (result.proposed) used = true;
      onDecision?.(result, o, legal); return result.action;
    };
  };
}
