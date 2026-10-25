// Evaluation only: teacher labels are never supplied to the deployed policy.
export function imitationDiagnostics(model, samples) {
  const categories = {};
  let correct = 0, choiceCorrect = 0, choices = 0, crossEntropy = 0;
  for (const sample of samples) {
    const {probs, logProbs} = model.forward(sample.features, sample.legalIds);
    const predicted = sample.legalIds.reduce((best, id) => probs[id] > probs[best] ? id : best);
    const hit = predicted === sample.actionId;
    const category = sample.actionId < 21 ? 'discard' : sample.actionId < 42 ? 'reveal' :
      sample.actionId < 84 || sample.actionId === 86 ? 'kong' :
      sample.actionId === 84 ? 'hu' : sample.actionId === 85 ? 'peng' : 'pass';
    const row = categories[category] ??= {samples:0, correct:0, choices:0, choiceCorrect:0};
    row.samples++; row.correct += Number(hit); correct += Number(hit);
    crossEntropy -= logProbs[sample.actionId];
    if (sample.legalIds.length > 1) {
      choices++; choiceCorrect += Number(hit); row.choices++; row.choiceCorrect += Number(hit);
    }
  }
  for (const row of Object.values(categories)) {
    row.accuracy = row.correct / row.samples;
    row.choiceAccuracy = row.choices ? row.choiceCorrect / row.choices : null;
  }
  return {samples:samples.length, accuracy:samples.length ? correct / samples.length : null,
    choices, choiceAccuracy:choices ? choiceCorrect / choices : null,
    crossEntropy:samples.length ? crossEntropy / samples.length : null, categories};
}
