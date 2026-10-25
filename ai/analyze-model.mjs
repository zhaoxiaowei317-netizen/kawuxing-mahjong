import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {MahjongEnvironment} from './environment.mjs';
import {policyById} from './policies/index.mjs';
import {deriveSeed, seededRandom} from './random.mjs';
import {distance} from '../src/engine.js';
import {chooseModelAction} from './training/policy.mjs';
import {loadCheckpoint, writeAtomicJson} from './training/checkpoint.mjs';
import {actionId} from './training/encoding.mjs';
import {sourceHashes, sha256} from './provenance.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--model', '--episodes', '--out', '--seed'].includes(args[i]) || !args[i + 1] || options[args[i]])
    throw Error('Use --model FILE --out NEW_JSON [--episodes 160] [--seed STRING]');
  options[args[i]] = args[i + 1];
}
if (!options['--model'] || !options['--out']) throw Error('--model and --out required');
if (existsSync(resolve(options['--out']))) throw Error('Diagnostic output must be new');
const episodes = Number(options['--episodes'] ?? 160), seed = options['--seed'] || 'kwx-action-diagnosis-v1';
if (!Number.isSafeInteger(episodes) || episodes < 1) throw Error('Invalid episodes');
const path = resolve(options['--model']), loaded = loadCheckpoint(path), frozen = sourceHashes(), teacher = policyById('H0');
const distributions = {};
for (const driver of ['H0', 'model']) {
  const stats = {episodes, decisions:0, choices:0, matches:0, huAvailable:0, huDeclined:0,
    freeDiscards:0, higherDistanceDiscards:0, extraDistance:0, distanceGapHistogram:{},
    teacherPeng:0, missedTeacherPeng:0, teacherPass:0, disagreedTeacherPass:0,
    revealAvailable:0, reveals:0, examples:[]};
  for (let episode = 0; episode < episodes; episode++) {
    const env = new MahjongEnvironment({seed:deriveSeed('diagnostics-only', seed, episode), record:false});
    const rng = seededRandom(deriveSeed(seed, 'diagnostic-policy', episode));
    let steps = 0;
    while (!env.done) {
      if (++steps > 500) throw Error('Diagnostic episode exceeded action limit');
      const o = env.observation(), legal = env.legalActions(), h0 = teacher(o, legal);
      const chosen = chooseModelAction(loaded.model, o, legal, rng, {deterministic:true}).action;
      stats.decisions++;
      if (legal.length > 1) { stats.choices++; stats.matches += Number(actionId(chosen) === actionId(h0)); }
      if (legal.some(a => a.type === 'hu')) { stats.huAvailable++; stats.huDeclined += Number(chosen.type !== 'hu'); }
      if (h0.type === 'peng') { stats.teacherPeng++; stats.missedTeacherPeng += Number(chosen.type !== 'peng'); }
      if (h0.type === 'pass') { stats.teacherPass++; stats.disagreedTeacherPass += Number(chosen.type !== 'pass'); }
      if (legal.some(a => a.type === 'discard' && a.reveal)) {
        stats.revealAvailable++; stats.reveals += Number(chosen.type === 'discard' && chosen.reveal);
      }
      const p = o.players[o.seat], discards = [...new Set(legal.filter(a => a.type === 'discard').map(a => a.tile))];
      if (chosen.type === 'discard' && !p.liang && discards.length > 1) {
        const after = tile => { const hand = [...p.hand]; hand.splice(hand.indexOf(tile), 1); return distance(hand, p.melds); };
        const minimum = Math.min(...discards.map(after)), actual = after(chosen.tile), gap = actual - minimum;
        stats.freeDiscards++; stats.extraDistance += gap;
        stats.distanceGapHistogram[gap] = (stats.distanceGapHistogram[gap] || 0) + 1;
        if (gap > 0) {
          stats.higherDistanceDiscards++;
          if (stats.examples.length < 12) stats.examples.push({episode, seat:o.seat, hand:p.hand,
            melds:p.melds, wallCount:o.wallCount, chosen, teacher:h0, chosenDistance:actual, minimumDistance:minimum});
        }
      }
      env.step(driver === 'H0' ? h0 : chosen);
    }
    if ((episode + 1) % 40 === 0) console.log(JSON.stringify({driver, episode:episode + 1, episodes}));
    await new Promise(resolve => setImmediate(resolve));
  }
  stats.choiceAgreement = stats.choices ? stats.matches / stats.choices : null;
  stats.higherDistanceRate = stats.freeDiscards ? stats.higherDistanceDiscards / stats.freeDiscards : null;
  distributions[driver] = stats;
}
if (JSON.stringify(sourceHashes()) !== JSON.stringify(frozen) || sha256(readFileSync(path)) !== loaded.sha256)
  throw Error('Model or sources changed during diagnostics');
writeAtomicJson(resolve(options['--out']), {format:'kwx-action-diagnostics-1', model:{path, sha256:loaded.sha256},
  episodesPerDistribution:episodes, seed, distributions, sourceHashes:frozen,
  diagnosticSourceHash:sha256(readFileSync(new URL('./analyze-model.mjs', import.meta.url))),
  note:'Post-selection diagnostics, never training labels or promotion evidence. Higher shanten can be intentional for value or defense; this is a speed tradeoff indicator, not proof of a wrong move.'}, {overwrite:false});
console.log(JSON.stringify({out:resolve(options['--out']), distributions}));
