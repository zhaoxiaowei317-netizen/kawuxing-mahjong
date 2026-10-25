import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import {MahjongEnvironment, observationFor} from '../ai/environment.mjs';
import {selectAction as h0} from '../ai/policies/h0.mjs';
import {seededRandom} from '../ai/random.mjs';
import {ENCODING_VERSION, INPUT_SIZE, ACTION_SIZE, TILE_TYPES, FEATURE_SCHEMA,
  actionId, legalActionIds, decodeAction, encodeObservation} from '../ai/training/encoding.mjs';

function segment(vector, name) {
  const field = FEATURE_SCHEMA.find(field => field.name === name);
  assert.ok(field, name);
  return vector.slice(field.offset, field.offset + field.size);
}
function rotateObservation(original, amount) {
  const obs = structuredClone(original), rotate = seat => (seat + amount) % 3;
  obs.seat = rotate(obs.seat); obs.turn = rotate(obs.turn); obs.dealer = rotate(obs.dealer);
  obs.players.forEach(player => { player.seat = rotate(player.seat); });
  // Object array order is not a seat identity; use a different serialization order too.
  obs.players.reverse();
  const totals = [...obs.totals];
  totals.forEach((score, seat) => { obs.totals[rotate(seat)] = score; });
  if (obs.pending) obs.pending.source = rotate(obs.pending.source);
  if (obs.lastDiscard) obs.lastDiscard.seat = rotate(obs.lastDiscard.seat);
  obs.kongs.forEach(kong => { kong.from = rotate(kong.from); kong.to = rotate(kong.to); });
  obs.publicActionLog = ['不同绝对名字的公开文字不参与本版编码'];
  return obs;
}

test('fixed protocol defines all 88 semantic actions without depending on hand indices', () => {
  assert.equal(ENCODING_VERSION, 'kwx-encoding-1');
  assert.equal(INPUT_SIZE, 1085); assert.equal(ACTION_SIZE, 88);
  assert.deepEqual(TILE_TYPES, ['p1','p2','p3','p4','p5','p6','p7','p8','p9',
    's1','s2','s3','s4','s5','s6','s7','s8','s9','z5','z6','z7']);
  const actions = [];
  for (const reveal of [false, true]) for (const tile of TILE_TYPES)
    actions.push(Object.freeze({type:'discard', tile, reveal}));
  for (const kind of ['an', 'bu']) for (const tile of TILE_TYPES)
    actions.push(Object.freeze({type:'kong', tile, kind}));
  for (const type of ['hu', 'peng', 'ming', 'pass']) actions.push(Object.freeze({type}));
  assert.equal(actions.length, 88);
  for (const [id, action] of actions.entries()) {
    assert.equal(actionId(action), id);
    assert.equal(decodeAction(id, actions), action);
    assert.equal(decodeAction(id, [action]), action);
  }
  assert.deepEqual(legalActionIds([...actions].reverse()), Array.from({length:88}, (_, id) => id));
  assert.equal(actionId({reveal:true, tile:'z7', type:'discard'}), 41);
  assert.equal(actionId({type:'kong', kind:'bu', tile:'z7'}), 83);
});

test('legal ID mask deduplicates and decoder rejects masked, malformed and out-of-range actions', () => {
  const a = Object.freeze({type:'discard', tile:'p1', reveal:false}), pass = Object.freeze({type:'pass'});
  assert.deepEqual(legalActionIds([pass, a, a]), [0, 87]);
  assert.deepEqual(legalActionIds([]), []);
  assert.equal(decodeAction(0, [a, pass]), a);
  for (const id of [-1, 88, 1.5, NaN, Infinity, '0', null])
    assert.throws(() => decodeAction(id, [a, pass]), /integer/);
  assert.throws(() => decodeAction(1, [a, pass]), /not legal/);
  assert.throws(() => decodeAction(84, []), /not legal/);
  for (const action of [null, {}, {type:'chi'}, {type:'hu', leaked:true},
    {type:'discard', tile:'?', reveal:false}, {type:'discard', tile:'p1'},
    {type:'discard', tile:'p1', reveal:1}, {type:'discard', tile:'p1', reveal:false, index:3},
    {type:'kong', tile:'p1', kind:'ming'}]) assert.throws(() => actionId(action));
  assert.throws(() => decodeAction(0, [a, {type:'hu', leaked:true}]), /fields/);
});

