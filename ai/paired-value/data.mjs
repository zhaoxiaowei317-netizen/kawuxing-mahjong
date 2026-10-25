import {mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {MahjongEnvironment} from '../environment.mjs';
import {policyById} from '../policies/index.mjs';
import {deriveSeed} from '../random.mjs';
import {sha256} from '../provenance.mjs';
import {simulateToEnd} from '../public-rollout/policy.mjs';
import {describeRoot} from './features.mjs';
import {inferenceSources} from './io.mjs';

export const DATA_VERSION = 'kwx-paired-realized-training-1';
export function dataSources() {
  return {...inferenceSources(), ...Object.fromEntries(['data.mjs','collect.mjs'].map(p =>
    [`ai/paired-value/${p}`,sha256(readFileSync(new URL(p,import.meta.url)))]))};
}
export async function collectData({out, hands, seed, split = 'training', startHand = 0, onProgress = () => {}}) {
  if (!['training', 'validation'].includes(split)) throw Error('Only fresh training or validation splits allowed');
  if (!Number.isInteger(hands) || hands < 1 || typeof seed !== 'string' || !seed) throw Error('Invalid collection config');
  if (!Number.isInteger(startHand) || startHand < 0) throw Error('Invalid start hand');
  const sources = dataSources();
  out = resolve(out); if (existsSync(out)) throw Error('Dataset exists'); mkdirSync(out, {recursive:true});
  const path = resolve(out, 'rows.jsonl.gz'); writeFileSync(path, gzipSync(''));
  let roots = 0, counterfactualBranches = 0, nonzeroLabels = 0, gainSum = 0;
  for (let localHand = 0; localHand < hands; localHand++) {
    const hand = startHand + localHand;
    const environmentSeed = deriveSeed(DATA_VERSION, split, seed, hand), seat = hand % 3;
    const mixed = Math.floor(hand / 3) % 2 === 1;
    const others = [0, 1, 2].filter(i => i !== seat), opponentIds = mixed
      ? (Math.floor(hand / 6) % 2 ? ['greedy-speed-v1', 'H0'] : ['H0', 'greedy-speed-v1']) : ['H0', 'H0'];
    const ids = [0, 1, 2].map(i => i === seat ? 'H0' : opponentIds[others.indexOf(i)]), policies = ids.map(policyById);
    const env = new MahjongEnvironment({seed:environmentSeed, record:false}), prefix = [];
    let steps = 0;
    while (!env.done) {
      if (++steps > 500) throw Error('Data episode action limit');
      const actor = env.actor, o = env.observation(), legal = env.legalActions();
      if (actor === seat) {
        const root = describeRoot(o, legal);
        if (root.proposed) {
          // Privileged state is used ONLY to create offline terminal-score labels.
          // Neither it nor hidden tiles are passed into describeRoot or the model.
          const world = env.auditState();
          const baseline = simulateToEnd(world, root.baseline, seat, {opponentIds});
          const alternative = simulateToEnd(world, root.alternative, seat, {opponentIds});
          const gain = (alternative.score - baseline.score) / o.config.base;
          const row = {hand, environmentSeed, seat, opponentIds, prefix, observation:o, legal,
            baseline:root.baseline, alternative:root.alternative, features:root.features, gain,
            terminal:{baseline, alternative}};
          appendFileSync(path, gzipSync(JSON.stringify(row) + '\n'));
          roots++; counterfactualBranches += 2; nonzeroLabels += Number(gain !== 0); gainSum += gain;
          break; // Baseline branch has completed this deal; no duplicate continuation.
        }
      }
      const action = policies[actor](o, legal); prefix.push({seat:actor, action}); env.step(action);
    }
    if ((localHand + 1) % 100 === 0 || localHand + 1 === hands) {
      onProgress({split, startHand, hands:localHand + 1, totalHands:hands, roots, nonzeroLabels});
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  if (JSON.stringify(dataSources()) !== JSON.stringify(sources)) throw Error('Collection sources changed');
  const manifest = {version:DATA_VERSION, split, seed, startHand, hands, roots, counterfactualBranches, nonzeroLabels, gainSum, sources,
    rowsSha256:sha256(readFileSync(path)), label:'Actual-world paired terminal net gain, alternative minus H0, in base units',
    inference:'Public features only; private state never stored as a model input'};
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); return manifest;
}
export function loadData(out, expectedSplit) {
  const manifest = JSON.parse(readFileSync(resolve(out, 'manifest.json'), 'utf8'));
  if (manifest.version !== DATA_VERSION || manifest.split !== expectedSplit || !['training', 'validation'].includes(expectedSplit)) throw Error('Dataset split/version differs');
  if (JSON.stringify(manifest.sources) !== JSON.stringify(dataSources())) throw Error('Dataset source mismatch');
  const bytes = readFileSync(resolve(out, 'rows.jsonl.gz'));
  if (sha256(bytes) !== manifest.rowsSha256) throw Error('Dataset bytes differ');
  const rows = gunzipSync(bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  if (rows.length !== manifest.roots) throw Error('Dataset count differs');
  return {manifest, rows};
}
export function mergeData({out, parts, split}) {
  const datasets=parts.map(p=>({path:p,...loadData(p,split)})).sort((a,b)=>a.manifest.startHand-b.manifest.startHand);
  if (!datasets.length) throw Error('No shards');
  const m={...datasets[0].manifest,startHand:0,hands:0,roots:0,counterfactualBranches:0,nonzeroLabels:0,gainSum:0};
  const bytes=[];
  for (const d of datasets) {
    if (d.manifest.startHand !== m.hands || d.manifest.seed !== m.seed) throw Error('Shard overlap/gap/seed mismatch');
    if (d.rows.some(r=>r.hand<d.manifest.startHand || r.hand>=d.manifest.startHand+d.manifest.hands)) throw Error('Row outside shard');
    for (const k of ['hands','roots','counterfactualBranches','nonzeroLabels','gainSum']) m[k]+=d.manifest[k];
    bytes.push(readFileSync(resolve(d.path,'rows.jsonl.gz')));
  }
  out=resolve(out);if(existsSync(out))throw Error('Merged output exists');mkdirSync(out,{recursive:true});
  const all=Buffer.concat(bytes);m.rowsSha256=sha256(all);m.shards=parts.length;
  writeFileSync(resolve(out,'rows.jsonl.gz'),all);writeFileSync(resolve(out,'manifest.json'),JSON.stringify(m,null,2)+'\n');return m;
}
