import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = new URL('../', import.meta.url);
export const sha256 = content => createHash('sha256').update(content).digest('hex');
export function sourceHashes() {
  const files = ['src/engine.js', 'src/wall.js', 'package.json',
    'ai/environment.mjs', 'ai/random.mjs', 'ai/runner.mjs', 'ai/statistics.mjs',
    'ai/policies/h0.mjs', 'ai/policies/H0.manifest.json', 'ai/policies/index.mjs', 'ai/provenance.mjs', 'ai/evaluate.mjs',
    'ai/training/encoding.mjs', 'ai/training/network.mjs', 'ai/training/policy.mjs', 'ai/training/checkpoint.mjs'];
  return Object.fromEntries(files.map(path => [path, sha256(readFileSync(new URL(path, root)))]));
}
export function verifyFrozenBaseline() {
  const manifest = JSON.parse(readFileSync(new URL('ai/policies/H0.manifest.json', root), 'utf8'));
  for (const [path, expected] of Object.entries(manifest.sha256)) {
    if (sha256(readFileSync(new URL(path, root))) !== expected)
      throw Error(`Frozen H0 source changed: ${path}. Register a new baseline/rules version first.`);
  }
  for (const [name, expected] of Object.entries(manifest.dependencies)) {
    const actual = JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, root), 'utf8')).version;
    if (actual !== expected) throw Error(`Frozen dependency changed: ${name} ${actual} != ${expected}`);
  }
  return manifest;
}
export const projectRoot = fileURLToPath(root);
