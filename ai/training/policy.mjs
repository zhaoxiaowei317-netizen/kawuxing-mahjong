import {encodeObservation, legalActionIds, decodeAction} from './encoding.mjs';

export function chooseModelAction(model, observation, legalActions, rng, {deterministic=false} = {}) {
  const features = encodeObservation(observation), legalIds = legalActionIds(legalActions);
  const output = model.forward(features, legalIds);
  let selected;
  if (deterministic) selected = legalIds.reduce((best, id) => output.probs[id] > output.probs[best] ? id : best, legalIds[0]);
  else {
    if (typeof rng !== 'function') throw Error('Stochastic inference requires an independent policy RNG');
    const target = rng(0x100000000) / 0x100000000;
    let cumulative = 0; selected = legalIds.at(-1);
    for (const id of legalIds) { cumulative += output.probs[id]; if (target < cumulative) { selected = id; break; } }
  }
  return {action:decodeAction(selected, legalActions), features, legalIds, actionId:selected,
    oldLogProb:output.logProbs[selected], oldValue:output.value};
}

export function modelPolicyFactory(model, {deterministic=true} = {}) {
  return () => (observation, legalActions, rng) => chooseModelAction(model, observation, legalActions, rng, {deterministic}).action;
}
