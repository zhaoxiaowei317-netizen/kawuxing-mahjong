import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {availableParallelism, cpus, totalmem, platform, release, arch} from 'node:os';
import {readFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runEvaluation, PROTOCOL_VERSION, DEFAULT_OPPONENT_PAIRS} from './runner.mjs';
import {sha256, sourceHashes, verifyFrozenBaseline, projectRoot} from './provenance.mjs';

export const BENCHMARK_VERSION = 'kwx-throughput-v1';
const CONCURRENCIES = Object.freeze([1, 2, 4]);
const JOBS = Object.freeze(Array.from({length:4}, (_, index) => Object.freeze({
  id:`job${index}`, seed:`m0-throughput-job-${index}`
})));
const OPTIONS = Object.freeze({candidate:'H0', incumbent:'H0', split:'development',
  independentGroups:1, sessionGroups:0, bootstrapSamples:20, validate:true});
const RSS_INTERVAL_MS = 25;

function hashes() {
  return {...sourceHashes(),
    'ai/benchmark.mjs':sha256(readFileSync(new URL('./benchmark.mjs', import.meta.url))),
    'ai/policies/H0.manifest.json':sha256(readFileSync(new URL('./policies/H0.manifest.json', import.meta.url)))};
}
function sameHashes(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(`Source hashes changed ${label}; discard this throughput run and rerun after sources are stable.`);
}
function semanticResult(result) {
  // Timing, wall-clock IDs and resource usage must not affect the same seeded games.
  return {protocolVersion:result.protocolVersion, seed:result.seed, candidate:result.candidate,
    incumbent:result.incumbent, opponentPairs:result.opponentPairs, totalGames:result.totalGames,
    totalDecisions:result.totalDecisions, illegalActions:result.illegalActions,
    records:result.records, statistics:result.statistics};
}
async function workerLoop() {
  const started = performance.now();
  const diagnostics = {workerId:workerData.workerId, jobs:[], ownJobSeconds:0};
  let busy = false;
  sameHashes(hashes(), workerData.hashes, 'at worker startup');
  verifyFrozenBaseline();
  parentPort.on('message', async message => {
    if (message.type === 'stop') {
      if (busy) throw Error('Cannot stop a busy benchmark worker');
      parentPort.postMessage({type:'stopped', diagnostics:{...diagnostics,
        ownLifetimeSeconds:(performance.now() - started) / 1000, sourceHashesEnd:hashes()}});
      parentPort.close();
      return;
    }
    if (message.type !== 'job' || busy) throw Error('Invalid benchmark worker dispatch');
    busy = true;
    try {
      const jobStarted = performance.now(), before = hashes();
      sameHashes(before, workerData.hashes, `before ${message.job.id}`);
      const result = await runEvaluation({...OPTIONS, seed:message.job.seed});
      const after = hashes();
      sameHashes(after, before, `during ${message.job.id}`);
      if (result.protocolVersion !== PROTOCOL_VERSION || result.totalGames !== 24 || result.illegalActions !== 0)
        throw Error('Benchmark job did not complete the expected 24 legal games');
      const seconds = (performance.now() - jobStarted) / 1000;
      diagnostics.jobs.push(message.job.id);
      diagnostics.ownJobSeconds += seconds;
      busy = false;
      parentPort.postMessage({type:'result', job:{...message.job, workerId:workerData.workerId,
        wallSeconds:seconds, evaluationSeconds:result.seconds, totalGames:result.totalGames,
        totalDecisions:result.totalDecisions, illegalActions:result.illegalActions,
        outcomeSha256:sha256(JSON.stringify(semanticResult(result))),
        sourceHashesStart:before, sourceHashesEnd:after}});
    } catch (error) {
      parentPort.postMessage({type:'failure', error:error.stack || String(error)});
      parentPort.close();
      process.exitCode = 1;
    }
  });
  parentPort.postMessage({type:'ready'});
}

