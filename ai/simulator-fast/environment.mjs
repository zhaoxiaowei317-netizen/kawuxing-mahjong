// GENERATED import-only mirror of ai/environment.mjs; see build.mjs.
import * as E from './geometry.mjs';
import {seededRandom} from '../random.mjs';

export const OBSERVATION_VERSION = 'kwx-observation-1';
export const ACTION_VERSION = 'kwx-actions-1';
const clone = value => structuredClone(value);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
export const actionKey = action => action && typeof action === 'object'
  ? JSON.stringify(Object.keys(action).sort().map(key => [key, action[key]])) : JSON.stringify(action);
export function actingSeat(g) {
  if (g.phase === 'ended') return null;
  if (g.phase === 'discard') return g.turn;
  return [0, 1, 2].find(i => i !== g.pending.source && !g.pending.responses[i]) ?? null;
}

// This whitelist is independent of network/UI state serialization.
export function observationFor(g, seat) {
  if (![0, 1, 2].includes(seat)) throw Error('Invalid observer seat');
  const players = g.players.map((p, i) => {
    const melds = p.melds.map(m => ({kind:m.kind, tile:m.tile,
      ...(i === seat && m.supplementForbidden ? {supplementForbidden:true} : {})}));
    const common = {seat:i, melds, river:[...p.river], liang:p.liang,
      handSize:p.hand.length, publicWaits:E.revealedWaits(g, i).map(w => w.tile)};
    if (i === seat) return {...common, hand:[...p.hand], passedHu:[...(p.passedHu || [])],
      passedPeng:[...(p.passedPeng || [])], buOpportunities:[...(p.buOpportunities || [])],
      reservedKongTiles:[...E.reservedKongTiles(p)]};
    const hidden = new Set(E.reservedKongTiles(p));
    const revealedTiles = p.liang ? E.sorted(p.hand.filter(t => !hidden.has(t))) : [];
    return {...common, revealedTiles, hiddenTileCount:p.hand.length - revealedTiles.length};
  });
  const last = g.lastDiscard;
  return freeze({version:OBSERVATION_VERSION, rulesVersion:E.RULES_VERSION, seat,
    config:{base:g.config.base, cap:g.config.cap}, players,
    phase:g.phase, turn:g.turn, dealer:g.dealer, round:g.round,
    totals:[...g.totals], wallCount:g.wall.length, gangChain:g.gangChain,
    drawTile:g.turn === seat && g.phase === 'discard' ? g.drawTile : null,
    pending:g.phase === 'react' ? {tile:g.pending.tile, source:g.pending.source,
      kind:g.pending.kind || 'discard', gangShot:g.pending.gangShot || 0,
      gangCount:g.pending.gangCount || 0} : null,
    lastDiscard:last ? {seat:last.seat, tile:last.tile, serial:last.serial, riverIndex:last.index} : null,
    kongs:g.kongs.map(k => ({from:k.from, to:k.to, amount:k.amount, why:k.why})),
    visibleCounts:E.visibleCounts(g, seat),
    // Engine log contains public draws/discards/meld declarations, never draw identities.
    publicActionLog:[...g.log].reverse()});
}

export function legalActionsFor(g, seat) {
  if (g.phase === 'ended') return [];
  if (g.phase === 'react') {
    if (seat === g.pending.source || g.pending.responses[seat]) return [];
    return [...E.reactionOptions(g, seat).map(type => ({type})), {type:'pass'}];
  }
  if (seat !== g.turn) return [];
  const actions = [];
  if (E.canWin(g, seat)) actions.push({type:'hu'});
  for (const o of E.selfKongOptions(g, seat)) actions.push({type:'kong', ...o});
  const p = g.players[seat], seen = new Set();
  for (const i of E.discardPolicy(g, seat).allowed) {
    const tile = p.hand[i]; if (seen.has(tile)) continue; seen.add(tile);
    actions.push({type:'discard', tile, reveal:false});
    if (!p.liang && E.waits(p.hand.filter((_, j) => j !== i), p.melds, true).length)
      actions.push({type:'discard', tile, reveal:true});
  }
  return actions;
}