test('schema is contiguous, immutable and names all normalization rules', () => {
  let offset = 0;
  for (const field of FEATURE_SCHEMA) {
    assert.equal(field.offset, offset); assert.ok(field.normalization);
    offset += field.size; assert.ok(Object.isFrozen(field));
  }
  assert.equal(offset, INPUT_SIZE); assert.ok(Object.isFrozen(FEATURE_SCHEMA));
  assert.equal(new Set(FEATURE_SCHEMA.map(field => field.name)).size, FEATURE_SCHEMA.length);
});

test('real read-only environment observations encode finite features and execute only decoded legal actions', () => {
  let decisions = 0, sawReact = false, sawEnded = false;
  for (let seed = 0; seed < 4; seed++) {
    const env = new MahjongEnvironment({seed:`encoding-play-${seed}`});
    while (!env.done) {
      assert.ok(++decisions < 2000);
      const obs = env.observation(), before = structuredClone(obs), actions = env.legalActions();
      const features = encodeObservation(obs), ids = legalActionIds(actions);
      assert.ok(Array.isArray(features)); assert.equal(features.length, INPUT_SIZE);
      assert.ok(features.every(Number.isFinite)); assert.deepEqual(obs, before);
      assert.ok(ids.length > 0 && ids.every(id => Number.isInteger(id) && id >= 0 && id < 88));
      const choice = h0(obs, actions), id = actionId(choice);
      assert.ok(ids.includes(id));
      assert.equal(decodeAction(id, actions), choice);
      if (obs.phase === 'react') sawReact = true;
      env.step(decodeAction(id, actions));
    }
    const ended = encodeObservation(env.observation(0));
    assert.deepEqual(segment(ended, 'table.phase'), [0, 0, 1]);
    assert.ok(ended.every(Number.isFinite)); sawEnded = true;
  }
  assert.ok(sawReact && sawEnded);
});

test('all absolute-seat rotations have identical relative features, including response and kong ledgers', () => {
  const g = E.newGame({mode:'bots'}, {dealer:1}, seededRandom('encoding-rotation'));
  g.players[0].river = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  g.players[2].river = ['s9'];
  g.lastDiscard = {seat:2, tile:'s9', serial:8, index:0, handIndex:9};
  g.phase = 'react'; g.pending = {source:2, tile:'s9', kind:'robKong', gangShot:0, gangCount:2, responses:{}};
  g.kongs = [{from:0, to:1, amount:2, why:'公开杠分'}, {from:2, to:0, amount:1, why:'公开杠分'}];
  g.totals = [7, -3, -4];
  const obs = observationFor(g, 1), encoded = encodeObservation(obs);
  for (const amount of [1, 2]) assert.deepEqual(encodeObservation(rotateObservation(obs, amount)), encoded);
  assert.deepEqual(segment(encoded, 'table.dealer'), [1, 0, 0]);
  assert.deepEqual(segment(encoded, 'table.pendingSource'), [0, 1, 0]);
  assert.deepEqual(segment(encoded, 'table.lastDiscardSeat'), [0, 1, 0]);
  assert.deepEqual(segment(encoded, 'table.pendingKind'), [0, 1]);
  const kongNet = segment(encoded, 'table.kongNet');
  assert.ok(kongNet[0] > 0 && kongNet[1] < 0 && kongNet[2] < 0);
});

