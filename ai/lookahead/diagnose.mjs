import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {MahjongEnvironment} from '../environment.mjs';
import {selectAction as h0} from '../policies/h0.mjs';
import {sha256} from '../provenance.mjs';
import {MODES, analyzeDiscards} from './policy.mjs';
import {studySources} from './study.mjs';

export function diagnoseLookahead({out, hands = 80, seed = 'kwx-two-draw-public-diagnostic-1'} = {}) {
  out = resolve(out);
  if (existsSync(out)) throw Error('Output exists');
  if (!Number.isInteger(hands) || hands < 1) throw Error('Invalid hands');
  const modes = Object.fromEntries(MODES.map(mode => [mode, {decisions:0, discardDecisions:0, searched:0,
    changed:0, lowerImmediateOuts:0, sameImmediateOuts:0, seconds:0, examples:[]}]));
  for (let hand = 0; hand < hands; hand++) {
    const env = new MahjongEnvironment({seed:`${seed}:${hand}`, record:false});
    let step = 0;
    while (!env.done) {
      if (++step > 500) throw Error('Action limit exceeded');
      const o = env.observation(), legal = env.legalActions(), baseline = h0(o, legal);
      for (const mode of MODES) {
        const stats = modes[mode], start = performance.now(), result = analyzeDiscards(o, legal, {mode});
        stats.seconds += (performance.now() - start) / 1000;
        stats.decisions++; stats.discardDecisions += Number(baseline.type === 'discard');
        if (!result.searched) continue;
        stats.searched++;
        if (result.action.tile === baseline.tile) continue;
        stats.changed++;
        const before = result.candidates.find(c => c.action.tile === baseline.tile), after = result.candidates[0];
        if (after.outs < before.outs) stats.lowerImmediateOuts++; else if (after.outs === before.outs) stats.sameImmediateOuts++;
        if (stats.examples.length < 6) stats.examples.push({hand, step, observation:o, baseline, selected:result.action,
          before:{distance:before.distance, outs:before.outs, lookahead:before.lookahead},
          after:{distance:after.distance, outs:after.outs, lookahead:after.lookahead}});
      }
      env.step(baseline);
    }
  }
  const report = {createdAt:new Date().toISOString(), hands, seed, trajectoryPolicy:'H0', trainingHands:0,
    purpose:'Post-hoc structural examples on shared H0 states; not a strength test or selection input.',
    sources:studySources(), diagnosticSha256:sha256(readFileSync(fileURLToPath(import.meta.url))), modes};
  mkdirSync(out, {recursive:true}); writeFileSync(resolve(out, 'diagnostics.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') throw Error('Use --out new-directory');
  const report = diagnoseLookahead({out:process.argv[3]});
  console.log(JSON.stringify({...report, sources:undefined,
    modes:Object.fromEntries(Object.entries(report.modes).map(([mode, stats]) => [mode, {...stats, examples:stats.examples.length}]))}));
}
