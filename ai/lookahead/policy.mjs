import {TYPES, counts, distance} from '../../src/engine.js';
import {selectAction as h0} from '../policies/h0.mjs';

export const LOOKAHEAD_VERSION = 'kwx-public-two-draw-1';
export const MODES = Object.freeze(['ties', 'same-shanten']);
const remove = (hand, tile) => {
  const next = [...hand], index = next.indexOf(tile);
  if (index < 0) throw Error('Missing own tile');
  next.splice(index, 1); return next;
};

// Only a per-decision structural cache; it stores neither observations nor hidden state.
export function distanceCache(melds) {
  const cache = new Map(); let calls = 0;
  const get = hand => {
    const c = counts(hand), key = TYPES.map(t => c[t] || 0).join('');
    if (!cache.has(key)) { cache.set(key, distance(hand, melds)); calls++; }
    return cache.get(key);
  };
  return {get, stats:() => ({entries:cache.size, distanceCalls:calls})};
}

export function unseenCounts(visible) {
  return Object.fromEntries(TYPES.map(tile => {
    const n = visible[tile] ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > 4) throw Error('Invalid public tile count');
    return [tile, 4 - n];
  }));
}

export function safeDiscardTiles(hand, dangerousTiles = []) {
  const danger = new Set(dangerousTiles), unique = [...new Set(hand)];
  const safe = unique.filter(t => !danger.has(t));
  return safe.length ? safe : unique;
}

// A structural surrogate, not a wall probability or an opponent rollout:
// sample two tiles without replacement from all publicly unseen tiles, allowing
// an optimal safe discard between them. Other players' future actions are fixed.
export function twoDrawPotential(hand, melds, visible, {dangerousTiles = [], cache = distanceCache(melds)} = {}) {
  if (hand.length + 3 * melds.length !== 13) throw Error('An after-discard hand is required');
  const rem = unseenCounts(visible), owned = counts([...hand,
    ...melds.flatMap(m => Array(m.kind === 'peng' ? 3 : 4).fill(m.tile))]);
  if (TYPES.some(t => (owned[t] || 0) > (visible[t] || 0))) throw Error('Own tiles must be public to oneself');
  const d = cache.get(hand), target = Math.max(-1, d - 2);
  const total = TYPES.reduce((s, t) => s + rem[t], 0), firstDraws = [];
  let numerator = 0, immediateOuts = 0;
  for (const tile of TYPES) {
    const n = rem[tile]; if (!n) continue;
    const drawn = [...hand, tile], nextD = cache.get(drawn);
    if (nextD < d) immediateOuts += n;
    if (total < 2 || nextD > target + 1) continue;
    if (nextD === -1) {
      numerator += n * (total - 1);
      firstDraws.push({tile, copies:n, immediateWin:true, secondOuts:total - 1, discard:null});
      continue;
    }
    let best = 0, discard = null;
    for (const out of safeDiscardTiles(drawn, dangerousTiles)) {
      const after = remove(drawn, out);
      if (cache.get(after) > target + 1) continue;
      let outs = 0;
      for (const second of TYPES) {
        // A draw becomes known; discarding it does not put it back in the pool.
        const copies = rem[second] - Number(second === tile);
        if (copies > 0 && cache.get([...after, second]) <= target) outs += copies;
      }
      if (outs > best) { best = outs; discard = out; }
    }
    numerator += n * best;
    firstDraws.push({tile, copies:n, immediateWin:false, secondOuts:best, discard});
  }
  const denominator = total * Math.max(0, total - 1);
  return {distance:d, target, unseen:total, immediateOuts, numerator, denominator,
    probability:denominator ? numerator / denominator : 0, firstDraws};
}

export function analyzeDiscards(o, legal, {mode = 'ties'} = {}) {
  if (!MODES.includes(mode)) throw Error('Unknown lookahead mode');
  const baseline = h0(o, legal), p = o.players[o.seat];
  const fallback = reason => ({action:baseline, baseline, searched:false, reason, candidates:[]});
  if (baseline.type !== 'discard' || baseline.reveal || p.liang) return fallback('preserve-H0-special-action');
  if (o.wallCount < 6) return fallback('fewer-than-two-normal-own-draws');
  const cache = distanceCache(p.melds), rem = unseenCounts(o.visibleCounts);
  const options = legal.filter(a => a.type === 'discard' && !a.reveal).map(action => {
    const hand = remove(p.hand, action.tile), d = cache.get(hand);
    return {action, hand, distance:d, outs:TYPES.reduce((s, t) =>
      s + (rem[t] && cache.get([...hand, t]) < d ? rem[t] : 0), 0)};
  });
  const base = options.find(c => c.action.tile === baseline.tile);
  if (!base) throw Error('H0 did not select a legal discard');
  if (base.distance < 1) return fallback('preserve-H0-ready-hand');
  const candidates = options.filter(c => c.distance === base.distance && (mode !== 'ties' || c.outs === base.outs));
  if (candidates.length < 2) return fallback('no-alternative');
  const dangerousTiles = o.players.flatMap((other, i) => i !== o.seat && other.liang ? other.publicWaits : []);
  for (const c of candidates) c.lookahead = twoDrawPotential(c.hand, p.melds, o.visibleCounts, {dangerousTiles, cache});
  candidates.sort((a, b) => b.lookahead.numerator - a.lookahead.numerator || b.outs - a.outs ||
    Number(b.action.tile === baseline.tile) - Number(a.action.tile === baseline.tile) ||
    p.hand.indexOf(a.action.tile) - p.hand.indexOf(b.action.tile));
  return {action:candidates[0].action, baseline, searched:true, reason:mode,
    candidates:candidates.map(({hand, ...c}) => c), cache:cache.stats()};
}

export function lookaheadFactory(options = {}) {
  if (!MODES.includes(options.mode ?? 'ties')) throw Error('Unknown lookahead mode');
  return () => (observation, legal) => analyzeDiscards(observation, legal, options).action;
}
