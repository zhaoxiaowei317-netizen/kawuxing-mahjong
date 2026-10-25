import {readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import os from 'node:os';
import {runEvaluation} from '../runner.mjs';
import {replayEpisode} from '../environment.mjs';
import {deriveSeed} from '../random.mjs';
import {sourceHashes, projectRoot, sha256, verifyFrozenBaseline} from '../provenance.mjs';
import {netScoreFactory, proposalOnceFactory, normalizeSearchConfig, ROLLOUT_VERSION} from './policy.mjs';

export const STUDY_VERSION = 'kwx-public-net-score-study-1';
export const ARMS = Object.freeze(['proposal-once', 'ev-H0', 'ev-mixed']);
export function rolloutSources() {
  return {...sourceHashes(), ...Object.fromEntries(['ai/lookahead/policy.mjs', 'ai/public-rollout/sampler.mjs',
    'ai/public-rollout/policy.mjs', 'ai/public-rollout/study.mjs'].map(path => [path, sha256(readFileSync(resolve(projectRoot, path)))]))};
}
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
export function armConfig(arm, common = {}) {
  if (!ARMS.includes(arm)) throw Error('Unknown arm');
  return normalizeSearchConfig({...common, opponentModel:arm === 'ev-mixed' ? 'mixed' : 'H0'});
}
export function selectDevelopment(rows) {
  if (rows.length !== ARMS.length || ARMS.some(arm => rows.filter(r => r.arm === arm).length !== 1)) throw Error('Missing planned arm');
  if (rows.some(r => !Number.isFinite(r.delta))) throw Error('Invalid score');
  const sorted = [...rows].sort((a, b) => b.delta - a.delta || ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm));
  return sorted[0].delta > 1e-9 ? sorted[0].arm : null;
}
function assertSources(sources) {
  if (JSON.stringify(rolloutSources()) !== JSON.stringify(sources)) throw Error('Study sources changed');
}

