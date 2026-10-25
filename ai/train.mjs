import {readFileSync} from 'node:fs';
import {runTraining} from './training/trainer.mjs';

const args = process.argv.slice(2), options = {};
if (args.includes('--help')) {
  console.log('node ai/train.mjs --out NEW_DIRECTORY [--config JSON] [--iterations 8] [--resume CHECKPOINT | --initialize-from CHECKPOINT]');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].slice(2);
  if (!args[i].startsWith('--') || !['out', 'config', 'iterations', 'resume', 'initialize-from'].includes(key) || args[i + 1] === undefined || Object.hasOwn(options, key))
    throw Error(`Invalid training option: ${args[i]}`);
  options[key] = args[i + 1];
}
if (!options.out) throw Error('--out must name a new/empty output directory');
const config = options.config ? JSON.parse(readFileSync(options.config, 'utf8')) : {};
let lastProgress = 0;
const summary = await runTraining({out:options.out, config, iterations:Number(options.iterations ?? 8), resume:options.resume,
  initializeFrom:options['initialize-from'],
  onProgress:event => {
    const now = Date.now();
    if (event.phase.endsWith('complete') || now - lastProgress > 5000 || event.phase === 'evaluation') {
      console.log(JSON.stringify(event)); lastProgress = now;
    }
  }});
console.log(JSON.stringify({status:summary.status, iteration:summary.iteration, counters:summary.counters,
  finalCheckpoint:summary.finalCheckpoint, elapsedSeconds:summary.elapsedSeconds, changedParameters:summary.changedParameters}));
