import {MahjongEnvironment} from '../environment.mjs';
import {deriveSeed, seededRandom} from '../random.mjs';
import {policyById} from '../policies/index.mjs';
import {encodeObservation, actionId, legalActionIds} from './encoding.mjs';
import {chooseModelAction} from './policy.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
export async function collectImitation({episodes, seed, teacher='H0', onProgress=null}) {
  if (!Number.isSafeInteger(episodes) || episodes < 0) throw Error('Invalid imitation episode count');
  const samples = [], scores = [0, 0, 0], select = policyById(teacher);
  for (let episode = 0; episode < episodes; episode++) {
    const env = new MahjongEnvironment({seed:deriveSeed('training', seed, 'imitation', episode), record:false});
    const rngs = [0, 1, 2].map(seat => seededRandom(deriveSeed(seed, 'imitation-policy', episode, seat)));
    let decisions = 0;
    while (!env.done) {
      if (++decisions > 500) throw Error('Imitation episode exceeded action budget');
      const seat = env.actor, observation = env.observation(), legal = env.legalActions();
      const action = select(observation, legal, rngs[seat]);
      samples.push({features:encodeObservation(observation), legalIds:legalActionIds(legal), actionId:actionId(action)});
      env.step(action);
    }
    env.result().delta.forEach((v, i) => scores[i] += v);
    onProgress?.({phase:'imitation', episode:episode + 1, episodes, decisions:samples.length});
    await tick();
  }
  return {samples, episodes, decisions:samples.length, scores};
}

// Only current-policy decisions enter PPO. Teacher and historical-opponent decisions never do.
export async function collectRollout({model, episodes, seed, iteration, selfPlayFraction=0.5,
  opponents=[], rewardScale=16, sessionHands=1, onProgress=null, onHand=null}) {
  if (!Number.isSafeInteger(episodes) || episodes < 1) throw Error('Invalid rollout episode count');
  if (!Number.isFinite(rewardScale) || rewardScale <= 0) throw Error('Invalid reward scale');
  if (!Number.isFinite(selfPlayFraction) || selfPlayFraction < 0 || selfPlayFraction > 1) throw Error('Invalid self-play fraction');
  if (!Number.isInteger(sessionHands) || sessionHands < 1 || sessionHands > 1000) throw Error('Invalid training session length');
  const samples = [], stats = {episodes:0, hands:0, environmentDecisions:0, learnerDecisions:0,
    learnerHands:0, learnerScore:0, selfPlayEpisodes:0, mixedEpisodes:0, opponentCounts:{}};
  for (let episode = 0; episode < episodes; episode++) {
    const matchRng = seededRandom(deriveSeed('training', seed, 'match', iteration, episode));
    const selfPlay = matchRng(0x100000000) / 0x100000000 < selfPlayFraction;
    const learnerSeat = (iteration * episodes + episode) % 3;
    const roles = [0, 1, 2].map(seat => {
      if (selfPlay || seat === learnerSeat) return {id:'learner', learner:true};
      const pool = opponents.length ? opponents : [{id:'H0', select:policyById('H0')}];
      const opponent = pool[matchRng(pool.length)];
      stats.opponentCounts[opponent.id] = (stats.opponentCounts[opponent.id] || 0) + 1;
      return {...opponent, learner:false};
    });
    const trajectories = [[], [], []];
    const totals = [0, 0, 0]; let previous = null, decisions = 0;
    for (let hand = 0; hand < sessionHands; hand++) {
      const env = new MahjongEnvironment({seed:deriveSeed('training', seed, 'environment', iteration, episode, hand), previous, record:false});
      const rngs = roles.map((role, seat) => seededRandom(deriveSeed(seed, 'policy', iteration, episode, hand, seat, role.id)));
      let handDecisions = 0;
      while (!env.done) {
        if (++handDecisions > 500) throw Error('Rollout hand exceeded action budget');
        const seat = env.actor, observation = env.observation(), legal = env.legalActions();
        let action;
        if (roles[seat].learner) {
          const choice = chooseModelAction(model, observation, legal, rngs[seat]);
          const {action:chosen, ...sample} = choice;
          trajectories[seat].push({...sample, hand}); action = chosen;
        } else action = roles[seat].select(observation, legal, rngs[seat]);
        env.step(action);
      }
      const result = env.result();
      result.delta.forEach((v, i) => totals[i] += v);
      previous = {dealer:result.next.dealer, seats:result.next.seats, totals:[...totals], round:hand + 2};
      onHand?.({episode, hand, dealer:env.auditState().dealer, result, totals:[...totals]});
      stats.hands++; decisions += handDecisions;
      await tick();
    }
    for (let seat = 0; seat < 3; seat++) if (roles[seat].learner) {
      stats.learnerHands += sessionHands; stats.learnerScore += totals[seat];
      // Terminal episode reward, at base=1. Every hand's kong/draw fees enter totals exactly once.
      const target = totals[seat] / rewardScale;
      for (const sample of trajectories[seat]) samples.push({...sample, return:target,
        advantage:target - sample.oldValue, episode, seat});
    }
    stats.episodes++; stats.environmentDecisions += decisions;
    stats[selfPlay ? 'selfPlayEpisodes' : 'mixedEpisodes']++;
    onProgress?.({phase:'rollout', iteration, episode:episode + 1, episodes, learnerDecisions:samples.length});
    await tick();
  }
  stats.learnerDecisions = samples.length;
  return {samples, stats};
}

export function normalizeAdvantages(samples) {
  if (!samples.length) throw Error('No learner samples');
  const mean = samples.reduce((sum, s) => sum + s.advantage / samples.length, 0);
  const variance = samples.reduce((sum, s) => sum + (s.advantage - mean) ** 2 / samples.length, 0);
  const scale = Math.sqrt(variance) + 1e-8;
  return {samples:samples.map(s => ({...s, advantage:(s.advantage - mean) / scale})), mean, std:Math.sqrt(variance)};
}