async function runPool(concurrency, frozenHashes, onProgress) {
  const started = performance.now(), cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const lifetimePeakRssStart = process.resourceUsage().maxRSS * 1024;
  let sampledPeakRss = rssStart, nextJob = 0, settled = false;
  const jobs = [], diagnostics = [], threads = [];
  const timer = setInterval(() => { sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss); }, RSS_INTERVAL_MS);
  try {
    await new Promise((resolvePool, rejectPool) => {
      let exited = 0;
      const fail = error => {
        if (settled) return;
        settled = true;
        rejectPool(error);
      };
      const dispatch = worker => {
        if (nextJob < JOBS.length) worker.postMessage({type:'job', job:JOBS[nextJob++]});
        else worker.postMessage({type:'stop'});
      };
      for (let id = 0; id < concurrency; id++) {
        const launched = performance.now();
        const worker = new Worker(new URL(import.meta.url), {workerData:{benchmark:BENCHMARK_VERSION,
          workerId:id, hashes:frozenHashes}});
        const workerDiagnostic = {workerId:id, readySecondsAfterLaunch:null};
        threads.push(worker);
        worker.on('message', message => {
          if (settled) return;
          try {
            if (message.type === 'ready') {
              workerDiagnostic.readySecondsAfterLaunch = (performance.now() - launched) / 1000;
              dispatch(worker);
            } else if (message.type === 'result') {
              sameHashes(message.job.sourceHashesStart, frozenHashes, 'in worker result');
              sameHashes(message.job.sourceHashesEnd, frozenHashes, 'in worker result');
              jobs.push(message.job);
              onProgress?.({concurrency, job:message.job.id, completedJobs:jobs.length,
                totalJobs:JOBS.length, seconds:(performance.now() - started) / 1000});
              dispatch(worker);
            } else if (message.type === 'stopped') {
              sameHashes(message.diagnostics.sourceHashesEnd, frozenHashes, 'at worker shutdown');
              Object.assign(workerDiagnostic, message.diagnostics);
            } else if (message.type === 'failure') fail(Error(message.error));
            else fail(Error('Unknown benchmark worker response'));
          } catch (error) { fail(error); }
        });
        worker.on('error', fail);
        worker.on('exit', code => {
          if (settled) return;
          if (code !== 0 || !workerDiagnostic.jobs) {
            fail(Error(`Benchmark worker ${id} exited unexpectedly (${code})`));
            return;
          }
          workerDiagnostic.parentObservedLifetimeSeconds = (performance.now() - launched) / 1000;
          diagnostics.push(workerDiagnostic);
          if (++exited === concurrency) { settled = true; resolvePool(); }
        });
      }
    });
  } finally {
    clearInterval(timer);
    await Promise.all(threads.map(thread => thread.terminate()));
  }
  const seconds = (performance.now() - started) / 1000, cpu = process.cpuUsage(cpuStart);
  const rssEnd = process.memoryUsage().rss;
  sampledPeakRss = Math.max(sampledPeakRss, rssEnd);
  if (jobs.length !== JOBS.length) throw Error('Incomplete benchmark job set');
  jobs.sort((a, b) => a.id.localeCompare(b.id));
  const totalGames = jobs.reduce((n, job) => n + job.totalGames, 0);
  const totalDecisions = jobs.reduce((n, job) => n + job.totalDecisions, 0);
  if (totalGames !== 96) throw Error('Unexpected benchmark game count');
  return {concurrency, workerThreads:concurrency, processes:1, totalGames, totalDecisions,
    wallSeconds:seconds, secondsPerGame:seconds / totalGames, gamesPerSecond:totalGames / seconds,
    decisionsPerSecond:totalDecisions / seconds,
    summedJobWallSeconds:jobs.reduce((n, job) => n + job.wallSeconds, 0),
    summedEvaluationSeconds:jobs.reduce((n, job) => n + job.evaluationSeconds, 0),
    processCpuUserSeconds:cpu.user / 1e6, processCpuSystemSeconds:cpu.system / 1e6,
    processRssStartBytes:rssStart, processRssEndBytes:rssEnd, sampledProcessPeakRssBytes:sampledPeakRss,
    processLifetimePeakRssAtStartBytes:lifetimePeakRssStart,
    processLifetimePeakRssAtEndBytes:process.resourceUsage().maxRSS * 1024,
    rssSampleIntervalMs:RSS_INTERVAL_MS, sourceHashesEnd:hashes(),
    jobs, workers:diagnostics.sort((a, b) => a.workerId - b.workerId)};
}

