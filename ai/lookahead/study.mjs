import {readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import os from 'node:os';
import {runEvaluation} from '../runner.mjs';
import {replayEpisode} from '../environment.mjs';
import {projectRoot, sha256, sourceHashes, verifyFrozenBaseline} from '../provenance.mjs';
import {LOOKAHEAD_VERSION, MODES, analyzeDiscards} from './policy.mjs';

export const STUDY_VERSION = 'kwx-two-draw-study-1';
export function studySources() {
  return {...sourceHashes(), ...Object.fromEntries(['ai/lookahead/policy.mjs', 'ai/lookahead/study.mjs']
    .map(path => [path, sha256(readFileSync(resolve(projectRoot, path)))]))};
}
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
function assertSources(expected) {
  if (JSON.stringify(studySources()) !== JSON.stringify(expected)) throw Error('Study sources changed; reject result');
}
export function selectDevelopment(rows) {
  if (rows.length !== MODES.length || MODES.some(mode => rows.filter(r => r.mode === mode).length !== 1))
    throw Error('All declared modes must be evaluated once');
  const sorted = [...rows].sort((a, b) => b.delta - a.delta || MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
  if (sorted.some(row => !Number.isFinite(row.delta))) throw Error('Invalid development score');
  return sorted[0].delta > 1e-9 ? sorted[0].mode : null;
}

export async function evaluateLookahead({mode, out, seed, split, independentGroups, sessionGroups,
  sessionHands = 16, bootstrapSamples = 2000, sources = studySources(), onProgress}) {
  if (!MODES.includes(mode)) throw Error('Unknown mode');
  out = resolve(out);
  if (existsSync(out)) throw Error('Output exists; preserve old evidence');
  assertSources(sources); mkdirSync(out, {recursive:true});
  const stats = {decisions:0, searched:0, changed:0, changedImmediateOuts:0, searchDistanceCalls:0,
    searchCandidateSum:0, byDistance:{}, fallbacks:{}};
  const id = `two-draw-${mode}-v1`, policyFactories = {[id]:() => (o, legal) => {
    const result = analyzeDiscards(o, legal, {mode}); stats.decisions++;
    if (result.searched) {
      stats.searched++; stats.searchDistanceCalls += result.cache.distanceCalls;
      stats.searchCandidateSum += result.candidates.length;
      const d = result.candidates[0].distance;
      stats.byDistance[d] = (stats.byDistance[d] || 0) + 1;
      if (result.action.tile !== result.baseline.tile) {
        stats.changed++;
        const base = result.candidates.find(c => c.action.tile === result.baseline.tile);
        if (base.outs !== result.candidates[0].outs) stats.changedImmediateOuts++;
      }
    } else stats.fallbacks[result.reason] = (stats.fallbacks[result.reason] || 0) + 1;
    return result.action;
  }};
  const replayPath = resolve(out, 'replays.jsonl.gz');
  let recorded = 0, audited = 0, report;
  try {
    report = await runEvaluation({candidate:id, incumbent:'H0', policyFactories, seed, split,
      independentGroups, sessionGroups, sessionHands, bootstrapSamples, validate:true, onProgress,
      onEpisode:episode => {
        appendFileSync(replayPath, gzipSync(JSON.stringify(episode) + '\n'));
        recorded++;
        if (episode.group === 0 && episode.hand === 0) { replayEpisode(episode.replay); audited++; }
      }});
  } catch (error) {
    save(resolve(out, 'failure.json'), {message:error.message, context:error.episodeContext, partialReplay:error.partialReplay});
    throw error;
  }
  assertSources(sources);
  Object.assign(report, {createdAt:new Date().toISOString(), studyVersion:STUDY_VERSION,
    policyVersion:LOOKAHEAD_VERSION, mode, sourceHashes:sources, search:stats,
    replayArtifact:{path:relative(projectRoot, replayPath), recorded, audited,
      sha256:sha256(readFileSync(replayPath))},
    hardware:{node:process.version, cpu:os.cpus()[0]?.model, logicalProcessors:os.availableParallelism()},
    limitations:['Public unseen tiles include concealed opponent tiles and are not the live wall.',
      'This two-draw structural target does not model future opponent actions, score, kong or reveal decisions.',
      'Development selection does not establish improvement. Frozen independent evaluation is reported separately.',
      'All games check canonical legality and conservation; only the reported stratified sample is replayed twice.']});
  save(resolve(out, 'report.json'), report); return report;
}

export async function runStudy({out, developmentSeed = 'kwx-public-two-draw-development-1',
  developmentGroups = 16, developmentSessionGroups = 4, sealedGroups = 32, sealedSessionGroups = 16,
  sessionHands = 16, bootstrapSamples = 5000, onProgress = console.log} = {}) {
  if (!out) throw Error('An output directory is required');
  out = resolve(out);
  if (existsSync(out)) throw Error('Study output exists; use a new directory');
  if (!Number.isInteger(sessionHands) || sessionHands < 1 ||
    [developmentGroups, sealedGroups].some(n => !Number.isInteger(n) || n < 0) ||
    [developmentSessionGroups, sealedSessionGroups].some(n => !Number.isInteger(n) || n < 1)) throw Error('Invalid study budget');
  const baseline = verifyFrozenBaseline(), sources = studySources();
  const plan = {version:STUDY_VERSION, createdAt:new Date().toISOString(), policyVersion:LOOKAHEAD_VERSION,
    modes:MODES, sourceHashes:sources, baseline, developmentSeed, sealedSeed:randomBytes(32).toString('hex'),
    budget:{developmentGroups, developmentSessionGroups, sealedGroups, sealedSessionGroups, sessionHands, bootstrapSamples},
    selection:'Highest development session paired delta, H0 if no positive delta; ties favor ties mode.',
    primary:`Fresh sealed ${sessionHands}-hand session net score per 100 hands, equal weight opponent pairs; paired group bootstrap.`,
    secondary:'Independent hands and per-opponent-pair results; no pooled development/sealed inference.',
    stopping:'Run both fixed development budgets, then at most one sealed budget. No automatic extension or game-AI replacement.',
    trainingHands:0};
  mkdirSync(out, {recursive:true}); save(resolve(out, 'plan.json'), plan);
  const rows = [];
  for (const mode of MODES) {
    const r = await evaluateLookahead({mode, out:resolve(out, `development-${mode}`), seed:developmentSeed,
      split:'development', independentGroups:developmentGroups, sessionGroups:developmentSessionGroups,
      sessionHands, bootstrapSamples, sources,
      onProgress:p => onProgress({stage:`development-${mode}`, ...p})});
    rows.push({mode, delta:r.statistics.session.overall.deltaPer100,
      ci95:r.statistics.session.overall.ci95, games:r.totalGames, search:r.search, seconds:r.seconds});
  }
  const selected = selectDevelopment(rows);
  const selection = {createdAt:new Date().toISOString(), selected, rows, planSha256:sha256(readFileSync(resolve(out, 'plan.json')))};
  save(resolve(out, 'selection.json'), selection);
  onProgress({stage:'selection', selected, rows:rows.map(({mode, delta}) => ({mode, delta}))});
  let sealed = null;
  if (selected) {
    sealed = await evaluateLookahead({mode:selected, out:resolve(out, 'sealed'), seed:plan.sealedSeed, split:'sealed',
      independentGroups:sealedGroups, sessionGroups:sealedSessionGroups, sessionHands, bootstrapSamples, sources,
      onProgress:p => onProgress({stage:'sealed', ...p})});
  }
  assertSources(sources);
  const primary = sealed?.statistics.session.overall || null;
  const summary = {version:STUDY_VERSION, completedAt:new Date().toISOString(), selected, development:rows,
    sealed:sealed ? {primary, independent:sealed.statistics.independent.overall,
      byOpponentPair:sealed.statistics.session.byOpponentPair, games:sealed.totalGames, search:sealed.search,
      latency:sealed.latency, seconds:sealed.seconds, replayArtifact:sealed.replayArtifact} : null,
    positiveSealedEvidence:!!(primary && primary.ci95[0] > 0),
    games:rows.reduce((sum, r) => sum + r.games, 0) + (sealed?.totalGames || 0), trainingHands:0,
    productionPolicy:'H0', sourceHashes:sources, planSha256:selection.planSha256,
    selectionSha256:sha256(readFileSync(resolve(out, 'selection.json')))};
  save(resolve(out, 'summary.json'), summary);
  writeFileSync(resolve(out, '结果.md'), renderReport(plan, summary));
  onProgress({stage:'complete', selected, games:summary.games, positiveSealedEvidence:summary.positiveSealedEvidence});
  return summary;
}

export function renderReport(plan, summary) {
  const n = x => x.toFixed(2), interval = row => `[${row.ci95.map(n).join(', ')}]`;
  const lines = ['# 两步公开牌效实验', '',
    `规则 ${plan.baseline.rulesVersion}；策略 ${LOOKAHEAD_VERSION}。新增训练 0 手，实际模拟 ${summary.games} 局。`, '',
    'H0 决定胡、碰、杠、亮倒、已经听牌和牌墙不足六张时的动作。新策略只重排尚未听牌的合法出牌。',
    'ties 只打破 H0 的相同向听、相同进张数平手；same-shanten 比较所有与 H0 相同向听数的出牌。', '',
    '| 开发策略 | 连续对局 Δ 底分/百手 | 95%区间（开发描述） | 模拟局数 | 改变 H0 出牌次数 |',
    '| --- | ---: | --- | ---: | ---: |',
    ...summary.development.map(r => `| ${r.mode} | ${n(r.delta)} | [${r.ci95.map(n).join(', ')}] | ${r.games} | ${r.search.changed} |`), '',
    `开发集选定：${summary.selected || 'H0（两种候选均未取得正的开发均值）'}。选择规则和预算在开始前写入 plan.json。`, ''];
  if (summary.sealed) {
    lines.push('| 新随机种子封闭评测 | Δ 底分/百手 | 95%区间 | 配对组数 | 每版本手数 |', '| --- | ---: | --- | ---: | ---: |');
    for (const [label, row] of [[`${plan.budget.sessionHands} 手连续对局（主指标）`, summary.sealed.primary],
      ['独立单局（辅助）', summary.sealed.independent], ...Object.entries(summary.sealed.byOpponentPair)]) {
      if (row) lines.push(`| ${label} | ${n(row.deltaPer100)} | ${interval(row)} | ${row.groups} | ${row.hands} |`);
    }
    lines.push('', summary.positiveSealedEvidence ? '本批对固定对手组合有正收益证据，仍不代表真人牌力或未见对手上的普遍提升。' :
      '本批未确认候选超过 H0。跨零区间不代表两者等强，也不证明候选更差。', '',
      `封闭评测保存 ${summary.sealed.replayArtifact.recorded} 局完整牌谱，其中 ${summary.sealed.replayArtifact.audited} 局分层抽样二次回放并核对结算。`, '');
  } else lines.push('按预定停止规则结束，不为开发表现未胜出的策略追加封闭评测。', '');
  lines.push('游戏默认仍为 H0，研究策略独立保留。', '',
    '## 计算含义与边界', '',
    '计算两次从“公开未知牌集合”不放回抽取的结构进展：一向听看两摸内成牌，二向听看两摸内听牌，依此类推。第一摸后可选择安全出牌；全危险时按正式规则允许出危险牌。每种牌乘以其剩余张数，摸过后从后续数量扣除，打出后也不回补。', '',
    '未知牌包含对手暗手，指标不是实际牌墙概率。搜索没有模拟对手未来碰杠、出牌、胡牌和提前终局，也没有优化番数、杠分、亮倒或局末查叫收益。搜索值提高不能直接解释为实战变强。', '',
    '对手为 H0/H0 与 H0/greedy-speed 两种组合，组合等权；每个配对组覆盖六种座位排列。连续局保留赢家坐庄及积分。按完整配对组做分层 bootstrap，不把同组的手数或座位当独立样本。开发筛选与封闭评测分开报告，不合并显著性。', '',
    '所有实际动作由同一正式引擎检查合法性、84 张牌守恒和零和结算。源码、运行环境、固定预算和随机种子记录在 plan.json；各阶段 report.json 含原始分组收益、耗时、延迟、搜索频率和牌谱 SHA-256。', '');
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined) throw Error('Use --option value');
    const key = args[i].slice(2);
    if (Object.hasOwn(options, key) || !['out', 'seed', 'dev-groups', 'dev-session-groups', 'sealed-groups', 'sealed-session-groups', 'session-hands', 'bootstrap'].includes(key)) throw Error('Invalid option');
    options[key] = args[i + 1];
  }
  await runStudy({out:options.out, developmentSeed:options.seed,
    ...Object.fromEntries([['dev-groups', 'developmentGroups'], ['dev-session-groups', 'developmentSessionGroups'],
      ['sealed-groups', 'sealedGroups'], ['sealed-session-groups', 'sealedSessionGroups'],
      ['session-hands', 'sessionHands'], ['bootstrap', 'bootstrapSamples']]
      .filter(([key]) => options[key] !== undefined).map(([key, field]) => [field, Number(options[key])])),
    onProgress:p => console.log(JSON.stringify(p))});
}
