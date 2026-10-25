// GENERATED import-only mirror of ai/action-scorer/features.mjs; see build.mjs.
import {TYPES, distance, waits, counts} from './geometry.mjs';
import {actionId} from '../training/encoding.mjs';

export const FEATURE_VERSION = 'kwx-candidate-features-1';
const KINDS = ['discard', 'reveal', 'hu', 'peng', 'ming', 'an', 'bu', 'pass'];
export const FEATURE_NAMES = Object.freeze([
  ...KINDS.map(k => `kind.${k}`), 'negativeDistance', 'distanceImprovement', 'improvesDistance',
  'outs', 'readyOuts', 'waitKinds', 'potentialFan', 'negativeDistanceGap',
  'reveal.outs', 'reveal.wall', 'reveal.otherLiang', 'reveal.fan',
  'reveal.atLeastTwoOuts', 'reveal.atLeastFourOuts', 'reveal.atLeastTenWall',
  'reveal.largeFan', 'reveal.otherLiangWithTwoOuts', 'reveal.otherLiangWithFourOuts',
  'discard.single', 'discard.pair', 'discard.triplet', 'discard.honor', 'discard.edge',
  'negativeHandOrder', 'kong.wall', 'peng.wall',
]);
export const FEATURE_SIZE = FEATURE_NAMES.length;
export const CONTEXT_SIZE = 10;

function remove(hand, tile, n) {
  const result = [...hand];
  for (let i = 0; i < n; i++) {
    const index = result.indexOf(tile); if (index < 0) throw Error('Action requires missing own tile');
    result.splice(index, 1);
  }
  return result;
}
// Remaining counts are public information, including one's own hand. They are not wall counts.
export function handEfficiency(hand, melds, visible) {
  const d = distance(hand, melds), ready = waits(hand, melds, true);
  let outs = 0, readyOuts = 0, fan = 0;
  for (const tile of TYPES) {
    const remaining = Math.max(0, 4 - (visible[tile] || 0));
    if (remaining && distance([...hand, tile], melds) < d) outs += remaining;
  }
  for (const w of ready) {
    readyOuts += Math.max(0, 4 - (visible[w.tile] || 0));
    fan = Math.max(fan, w.score?.raw || 0);
  }
  return {distance:d, outs, readyOuts, waitKinds:ready.length, fan};
}

export function encodeCandidates(o, legal) {
  if (!Array.isArray(legal) || !legal.length) throw Error('Legal candidates required');
  const p = o.players[o.seat], visible = o.visibleCounts;
  if (!p?.hand || !visible) throw Error('Player observation required');
  const before = distance(p.hand, p.melds), owned = counts(p.hand);
  const othersLiang = o.players.filter((other, i) => i !== o.seat && other.liang).length;
  const cache = new Map(), describe = (hand, melds) => {
    const key = JSON.stringify([hand, melds]);
    if (!cache.has(key)) cache.set(key, handEfficiency(hand, melds, visible));
    return cache.get(key);
  };
  const candidates = legal.map(action => {
    const kind = action.type === 'discard' ? action.reveal ? 'reveal' : 'discard' : action.type === 'kong' ? action.kind : action.type;
    let shape = {distance:before, outs:0, readyOuts:0, waitKinds:0, fan:0};
    if (action.type === 'discard') shape = describe(remove(p.hand, action.tile, 1), p.melds);
    else if (kind === 'pass') shape = describe(p.hand, p.melds);
    else if (kind === 'peng') {
      const hand = remove(p.hand, o.pending.tile, 2), melds = [...p.melds, {kind:'peng', tile:o.pending.tile}];
      // Structural best continuation, not an oracle future draw. The next engine turn still enforces legal discards.
      shape = [...new Set(hand)].map(tile => describe(remove(hand, tile, 1), melds))
        .sort((a, b) => a.distance - b.distance || b.readyOuts - a.readyOuts || b.outs - a.outs)[0];
    } else if (kind === 'ming' || kind === 'an') {
      const tile = kind === 'ming' ? o.pending.tile : action.tile;
      shape = describe(remove(p.hand, tile, kind === 'ming' ? 3 : 4), [...p.melds, {kind, tile}]);
    } else if (kind === 'bu') {
      shape = describe(remove(p.hand, action.tile, 1), p.melds.map(m => m.kind === 'peng' && m.tile === action.tile ? {...m, kind:'bu'} : m));
    }
    return {id:actionId(action), kind, action, shape};
  }).sort((a, b) => a.id - b.id);
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw Error('Duplicate candidate IDs');
  const minimum = Math.min(...candidates.filter(c => ['discard', 'reveal', 'peng', 'pass'].includes(c.kind)).map(c => c.shape.distance));
  const encoded = candidates.map(({id, kind, action, shape:s}) => {
    const reveal = Number(kind === 'reveal'), discard = Number(kind === 'discard' || kind === 'reveal');
    const kong = Number(['ming', 'an', 'bu'].includes(kind)), wall = o.wallCount / 44;
    const fan = Math.log2(1 + s.fan) / 5, tile = action.tile;
    const values = [
      ...KINDS.map(k => Number(k === kind)), -s.distance / 6, (before - s.distance) / 6, Number(s.distance < before),
      s.outs / 12, s.readyOuts / 12, s.waitKinds / 8, fan,
      Number.isFinite(minimum) ? -(s.distance - minimum) / 6 : 0,
      reveal * s.readyOuts / 12, reveal * wall, reveal * othersLiang / 2, reveal * fan,
      reveal * Number(s.readyOuts >= 2), reveal * Number(s.readyOuts >= 4), reveal * Number(o.wallCount >= 10),
      reveal * Number(s.fan >= 4), reveal * Number(othersLiang > 0 && s.readyOuts >= 2),
      reveal * Number(othersLiang > 0 && s.readyOuts >= 4),
      discard * Number(owned[tile] === 1), discard * Number(owned[tile] === 2), discard * Number(owned[tile] >= 3),
      discard * Number(Boolean(tile?.startsWith('z'))), discard * Number(['1', '9'].includes(tile?.[1])),
      discard ? -p.hand.indexOf(tile) / 14 : 0, kong * wall, Number(kind === 'peng') * wall,
    ];
    return {id, values};
  });
  const context = [1, before / 6, o.wallCount / 44, Number(p.liang), othersLiang / 2, p.melds.length / 4,
    Math.asinh((o.totals?.[o.seat] || 0) / (o.config?.base || 1)) / Math.asinh(100),
    Number(o.dealer === o.seat), (o.round || 1) / 16, (o.gangChain || 0) / 16];
  if (encoded.some(c => c.values.length !== FEATURE_SIZE || c.values.some(x => !Number.isFinite(x))) ||
    context.length !== CONTEXT_SIZE || context.some(x => !Number.isFinite(x))) throw Error('Invalid candidate features');
  return {candidates:encoded, context};
}
