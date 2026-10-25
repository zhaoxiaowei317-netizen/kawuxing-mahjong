import {TYPES, counts} from '../../src/engine.js';
import {analyzeDiscards} from '../lookahead/policy.mjs';
import {proposeActions} from '../public-rollout/policy.mjs';

export const FEATURE_VERSION = 'kwx-paired-public-value-features-1';
export const GATE_CONFIG = Object.freeze({worlds:16, uncertaintyPenalty:0});
export const FEATURE_NAMES = Object.freeze([
  'constant', 'distance', 'wall', 'ownMelds', 'ownHandSize', 'otherLiang', 'unseen',
  'baseOuts', 'altOuts', 'outsDifference', 'baseTwoDraw', 'altTwoDraw', 'twoDrawDifference',
  'baseOwnCopies', 'altOwnCopies', 'baseVisibleCopies', 'altVisibleCopies',
  'baseHonor', 'altHonor', 'baseEdge', 'altEdge',
  'baseCentrality', 'altCentrality', 'baseOwnSuitFraction', 'altOwnSuitFraction',
  'ownDangerousFraction', 'ownSingles', 'ownPairs', 'ownTriplets', 'ownQuads', 'ownHonors', 'ownP', 'ownS',
  'ownRiverSize', 'gangChain', 'ownKongNet',
  ...[1, 2].flatMap(i => [`op${i}.liang`, `op${i}.melds`, `op${i}.handSize`, `op${i}.riverSize`,
    `op${i}.waitKinds`, `op${i}.hiddenSize`, `op${i}.pengs`, `op${i}.honorMelds`,
    `op${i}.baseRiverCopies`, `op${i}.altRiverCopies`, `op${i}.baseRiverSuitFraction`, `op${i}.altRiverSuitFraction`,
    `op${i}.baseMeldSuitFraction`, `op${i}.altMeldSuitFraction`]),
]);
export const FEATURE_SIZE = FEATURE_NAMES.length;

export function describeRoot(o, legal) {
  const proposal = proposeActions(o, legal, GATE_CONFIG);
  if (!proposal.proposed) return {...proposal, features:null};
  const shape = analyzeDiscards(o, legal, {mode:'same-shanten'});
  const base = shape.candidates.find(c => c.action.tile === proposal.baseline.tile), alt = shape.candidates[0];
  if (!base || alt.action.tile !== proposal.alternative.tile) throw Error('Proposal mismatch');
  const p = o.players[o.seat], owned = counts(p.hand), multiplicities = Object.values(owned);
  const others = [o.players[(o.seat + 1) % 3], o.players[(o.seat + 2) % 3]];
  const danger = new Set(others.flatMap(q => q.liang ? q.publicWaits : []));
  const edge = t => Number(t[0] !== 'z' && ['1', '9'].includes(t[1]));
  const centrality = t => t[0] === 'z' ? 0 : Math.min(Number(t[1]) - 1, 9 - Number(t[1])) / 4;
  const suitFraction = (tiles, tile) => tiles.length ? tiles.filter(t => t[0] === tile[0]).length / tiles.length : 0;
  const net = o.kongs.reduce((sum, k) => sum + (k.to === o.seat ? k.amount : 0) - (k.from === o.seat ? k.amount : 0), 0);
  const features = [1, base.distance / 6, o.wallCount / 44, p.melds.length / 4, p.hand.length / 14,
    others.filter(q => q.liang).length / 2, base.lookahead.unseen / 84,
    base.outs / 44, alt.outs / 44, (alt.outs - base.outs) / 44,
    base.lookahead.probability, alt.lookahead.probability, alt.lookahead.probability - base.lookahead.probability,
    owned[base.action.tile] / 4, owned[alt.action.tile] / 4,
    (o.visibleCounts[base.action.tile] || 0) / 4, (o.visibleCounts[alt.action.tile] || 0) / 4,
    Number(base.action.tile[0] === 'z'), Number(alt.action.tile[0] === 'z'), edge(base.action.tile), edge(alt.action.tile),
    centrality(base.action.tile), centrality(alt.action.tile), suitFraction(p.hand, base.action.tile), suitFraction(p.hand, alt.action.tile),
    p.hand.filter(t => danger.has(t)).length / p.hand.length,
    multiplicities.filter(n => n === 1).length / 14, multiplicities.filter(n => n === 2).length / 7,
    multiplicities.filter(n => n === 3).length / 4, multiplicities.filter(n => n === 4).length / 3,
    p.hand.filter(t => t[0] === 'z').length / 14, p.hand.filter(t => t[0] === 'p').length / 14,
    p.hand.filter(t => t[0] === 's').length / 14, p.river.length / 20, o.gangChain / 16,
    Math.asinh(net / o.config.base) / Math.asinh(100),
    ...others.flatMap(q => [Number(q.liang), q.melds.length / 4, q.handSize / 14, q.river.length / 20,
      q.publicWaits.length / TYPES.length, q.hiddenTileCount / 14, q.melds.filter(m => m.kind === 'peng').length / 4,
      q.melds.filter(m => m.tile[0] === 'z').length / 4,
      q.river.filter(t => t === base.action.tile).length / 4, q.river.filter(t => t === alt.action.tile).length / 4,
      suitFraction(q.river, base.action.tile), suitFraction(q.river, alt.action.tile),
      suitFraction(q.melds.map(m => m.tile), base.action.tile), suitFraction(q.melds.map(m => m.tile), alt.action.tile)]),
  ];
  if (features.length !== FEATURE_SIZE || features.some(x => !Number.isFinite(x))) throw Error('Invalid paired value features');
  return {...proposal, features};
}
