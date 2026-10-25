import {writeFileSync, existsSync} from 'node:fs';
import {runEvaluation} from '../runner.mjs';
import {netScoreFactory} from './policy.mjs';

// Throughput/coverage only; scores are deliberately not used to tune the study.
const out = process.argv[2];
if (!out || existsSync(out)) throw Error('Provide a new output file');
let searches = 0, changed = 0, simulations = 0, simulationDecisions = 0;
const id = 'net-score-probe';
const report = await runEvaluation({candidate:id, incumbent:'H0', seed:'kwx-net-score-cost-probe-1',
  independentGroups:4, sessionGroups:0, bootstrapSamples:50,
  policyFactories:{[id]:netScoreFactory({}, r => {
    if (!r.searched) return;
    searches++; changed += Number(r.comparison.chooseAlternative); simulations += r.worlds.length * 2;
    simulationDecisions += r.worlds.reduce((s, w) => s + w.baseline.decisions + w.alternative.decisions, 0);
  })}});
const summary = {purpose:'Cost and search-coverage probe, excluded from strength selection and training',
  games:report.totalGames, seconds:report.seconds, searches, changed, simulations, simulationDecisions, latency:report.latency};
writeFileSync(out, JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary));
