import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {loadScorer} from './io.mjs';
import {FEATURE_SIZE} from './features.mjs';
import {replayEpisode} from '../environment.mjs';
import {writeAtomicJson} from '../training/checkpoint.mjs';
import {sha256, projectRoot, verifyFrozenBaseline} from '../provenance.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--run' || args[2] !== '--out') throw Error('Use --run COMPLETE_STUDY --out NEW_JSON');
const run = resolve(args[1]), out = resolve(args[3]), read = name => JSON.parse(readFileSync(resolve(run, name), 'utf8'));
const s = read('summary.json'), m = read('manifest.json'), frozen = read('selection-frozen.json');
if (s.status !== 'complete' || sha256(read('sealed-seed.json').seed) !== m.sealedSeedCommitment ||
  frozen.selected.sha256 !== s.selection.selected.sha256) throw Error('Study consistency failed');
for (const [file, hash] of Object.entries(s.sourceHashes)) if (sha256(readFileSync(resolve(projectRoot, file))) !== hash) throw Error(`Source changed: ${file}`);
if (sha256(readFileSync(resolve(m.referenceStudy, 'summary.json'))) !== m.referenceSummarySha256) throw Error('Reference summary changed');
const models = [];
for (const b of m.baselines) {
  const c = loadScorer(b.path);
  if (c.sha256 !== b.sha256) throw Error('Reference endpoint changed');
  models.push({arm:b.arm, seed:b.seed, reused:true, path:b.path, sha256:c.sha256});
}
for (const t of s.trainings) {
  const root = resolve(run, `seed-${t.seed}`, t.arm);
  const events = readFileSync(resolve(root, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const saved = events.filter(e => t.arm === 'bc-only' || e.phase === 'iteration-complete');
  if (saved.length !== t.counters.hands / t.trainingConfig.handsPerIteration) throw Error('Missing saved iterations');
  for (const [index, e] of saved.entries()) {
    const row = e.checkpoint, c = loadScorer(row.path), state = c.checkpoint.metadata.bcOnlyTraining || c.checkpoint.metadata.training;
    if (c.sha256 !== row.sha256 || state.iteration !== e.iteration || state.iteration !== index + 1 || state.counters.hands !== state.iteration * state.config.handsPerIteration ||
      state.history.length !== state.iteration || c.checkpoint.node !== process.version) throw Error('Training checkpoint mismatch');
    const parent = loadScorer(m.parent.path);
    if (t.arm === 'bc-only' && Array.from(c.model.parameters.slice(FEATURE_SIZE)).some((x, i) => x !== parent.model.parameters[FEATURE_SIZE + i])) throw Error('BC changed critic');
    models.push({arm:t.arm, seed:t.seed, iteration:e.iteration, path:row.path, sha256:c.sha256});
  }
}
const replays = []; let totalReplayed = 0;
for (const name of ['sealed-vs-H0', 'sealed-vs-parent']) {
  if (!existsSync(resolve(run, name, 'report.json'))) continue;
  const r = read(`${name}/report.json`), bytes = readFileSync(resolve(run, name, 'replays.jsonl.gz'));
  if (sha256(bytes) !== r.replaySha256 || r.manifest.candidate.sha256 !== frozen.selected.sha256 ||
    r.manifest.seed !== read('sealed-seed.json').seed || Date.parse(r.manifest.startedAt) < Date.parse(frozen.frozenAt)) throw Error('Sealed provenance failed');
  const lines = gunzipSync(bytes).toString('utf8').trim().split('\n');
  if (lines.length !== r.totalGames) throw Error('Replay count failed');
  for (let i = 0; i < lines.length; i++) {
    replayEpisode(JSON.parse(lines[i]).replay);
    if ((i + 1) % 400 === 0) console.log(JSON.stringify({phase:'replay', name, completed:i + 1, total:lines.length}));
  }
  totalReplayed += lines.length; replays.push({name, count:lines.length, sha256:sha256(bytes)});
}
writeAtomicJson(out, {verifiedAt:new Date().toISOString(), baseline:verifyFrozenBaseline().id,
  modelSnapshots:models, totalReplayed, replays, sourceHashes:s.sourceHashes, selectionAndSeedVerified:true}, {overwrite:false});
console.log(JSON.stringify({complete:true, modelSnapshots:models.length, totalReplayed, out}));
