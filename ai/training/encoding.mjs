import {TYPES, RULES_VERSION} from '../../src/engine.js';
import {OBSERVATION_VERSION} from '../environment.mjs';

export const ENCODING_VERSION = 'kwx-encoding-1';
export const ACTION_SIZE = 88;
export const TILE_TYPES = Object.freeze([...TYPES]);
export const RIVER_WINDOW = 6;
const TILE_COUNT = TILE_TYPES.length;
const tileIndex = new Map(TILE_TYPES.map((tile, index) => [tile, index]));
const MELD_KINDS = Object.freeze(['peng', 'ming', 'an', 'bu']);
const PHASES = Object.freeze(['discard', 'react', 'ended']);
const PENDING_KINDS = Object.freeze(['discard', 'robKong']);
const SCORE_SCALE = Math.asinh(100);

const descriptions = [];
let inputSize = 0;
function feature(name, size, normalization) {
  descriptions.push(Object.freeze({name, offset:inputSize, size, normalization}));
  inputSize += size;
}
feature('own.handCounts', TILE_COUNT, 'count / 4');
feature('own.drawTile', TILE_COUNT, 'one-hot; absent = all zero');
feature('public.visibleCounts', TILE_COUNT, 'count / 4');
for (let relative = 0; relative < 3; relative++) {
  const prefix = `players.relative${relative}`;
  feature(`${prefix}.revealedTileCounts`, TILE_COUNT, 'count / 4; only public part, including for self');
  feature(`${prefix}.riverCounts`, TILE_COUNT, 'count / 4');
  for (const kind of MELD_KINDS) feature(`${prefix}.melds.${kind}`, TILE_COUNT, 'number of meld groups');
  feature(`${prefix}.publicWaits`, TILE_COUNT, 'binary tile membership');
  feature(`${prefix}.status`, 3, '[liang ? 1 : 0, handSize / 14, hiddenTileCount / 14]');
  feature(`${prefix}.riverTail`, RIVER_WINDOW * (TILE_COUNT + 1),
    'oldest to newest, right-aligned; each slot = tile one-hot then presence bit');
}
for (const name of ['passedHu', 'passedPeng', 'buOpportunities', 'reservedKongTiles', 'supplementForbidden'])
  feature(`own.${name}`, TILE_COUNT, 'binary tile membership');
for (const [name, normalization] of [['wallCount', 'value / 44'], ['gangChain', 'value / 16'],
  ['base', 'value / 100'], ['round', 'value / 16']]) feature(`table.${name}`, 1, normalization);
feature('table.totals', 3, 'relative seats; asinh(score / base) / asinh(100)');
feature('table.kongNet', 3, 'completed-kong ledger net, relative seats; asinh(score / base) / asinh(100)');
feature('table.turn', 3, 'relative-seat one-hot');
feature('table.dealer', 3, 'relative-seat one-hot');
feature('table.phase', PHASES.length, '[discard, react, ended] one-hot');
feature('table.pendingTile', TILE_COUNT, 'tile one-hot; absent = all zero');
feature('table.pendingSource', 3, 'relative-seat one-hot; absent = all zero');
feature('table.pendingKind', PENDING_KINDS.length, '[discard, robKong] one-hot; absent = all zero');
feature('table.pendingGangShot', 1, 'value / 16; absent = zero');
feature('table.pendingGangCount', 1, 'value / 16; absent = zero');
feature('table.lastDiscardTile', TILE_COUNT, 'tile one-hot; absent = all zero');
feature('table.lastDiscardSeat', 3, 'relative-seat one-hot; absent = all zero');

export const INPUT_SIZE = inputSize;
export const FEATURE_SCHEMA = Object.freeze(descriptions);
if (INPUT_SIZE !== 1085) throw Error('Unexpected encoding schema size; version and network dimensions must change together');

