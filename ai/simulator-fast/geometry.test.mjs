import test from 'node:test';
import assert from 'node:assert/strict';
import * as original from '../../src/engine.js';
import {distance,waits,configureGeometryCache,geometryCacheMetrics} from './geometry.mjs';
import {build} from './build.mjs';
import {MahjongEnvironment} from '../environment.mjs';
import {selector} from './selector.mjs';
import {selector as originalSelector} from '../strong-pool/config.mjs';
import {encodePublic as originalEncode} from '../tile-q/encoding.mjs';
import {encodePublic} from './encoding.mjs';

test('memoized geometry preserves all parameters, mutable results, bounded eviction and disabled mode',()=>{
  configureGeometryCache(2);const h=original.parseHand('p123456789s1234'),melds=[];
  for(const liang of [false,true])for(const minimum of [1,2,4,16]){const expected=original.waits(h,melds,liang,minimum),r=waits(h,melds,liang,minimum);assert.deepEqual(r,expected);r.push({tile:'sentinel'});assert.deepEqual(waits(h,melds,liang,minimum),expected);}
  for(let n=0;n<4;n++){const hand=h.slice(n);assert.equal(distance(hand),original.distance(hand));assert.equal(distance(hand),original.distance(hand));}
  const m=geometryCacheMetrics();assert.ok(m.waits.hits>0&&m.distance.hits>0);assert.ok(m.waits.evictions>0&&m.distance.evictions>0);assert.ok(m.waits.size<=2&&m.distance.size<=2);
  configureGeometryCache(0);waits(h);waits(h);assert.equal(geometryCacheMetrics().waits.hits,0);
  assert.deepEqual(waits(h,[],false,NaN),original.waits(h,[],false,NaN));assert.throws(()=>configureGeometryCache(-1));configureGeometryCache(32768);
});
test('import-only mirrors reproduce and public encodings/selectors remain exact on legal trajectories',()=>{
  build({verify:true});configureGeometryCache(32768);let decisions=0;
  for(let seed=0;seed<12;seed++){const env=new MahjongEnvironment({seed:'cached-geometry-'+seed});while(!env.done){const o=env.observation(),legal=env.legalActions();assert.deepEqual(encodePublic(o,legal),originalEncode(o,legal));
    for(const id of ['H0','h0-never','greedy-speed-v1'])assert.deepEqual(selector(id)(o,legal),originalSelector(id)(o,legal));env.step(originalSelector(seed%2?'H0':'h0-never')(o,legal));decisions++;}}
  assert.ok(decisions>100);assert.ok(geometryCacheMetrics().waits.hits>0);
});
