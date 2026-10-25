import {mkdirSync, readdirSync, existsSync, readFileSync, appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {loadScorer, scorerFactory, scorerSources} from './io.mjs';
import {loadCheckpoint, writeAtomicJson} from '../training/checkpoint.mjs';
import {modelPolicyFactory} from '../training/policy.mjs';
import {runEvaluation} from '../runner.mjs';
import {replayEpisode} from '../environment.mjs';
import {sha256} from '../provenance.mjs';

export async function evaluateScorer({model, incumbent=null, incumbentKind='raw', out,
  seed=randomBytes(32).toString('hex'), split='sealed', independentGroups=32, sessionGroups=8,
  sessionHands=16, bootstrapSamples=2000, onProgress=null}) {
  if (!['raw', 'structured'].includes(incumbentKind) || !['development', 'sealed'].includes(split) || typeof seed !== 'string' || !seed.length)
    throw Error('Invalid evaluation protocol');
  for (const n of [independentGroups, sessionGroups, sessionHands, bootstrapSamples])
    if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid evaluation budget');
  const folder = resolve(out);
  if (existsSync(folder) && readdirSync(folder).length) throw Error('Evaluation requires a new empty directory');
  const candidate = loadScorer(model), other = incumbent ? incumbentKind === 'raw' ? loadCheckpoint(incumbent) : loadScorer(incumbent) : null;
  const candidateId = `model-${candidate.sha256.slice(0, 12)}`, incumbentId = other ? `model-${other.sha256.slice(0, 12)}` : 'H0';
  const factories = {[candidateId]:scorerFactory(candidate.model)};
  if (other) factories[incumbentId] = incumbentKind === 'raw' ? modelPolicyFactory(other.model) : scorerFactory(other.model);
  const sources = scorerSources(), evaluatorHash = sha256(readFileSync(fileURLToPath(import.meta.url)));
  mkdirSync(folder, {recursive:true});
  const manifest = {format:'kwx-action-scorer-evaluation-1', seed, split, independentGroups, sessionGroups,
    sessionHands, bootstrapSamples, sourceHashes:sources, evaluatorHash, startedAt:new Date().toISOString(),
    candidate:{path:resolve(model), sha256:candidate.sha256},
    incumbent:other ? {path:resolve(incumbent), sha256:other.sha256, kind:incumbentKind} : {id:'H0'},
    interpretation:'Fixed-model paired evaluation; group bootstrap, no selection on these games. No automatic deployment.'};
  writeAtomicJson(resolve(folder, 'manifest.json'), manifest, {overwrite:false});
  let replayed = 0, recorded = 0;
  const report = await runEvaluation({candidate:candidateId, incumbent:incumbentId, policyFactories:factories,
    seed, split, independentGroups, sessionGroups, sessionHands, bootstrapSamples,
    onProgress:p => { writeAtomicJson(resolve(folder, 'status.json'), p); onProgress?.(p); },
    onEpisode:e => {
      // Concatenated gzip members allow a durable append after every completed game.
      appendFileSync(resolve(folder, 'replays.jsonl.gz'), gzipSync(JSON.stringify(e) + '\n')); recorded++;
      if (e.group === 0 && e.hand === 0) { replayEpisode(e.replay); replayed++; }
    }});
  if (JSON.stringify(scorerSources()) !== JSON.stringify(sources) || sha256(readFileSync(fileURLToPath(import.meta.url))) !== evaluatorHash ||
    sha256(readFileSync(model)) !== candidate.sha256 || other && sha256(readFileSync(incumbent)) !== other.sha256)
    throw Error('Evaluation sources or models changed');
  const result = {...report, manifest, recorded, replayed,
    replaySha256:sha256(readFileSync(resolve(folder, 'replays.jsonl.gz')))};
  writeAtomicJson(resolve(folder, 'report.json'), result, {overwrite:false});
  writeAtomicJson(resolve(folder, 'status.json'), {phase:'complete', totalGames:result.totalGames}); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--model', '--incumbent', '--incumbent-kind', '--out', '--seed', '--split', '--groups', '--session-groups'].includes(args[i]) || !args[i + 1] || options[args[i]])
      throw Error('Use --model FILE --out NEW_DIRECTORY [--incumbent FILE --incumbent-kind raw|structured --seed STRING --split sealed|development --groups 32 --session-groups 8]');
    options[args[i]] = args[i + 1];
  }
  if (!options['--model'] || !options['--out']) throw Error('--model and --out required');
  await evaluateScorer({model:options['--model'], out:options['--out'], incumbent:options['--incumbent'] || null,
    incumbentKind:options['--incumbent-kind'] || 'raw', split:options['--split'] || 'sealed',
    ...(options['--seed'] ? {seed:options['--seed']} : {}),
    independentGroups:Number(options['--groups'] || 32), sessionGroups:Number(options['--session-groups'] || 8),
    onProgress:p => console.log(JSON.stringify(p))});
}
