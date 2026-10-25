// Post-selection diagnostic only. H0 disagreement is not a counterfactual estimate of score loss.
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MahjongEnvironment} from '../environment.mjs';
import {selectAction as h0} from '../policies/h0.mjs';
import {actionId} from '../training/encoding.mjs';
import {deriveSeed} from '../random.mjs';
import {loadScorer, scorerChoice, scorerSources} from './io.mjs';
import {FEATURE_NAMES} from './features.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';
import {sha256} from '../provenance.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--model', '--out', '--hands'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Use --model SCORER --out NEW_JSON [--hands 160]');
  options[args[i]] = args[i + 1];
}
if (!options['--model'] || !options['--out'] || existsSync(options['--out'])) throw Error('Model and new output required');
const hands = Number(options['--hands'] || 160);
if (!Number.isSafeInteger(hands) || hands < 1) throw Error('Invalid hands');
const loaded = loadScorer(options['--model']), sources = scorerSources(), seed = 'kwx-candidate-post-selection-diagnostics-v1';
const stats = {hands, choices:0, matches:0, mismatches:0, kinds:{}, firstEfficiencyDifference:{}, sameTileRevealDifference:0,
  differentDiscardTile:0, revealMismatchesWithOtherLiang:0, examples:[]};
const features = [['negativeDistance', -6, 'distance'], ['readyOuts', 12, 'readyOuts'], ['outs', 12, 'outs'], ['waitKinds', 8, 'waitKinds']];
const shape = c => Object.fromEntries(features.map(([name, scale, label]) => [label, c.values[FEATURE_NAMES.indexOf(name)] * scale]));
const kind = a => a.type === 'discard' && a.reveal ? 'reveal' : a.type;
for (let hand = 0; hand < hands; hand++) {
  const env = new MahjongEnvironment({seed:deriveSeed('diagnostics-only', seed, hand), record:false}); let steps = 0;
  while (!env.done) {
    if (++steps > 500) throw Error('Action budget exceeded');
    const o = env.observation(), legal = env.legalActions(), teacher = h0(o, legal);
    const chosen = scorerChoice(loaded.model, o, legal, null, true), same = chosen.actionId === actionId(teacher);
    if (legal.length > 1) {
      stats.choices++; stats.matches += Number(same);
      if (!same) {
        stats.mismatches++; const kinds = `${kind(teacher)} -> ${kind(chosen.action)}`;
        stats.kinds[kinds] = (stats.kinds[kinds] || 0) + 1;
        if (teacher.type === 'discard' && chosen.action.type === 'discard') {
          if (teacher.tile === chosen.action.tile) stats.sameTileRevealDifference++;
          else stats.differentDiscardTile++;
          const t = shape(chosen.candidates.find(c => c.id === actionId(teacher))), c = shape(chosen.candidates.find(c => c.id === chosen.actionId));
          const first = features.map(([, , name]) => name).find(name => Math.abs(c[name] - t[name]) > 1e-8);
          const category = first ? `${first}:${c[first] > t[first] ? 'higher' : 'lower'}` : 'sameEfficiency';
          stats.firstEfficiencyDifference[category] = (stats.firstEfficiencyDifference[category] || 0) + 1;
          if (teacher.reveal !== chosen.action.reveal && o.players.some((p, i) => i !== o.seat && p.liang)) stats.revealMismatchesWithOtherLiang++;
          if (stats.examples.length < 12 && category !== 'sameEfficiency') stats.examples.push({hand, seat:o.seat,
            ownHand:o.players[o.seat].hand, ownMelds:o.players[o.seat].melds, wallCount:o.wallCount, teacher, chosen:chosen.action,
            teacherEfficiency:t, chosenEfficiency:c, firstDifference:category});
        }
      }
    }
    env.step(chosen.action);
  }
  if ((hand + 1) % 40 === 0) console.log(JSON.stringify({hand:hand + 1, hands}));
  await new Promise(resolve => setImmediate(resolve));
}
if (JSON.stringify(scorerSources()) !== JSON.stringify(sources) || sha256(readFileSync(options['--model'])) !== loaded.sha256) throw Error('Diagnostic sources/model changed');
writeAtomicJson(options['--out'], {model:{path:resolve(options['--model']), sha256:loaded.sha256}, stats, seed,
  sourceHashes:sources, diagnosticSourceHash:sha256(readFileSync(fileURLToPath(import.meta.url))),
  interpretation:'Own-policy trajectories. First differing metric follows H0 priority: shanten, ready outs, improving outs, wait kinds. Higher shanten may intentionally exchange speed for value/defense. Matching these metrics does not imply equal expected score. This is disagreement analysis, not causal score attribution.'}, {overwrite:false});
console.log(JSON.stringify({complete:true, stats}));