export function assertConservation(g) {
  const tiles = [...g.wall, ...g.players.flatMap(p => [...p.hand, ...p.river,
    ...p.melds.flatMap(m => Array(m.kind === 'peng' ? 3 : 4).fill(m.tile))])];
  const c = E.counts(tiles);
  if (tiles.length !== 84 || Object.keys(c).length !== 21 || E.TYPES.some(t => c[t] !== 4))
    throw Error('84-tile conservation violated');
  if (g.totals.reduce((a, b) => a + b, 0) !== 0 ||
      g.result && g.result.delta.reduce((a, b) => a + b, 0) !== 0) throw Error('Score is not zero-sum');
}

export function deterministicResult(result) {
  const {id, endedAt, ...rest} = result;
  return clone(rest);
}

export class MahjongEnvironment {
  #game; #actions = null; #audit;
  constructor({seed='development', config={base:1, mode:'bots'}, previous=null, initialState=null,
    validate=true, record=true} = {}) {
    this.validate = validate;
    this.reset({seed, config, previous, initialState, record});
  }
  reset({seed='development', config={base:1, mode:'bots'}, previous=null, initialState=null, record=true} = {}) {
    this.#game = initialState ? clone(initialState) : E.newGame(config, previous, seededRandom(seed));
    if (this.#game.config.rulesVersion !== E.RULES_VERSION) throw Error('Incompatible rules');
    this.#actions = null;
    this.#audit = record ? {version:'kwx-replay-1', rulesVersion:E.RULES_VERSION,
      observationVersion:OBSERVATION_VERSION, actionVersion:ACTION_VERSION,
      seed:String(seed), initialState:clone(this.#game), actions:[]} : null;
    if (this.validate) assertConservation(this.#game);
    return this;
  }
  get done() { return this.#game.phase === 'ended'; }
  get actor() { return actingSeat(this.#game); }
  observation(seat=this.actor) { return observationFor(this.#game, seat); }
  legalActions(seat=this.actor) {
    if (seat !== this.actor) return freeze(legalActionsFor(this.#game, seat));
    return this.#actions ??= freeze(legalActionsFor(this.#game, seat));
  }
  step(action) {
    if (this.done) throw Error('Episode already ended');
    const seat = this.actor, canonical = this.legalActions().find(a => actionKey(a) === actionKey(action));
    if (!canonical) throw Error(`Illegal action at seat ${seat}: ${JSON.stringify(action)}`);
    const g = this.#game;
    if (g.phase === 'react') E.respond(g, seat, canonical.type);
    else if (canonical.type === 'hu') E.finish(g, [seat]);
    else if (canonical.type === 'kong') E.kong(g, canonical.tile, canonical.kind);
    else {
      const index = E.discardPolicy(g, seat).allowed.find(i => g.players[seat].hand[i] === canonical.tile);
      E.discard(g, index, canonical.reveal);
    }
    this.#audit?.actions.push({seat, action:clone(canonical)});
    this.#actions = null;
    if (this.validate) assertConservation(g);
    // Kong ledger is already included in terminal delta. It is never paid twice.
    return {done:this.done, reward:this.done ? [...g.result.delta] : [0, 0, 0]};
  }
  result() { return this.done ? deterministicResult(this.#game.result) : null; }
  auditState() { return clone(this.#game); }
  replay() {
    if (!this.#audit) throw Error('Replay recording disabled');
    return {...clone(this.#audit), result:this.result()};
  }
}

export function replayEpisode(replay, {validate=true} = {}) {
  if (replay.version !== 'kwx-replay-1' || replay.rulesVersion !== E.RULES_VERSION ||
      replay.actionVersion !== ACTION_VERSION || replay.observationVersion !== OBSERVATION_VERSION)
    throw Error('Incompatible replay');
  const env = new MahjongEnvironment({initialState:replay.initialState, seed:replay.seed, validate, record:false});
  for (const entry of replay.actions) {
    if (env.actor !== entry.seat) throw Error('Replay actor mismatch');
    env.step(entry.action);
  }
  if (JSON.stringify(env.result()) !== JSON.stringify(replay.result)) throw Error('Replay result mismatch');
  return env.result();
}