export async function evaluateArm({candidate, incumbent = 'H0', common, out, seed, split,
  independentGroups, sessionGroups, sessionHands = 16, bootstrapSamples = 2000,
  sources = rolloutSources(), onProgress}) {
  if (!ARMS.includes(candidate) || !['H0', 'proposal-once'].includes(incumbent)) throw Error('Invalid comparison');
  out = resolve(out); if (existsSync(out)) throw Error('Output exists');
  assertSources(sources); mkdirSync(out, {recursive:true});
  const replayPath = resolve(out, 'replays.jsonl.gz'), searchPath = resolve(out, 'searches.jsonl.gz');
  writeFileSync(replayPath, gzipSync('')); writeFileSync(searchPath, gzipSync(''));
  const stats = {}, pending = [];
  function factory(arm) {
    const config = armConfig(arm, common);
    const stat = stats[arm] = {decisions:0, proposals:0, searches:0, changed:0, hypotheticalGames:0,
      hypotheticalDecisions:0, fallbacks:{}, modeledOpponentWins:0, modeledDraws:0};
    return () => {
      let ownDecision = 0;
      const callback = (analysis, observation, legal) => {
        if (!analysis.proposed) { stat.fallbacks[analysis.reason] = (stat.fallbacks[analysis.reason] || 0) + 1; return; }
        stat.proposals++; stat.searches += Number(analysis.searched);
        stat.changed += Number(analysis.action.tile !== analysis.baseline.tile);
        for (const world of analysis.worlds || []) for (const result of [world.baseline, world.alternative]) {
          stat.hypotheticalGames++; stat.hypotheticalDecisions += result.decisions;
          stat.modeledOpponentWins += Number(result.opponentWin); stat.modeledDraws += Number(result.draw);
        }
        pending.push({policy:arm, ownDecision, observation, legal, analysis});
      };
      const select = (arm === 'proposal-once' ? proposalOnceFactory : netScoreFactory)(config, callback)();
      return (o, legal) => { ownDecision++; stat.decisions++; return select(o, legal); };
    };
  }
  const policyFactories = {[candidate]:factory(candidate)};
  if (incumbent !== 'H0' && incumbent !== candidate) policyFactories[incumbent] = factory(incumbent);
  let games = 0, audits = 0, decisionsRecorded = 0, report;
  try {
    report = await runEvaluation({candidate, incumbent, seed, split, policyFactories, independentGroups,
      sessionGroups, sessionHands, bootstrapSamples, validate:true, onProgress,
      onEpisode:episode => {
        if (pending.length > 1) throw Error('Per-hand search quota violated');
        for (const decision of pending) {
          appendFileSync(searchPath, gzipSync(JSON.stringify({suite:episode.suite, opponentPair:episode.opponentPair,
            group:episode.group, groupSeed:episode.groupSeed, permutation:episode.permutation,
            arm:episode.arm, hand:episode.hand, ...decision}) + '\n'));
          decisionsRecorded++;
        }
        pending.length = 0;
        appendFileSync(replayPath, gzipSync(JSON.stringify(episode) + '\n')); games++;
        if (episode.group === 0 && episode.hand === 0) { replayEpisode(episode.replay); audits++; }
      }});
  } catch (error) {
    save(resolve(out, 'failure.json'), {message:error.message, context:error.episodeContext, partialReplay:error.partialReplay}); throw error;
  }
  assertSources(sources);
  Object.assign(report, {createdAt:new Date().toISOString(), studyVersion:STUDY_VERSION, policyVersion:ROLLOUT_VERSION,
    configs:Object.fromEntries(Object.keys(policyFactories).map(id => [id, armConfig(id, common)])), sourceHashes:sources, search:stats,
    artifacts:{replays:{path:relative(projectRoot, replayPath), recorded:games, audited:audits, sha256:sha256(readFileSync(replayPath))},
      decisions:{path:relative(projectRoot, searchPath), recorded:decisionsRecorded, sha256:sha256(readFileSync(searchPath))}},
    hardware:{node:process.version, cpu:os.cpus()[0]?.model},
    limitations:['Uniform current-count belief; not a posterior over opponents\' past choices.',
      'Unknown opponent passed-win/peng/kong flags are assumed empty; revealed hidden triplets are unsupported.',
      'At most one proposal per hand. All subsequent own decisions use H0.',
      'Hypothetical terminal scores are estimates, not observed outcomes. No neural-network training.',
      'Development data select a candidate; independent sealed comparisons are reported separately.']});
  save(resolve(out, 'report.json'), report); return report;
}