export async function runThroughputBenchmark({onProgress=null} = {}) {
  const began = new Date().toISOString(), frozenHashes = hashes();
  const baseline = verifyFrozenBaseline();
  const hardware = {node:process.version, nodeVersions:process.versions, platform:platform(),
    release:release(), arch:arch(), cpuModel:cpus()[0]?.model || null,
    availableParallelism:availableParallelism(), logicalCpuCount:cpus().length,
    totalMemoryBytes:totalmem()};
  const results = [];
  for (const concurrency of CONCURRENCIES) {
    sameHashes(hashes(), frozenHashes, `before ${concurrency} workers`);
    const result = await runPool(concurrency, frozenHashes, onProgress);
    sameHashes(result.sourceHashesEnd, frozenHashes, `after ${concurrency} workers`);
    if (results.length) for (const job of result.jobs) {
      const first = results[0].jobs.find(reference => reference.id === job.id);
      if (!first || first.seed !== job.seed || first.outcomeSha256 !== job.outcomeSha256 ||
          first.totalDecisions !== job.totalDecisions)
        throw Error(`Seeded outcomes changed across worker counts for ${job.id}`);
    }
    results.push(result);
  }
  const finalHashes = hashes();
  sameHashes(finalHashes, frozenHashes, 'across the complete benchmark');
  return {benchmarkVersion:BENCHMARK_VERSION, protocolVersion:PROTOCOL_VERSION,
    startedAt:began, endedAt:new Date().toISOString(), hardware,
    configuration:{...OPTIONS, jobs:JOBS, concurrencies:CONCURRENCIES, opponentPairs:DEFAULT_OPPONENT_PAIRS,
      expectedGamesPerJob:24, expectedGamesPerConcurrency:96},
    baseline, sourceHashesStart:frozenHashes, sourceHashesEnd:finalHashes,
    sourceHashesUnchanged:true, sameSeededOutcomesAcrossConcurrencies:true, results,
    limitations:[
      'Only four independent job seeds and 96 games per concurrency; results describe this small fixed workload.',
      'Each configuration uses newly created worker threads; there is no separate warmup. First-job JIT/cache costs and later-job reuse differ.',
      'Configurations run once in fixed order 1, 2, 4. Thermal, OS scheduling, GC and background load are not controlled or randomized.',
      'Whole wall time includes worker startup/import, source checks, evaluation/statistics, dispatch and shutdown.',
      'All worker threads share one process. RSS is process-wide and must not be summed across workers.',
      'OS maxRSS is a process-lifetime high-water mark, cumulative across configurations; sampled RSS is only an approximate per-configuration peak.',
      'This is JavaScript evaluation throughput with validation enabled, not neural training or GPU throughput.'
    ]};
}

