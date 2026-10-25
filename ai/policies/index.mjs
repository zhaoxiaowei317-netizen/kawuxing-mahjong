import {distance} from '../../src/engine.js';
import {selectAction as h0} from './h0.mjs';

// Random is a smoke opponent; greedy-speed is an untrained, transparent foil.
const random = (_observation, actions, rng) => actions[rng(actions.length)];
function greedySpeed(o, actions) {
  for (const type of ['hu', 'ming', 'kong']) {
    const action = actions.find(a => a.type === type); if (action) return action;
  }
  if (o.phase === 'react') return actions.find(a => a.type === 'pass');
  const p = o.players[o.seat];
  return actions.filter(a => a.type === 'discard' && !a.reveal).map(a => {
    const hand = [...p.hand]; hand.splice(hand.indexOf(a.tile), 1);
    return {action:a, distance:distance(hand, p.melds)};
  }).sort((a, b) => a.distance - b.distance)[0].action;
}
const policies = {H0:h0, 'random-legal-v1':random, 'greedy-speed-v1':greedySpeed};
export const POLICY_IDS = Object.freeze(Object.keys(policies));
export function policyById(id) {
  if (!Object.hasOwn(policies, id)) throw Error(`Unknown policy: ${id}`);
  return policies[id];
}
