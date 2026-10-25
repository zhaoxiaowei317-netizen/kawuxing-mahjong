import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {replayEpisode} from '../environment.mjs';
import {loadCheckpoint, writeAtomicJson} from '../training/checkpoint.mjs';
import {loadScorer} from './io.mjs';
import {sha256, projectRoot, verifyFrozenBaseline} from '../provenance.mjs';

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--study' || args[2] !== '--supplement' || args[4] !== '--out')
  throw Error('Use --study STUDY --supplement EVALUATION --out NEW_JSON');
const study = resolve(args[1]), supplement = resolve(args[3]), out = resolve(args[5]);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const summary = read(resolve(study, 'summary.json')), evaluated = read(resolve(supplement, 'report.json'));
if (summary.status !== 'complete') throw Error('Study incomplete');
if (sha256(readFileSync(resolve(projectRoot, 'ai/action-scorer/evaluate.mjs'))) !== evaluated.manifest.evaluatorHash)
  throw Error('Supplement evaluator changed');
const selection = read(resolve(study, 'selection-frozen.json')), plan = read(resolve(supplement, 'preregistered-plan.json'));
if (evaluated.manifest.candidate.sha256 !== summary.selected.structured.sha256 ||
  plan.selectionSha256 !== sha256(readFileSync(resolve(study, 'selection-frozen.json'))) ||
  evaluated.manifest.seed !== plan.seed || sha256(plan.seed) !== plan.seedCommitment ||
  evaluated.manifest.incumbent.sha256 !== plan.incumbentSha256 ||
  sha256(readFileSync(evaluated.manifest.incumbent.path)) !== plan.incumbentSha256 ||
  plan.seed === readFileSync(resolve(study, 'sealed-seed.txt'), 'utf8').trim() ||
  Date.parse(plan.createdAt) >= Date.parse(selection.frozenAt) ||
  Date.parse(selection.frozenAt) > Date.parse(evaluated.manifest.startedAt)) throw Error('Supplement preregistration or frozen selection mismatch');
const diagnostics = read(resolve(study, 'action-diagnostics.json'));
for (const arm of ['raw', 'structured']) if (diagnostics[arm].model.sha256 !== summary.selected[arm].sha256)
  throw Error('Diagnostic model differs from selected model');
for (const [file, hash] of Object.entries(summary.sourceHashes))
  if (sha256(readFileSync(resolve(projectRoot, file))) !== hash) throw Error(`Study source changed: ${file}`);
const models = [];
for (let seed = 0; seed < summary.config.seeds; seed++) for (const arm of ['raw', 'structured']) {
  const history = read(resolve(study, `seed-${seed}`, `${arm}-history.json`));
  for (const row of history) {
    const loaded = arm === 'raw' ? loadCheckpoint(row.path) : loadScorer(row.path);
    if (loaded.sha256 !== row.sha256) throw Error('Saved checkpoint hash mismatch');
    models.push({seed, arm, epoch:row.epoch, path:row.path, sha256:loaded.sha256});
  }
}
const replayFiles = []; let studyReplayed = 0;
for (const name of readdirSync(study).filter(name => name.endsWith('-replays.jsonl'))) {
  const bytes = readFileSync(resolve(study, name));
  const episodes = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const e of episodes) replayEpisode(e.replay);
  studyReplayed += episodes.length; replayFiles.push({name, count:episodes.length, sha256:sha256(bytes)});
}
if (studyReplayed !== summary.replayed) throw Error('Study replay count mismatch');
const replayBytes = readFileSync(resolve(supplement, 'replays.jsonl.gz'));
if (sha256(replayBytes) !== evaluated.replaySha256) throw Error('Supplement replay hash mismatch');
const episodes = gunzipSync(replayBytes).toString('utf8').trim().split('\n');
if (episodes.length !== evaluated.totalGames || episodes.length !== evaluated.recorded) throw Error('Supplement replay count mismatch');
const fullReplayProofPath = resolve(supplement, 'full-replay-verification.json');
const priorReplayProof = existsSync(fullReplayProofPath) ? read(fullReplayProofPath) : null;
if (priorReplayProof) {
  // Reuse this run's completed audit only while the complete compressed replay bytes remain identical.
  if (priorReplayProof.complete !== true || priorReplayProof.replayed !== episodes.length ||
    priorReplayProof.sha256 !== sha256(replayBytes) || !Number.isFinite(Date.parse(priorReplayProof.verifiedAt)) ||
    Date.parse(priorReplayProof.verifiedAt) < Date.parse(evaluated.manifest.startedAt)) throw Error('Prior full-replay audit mismatch');
} else {
  for (let i = 0; i < episodes.length; i++) {
    replayEpisode(JSON.parse(episodes[i]).replay);
    if ((i + 1) % 200 === 0) console.log(JSON.stringify({phase:'replay', completed:i + 1, total:episodes.length}));
  }
}
const oldResumePath = resolve(projectRoot, 'ai-runs/refined-ppo-20261017/training/checkpoints/iteration-00012.json');
const old = loadCheckpoint(oldResumePath, {forResume:true});
const result = {verifiedAt:new Date().toISOString(), baseline:verifyFrozenBaseline().id,
  preregistrationAndSelectionVerified:true,
  sourceHashes:summary.sourceHashes, modelSnapshots:models, studyReplayed, replayFiles,
  supplement:{path:supplement, replayed:episodes.length, sha256:sha256(replayBytes),
    reusedCompletedAudit:!!priorReplayProof, auditSha256:priorReplayProof ? sha256(readFileSync(fullReplayProofPath)) : null},
  priorExactResume:{path:oldResumePath, sha256:old.sha256, compatible:true},
  totalReplayed:studyReplayed + episodes.length};
writeAtomicJson(out, result, {overwrite:false}); console.log(JSON.stringify({complete:true, totalReplayed:result.totalReplayed, out}));