test('hidden opponent identities, hidden positions and extra private fields never alter encoding', () => {
  const g = E.newGame({mode:'bots'}, {dealer:0}, seededRandom('encoding-hidden'));
  g.players[1].hand = E.parseHand('p111s123456789z5');
  Object.assign(g.players[1], {liang:true, liangKongTiles:['p1'], publicWaits:[{tile:'z5'}]});
  const first = observationFor(g, 0), encoded = encodeObservation(first);
  g.players[1].hand = E.parseHand('p222s123456789z5').reverse();
  g.players[1].liangKongTiles = ['p2']; g.players[2].hand.reverse(); g.wall.reverse();
  assert.deepEqual(encodeObservation(observationFor(g, 0)), encoded);
  const injected = structuredClone(first);
  injected.players[1].hand = ['z7', 'z7'];
  injected.players[1].liangKongTiles = ['z7']; injected.players[1].passedHu = ['p9'];
  injected.players[1].passedPeng = ['s9']; injected.players[1].buOpportunities = ['p8'];
  injected.players[1].melds.forEach(meld => { meld.supplementForbidden = true; });
  injected.players[2].hand = ['p1']; injected.wall = ['p9'];
  injected.pendingResponses = {1:'hu'}; injected.auditSeed = 'hidden';
  injected.publicActionLog = ['完全不同的文字、名字及隐藏诱饵'];
  injected.players[0].hand.reverse();
  assert.deepEqual(encodeObservation(injected), encoded);
});

test('own rule restrictions are separate membership channels and opponent flags are ignored', () => {
  const obs = structuredClone(new MahjongEnvironment({seed:'encoding-own-flags'}).observation(0));
  const own = obs.players.find(player => player.seat === 0);
  own.passedHu = ['p1', 'p1']; own.passedPeng = ['s1']; own.buOpportunities = ['z5'];
  own.reservedKongTiles = ['z6']; own.melds = [{kind:'peng', tile:'z7', supplementForbidden:true}];
  const encoded = encodeObservation(obs);
  for (const [name, tileId] of [['passedHu', 0], ['passedPeng', 9], ['buOpportunities', 18],
    ['reservedKongTiles', 19], ['supplementForbidden', 20]]) {
    const field = segment(encoded, `own.${name}`);
    assert.equal(field[tileId], 1); assert.equal(field.reduce((sum, value) => sum + value, 0), 1);
  }
  assert.equal(segment(encoded, 'players.relative0.melds.peng')[20], 1);
  const other = obs.players.find(player => player.seat === 1);
  other.passedHu = ['z7']; other.supplementForbidden = ['p9'];
  assert.deepEqual(encodeObservation(obs), encoded);
});

test('public river tail preserves order, uses presence padding and never loses full-river counts', () => {
  const obs = structuredClone(new MahjongEnvironment({seed:'encoding-river'}).observation(0));
  const own = obs.players.find(player => player.seat === 0);
  own.river = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let encoded = encodeObservation(obs), tail = segment(encoded, 'players.relative0.riverTail');
  assert.equal(tail[1], 1); // Oldest retained tile is p2; p1 remains in full-river counts.
  assert.equal(tail[21], 1); assert.equal(tail[5 * 22 + 6], 1);
  assert.equal(segment(encoded, 'players.relative0.riverCounts')[0], 0.25);
  own.river = ['p1']; encoded = encodeObservation(obs);
  tail = segment(encoded, 'players.relative0.riverTail');
  assert.deepEqual(tail.slice(0, 5 * 22), Array(5 * 22).fill(0));
  assert.equal(tail[5 * 22], 1); assert.equal(tail[6 * 22 - 1], 1);
});

test('finite score and round boundaries remain finite; incompatible or non-finite input is rejected', () => {
  const obs = structuredClone(new MahjongEnvironment({seed:'encoding-finite', config:{base:100}}).observation(0));
  obs.totals = [Number.MAX_VALUE, -Number.MAX_VALUE, 0]; obs.round = Number.MAX_VALUE;
  assert.ok(encodeObservation(obs).every(Number.isFinite));
  assert.ok(segment(encodeObservation(obs), 'table.totals')[0] > 0);
  assert.throws(() => encodeObservation(E.newGame({mode:'bots'}, null, seededRandom('not-an-observation'))), /Incompatible/);
  for (const mutate of [copy => { copy.round = Infinity; }, copy => { copy.totals[1] = NaN; },
    copy => { copy.visibleCounts.p1 = NaN; }, copy => { copy.version = 'future'; },
    copy => { copy.rulesVersion = 'other'; }, copy => { copy.config.cap = 32; },
    copy => { copy.config.base = 0; }, copy => { copy.players[1].seat = copy.players[0].seat; }]) {
    const invalid = structuredClone(obs); mutate(invalid);
    assert.throws(() => encodeObservation(invalid));
  }
});
