import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {loadScorer} from './io.mjs';
import {trainingSources, TRAINING_VERSION} from './train.mjs';
import {replayEpisode} from '../environment.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';
import {sha256, projectRoot, verifyFrozenBaseline} from '../provenance.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--run' || args[2] !== '--out') throw Error('Use --run RL_STUDY --out NEW_JSON');
const run = resolve(args[1]), out = resolve(args[3]), read = name => JSON.parse(readFileSync(resolve(run, name), 'utf8'));
const summary = read('summary.json'), manifest = read('manifest.json'), frozen = read('selection-frozen.json');
if (summary.status !== 'complete' || manifest.sealedSeedCommitment !== sha256(read('sealed-seed.json').seed) ||
  frozen.selected.sha256 !== summary.selection.selected.sha256) throw Error('Incomplete or inconsistent study');
for (const [file, hash] of Object.entries(summary.sourceHashes))
  if (sha256(readFileSync(resolve(projectRoot, file))) !== hash) throw Error(`Source mismatch: ${file}`);
const currentTrainingSources = trainingSources(), models = [];
for (const training of summary.trainings) {
  const root = resolve(run, `seed-${training.seed}`, training.arm);
  const events = readFileSync(resolve(root, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const saved = events.filter(e => e.phase === 'iteration-complete');
  if (saved.length !== summary.config.iterations) throw Error('Missing training iterations');
  for (const event of saved) {
    const c = loadScorer(event.checkpoint.path), state = c.checkpoint.metadata.training;
    if (c.sha256 !== event.checkpoint.sha256 || state.version !== TRAINING_VERSION || state.iteration !== event.iteration ||
      JSON.stringify(state.sourceHashes) !== JSON.stringify(currentTrainingSources) || c.checkpoint.node !== process.version ||
      state.history.length !== state.iteration || state.counters.hands !== state.iteration * state.config.handsPerIteration)
      throw Error('Checkpoint provenance/state mismatch');
    models.push({seed:training.seed, arm:training.arm, iteration:state.iteration, path:event.checkpoint.path, sha256:c.sha256});
  }
}
const replays = []; let totalReplayed = 0;
for (const name of ['sealed-vs-H0', 'sealed-vs-parent']) {
  if (!existsSync(resolve(run, name, 'report.json'))) continue;
  const report = read(`${name}/report.json`), bytes = readFileSync(resolve(run, name, 'replays.jsonl.gz'));
  if (report.manifest.seed !== read('sealed-seed.json').seed || report.manifest.candidate.sha256 !== frozen.selected.sha256 ||
    Date.parse(report.manifest.startedAt) < Date.parse(frozen.frozenAt) || sha256(bytes) !== report.replaySha256) throw Error('Sealed test provenance mismatch');
  const lines = gunzipSync(bytes).toString('utf8').trim().split('\n');
  if (lines.length !== report.totalGames) throw Error('Replay count mismatch');
  for (let i = 0; i < lines.length; i++) {
    replayEpisode(JSON.parse(lines[i]).replay);
    if ((i + 1) % 400 === 0) console.log(JSON.stringify({phase:'replay', name, completed:i + 1, total:lines.length}));
  }
  totalReplayed += lines.length; replays.push({name, count:lines.length, sha256:sha256(bytes)});
}
const parent = loadScorer(manifest.parent.path);
if (parent.sha256 !== manifest.parent.sha256) throw Error('Parent changed');
const result = {verifiedAt:new Date().toISOString(), baseline:verifyFrozenBaseline().id, sourceHashes:summary.sourceHashes,
  modelSnapshots:models, totalReplayed, replays, parent:{path:manifest.parent.path, sha256:parent.sha256},
  selectionAndSealedSeedVerified:true};
writeAtomicJson(out, result, {overwrite:false}); console.log(JSON.stringify({complete:true, modelSnapshots:models.length, totalReplayed, out}));
