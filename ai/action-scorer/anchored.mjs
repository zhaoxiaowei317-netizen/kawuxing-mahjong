import {ActionScorer} from './model.mjs';

// Inference and checkpoint tensor layout stay identical to ActionScorer v1.
// Only training adds an H0-label loss. Pin this file in the training manifest.
export class AnchoredScorer extends ActionScorer {
  lossAndGradients(samples, kind='bc', {bcCoef=0, ...options}={}) {
    if (!Number.isFinite(bcCoef) || bcCoef < 0) throw Error('Invalid BC anchor coefficient');
    const ppo = super.lossAndGradients(samples, kind, options);
    if (kind !== 'ppo' || bcCoef === 0) return {...ppo, anchorLoss:0};
    const teacherSamples = samples.map(s => ({...s, actionId:s.teacherActionId}));
    const bc = super.lossAndGradients(teacherSamples, 'bc', {entropyCoef:0, valueCoef:0});
    const gradients = Float64Array.from(ppo.gradients, (g, i) => g + bcCoef * bc.gradients[i]);
    const loss = ppo.loss + bcCoef * bc.loss;
    if (!Number.isFinite(loss) || !gradients.every(Number.isFinite)) throw Error('Nonfinite anchored loss');
    return {...ppo, loss, gradients, anchorLoss:bc.loss};
  }
  static fromJSON(data) {
    const model = ActionScorer.fromJSON(data);
    Object.setPrototypeOf(model, AnchoredScorer.prototype); return model;
  }
}
