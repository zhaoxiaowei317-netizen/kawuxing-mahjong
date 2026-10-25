import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MahjongEnvironment} from '../environment.mjs';
import {selectAction as h0} from '../policies/h0.mjs';
import {deriveSeed} from '../random.mjs';
import {distance} from '../../src/engine.js';
import {chooseModelAction} from '../training/policy.mjs';
import {loadCheckpoint, writeAtomicJson} from '../training/checkpoint.mjs';
import {actionId} from '../training/encoding.mjs';
import {loadScorer, scorerChoice, scorerSources} from './io.mjs';
import {sha256} from '../provenance.mjs';

export async function diagnose({path, arm, hands=160, seed='kwx-candidate-post-selection-diagnostics-v1', onProgress=null}) {
  if (!['raw', 'structured'].includes(arm) || !Number.isSafeInteger(hands) || hands < 1) throw Error('Invalid diagnostic configuration');
  const loaded = arm === 'raw' ? loadCheckpoint(path) : loadScorer(path), sources = scorerSources(), distributions = {};
  for (const driver of ['H0', 'model']) {
    const stats = {hands, choices:0, matches:0, freeDiscards:0, higherDistanceDiscards:0,
      huAvailable:0, huDeclined:0, teacherPeng:0, missedTeacherPeng:0, teacherPass:0, disagreedTeacherPass:0};
    for (let hand = 0; hand < hands; hand++) {
      const env = new MahjongEnvironment({seed:deriveSeed('diagnostics-only', seed, hand), record:false});
      let steps = 0;
      while (!env.done) {
        if (++steps > 500) throw Error('Diagnostic action budget exceeded');
        const o = env.observation(), legal = env.legalActions(), teacher = h0(o, legal);
        const chosen = arm === 'raw' ? chooseModelAction(loaded.model, o, legal, null, {deterministic:true}).action : scorerChoice(loaded.model, o, legal, null, true).action;
        if (legal.length > 1) { stats.choices++; stats.matches += Number(actionId(chosen) === actionId(teacher)); }
        if (legal.some(a => a.type === 'hu')) { stats.huAvailable++; stats.huDeclined += Number(chosen.type !== 'hu'); }
        if (teacher.type === 'peng') { stats.teacherPeng++; stats.missedTeacherPeng += Number(chosen.type !== 'peng'); }
        if (teacher.type === 'pass') { stats.teacherPass++; stats.disagreedTeacherPass += Number(chosen.type !== 'pass'); }
        const p = o.players[o.seat], tiles = [...new Set(legal.filter(a => a.type === 'discard').map(a => a.tile))];
        if (chosen.type === 'discard' && !p.liang && tiles.length > 1) {
          const after = tile => { const h = [...p.hand]; h.splice(h.indexOf(tile), 1); return distance(h, p.melds); };
          stats.freeDiscards++;
          stats.higherDistanceDiscards += Number(after(chosen.tile) > Math.min(...tiles.map(after)));
        }
        env.step(driver === 'H0' ? teacher : chosen);
      }
      if ((hand + 1) % 40 === 0) onProgress?.({arm, driver, hand:hand + 1, hands});
      await new Promise(resolve => setImmediate(resolve));
    }
    stats.choiceAgreement = stats.choices ? stats.matches / stats.choices : null;
    stats.higherDistanceRate = stats.freeDiscards ? stats.higherDistanceDiscards / stats.freeDiscards : null;
    distributions[driver] = stats;
  }
  if (JSON.stringify(scorerSources()) !== JSON.stringify(sources) || sha256(readFileSync(path)) !== loaded.sha256) throw Error('Diagnostic sources/model changed');
  return {model:{path:resolve(path), sha256:loaded.sha256, arm}, handsPerDistribution:hands, seed, distributions, sourceHashes:sources,
    diagnosticSourceHash:sha256(readFileSync(fileURLToPath(import.meta.url))),
    note:'Post-selection diagnostics only. Teacher disagreement and higher shanten are not necessarily mistakes. Own-state distributions differ between models; H0-driven distributions share identical states.'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--study') throw Error('Use --study COMPLETE_STUDY_DIRECTORY');
  const folder = resolve(args[1]), summary = JSON.parse(readFileSync(resolve(folder, 'summary.json'))), out = resolve(folder, 'action-diagnostics.json');
  if (summary.status !== 'complete' || existsSync(out)) throw Error('Requires complete study and new diagnostic output');
  const reports = {};
  for (const arm of ['raw', 'structured']) reports[arm] = await diagnose({path:summary.selected[arm].path, arm, onProgress:p => console.log(JSON.stringify(p))});
  writeAtomicJson(out, reports, {overwrite:false}); console.log(JSON.stringify({complete:true, out}));
}