const fixed = (value, digits=3) => Number(value).toFixed(digits);
const mib = bytes => fixed(bytes / 1024 ** 2, 1);
export function renderThroughputMarkdown(report) {
  const lines = [
    '# M0 工作线程吞吐实测', '',
    `运行时间：${report.startedAt} 至 ${report.endedAt}。协议：\`${report.protocolVersion}\`；脚本：\`${report.benchmarkVersion}\`。`, '',
    `硬件：${report.hardware.cpuModel}，${report.hardware.availableParallelism} 个可用逻辑处理器，${fixed(report.hardware.totalMemoryBytes / 1024 ** 3, 1)} GiB 内存；Node ${report.hardware.node}，${report.hardware.platform}/${report.hardware.arch}。`, '',
    '每种并行度都运行同样的 4 个 job，各自使用 `m0-throughput-job-0` 至 `m0-throughput-job-3`。每 job 为 H0 对 H0、1 组独立开局、两个固定对手组合、六种座位排列，共 24 局；每种并行度合计 96 局。开启逐动作守恒校验，bootstrap 仅 20 次且不用于实力结论。', '',
    '| 工作线程 | 总局数 | 决策数 | 完整墙钟秒 | 秒/局 | 局/秒 | 决策/秒 | 采样进程 RSS 峰值 MiB | 进程累计 maxRSS MiB |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const r of report.results) lines.push(`| ${r.concurrency} | ${r.totalGames} | ${r.totalDecisions} | ${fixed(r.wallSeconds)} | ${fixed(r.secondsPerGame, 4)} | ${fixed(r.gamesPerSecond)} | ${fixed(r.decisionsPerSecond)} | ${mib(r.sampledProcessPeakRssBytes)} | ${mib(r.processLifetimePeakRssAtEndBytes)} |`);
  lines.push('', '完整墙钟时间包含线程启动、模块导入、源码核对、对局与统计、任务分派和线程回收。上表所有内存均为单进程含全部 worker_threads 的整体数值，不能按线程重复相加。`maxRSS` 是进程启动以来的累计高水位，不能当作各配置独占峰值；25 ms 采样峰值也可能漏掉短暂尖峰。', '',
    '## 各线程与固定任务', '',
    '| 并行度 | 线程 | job | 线程内 job 总秒 | 主线程观测存活秒 | 启动至就绪秒 |',
    '| --- | --- | --- | --- | --- | --- |');
  for (const r of report.results) for (const w of r.workers)
    lines.push(`| ${r.concurrency} | ${w.workerId} | ${w.jobs.join(', ')} | ${fixed(w.ownJobSeconds)} | ${fixed(w.parentObservedLifetimeSeconds)} | ${fixed(w.readySecondsAfterLaunch)} |`);
  lines.push('', '逐 job 耗时、每个 job 的决策数和确定性结果哈希见同目录 `throughput.json`。', '',
    '## 可复现与解释边界', '',
    `全流程源码与协议哈希核对：${report.sourceHashesUnchanged ? '开始、每个 job 前后与结束完全一致' : '失败'}。相同 job 在 1、2、4 线程下的语义结果哈希和决策数：${report.sameSeededOutcomesAcrossConcurrencies ? '全部一致' : '不一致'}。完整哈希清单记录在 JSON 中。`, '',
    '每个并行度只测一次、固定按 1→2→4 顺序运行，样本仅四个 job 种子。各配置新建线程且没有独立预热；单线程会复用同一个线程执行四次，四线程各只执行一次，因此 JIT、缓存和后续任务复用的影响不同。温度、系统调度、垃圾回收及后台负载也会影响结果。', '',
    '这些结果用于选择下一轮评测的初始并行配置，不能证明更多线程必然更快，也不能外推神经网络训练或 GPU 速度。要作稳定吞吐比较，后续应扩大工作量、分别预热、随机化配置顺序并重复测量。', '',
    '该测试不改变 AI 策略，不提供牌技提升证据，也不使用封存考场。', ''
  );
  return lines.join('\n');
}

function parseArguments(args) {
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) out = args[++i];
    else if (args[i] === '--help') return {help:true};
    else throw Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  return {out:resolve(projectRoot, out || `docs/reports/throughput-${new Date().toISOString().replace(/[:.]/g, '-')}`)};
}
async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node ai/benchmark.mjs [--out DIRECTORY]\nRuns identical four jobs with 1, 2 and 4 worker_threads; never overwrites reports.');
    return;
  }
  const jsonPath = join(args.out, 'throughput.json'), markdownPath = join(args.out, 'throughput.md');
  for (const path of [jsonPath, markdownPath]) if (existsSync(path)) throw Error(`Report exists; choose another --out: ${path}`);
  mkdirSync(args.out, {recursive:true});
  const report = await runThroughputBenchmark({onProgress:progress => {
    console.log(`[${progress.concurrency} workers] ${progress.job}: ${progress.completedJobs}/${progress.totalJobs} jobs, ${fixed(progress.seconds, 1)} s`);
  }});
  // Exclusive file creation also protects against a report appearing during the run.
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', {encoding:'utf8', flag:'wx'});
  writeFileSync(markdownPath, renderThroughputMarkdown(report), {encoding:'utf8', flag:'wx'});
  console.log(`Saved ${jsonPath}\nSaved ${markdownPath}`);
}

if (!isMainThread && workerData?.benchmark === BENCHMARK_VERSION) {
  workerLoop().catch(error => {
    parentPort.postMessage({type:'failure', error:error.stack || String(error)});
    process.exitCode = 1;
    parentPort.close();
  });
} else if (isMainThread && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
}