export async function runStudy({out, developmentSeed = 'kwx-net-score-development-1', worlds = 16,
  developmentGroups = 8, developmentSessionGroups = 2, sealedGroups = 16, sealedSessionGroups = 8,
  sessionHands = 16, bootstrapSamples = 5000, onProgress = console.log} = {}) {
  if (!out) throw Error('Output required'); out = resolve(out);
  if (existsSync(out)) throw Error('Study output exists');
  if ([developmentGroups, sealedGroups].some(n => !Number.isInteger(n) || n < 0) ||
    [developmentSessionGroups, sealedSessionGroups, sessionHands, bootstrapSamples].some(n => !Number.isInteger(n) || n < 1)) throw Error('Invalid budget');
  const common = normalizeSearchConfig({worlds, uncertaintyPenalty:0});
  const plan = {version:STUDY_VERSION, createdAt:new Date().toISOString(), baseline:verifyFrozenBaseline(), sourceHashes:rolloutSources(),
    arms:ARMS, configs:Object.fromEntries(ARMS.map(id => [id, armConfig(id, common)])), common,
    developmentSeed, sealedSeed:randomBytes(32).toString('hex'),
    budget:{developmentGroups, developmentSessionGroups, sealedGroups, sealedSessionGroups, sessionHands, bootstrapSamples},
    selection:'Highest development session paired net-score delta vs H0; H0 if no positive delta; ties favor proposal then ev-H0.',
    primary:'Fresh sealed session net score per 100 hands vs H0; opponent pairs equal-weight; paired group bootstrap.',
    secondary:'If an EV arm is selected, an additional frozen comparison vs proposal-once tests the rollout filter separately.',
    stopping:'All three fixed development budgets; at most two sealed budgets. No interim stopping or automatic extension.',
    trainingHands:0, productionPolicy:'H0'};
  mkdirSync(out, {recursive:true}); save(resolve(out, 'plan.json'), plan);
  const development = [];
  for (const arm of ARMS) {
    const r = await evaluateArm({candidate:arm, common, out:resolve(out, `development-${arm}`), seed:developmentSeed,
      split:'development', independentGroups:developmentGroups, sessionGroups:developmentSessionGroups, sessionHands,
      bootstrapSamples, sources:plan.sourceHashes, onProgress:p => onProgress({stage:`development-${arm}`, ...p})});
    development.push({arm, delta:r.statistics.session.overall.deltaPer100, ci95:r.statistics.session.overall.ci95,
      games:r.totalGames, seconds:r.seconds, search:r.search[arm]});
  }
  const selected = selectDevelopment(development);
  const selection = {selected, rows:development, createdAt:new Date().toISOString(), planSha256:sha256(readFileSync(resolve(out, 'plan.json')))};
  save(resolve(out, 'selection.json'), selection); onProgress({stage:'selection', selected, scores:development.map(r => ({arm:r.arm, delta:r.delta}))});
  const sealed = {};
  if (selected) for (const incumbent of ['H0', ...(selected !== 'proposal-once' ? ['proposal-once'] : [])]) {
    const r = await evaluateArm({candidate:selected, incumbent, common, out:resolve(out, `sealed-vs-${incumbent}`),
      seed:deriveSeed(plan.sealedSeed, incumbent), split:'sealed', independentGroups:sealedGroups, sessionGroups:sealedSessionGroups,
      sessionHands, bootstrapSamples, sources:plan.sourceHashes, onProgress:p => onProgress({stage:`sealed-vs-${incumbent}`, ...p})});
    sealed[incumbent] = {primary:r.statistics.session.overall, independent:r.statistics.independent.overall,
      byOpponentPair:r.statistics.session.byOpponentPair, games:r.totalGames, seconds:r.seconds, search:r.search};
  }
  assertSources(plan.sourceHashes);
  const summary = {version:STUDY_VERSION, completedAt:new Date().toISOString(), selected, development, sealed,
    games:development.reduce((s, r) => s + r.games, 0) + Object.values(sealed).reduce((s, r) => s + r.games, 0),
    trainingHands:0, productionPolicy:'H0', sourceHashes:plan.sourceHashes, planSha256:selection.planSha256,
    selectionSha256:sha256(readFileSync(resolve(out, 'selection.json'))),
    positiveSealedEvidence:!!(sealed.H0 && sealed.H0.primary.ci95[0] > 0),
    positiveRolloutFilterEvidence:!!(sealed['proposal-once'] && sealed['proposal-once'].primary.ci95[0] > 0)};
  save(resolve(out, 'summary.json'), summary); writeFileSync(resolve(out, '结果.md'), renderReport(plan, summary));
  onProgress({stage:'complete', games:summary.games, selected, positiveSealedEvidence:summary.positiveSealedEvidence}); return summary;
}