function tileId(tile) {
  const id = tileIndex.get(tile);
  if (id === undefined) throw Error(`Unknown tile: ${String(tile)}`);
  return id;
}
function exactKeys(action, keys) {
  if (!action || typeof action !== 'object' || Array.isArray(action) ||
      Object.keys(action).length !== keys.length || keys.some(key => !Object.hasOwn(action, key)))
    throw Error('Invalid semantic action fields');
}
export function actionId(action) {
  if (!action || typeof action !== 'object') throw Error('Invalid semantic action');
  if (action.type === 'discard') {
    exactKeys(action, ['type', 'tile', 'reveal']);
    if (typeof action.reveal !== 'boolean') throw Error('Discard reveal must be boolean');
    return tileId(action.tile) + (action.reveal ? 21 : 0);
  }
  if (action.type === 'kong') {
    exactKeys(action, ['type', 'tile', 'kind']);
    if (!['an', 'bu'].includes(action.kind)) throw Error('Self kong kind must be an or bu');
    return tileId(action.tile) + (action.kind === 'an' ? 42 : 63);
  }
  exactKeys(action, ['type']);
  const id = {hu:84, peng:85, ming:86, pass:87}[action.type];
  if (!Number.isInteger(id)) throw Error(`Unknown semantic action: ${String(action.type)}`);
  return id;
}
export function legalActionIds(actions) {
  if (!Array.isArray(actions)) throw Error('Legal actions must be an array');
  return [...new Set(actions.map(actionId))].sort((a, b) => a - b);
}
export function decodeAction(id, legalActions) {
  if (!Number.isInteger(id) || id < 0 || id >= ACTION_SIZE) throw Error('Action ID must be an integer in [0, 87]');
  if (!Array.isArray(legalActions)) throw Error('Legal actions must be an array');
  const ids = legalActions.map(actionId), index = ids.indexOf(id);
  if (index < 0) throw Error(`Action ${id} is not legal in this observation`);
  // Return the original engine-validated semantic object; never invent a fallback.
  return legalActions[index];
}

function finite(value, name) {
  if (!Number.isFinite(value)) throw Error(`Non-finite observation field: ${name}`);
  return value;
}
function seatId(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 2) throw Error(`Invalid observation seat: ${name}`);
  return value;
}
function tileArray(value, name) {
  if (!Array.isArray(value)) throw Error(`Observation field must be an array: ${name}`);
  for (const tile of value) tileId(tile);
  return value;
}
function countsVector(tiles, scale=4) {
  const vector = Array(TILE_COUNT).fill(0);
  for (const tile of tiles) vector[tileId(tile)] += 1 / scale;
  return vector;
}
function membershipVector(tiles) {
  const vector = Array(TILE_COUNT).fill(0);
  for (const tile of tiles) vector[tileId(tile)] = 1;
  return vector;
}
function oneHot(value, size) {
  const vector = Array(size).fill(0);
  if (value !== null && value !== undefined) vector[value] = 1;
  return vector;
}
function optionalTile(tile) { return oneHot(tile === null || tile === undefined ? null : tileId(tile), TILE_COUNT); }

