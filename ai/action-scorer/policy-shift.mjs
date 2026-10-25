import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectPairedData, diagnostics} from './experiment.mjs';
import {loadScorer, scorerSources} from './io.mjs';
import {FEATURE_SIZE} from './features.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';
import {sha256} from '../provenance.mjs';

export function comparePolicy(parent, candidate, samples) {
  let choices = 0, changes = 0, kl = 0;
  for (const sample of samples) {
    if (sample.candidates.length < 2) continue;
    const a = parent.forward(sample), b = candidate.forward(sample);
    const argmax = f => f.probs.reduce((best, p, i) => p > f.probs[best] ? i : best, 0);
    choices++; changes += Number(a.ids[argmax(a)] !== b.ids[argmax(b)]);
    kl += a.probs.reduce((sum, p, i) => sum + p * (a.logProbs[i] - b.logProbs[i]), 0);
  }
  const delta = Array.from(candidate.parameters, (x, i) => x - parent.parameters[i]);
  return {choices, changes, changedChoiceRate:choices ? changes / choices : null,
    meanParentToCandidateKl:choices ? kl / choices : null,
    actorWeightChangeNorm:Math.hypot(...delta.slice(0, FEATURE_SIZE)), valueWeightChangeNorm:Math.hypot(...delta.slice(FEATURE_SIZE))};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--study') throw Error('Use --study FROZEN_RL_STUDY');
  const run = resolve(args[1]), out = resolve(run, 'policy-shift-diagnostics.json');
  if (existsSync(out)) throw Error('Diagnostic output already exists');
  const manifest = JSON.parse(readFileSync(resolve(run, 'manifest.json')));
  if (!existsSync(resolve(run, 'selection-frozen.json'))) throw Error('Selection must be frozen before diagnostics');
  const trainings = [];
  for (let seed = 0; seed < manifest.config.seeds; seed++) for (const arm of ['ppo', 'anchored']) {
    const training = JSON.parse(readFileSync(resolve(run, `seed-${seed}`, arm, 'summary.json')));
    if (training.status !== 'complete') throw Error('Training incomplete');
    trainings.push({seed, arm, finalCheckpoint:training.finalCheckpoint});
  }
  const parent = loadScorer(manifest.parent.path), sources = scorerSources();
  if (parent.sha256 !== manifest.parent.sha256) throw Error('Parent model changed');
  const seed = 'kwx-rl-post-selection-policy-shift-v1', hands = 120;
  const data = await collectPairedData({hands, seed, onProgress:p => { if (p.hand % 40 === 0) console.log(JSON.stringify(p)); }});
  const rows = [];
  for (const row of trainings) {
    const candidate = loadScorer(row.finalCheckpoint.path);
    if (candidate.sha256 !== row.finalCheckpoint.sha256) throw Error('Candidate model changed');
    rows.push({seed:row.seed, arm:row.arm, checkpoint:row.finalCheckpoint,
      shift:comparePolicy(parent.model, candidate.model, data.structured), teacher:diagnostics(candidate.model, data.structured, 'structured')});
  }
  if (JSON.stringify(scorerSources()) !== JSON.stringify(sources)) throw Error('Diagnostic source changed');
  const result = {seed, hands, samples:data.structured.length, parent:manifest.parent,
    parentTeacher:diagnostics(parent.model, data.structured, 'structured'), rows, sourceHashes:sources,
    diagnosticSourceHash:sha256(readFileSync(fileURLToPath(import.meta.url))),
    dataSourceHash:sha256(readFileSync(new URL('./experiment.mjs', import.meta.url))),
    note:'Post-selection diagnostic on common fresh H0 states. Not a selection criterion or strength test. KL is exact categorical KL per non-forced state; per-update sampled KL in training measures a different quantity.'};
  writeAtomicJson(out, result, {overwrite:false}); console.log(JSON.stringify({complete:true, out}));
}
