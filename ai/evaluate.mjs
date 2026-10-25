import {mkdirSync, openSync, closeSync, writeSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {runEvaluation, percentile} from './runner.mjs';
import {replayEpisode} from './environment.mjs';
import {projectRoot, sha256, sourceHashes, verifyFrozenBaseline} from './provenance.mjs';
import {loadCheckpoint} from './training/checkpoint.mjs';
import {modelPolicyFactory} from './training/policy.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || args[i + 1] === undefined) throw Error('Use --option value');
  const key = args[i].slice(2);
  if (Object.hasOwn(options, key)) throw Error(`Duplicate option: ${key}`);
  options[key] = args[i + 1];
}
const known = ['candidate', 'incumbent', 'seed', 'split', 'groups', 'session-groups', 'session-hands',
  'bootstrap', 'out', 'replay', 'replays', 'seed-file', 'candidate-model', 'incumbent-model'];
for (const key of Object.keys(options)) if (!known.includes(key)) throw Error(`Unknown option: --${key}`);
if (options.replay) {
  const buffer = readFileSync(resolve(options.replay));
  const content = options.replay.endsWith('.gz') ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
  let count = 0;
  for (const line of content.trim().split('\n')) {
    const value = JSON.parse(line);
    if (value.provenance) {
      for (const [path, expected] of Object.entries(value.provenance.rulesSourceHashes)) {
        if (!['src/engine.js', 'src/wall.js'].includes(path)) throw Error('Unknown replay rules source');
        if (sha256(readFileSync(resolve(projectRoot, path))) !== expected) throw Error(`Replay source differs: ${path}`);
      }
      for (const [name, expected] of Object.entries(value.provenance.dependencies)) {
        if (name !== '@kobalab/majiang-core') throw Error('Unknown replay dependency');
        const actual = JSON.parse(readFileSync(resolve(projectRoot, `node_modules/${name}/package.json`), 'utf8')).version;
        if (actual !== expected) throw Error(`Replay dependency differs: ${name}`);
      }
    }
    replayEpisode(value.replay || value); count++;
  }
  console.log(`Replayed ${count} episodes: identical settlement and conserved tiles.`);
} else {
  const baseline = verifyFrozenBaseline();
  const policyFactories = {}, models = {}, selected = {};
  for (const arm of ['candidate', 'incumbent']) if (options[`${arm}-model`]) {
    if (options[arm]) throw Error(`Use --${arm} or --${arm}-model, not both`);
    const path = resolve(options[`${arm}-model`]), loaded = loadCheckpoint(path);
    const id = `model-${loaded.sha256.slice(0, 12)}`;
    selected[arm] = id; policyFactories[id] = modelPolicyFactory(loaded.model);
    models[arm] = {path, sha256:loaded.sha256, modelVersion:loaded.checkpoint.modelVersion,
      encodingVersion:loaded.checkpoint.encodingVersion, trainingSteps:loaded.checkpoint.trainingSteps,
      iteration:loaded.checkpoint.iteration, inference:'deterministic masked argmax'};
  }
  const split = options.split || 'development';
  if (split === 'sealed' && !options['seed-file']) throw Error('Sealed runs require a separately provisioned --seed-file');
  const seed = options['seed-file'] ? readFileSync(resolve(options['seed-file']), 'utf8').trim()
    : options.seed || 'm0-development-v1';
  if (!seed) throw Error('Empty seed');
  const out = resolve(options.out || '.tmp/ai-evaluation/latest');
  if (existsSync(resolve(out, 'report.json')) || existsSync(resolve(out, 'replays.jsonl.gz')))
    throw Error('Output already exists; use a new --out directory to preserve previous evidence');
  mkdirSync(out, {recursive:true});
  const mode = options.replays || 'all';
  if (!['all', 'sample', 'none'].includes(mode)) throw Error('Invalid --replays mode');
  const replayPath = resolve(out, 'replays.jsonl.gz');
  const fd = mode === 'none' ? null : openSync(replayPath, 'wx');
  let savedReplays = 0;
  const frozenSources = sourceHashes();
  let report;
  try {
    report = await runEvaluation({candidate:selected.candidate || options.candidate || 'H0', incumbent:selected.incumbent || options.incumbent || 'H0',
      policyFactories,
      seed, split, independentGroups:Number(options.groups ?? 8), sessionGroups:Number(options['session-groups'] ?? 1),
      sessionHands:Number(options['session-hands'] ?? 16), bootstrapSamples:Number(options.bootstrap ?? 2000),
      onProgress:p => console.log(`${p.suite} ${p.opponentPair} ${p.group}/${p.groups}: ${p.totalGames} games, ${p.seconds.toFixed(1)}s`),
      onEpisode:episode => {
        if (fd !== null && (mode === 'all' || savedReplays < 12)) {
          const provenance = {baselineVersion:baseline.version, dependencies:baseline.dependencies,
            rulesSourceHashes:Object.fromEntries(['src/engine.js', 'src/wall.js'].map(path => [path, frozenSources[path]]))};
          writeSync(fd, gzipSync(JSON.stringify({...episode, provenance}) + '\n')); savedReplays++;
        }
      }});
  } catch (error) {
    writeFileSync(resolve(out, 'failure.json'), JSON.stringify({message:error.message,
      context:error.episodeContext, replay:error.partialReplay}, null, 2));
    throw error;
  } finally { if (fd !== null) closeSync(fd); }
  const finalSources = sourceHashes();
  if (JSON.stringify(finalSources) !== JSON.stringify(frozenSources)) throw Error('Sources changed during run; results rejected');
  for (const model of Object.values(models))
    if (sha256(readFileSync(model.path)) !== model.sha256) throw Error('Checkpoint changed during evaluation');
  let gitHead = null, gitDirty = null;
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:projectRoot, encoding:'utf8'}).trim();
    gitDirty = Boolean(execFileSync('git', ['status', '--porcelain'], {cwd:projectRoot, encoding:'utf8'}).trim());
  } catch { /* Source hashes remain authoritative if Git is unavailable. */ }
  const minGroupsPerPair = Math.min(...Object.values(report.statistics).flatMap(s => Object.values(s.byOpponentPair).map(p => p.groups)));
  Object.assign(report, {createdAt:new Date().toISOString(), baseline, sourceHashes:frozenSources, models,
    descriptiveOnly:true, minGroupsPerPair, gitHead, gitDirty,
    command:process.argv.slice(1), hardware:{node:process.version, cpu:os.cpus()[0]?.model,
      logicalProcessors:os.availableParallelism(), totalMemoryGiB:os.totalmem() / 1024 ** 3,
      processPeakRssMiB:process.resourceUsage().maxRSS / 1024},
    replayArtifact:fd === null ? null : {path:relative(projectRoot, replayPath), episodes:savedReplays,
      sha256:sha256(readFileSync(replayPath)), format:'concatenated gzip members containing JSONL'},
    limitations:['Development pilots do not establish playing-strength improvement.',
      'Confidence intervals describe paired score differences, not absolute skill.',
      'One-seed strata cannot estimate unseen seed variation.',
      'Privacy invariance tests cover known cases; arbitrary policy code is not sandboxed.']});
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const n = x => Number(x).toFixed(2);
  const lines = [`# 卡五星 AI 评测报告`, '', `协议：${report.protocolVersion}；规则：${baseline.rulesVersion}；数据层：${report.split}。`, '',
    ...(minGroupsPerPair <= 2 ? ['**每个组合最少仅有 '+minGroupsPerPair+' 个独立配对组，区间只作方法检查，不能作为可靠显著性或晋级证据。**', ''] : []),
    `候选 ${report.candidate}；基线 ${report.incumbent}。共 ${report.totalGames} 局、${report.totalDecisions} 次决策。`, '',
    '| 测试 | 对手组合 | 配对组数 | 每版本局数 | 候选/百局 | 基线/百局 | Δ/百局 | Δ 95%区间 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const [suite, result] of Object.entries(report.statistics)) {
    for (const [pair, row] of [['总体', result.overall], ...Object.entries(result.byOpponentPair)]) {
      if (!row) continue;
      lines.push(`| ${suite} | ${pair} | ${row.groups} | ${row.hands} | ${n(row.candidatePer100)} | ${n(row.incumbentPer100)} | ${n(row.deltaPer100)} | [${row.ci95.map(n).join(', ')}] |`);
    }
  }
  lines.push('', '对手组合等权；在组合内按整组初始牌局重采样。六种座位排列与连续牌局不当成独立样本。区间仅针对新旧差值。', '',
    '| 测试/组合/版本 | 胡牌率 | 自摸率 | 放炮率 | 胡分/百局 | 杠分/百局 | 查叫分/百局 | 亮倒率 | 大亏率≤−16底分 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const suite of ['independent', 'session']) for (const pair of report.opponentPairs) {
    const records = report.records.filter(r => r.suite === suite && r.opponentPair === pair.id);
    if (!records.length) continue;
    for (const arm of ['candidate', 'incumbent']) {
      const sum = key => records.reduce((s, r) => s + r[arm][key], 0), hands = sum('hands');
      const rate = key => n(sum(key) / hands * 100), scoreRate = key => n(sum(key) / hands / report.base * 100);
      lines.push(`| ${suite}/${pair.id}/${arm} | ${rate('wins')}% | ${rate('selfDraws')}% | ${rate('dealIns')}% | ${scoreRate('huScore')} | ${scoreRate('kongScore')} | ${scoreRate('drawScore')} | ${rate('revealHands')}% | ${rate('largeLosses')}% |`);
    }
  }
  lines.push('', '自摸率、放炮率均以全部手数为分母；双响放炮算一次放炮事件。大亏门槛预设为单局净分≤−16底分。各收益分项之和为总净收益。', '',
    '| 连续对局/组合/版本 | 桌数 | 第一率（并列分摊） | 末位率（并列分摊） | 桌收益10%分位 | 亮倒局条件均分 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const pair of report.opponentPairs) for (const arm of ['candidate', 'incumbent']) {
    const records = report.records.filter(r => r.suite === 'session' && r.opponentPair === pair.id);
    if (!records.length) continue;
    const sum = key => records.reduce((s, r) => s + r[arm][key], 0), sessions = sum('sessions');
    const scores = records.flatMap(r => r[arm].sessionScores);
    lines.push(`| ${pair.id}/${arm} | ${sessions} | ${n(sum('sessionFirstCredit') / sessions * 100)}% | ${n(sum('sessionLastCredit') / sessions * 100)}% | ${n(percentile(scores, 0.1))} | ${sum('revealHands') ? n(sum('revealedScore') / sum('revealHands')) : '无亮倒'} |`);
  }
  lines.push('', `连续对局长度为 ${report.sessionHands} 局；“亮倒局条件均分”描述选择亮倒的那些局的实际结果，不能解释成亮倒动作的因果收益。`, '',
    `对战耗时 ${n(report.seconds)} 秒；${n(report.gamesPerSecond)} 局/秒，${n(report.decisionsPerSecond)} 决策/秒。含观测、校验和牌谱写入，不含最后的 bootstrap 与报告生成；单工作进程。`, '',
    '| 策略 | 决策次数 | 策略 p50/ms | 策略 p95/ms |', '| --- | ---: | ---: | ---: |');
  for (const [id, row] of Object.entries(report.latency)) lines.push(`| ${id} | ${row.decisions} | ${n(row.p50Ms)} | ${n(row.p95Ms)} |`);
  lines.push('', `非法动作 ${report.illegalActions}；每步检查 84 张牌守恒及零和积分。原始指标、分项收益、版本哈希和牌谱定位见 report.json。`, '',
    '本报告用于验证评测平台及描述开发集基线，不构成新模型牌技提升、真人段位或正式晋级结论。小样本下的区间不能覆盖未见打法；单组区间退化不能解释为确定性强弱。', '');
  writeFileSync(resolve(out, 'report.md'), lines.join('\n'));
  console.log(`Saved ${relative(projectRoot, out)}; ${report.totalGames} games at ${n(report.gamesPerSecond)} games/s`);
}
