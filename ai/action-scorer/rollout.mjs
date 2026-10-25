import {MahjongEnvironment} from '../environment.mjs';
import {deriveSeed, seededRandom} from '../random.mjs';
import {selectAction as h0} from '../policies/h0.mjs';
import {actionId} from '../training/encoding.mjs';
import {scorerChoice} from './io.mjs';

export async function collectScorerRollout({model, hands, seed, iteration, selfPlayFraction=0.25,
  rewardScale=16, onProgress=null, onHand=null}) {
  if (!Number.isSafeInteger(hands) || hands < 1 || !Number.isSafeInteger(iteration) || iteration < 1 ||
    typeof seed !== 'string' || !seed.length || !Number.isFinite(selfPlayFraction) || selfPlayFraction < 0 || selfPlayFraction > 1 ||
    !Number.isFinite(rewardScale) || rewardScale <= 0) throw Error('Invalid scorer rollout configuration');
  const samples = [], stats = {hands:0, environmentDecisions:0, learnerDecisions:0,
    learnerHands:0, learnerScore:0, selfPlayHands:0, H0Hands:0};
  for (let hand = 0; hand < hands; hand++) {
    const rng = seededRandom(deriveSeed('scorer-training', seed, 'roles', iteration, hand));
    const selfPlay = rng(0x100000000) / 0x100000000 < selfPlayFraction;
    const learnerSeat = ((iteration - 1) * hands + hand) % 3;
    const trajectories = [[], [], []], env = new MahjongEnvironment({
      seed:deriveSeed('scorer-training', seed, 'environment', iteration, hand), record:false});
    const policyRngs = [0, 1, 2].map(seat => seededRandom(deriveSeed(seed, 'scorer-policy', iteration, hand, seat)));
    let decisions = 0;
    while (!env.done) {
      if (++decisions > 500) throw Error('Scorer rollout action budget exceeded');
      const seat = env.actor, o = env.observation(), legal = env.legalActions();
      if (selfPlay || seat === learnerSeat) {
        const {action, ...sample} = scorerChoice(model, o, legal, policyRngs[seat], false);
        // Teacher sees the same public observation. Labels are training-only, never policy inputs.
        trajectories[seat].push({...sample, teacherActionId:actionId(h0(o, legal))});
        env.step(action);
      } else env.step(h0(o, legal));
    }
    const result = env.result();
    for (let seat = 0; seat < 3; seat++) if (selfPlay || seat === learnerSeat) {
      stats.learnerHands++; stats.learnerScore += result.delta[seat];
      const target = result.delta[seat] / rewardScale;
      for (const s of trajectories[seat]) samples.push({...s, return:target, advantage:target - s.oldValue, hand, seat});
    }
    stats.hands++; stats.environmentDecisions += decisions; stats[selfPlay ? 'selfPlayHands' : 'H0Hands']++;
    onHand?.({hand, learnerSeat, selfPlay, result});
    onProgress?.({hand:hand + 1, hands, learnerDecisions:samples.length});
    await new Promise(resolve => setImmediate(resolve));
  }
  stats.learnerDecisions = samples.length; return {samples, stats};
}
