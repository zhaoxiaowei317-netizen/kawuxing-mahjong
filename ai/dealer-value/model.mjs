import assert from 'node:assert/strict';
export const VERSION='kwx-exploratory-dealer-value-1';
// A deliberately small public-state approximation of the frozen Short policy's
// future net score. It does not model hand quality, hidden tiles, standings or
// history, and is not the GRU global-reward predictor from Suphx.
export function fitDealerValue(rows,{horizon=16,pseudoCount=1}={}){
  assert.ok(rows.length);assert.ok(Number.isInteger(horizon)&&horizon>=1&&horizon<=1000);assert.ok(Number.isFinite(pseudoCount)&&pseudoCount>0);
  const counts=[0,0],rewardSums=[0,0],transitions=[[0,0],[0,0]];
  for(const r of rows){assert.ok([0,1].includes(r.state)&&[0,1].includes(r.nextState)&&Number.isFinite(r.reward));counts[r.state]++;rewardSums[r.state]+=r.reward;transitions[r.state][r.nextState]++;}
  const globalMean=rewardSums.reduce((n,x)=>n+x,0)/rows.length,meanReward=counts.map((n,s)=>n?rewardSums[s]/n:globalMean),matrix=transitions.map((row,s)=>row.map(n=>(n+pseudoCount)/(counts[s]+2*pseudoCount))),values=[[0,0]];
  for(let h=1;h<=horizon;h++)values.push(meanReward.map((r,s)=>r+matrix[s].reduce((n,p,t)=>n+p*values[h-1][t],0)));
  return {version:VERSION,stateNames:['otherDealer','selfDealer'],horizon,pseudoCount,trainingHands:rows.length,counts,rewardSums,transitions,globalMean,meanReward,matrix,values};
}
export function forecast(model,h,state){assert.equal(model.version,VERSION);assert.ok(Number.isInteger(h)&&h>=0&&h<=model.horizon&&[0,1].includes(state));return model.values[h][state];}
export function sessionRows(episodes,sessionHands){
  assert.ok(episodes.length%sessionHands===0);const rows=[];
  for(let start=0;start<episodes.length;start+=sessionHands){const session=episodes.slice(start,start+sessionHands),target=session[0].schedule.target;
    assert.ok(session.every((e,i)=>e.hand===start+i&&e.schedule.target===target));let future=0;
    for(let i=session.length-1;i>=0;i--){const e=session[i],reward=e.replay.result.delta[target];future+=reward;
      rows.push({hand:e.hand,session:start/sessionHands,state:Number(e.replay.initialState.dealer===target),nextState:Number(e.replay.result.next.dealer===target),reward,horizon:sessionHands-i,futureNet:future});}
  }
  return rows.sort((a,b)=>a.hand-b.hand);
}
export function evaluateDealerValue(model,rows){
  assert.ok(rows.length);const sums={dealerMse:0,globalMeanMse:0,zeroMse:0};
  for(const r of rows){const p=forecast(model,r.horizon,r.state),constant=r.horizon*model.globalMean;sums.dealerMse+=(p-r.futureNet)**2;sums.globalMeanMse+=(constant-r.futureNet)**2;sums.zeroMse+=r.futureNet**2;}
  return {hands:rows.length,sessions:new Set(rows.map(r=>r.session)).size,...Object.fromEntries(Object.entries(sums).map(([k,n])=>[k,n/rows.length]))};
}
export function correctedRootGain(episode,model,sessionHands){
  if(!episode.root)return null;const target=episode.schedule.target,h=sessionHands-episode.hand%sessionHands-1;
  assert.ok(h>=0&&h<=model.horizon);let current=0,correction=0;
  for(const s of episode.samples){const baseline=s.baselineReplay?.result??episode.replay.result,alternative=s.alternativeReplay.result;
    current+=s.gain;correction+=(forecast(model,h,Number(alternative.next.dealer===target))-forecast(model,h,Number(baseline.next.dealer===target)))/16;
  }
  return {currentGain:current/episode.samples.length,futureDealerCorrection:correction/episode.samples.length,correctedGain:(current+correction)/episode.samples.length};
}
