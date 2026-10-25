import assert from 'node:assert/strict';
import {seededRandom} from '../random.mjs';
import {assertConservation,observationFor} from '../environment.mjs';

// Offline labels only: condition on the actual complete hands and remaining
// multiset; integrate over future draw order. This is NOT a public posterior.
export function shuffleFutureWall(world,seed){
  assert.equal(world.phase,'discard');assert.equal(world.pending,null);
  const sampled=structuredClone(world),rng=seededRandom(seed),before=observationFor(world,world.turn);
  for(let i=sampled.wall.length-1;i>0;i--){const j=rng(i+1);[sampled.wall[i],sampled.wall[j]]=[sampled.wall[j],sampled.wall[i]];}
  assertConservation(sampled);assert.deepEqual(observationFor(sampled,world.turn),before);
  const {wall:oldWall,...oldRest}=world,{wall:newWall,...newRest}=sampled;
  assert.deepEqual(newRest,oldRest);assert.deepEqual([...newWall].sort(),[...oldWall].sort());
  return sampled;
}