export function encodeObservation(obs) {
  if (!obs || obs.version !== OBSERVATION_VERSION || obs.rulesVersion !== RULES_VERSION)
    throw Error('Incompatible observation or rules version');
  const seat = seatId(obs.seat, 'observer');
  if (!Array.isArray(obs.players) || obs.players.length !== 3 ||
      new Set(obs.players.map(player => seatId(player.seat, 'player'))).size !== 3)
    throw Error('Observation requires three distinct player seats');
  const players = [0, 1, 2].map(relative => obs.players.find(player => player.seat === (seat + relative) % 3));
  const own = players[0], hand = tileArray(own.hand, 'own.hand');
  const relativeSeat = absolute => (seatId(absolute, 'public actor') - seat + 3) % 3;
  const base = finite(obs.config?.base, 'base');
  if (base < 1 || base > 100 || !Number.isInteger(base) || obs.config.cap !== 16)
    throw Error('Incompatible base or cap');
  if (!Array.isArray(obs.totals) || obs.totals.length !== 3) throw Error('Observation requires three totals');
  const result = [], append = vector => result.push(...vector);
  append(countsVector(hand));
  append(optionalTile(obs.drawTile));
  append(TILE_TYPES.map(tile => finite(obs.visibleCounts?.[tile] ?? 0, `visibleCounts.${tile}`) / 4));
  for (const [relative, player] of players.entries()) {
    const river = tileArray(player.river, 'player.river');
    if (!Array.isArray(player.melds)) throw Error('Observation melds must be an array');
    const reserved = relative === 0 ? new Set(tileArray(own.reservedKongTiles, 'own.reservedKongTiles')) : null;
    // Opponents' private hand/metadata are deliberately never read, even if injected as extra fields.
    const revealed = relative === 0
      ? player.liang ? hand.filter(tile => !reserved.has(tile)) : []
      : tileArray(player.revealedTiles, 'opponent.revealedTiles');
    append(countsVector(revealed));
    append(countsVector(river));
    for (const meld of player.melds) {
      if (!MELD_KINDS.includes(meld.kind)) throw Error('Unknown public meld kind');
      tileId(meld.tile);
    }
    for (const kind of MELD_KINDS) append(countsVector(player.melds.filter(meld => meld.kind === kind).map(meld => meld.tile), 1));
    append(membershipVector(tileArray(player.publicWaits, 'player.publicWaits')));
    const handSize = finite(player.handSize, 'handSize');
    const hiddenCount = relative === 0 ? handSize - revealed.length : finite(player.hiddenTileCount, 'hiddenTileCount');
    append([Number(Boolean(player.liang)), handSize / 14, hiddenCount / 14]);
    for (let position = 0; position < RIVER_WINDOW; position++) {
      const index = river.length - RIVER_WINDOW + position, tile = index >= 0 ? river[index] : null;
      append(optionalTile(tile)); result.push(tile === null ? 0 : 1);
    }
  }
  for (const name of ['passedHu', 'passedPeng', 'buOpportunities', 'reservedKongTiles'])
    append(membershipVector(tileArray(own[name], `own.${name}`)));
  append(membershipVector(own.melds.filter(meld => meld.supplementForbidden).map(meld => meld.tile)));
  append([finite(obs.wallCount, 'wallCount') / 44, finite(obs.gangChain, 'gangChain') / 16,
    base / 100, finite(obs.round, 'round') / 16]);
  const encodeScore = score => Math.asinh(finite(score, 'score') / base) / SCORE_SCALE;
  append(players.map(player => encodeScore(obs.totals[player.seat])));
  const kongNet = [0, 0, 0];
  if (!Array.isArray(obs.kongs)) throw Error('Observation kongs must be an array');
  for (const kong of obs.kongs) {
    const from = seatId(kong.from, 'kong.from'), to = seatId(kong.to, 'kong.to');
    const amount = finite(kong.amount, 'kong.amount');
    kongNet[from] -= amount; kongNet[to] += amount;
  }
  append(players.map(player => encodeScore(kongNet[player.seat])));
  append(oneHot(relativeSeat(obs.turn), 3));
  append(oneHot(relativeSeat(obs.dealer), 3));
  const phase = PHASES.indexOf(obs.phase);
  if (phase < 0) throw Error('Unknown observation phase');
  append(oneHot(phase, PHASES.length));
  append(optionalTile(obs.pending?.tile));
  append(oneHot(obs.pending ? relativeSeat(obs.pending.source) : null, 3));
  const pendingKind = obs.pending ? PENDING_KINDS.indexOf(obs.pending.kind) : null;
  if (pendingKind === -1) throw Error('Unknown pending kind');
  append(oneHot(pendingKind, PENDING_KINDS.length));
  append([finite(obs.pending?.gangShot ?? 0, 'pending.gangShot') / 16,
    finite(obs.pending?.gangCount ?? 0, 'pending.gangCount') / 16]);
  append(optionalTile(obs.lastDiscard?.tile));
  append(oneHot(obs.lastDiscard ? relativeSeat(obs.lastDiscard.seat) : null, 3));
  if (result.length !== INPUT_SIZE || !result.every(Number.isFinite)) throw Error('Invalid encoded observation shape or non-finite feature');
  return result;
}
