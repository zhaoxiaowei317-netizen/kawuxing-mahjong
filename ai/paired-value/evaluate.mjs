import {mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {runEvaluation} from '../runner.mjs';
import {replayEpisode, actionKey} from '../environment.mjs';
import {sha256} from '../provenance.mjs';
import {proposalOnceFactory} from '../public-rollout/policy.mjs';
import {learnedGainFactory} from './policy.mjs';
import {loadGain, inferenceSources} from './io.mjs';
import {GATE_CONFIG} from './features.mjs';

export async function evaluateGain({out, candidate, checkpoint, incumbent = 'H0', seed, split,
  independentGroups, sessionGroups, sessionHands = 16, bootstrapSamples = 5000, onProgress}) {
  const loaded = loadGain(checkpoint), sources = inferenceSources();
  out = resolve(out); if (existsSync(out)) throw Error('Evaluation output exists'); mkdirSync(out, {recursive:true});
  if (!['H0', 'proposal-once'].includes(incumbent)) throw Error('Unsupported control');
  const replayPath = resolve(out, 'replays.jsonl.gz'), tracePath = resolve(out, 'decisions.jsonl.gz');
  writeFileSync(replayPath, gzipSync('')); writeFileSync(tracePath, gzipSync(''));
  const counts = {proposals:0, accepted:0}, pending = [];
  let games = 0;
  const policyFactories = {[candidate]:learnedGainFactory(loaded.model, (analysis, observation, legal) => {
    counts.proposals++; counts.accepted += Number(actionKey(analysis.action) === actionKey(analysis.root.alternative));
    pending.push({analysis, observation, legal});
  })};
  if (incumbent === 'proposal-once') policyFactories[incumbent] = proposalOnceFactory(GATE_CONFIG);
  const r = await runEvaluation({candidate, incumbent, seed, split, independentGroups, sessionGroups, sessionHands,
    bootstrapSamples, policyFactories, validate:true, onProgress, onEpisode:e => {
      if (pending.length > 1) throw Error('Per-hand proposal quota violated');
      for (const t of pending) appendFileSync(tracePath, gzipSync(JSON.stringify({suite:e.suite,
        opponentPair:e.opponentPair, group:e.group, permutation:e.permutation, arm:e.arm, hand:e.hand, ...t}) + '\n'));
      pending.length = 0;
      replayEpisode(e.replay); // Every actual evaluation game is replayed, not just a sample.
      appendFileSync(replayPath, gzipSync(JSON.stringify(e) + '\n')); games++;
    }});
  if (JSON.stringify(inferenceSources()) !== JSON.stringify(sources) || loadGain(checkpoint).sha256 !== loaded.sha256) throw Error('Evaluation source/model changed');
  Object.assign(r, {checkpoint:resolve(checkpoint), checkpointSha256:loaded.sha256, sourceHashes:sources, counts,
    artifacts:{replays:{sha256:sha256(readFileSync(replayPath)), games, replayed:games},
      decisions:{sha256:sha256(readFileSync(tracePath)), rows:counts.proposals}}});
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(r, null, 2) + '\n'); return r;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const spec=JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'));
  evaluateGain({...spec,onProgress:p=>console.log(JSON.stringify(p))})
    .then(r=>console.log(JSON.stringify({complete:true,games:r.totalGames})))
    .catch(e=>{console.error(e);process.exitCode=1;});
}
