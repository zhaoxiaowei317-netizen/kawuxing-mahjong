import {selectAction as h0} from '../policies/h0.mjs';
import {describeRoot} from './features.mjs';
import {predictModel} from './model.mjs';

export function learnedGainFactory(model, onDecision = null) {
  return () => {
    let used = false;
    return (o, legal) => {
      if (used) return h0(o, legal);
      const root = describeRoot(o, legal);
      if (!root.proposed) return root.action;
      used = true;
      const predictedGain = predictModel(model, root.features);
      const action = predictedGain > 1e-9 ? root.alternative : root.baseline;
      onDecision?.({root, predictedGain, action}, o, legal); return action;
    };
  };
}
