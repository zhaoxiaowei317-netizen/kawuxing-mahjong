import * as E from '../../src/engine.js';
import {assertConservation, observationFor} from '../environment.mjs';
import {seededRandom} from '../random.mjs';

export const SAMPLER_VERSION = 'kwx-public-discard-worlds-1';
export function samplingSupport(o) {
  if (o.rulesVersion !== E.RULES_VERSION || o.phase !== 'discard' || o.turn !== o.seat || o.pending)
    return {supported:false, reason:'only-own-discard-supported'};
  if (o.players.some((p, i) => i !== o.seat && p.liang && p.hiddenTileCount !== 0))
    return {supported:false, reason:'revealed-reserved-triplet-unknown'};
  return {supported:true, reason:null};
}

// Uniform allocation conditional on current public counts, NOT a posterior
// conditioned on opponents' past choices. Unknown pass/kong flags start empty.
export function sampleWorld(o, seed) {
  const support = samplingSupport(o);
  if (!support.supported) throw Error(support.reason);
  const known = o.players.flatMap((p, i) => [...p.river,
    ...p.melds.flatMap(m => Array(m.kind === 'peng' ? 3 : 4).fill(m.tile)),
    ...(i === o.seat ? p.hand : p.revealedTiles)]);
  const visible = E.counts(known);
  for (const tile of E.TYPES) {
    const n = o.visibleCounts[tile] ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > 4 || n !== (visible[tile] || 0)) throw Error('Inconsistent public counts');
  }
  if (known.some(t => !E.TYPES.includes(t))) throw Error('Unknown public tile');
  const pool = E.TYPES.flatMap(t => Array(4 - (visible[t] || 0)).fill(t));
  const hiddenCount = o.players.reduce((sum, p, i) => sum + (i === o.seat ? 0 : p.hiddenTileCount), 0);
  if (pool.length !== hiddenCount + o.wallCount) throw Error('Public unknown pool size mismatch');
  const rng = seededRandom(seed);
  for (let i = pool.length - 1; i > 0; i--) { const j = rng(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  let offset = 0;
  const players = o.players.map((p, i) => {
    const own = i === o.seat;
    const hand = own ? [...p.hand] : E.sorted([...p.revealedTiles, ...pool.slice(offset, offset += p.hiddenTileCount)]);
    if (hand.length !== p.handSize) throw Error('Hand size mismatch');
    return {id:i, hand, river:[...p.river], melds:p.melds.map(m => ({...m})), liang:p.liang,
      passedHu:own ? [...p.passedHu] : [], passedPeng:own ? [...p.passedPeng] : [],
      buOpportunities:own ? [...p.buOpportunities] : [],
      ...(p.liang ? {liangWaits:p.publicWaits.map(tile => ({tile})),
        liangKongTiles:own ? [...p.reservedKongTiles] : []} : {})};
  });
  const game = {config:E.normalizeConfig({...o.config, mode:'bots'}), seats:[0, 1, 2], bench:null,
    dealer:o.dealer, players, wall:pool.slice(offset), turn:o.turn, lastDraw:o.drawTile ? o.seat : null,
    drawTile:o.drawTile, phase:'discard', pending:null, kongs:o.kongs.map(k => ({...k})),
    gangChain:o.gangChain, round:o.round, history:[], totals:[...o.totals],
    log:[...o.publicActionLog].reverse(), result:null, discardSerial:o.lastDiscard?.serial || 0,
    lastDiscard:o.lastDiscard ? {seat:o.lastDiscard.seat, tile:o.lastDiscard.tile,
      serial:o.lastDiscard.serial, index:o.lastDiscard.riverIndex} : null};
  assertConservation(game);
  // Stronger than conservation: every public field must round-trip unchanged.
  if (JSON.stringify(observationFor(game, o.seat)) !== JSON.stringify(o)) throw Error('Sample changed public observation');
  return game;
}