export function renderReport(plan, summary) {
  const n = x => x.toFixed(2), ci = r => `[${r.ci95.map(n).join(', ')}]`;
  const lines = ['# 公开信息终局收益推演实验', '',
    `本轮实际评测 ${summary.games} 局，新增神经网络训练 0 手。规则 ${plan.baseline.rulesVersion}；游戏默认 H0。`, '',
    '每手最多考虑一次与 H0 不同的前瞻出牌。proposal-once 直接采用；ev-H0 用假设全是 H0 的后续对局筛选；ev-mixed 同时考虑 H0 和 greedy-speed 两类后续对手。',
    `每次收益筛选抽取 ${plan.common.worlds} 个公开信息兼容的假设世界，两个候选共用世界，全部推演到正式终局。只有替代出牌的平均最终净收益更高时才采用，打平保留 H0。`, '',
    '| 开发策略 | 连续对局 Δ 底分/百手 | 95%区间（仅开发描述） | 改变 H0 次数 | 假设对局数 |',
    '| --- | ---: | --- | ---: | ---: |',
    ...summary.development.map(r => `| ${r.arm} | ${n(r.delta)} | [${r.ci95.map(n).join(', ')}] | ${r.search.changed} | ${r.search.hypotheticalGames} |`), '',
    `开发选择：${summary.selected || 'H0（所有候选均未取得正的开发均值）'}。预算与选择规则在首局之前固定。`, ''];
  for (const [opponent, r] of Object.entries(summary.sealed)) {
    lines.push(`## 固定候选独立评测：对照 ${opponent}`, '', '| 指标 | Δ 底分/百手 | 95%区间 | 配对组数 | 每版本手数 |',
      '| --- | ---: | --- | ---: | ---: |');
    for (const [label, row] of [[`${plan.budget.sessionHands} 手连续对局（主指标）`, r.primary], ['独立单局（辅助）', r.independent],
      ...Object.entries(r.byOpponentPair)]) if (row) lines.push(`| ${label} | ${n(row.deltaPer100)} | ${ci(row)} | ${row.groups} | ${row.hands} |`);
    lines.push('');
  }
  lines.push(summary.positiveSealedEvidence ? '本批在固定对手组合上存在相对 H0 的正收益证据，尚不代表真人段位或未见对手上的普遍提升。' :
    '本轮没有确认超过 H0。区间跨零不等于等强，也不证明候选更差；开发结果不能替代独立验收。', '',
    '## 机制与边界', '',
    'AI 没有读取真实暗手或牌墙。未知牌从 4 减公开可见数量得到，随机分配给未亮倒对手与剩余牌墙，保持公开观测与根节点合法动作完全一致。亮倒对手仍有隐藏保留刻子时明确回退 H0。', '',
    '这种随机分配仅按当前可见数量，不是根据对手整段打法推断的真实概率。对手未公开的过胡、过碰、补杠禁令按空处理，可能造成估计偏差；推演中的其他两家只用预定的简单策略。样本平均净分不是实际获胜概率。', '',
    '推演使用正式引擎，把胡牌、杠分和流局查叫统一计入最终净收益；其他人提前胡牌也会终止假设对局。每个分支独立克隆同一世界，不共用被动作修改的状态。除该次选择外，自己的后续动作仍采用 H0。', '',
    '实际评测使用 H0/H0、H0/greedy-speed 两种对手组合，组合等权，六种座位排列，真实轮庄的连续对局。整组配对 bootstrap，不把同组每手或座位当独立样本。开发、封闭对 H0、封闭对前瞻对照分别报告，不合并选显著结果。', '',
    '每局保存完整牌谱，每次实际候选提案另存公开观测、合法动作、假设种子及分支结算。封闭评测中的记录仅用于审计，不作为训练数据。源码、随机种子、预算及配置见 plan.json；完整重新回放与推演重算结果见另行生成的 verification.json。', '');
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  const mapping = {'dev-groups':'developmentGroups', 'dev-session-groups':'developmentSessionGroups',
    'sealed-groups':'sealedGroups', 'sealed-session-groups':'sealedSessionGroups', 'session-hands':'sessionHands', 'worlds':'worlds', 'bootstrap':'bootstrapSamples'};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined || Object.hasOwn(options, key) ||
      !['out', 'seed', ...Object.keys(mapping)].includes(key)) throw Error('Invalid options');
    options[key] = args[i + 1];
  }
  await runStudy({out:options.out, developmentSeed:options.seed,
    ...Object.fromEntries(Object.entries(mapping).filter(([key]) => options[key] !== undefined).map(([key, field]) => [field, Number(options[key])])),
    onProgress:p => console.log(JSON.stringify(p))});
}
