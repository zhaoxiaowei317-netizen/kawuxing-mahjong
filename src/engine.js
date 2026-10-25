import Majiang from '@kobalab/majiang-core';
import {dealWall,roundId,randomBelow} from './wall.js';

export const RULES_VERSION='xiaogan-1.0';
export const HU_CAP=16;
export function normalizeConfig(config={}) {
 const base=Number(config.base??1);
 if(!Number.isInteger(base)||base<1||base>100)throw Error('底分须为1至100的整数');
 return {base,cap:HU_CAP,mode:config.mode==='bots'?'bots':'three',rulesVersion:RULES_VERSION};
}

export const TYPES = [...['p','s'].flatMap(s => Array.from({length:9},(_,i)=>s+(i+1))), 'z5','z6','z7'];
export const names = ['阿源','小林','阿慧'];
export const tileName = t => t[0]==='z' ? ({z5:'白板',z6:'发财',z7:'红中'}[t]) : t[1]+(t[0]==='p'?'筒':'条');
export const counts = a => a.reduce((o,t)=>(o[t]=(o[t]||0)+1,o),{});
export const sorted = a => [...a].sort((a,b)=>TYPES.indexOf(a)-TYPES.indexOf(b));
export function parseHand(s) {
 if (!/^([ps][1-9]+|z[567]+)+$/.test(s)) throw Error('牌谱只接受 p1-9（筒）、s1-9（条）、z567（白发中）');
 const a=[...s.matchAll(/([psz])(\d+)/g)].flatMap(m=>[...m[2]].map(n=>m[1]+n));
 if(Object.values(counts(a)).some(n=>n>4)) throw Error('同一种牌不能超过4张');
 return a;
}
const meldString = m => m.tile[0]+m.tile[1].repeat(m.kind==='peng'?3:4)+(m.kind==='an'?'':'+');
export function evaluate(hand,melds=[],ctx={}) {
 const all=[...hand,...melds.flatMap(m=>Array(m.kind==='peng'?3:4).fill(m.tile))];
 if(hand.length+melds.length*3!==14 || (ctx.winTile&&!hand.includes(ctx.winTile)) || all.some(t=>!TYPES.includes(t)) || Object.values(counts(all)).some(n=>n>4)) return null;
 const c=counts(hand), qids=!melds.length && Object.values(c).every(n=>n%2===0);
 const winTile=ctx.winTile||hand.at(-1);
 let decomps=[];
 try {
  const sp=new Majiang.Shoupai(hand); sp._fulou=melds.map(meldString); sp._zimo=ctx.winTile||hand.at(-1);
  decomps=Majiang.Util.hule_mianzi(sp).filter(d=>d.length===5);
 } catch { return null; }
 if(!decomps.length&&!qids) return null;
 const candidates=[];
 for(const dec of [...decomps,...(qids?[null]:[])]) {
  const f=[]; const add=(name,n)=>f.push({name,n});
  if(dec===null) {
   const quads=Object.values(c).filter(n=>n===4).length;
   add(['七对','豪七对','双豪七对','三豪七对'][quads],[4,8,16,32][quads]);
  } else {
   const clean=dec.map(x=>x.replace(/[^psz0-9]/g,''));
   const allExposed=melds.length===4&&melds.every(m=>m.kind!=='an');
   if(allExposed)add('全求人',4);
   else if(clean.slice(1).every(x=>new Set(x.slice(1)).size===1)) add('碰碰胡',2);
   if(dec.some(x=>/^[ps]45_!6$/.test(x))) add('卡五星',2);
   const ds=clean.slice(1).filter(x=>/^z([567])\1\1/.test(x)).length;
   if(ds===3) add('大三元',8); else if(ds===2 && /^z([567])\1$/.test(clean[0])) add('小三元',4);
   if(melds.some(m=>m.kind==='peng'&&m.tile===winTile&&c[m.tile]===1)) add('明四归',2);
   if(c[winTile]===4) add('暗四归',4);
  }
  const suits=new Set(all.map(t=>t[0]));
  if(suits.size===1&&!suits.has('z')) add('清一色',4);
  if(ctx.liang) add('亮倒',2);
  if(ctx.otherLiang) add(ctx.liang?'对亮':'亮倒',2);
  if(ctx.gang>0 && ctx.self) add('杠上开花',2**ctx.gang);
  if(ctx.robKong && !ctx.self)add('抢杠胡',2**(ctx.robKong===true?1:ctx.robKong));
  else if(ctx.gangShot && !ctx.self) add('杠上炮',2**(ctx.gangShot===true?1:ctx.gangShot));
  if(ctx.sea) add(ctx.self?'海底自摸':'海底放炮',2);
  const raw=f.reduce((v,x)=>v*x.n,1);
  if(!f.length) add('普通胡',1);
  candidates.push({factors:f,raw,legal:!!ctx.self||raw>=2,warning:null});
 }
 return candidates.sort((a,b)=>Number(b.legal)-Number(a.legal)||b.raw-a.raw)[0];
}
export function amount(raw,config) {return Math.min(raw,HU_CAP)*(config.base??1);}
export function waits(hand,melds=[],liang=false,minimum=2) {
 const owned=counts([...hand,...melds.flatMap(m=>Array(m.kind==='peng'?3:4).fill(m.tile))]);
 return TYPES.filter(t=>(owned[t]||0)<4).map(t=>({tile:t,score:evaluate([...hand,t],melds,{winTile:t,liang})})).filter(x=>x.score&&x.score.raw>=minimum&&!x.score.warning);
}
// A revealed player's wait stays fixed while their extra drawn tile is in hand.
export function revealedWaits(g,seat) {
 const p=g.players[seat];
 if(!p?.liang)return [];
 if(p.publicWaits)return p.publicWaits;
 if(p.liangWaits)return p.liangWaits;
 const hand=[...p.hand];
 if(hand.length+p.melds.length*3===14){
  if(g.turn!==seat||!g.drawTile)return [];
  const index=hand.lastIndexOf(g.drawTile);
  if(index<0)return [];
  hand.splice(index,1);
 }
 return waits(hand,p.melds,true);
}
// A reserved triplet may be exposed as a kong only if the exact wait set stays fixed.
export function reservedKongTiles(p){
 if(!p.liang)return [];
 if(p.liangKongTiles)return p.liangKongTiles;
 return Object.entries(counts(p.hand)).filter(([,n])=>n===3).map(([t])=>t).filter(t=>liangKongAllowed(p,t));
}
export function liangKongAllowed(p,tile){
 if(!p.liang||counts(p.hand)[tile]!==3)return false;
 const before=(p.liangWaits||waits(p.hand,p.melds,true)).map(w=>w.tile).sort();
 const after=waits(p.hand.filter(t=>t!==tile),[...p.melds,{kind:'ming',tile}],true).map(w=>w.tile).sort();
 return before.length>0&&JSON.stringify(before)===JSON.stringify(after);
}
function liangSupplementAllowed(g,p,tile){
 const meld=p.melds.find(m=>m.kind==='peng'&&m.tile===tile&&!m.supplementForbidden);
 if(!p.liang||!meld||g.drawTile!==tile||(counts(p.hand)[tile]||0)<1)return false;
 const before=(p.liangWaits||revealedWaits({players:[p],turn:0,drawTile:tile},0)).map(w=>w.tile).sort();
 const index=p.hand.lastIndexOf(tile),hand=p.hand.filter((_,i)=>i!==index),melds=p.melds.map(m=>m===meld?{...m,kind:'bu'}:m);
 const after=waits(hand,melds,true).map(w=>w.tile).sort();
 return before.length>0&&JSON.stringify(before)===JSON.stringify(after);
}
export function selfKongOptions(g,seat=g.turn){
 if(g.phase!=='discard'||g.turn!==seat||!g.wall.length)return [];
 const p=g.players[seat],out=[];
 for(const [tile,n] of Object.entries(counts(p.hand))){
  if(n===4){
   const index=p.hand.lastIndexOf(tile),before={...p,hand:p.hand.filter((_,i)=>i!==index)};
   if(!p.liang||(g.drawTile===tile&&reservedKongTiles(before).includes(tile)&&liangKongAllowed(before,tile)))out.push({tile,kind:'an'});
  }
  const opportunity=g.drawTile===tile||(p.buOpportunities||[]).includes(tile);
  const sendsToRevealed=g.players.some((other,i)=>i!==seat&&other.liang&&revealedWaits(g,i).some(w=>w.tile===tile));
  if(opportunity&&!sendsToRevealed&&p.melds.some(m=>m.kind==='peng'&&m.tile===tile&&!m.supplementForbidden)&&(!p.liang||liangSupplementAllowed(g,p,tile)))out.push({tile,kind:'bu'});
 }
 return out;
}
export function drawSettlement(players,kongs,config) {
 // Draw readiness is a completed shape, not permission to claim a one-point win.
 const delta=[0,0,0], lines=[], ready=players.map(p=>waits(p.hand,p.melds,p.liang,1));
 const maximum=ready.map(r=>r.reduce((best,x)=>!best||x.score.raw>best.score.raw?x:best,null));
 const explanation=(seat,multiplier)=>{const best=maximum[seat];return `最大听牌 ${tileName(best.tile)}：${best.score.factors.map(f=>`${f.name}×${f.n}`).join(' · ')}${multiplier===2?'，赔付翻倍×2':''}，${best.score.raw*multiplier}倍${best.score.raw*multiplier>HU_CAP?'，按16倍封顶':''}`;};
 const yes=ready.map((r,i)=>r.length?i:-1).filter(i=>i>=0), no=[0,1,2].filter(i=>!yes.includes(i));
 const transfer=(a,b,v,why)=>{delta[a]-=v;delta[b]+=v;lines.push({from:a,to:b,amount:v,why});};
 const keepKongs=true;
 for(const k of kongs) transfer(k.from,k.to,k.amount,(k.why||'杠分')+' · 保留');
 if(yes.length>0&&no.length>0) {
  for(const a of no) for(const b of yes) transfer(a,b,amount(maximum[b].score.raw,config),'未听赔听 · '+explanation(b,1));
 } else if(yes.length===3) {
  for(let a=0;a<3;a++) if(players[a].liang) for(let b=0;b<3;b++) if(!players[b].liang)
   transfer(a,b,amount(maximum[b].score.raw*2,config),'全听：亮倒赔未亮倒 · '+explanation(b,2));
 }
 return {delta,lines,keepKongs,ready:ready.map(r=>r.map(x=>x.tile))};
}
export function winSettlement(players,winners,source,scores,kongs,config) {
 const delta=[0,0,0],lines=[...kongs.map(x=>({...x,why:x.why||'杠分'}))];
 for(const w of winners) for(let a=0;a<3;a++) if(a!==w&&(source===null||source===a)) {
  const score=scores[w][a]; if(!score?.legal||score.warning) throw Error('该结算尚未达到起胡条件');
  lines.push({from:a,to:w,amount:amount(score.raw,config),why:score.factors.map(x=>`${x.name}×${x.n}`).join(' · ')+`，原始${score.raw}倍`});
 }
 for(const l of lines){delta[l.from]-=l.amount;delta[l.to]+=l.amount;}
 return {delta,lines};
}
export function nextSeats(seats,bench,winners,source,dealer=0) {
 const out=[...seats];
 if(!winners.length) return {seats:out,bench:null,dealer};
 else if(winners.length>1) dealer=source;
 else dealer=winners[0];
 return {seats:out,bench:null,dealer};
}
export function newGame(config={mode:'bots'},previous=null,random=randomBelow) {
 config=normalizeConfig(config);
 const seats=previous?.seats||[0,1,2], dealer=previous?.dealer??random(3);
 if(seats.length!==3||new Set(seats).size!==3||seats.some(i=>!Number.isInteger(i)||i<0||i>2)||!Number.isInteger(dealer)||dealer<0||dealer>2)throw Error('仅支持三人固定座位');
 const {hands,wall,opening,wallState}=dealWall(TYPES.flatMap(t=>Array(4).fill(t)),dealer,random);
 const players=seats.map((id,i)=>({id,hand:sorted(hands[i]),dealHand:[...hands[i]],melds:[],river:[],liang:false}));
 const t=hands[dealer].at(-1);players[dealer].hand=sorted(hands[dealer].slice(0,-1));players[dealer].hand.push(t);
 return {config,seats,bench:null,dealer,players,wall,opening,wallState,turn:dealer,lastDraw:dealer,drawTile:t,phase:'discard',pending:null,kongs:[],gangChain:0,round:previous?.round||1,history:previous?.history||[],totals:previous?.totals?.slice(0,3)||[0,0,0],log:[`四边码牌11/10/11/10墩 · 骰子${opening.dice.join('+')} · 从${['南','东','北','西'][opening.side]}边数墩开牌`,'新一局开牌'],result:null};
}
export function scoresFor(g,w,source=null) {
 const p=g.players[w],hand=source===null?p.hand:[...p.hand,g.pending.tile];
 return Object.fromEntries([0,1,2].filter(a=>a!==w).map(a=>[a,evaluate(hand,p.melds,{winTile:source===null?g.drawTile:g.pending.tile,liang:p.liang,otherLiang:g.players[a].liang,self:source===null,sea:g.wall.length===0,gang:source===null?g.gangChain:0,gangShot:source!==null&&g.pending.gangShot,robKong:source!==null&&g.pending.kind==='robKong'?g.pending.gangCount:0})]));
}
export function canWin(g,w,source=null) {
 if(!g.players[w])return false;
 if(source===null){if(g.phase!=='discard'||g.turn!==w||!g.drawTile||!g.players[w].hand.includes(g.drawTile))return false;}
 else if(g.phase!=='react'||!g.pending||source!==g.pending.source||w===source||(g.players[w].passedHu||[]).includes(g.pending.tile))return false;
 return Object.entries(scoresFor(g,w,source)).filter(([a])=>source===null||+a===source).every(([,s])=>s?.legal&&!s.warning);
}
export function reactionOptions(g,seat){
 if(g.phase!=='react'||seat===g.pending.source||g.pending.responses[seat])return [];
 const p=g.players[seat],n=counts(p.hand)[g.pending.tile]||0,options=[];
 if(canWin(g,seat,g.pending.source))options.push('hu');
 if(g.pending.kind==='robKong')return options;
 if(!p.liang&&n>=2&&!(p.passedPeng||[]).includes(g.pending.tile))options.push('peng');
 if(n>=3&&g.wall.length&&(!p.liang||liangKongAllowed(p,g.pending.tile)))options.push('ming');
 return options;
}
export function autoPass(g){
 if(g.phase!=='react')return;
 for(const seat of [0,1,2]){
  if(g.phase!=='react')break;
  if(seat!==g.pending.source&&!g.pending.responses[seat]&&!reactionOptions(g,seat).length)respond(g,seat,'pass');
 }
}
export function finish(g,winners=[],source=null) {
 if(g.phase==='ended')return;
 if(winners.some(w=>!canWin(g,w,source)))throw Error('未满足胡牌动作条件');
 const scores=Object.fromEntries(winners.map(w=>[w,scoresFor(g,w,source)]));
 const s=winners.length?winSettlement(g.players,winners,source,scores,g.kongs,g.config):drawSettlement(g.players,g.kongs,g.config);
 const next=nextSeats(g.seats,g.bench,winners,source,g.dealer);
 // Freeze before rotating seats or dealing the next round; ron tile stays separate.
 g.result={...s,winners:[...winners],source,next,round:g.round,seats:[...g.seats],
  id:roundId(),endedAt:new Date().toISOString(),config:{...g.config},
  players:structuredClone(g.players),scores:structuredClone(scores),
  winTile:winners.length?(source===null?g.drawTile:g.pending.tile):null,
  kongs:structuredClone(g.kongs),actions:[...g.log].reverse()};g.phase='ended';
 s.delta.forEach((v,i)=>g.totals[g.seats[i]]+=v);
 g.history.unshift({round:g.round,seats:[...g.seats],...structuredClone(g.result)});
 g.log.unshift(winners.length?winners.map(w=>names[g.seats[w]]).join('、')+'胡牌':'流局查叫');
}
export function draw(g,seat,replacement=false) {
 if(!g.wall.length){finish(g);return;}
 const p=g.players[seat];p.passedHu=[];p.passedPeng=[];
 if(!replacement)p.buOpportunities=[];
 g.turn=seat;g.lastDraw=seat;g.drawTile=replacement?g.wall.shift():g.wall.pop();if(g.wallState)g.wallState[replacement?'back':'front']++;g.players[seat].hand=sorted(g.players[seat].hand);g.players[seat].hand.push(g.drawTile);g.phase='discard';g.pending=null;
 if(p.melds.some(m=>m.kind==='peng'&&m.tile===g.drawTile&&!m.supplementForbidden))p.buOpportunities=[...new Set([...(p.buOpportunities||[]),g.drawTile])];
 if(!replacement) g.gangChain=0;
 g.log.unshift(names[g.seats[seat]]+'摸牌');
}
export function discardPolicy(g,seat=g.turn) {
 const p=g.players[seat],all=p.hand.map((_,i)=>i);
 if(p.liang)return {allowed:all.filter(i=>i===p.hand.lastIndexOf(g.drawTile)),dangerous:[],allDangerous:false};
 const danger=new Set(g.players.flatMap((other,i)=>i!==seat&&other.liang?revealedWaits(g,i).map(x=>x.tile):[]));
 const dangerous=all.filter(i=>danger.has(p.hand[i]));
 const safe=all.filter(i=>!danger.has(p.hand[i]));
 return {allowed:safe.length?safe:all,dangerous,allDangerous:all.length>0&&safe.length===0};
}
export function discard(g,index,reveal=false) {
 if(g.phase!=='discard') throw Error('当前不是出牌阶段');
 const p=g.players[g.turn];if(!Number.isInteger(index)||index<0||index>=p.hand.length)throw Error('请选择手牌');
 if(reveal&&p.liang)throw Error('已经亮倒，不能重新宣告');
 if(!discardPolicy(g).allowed.includes(index))throw Error(p.liang?'亮倒后只允许摸切':'有安全牌可打，不能打亮倒玩家的炮牌');
 const after=p.hand.filter((_,i)=>i!==index),ready=reveal?waits(after,p.melds,true):[];
 if(reveal&&!ready.length) throw Error('打出此牌后不能听牌，无法亮倒');
 if(canWin(g,g.turn))p.passedHu=[...new Set([...(p.passedHu||[]),g.drawTile])];
 const expired=new Set([...(p.buOpportunities||[]),g.drawTile]);
 for(const m of p.melds)if(m.kind==='peng'&&expired.has(m.tile)&&p.hand.includes(m.tile))m.supplementForbidden=true;
 p.buOpportunities=[];
 const tile=p.hand.splice(index,1)[0];p.river.push(tile);p.hand=sorted(p.hand);if(reveal){p.liang=true;p.liangWaits=ready;p.liangKongTiles=reservedKongTiles(p);}
 g.discardSerial=(g.discardSerial||0)+1;
 g.lastDiscard={seat:g.turn,tile,index:p.river.length-1,handIndex:index,serial:g.discardSerial};
 g.pending={tile,source:g.turn,responses:{},gangShot:g.gangChain};g.gangChain=0;g.phase='react';g.log.unshift(names[g.seats[g.turn]]+'打出'+tileName(tile)+(reveal?'并亮倒':'')+(g.pending.gangShot?'（杠后出牌）':''));
 autoPass(g);
}
export function respond(g,seat,choice) {
 if(!['pass','peng','ming','hu'].includes(choice))throw Error('无效响应');
 if(g.phase!=='react'||seat===g.pending.source||g.pending.responses[seat])throw Error('当前座位不能响应');
 const p=g.players[seat],n=counts(p.hand)[g.pending.tile]||0;
 const options=reactionOptions(g,seat);
 if(choice!=='pass'&&!options.includes(choice))throw Error('未满足胡牌或碰杠条件');
 if(choice!=='hu'&&options.includes('hu'))p.passedHu=[...new Set([...(p.passedHu||[]),g.pending.tile])];
 if(choice==='pass'&&options.includes('peng'))p.passedPeng=[...new Set([...(p.passedPeng||[]),g.pending.tile])];
 g.pending.responses[seat]=choice;
 if(Object.keys(g.pending.responses).length<2)return;
 const source=g.pending.source, tile=g.pending.tile, responses=g.pending.responses;
 const winners=[0,1,2].filter(i=>responses[i]==='hu');
 if(g.pending.kind==='robKong'){
  if(winners.length){
   const actor=g.players[source];actor.hand.splice(actor.hand.indexOf(tile),1);actor.river.push(tile);
   finish(g,winners,source);
  }else completeSelfKong(g,tile,'bu',g.pending.gangCount);
  return;
 }
 if(winners.length){finish(g,winners,source);return;}
 const claimant=[(source+1)%3,(source+2)%3].find(i=>['peng','ming'].includes(responses[i]));
 if(claimant!==undefined){
  const kind=responses[claimant],pl=g.players[claimant],take=kind==='peng'?2:3;
  const supplementForbidden=kind==='peng'&&counts(pl.hand)[tile]===3;
  for(let i=0;i<take;i++)pl.hand.splice(pl.hand.indexOf(tile),1);
  const chain=kind==='ming'?(g.pending.gangShot||0)+1:0;
  pl.melds.push({kind,tile,...(supplementForbidden?{supplementForbidden:true}:{})});g.players[source].river.pop();g.pending=null;g.turn=claimant;g.gangChain=chain;
  g.log.unshift(names[g.seats[claimant]]+(kind==='peng'?'碰':'明杠')+tileName(tile));
  if(kind==='ming'){g.kongs.push({from:source,to:claimant,amount:2*g.config.base*2**(chain-1),why:`明杠 ${tileName(tile)} · 连续第${chain}杠`});pl.buOpportunities=[];draw(g,claimant,true);}else{g.phase='discard';g.drawTile=null;pl.buOpportunities=[];}
 } else draw(g,(source+1)%3);
}

export function distance(hand,melds=[]) {
 const sp=new Majiang.Shoupai(hand);sp._fulou=melds.map(meldString);sp._zimo=null;
 const normal=Majiang.Util.xiangting_yiban(sp);
 const pairs=Object.values(counts(hand)).reduce((n,c)=>n+Math.floor(c/2),0);
 return melds.length?normal:Math.min(normal,6-pairs);
}
export function visibleCounts(g,seat) {
 const vis={}; const add=t=>{if(TYPES.includes(t))vis[t]=(vis[t]||0)+1;};
 if(!g||!g.players)return vis;
 const me=g.players[seat];
 if(me?.hand)for(const t of me.hand)add(t);
 for(let i=0;i<g.players.length;i++){
  const p=g.players[i];if(!p)continue;
  if(p.river)for(const t of p.river)add(t);
  if(p.melds)for(const m of p.melds){const n=m.kind==='peng'?3:4;for(let k=0;k<n;k++)add(m.tile);}
  if(i!==seat&&p.liang&&p.hand){const hidden=reservedKongTiles(p);for(const t of p.hand)if(!hidden.includes(t))add(t);}
 }
 if(g.pending?.kind==='robKong'&&g.pending.source!==seat&&!g.players[g.pending.source].liang)add(g.pending.tile);
 return vis;
}
export function chooseDiscard(p,drawTile,allowed=null,g=null,seat=null) {
 if(p.liang)return {index:p.hand.lastIndexOf(drawTile),reveal:false};
 const withGame=Boolean(g&&seat!==null&&seat!==undefined);
 const vis=withGame?visibleCounts(g,seat):null;
 const selfOwned=!withGame?counts([...p.hand,...p.melds.flatMap(m=>Array(m.kind==='peng'?3:4).fill(m.tile))]):null;
 const rem=t=>Math.max(0,4-((withGame?vis[t]:selfOwned[t])||0));
 const options=[];
 for(let index=0;index<p.hand.length;index++) {
  if(allowed&&!allowed.includes(index))continue;
  if(p.hand.indexOf(p.hand[index])!==index)continue;
  const h=p.hand.filter((_,i)=>i!==index), ready=waits(h,p.melds,true), d=distance(h,p.melds);
  let outs=0;
  for(const t of TYPES)if(rem(t)>0&&distance([...h,t],p.melds)<d)outs+=rem(t);
  const readyOuts=ready.reduce((s,w)=>s+rem(w.tile),0);
  const maxRaw=ready.reduce((m,w)=>Math.max(m,w.score?.raw||0),0);
  let shouldReveal=false;
  if(ready.length>0) {
   const condA=readyOuts>=2;
   const condB=!g||g.wall.length>=10;
   const oppLiang=Boolean(g&&g.players&&g.players.some((op,i)=>i!==seat&&op.liang));
   const condC=!oppLiang||readyOuts>=4||(maxRaw>=4&&readyOuts>=2);
   shouldReveal=condA&&condB&&condC;
  }
  options.push({index,reveal:shouldReveal,d,outs,ready:ready.length,readyOuts,maxRaw});
 }
 return options.sort((a,b)=>Number(b.reveal)-Number(a.reveal)||a.d-b.d||(b.readyOuts||0)-(a.readyOuts||0)||b.outs-a.outs||b.ready-a.ready)[0];
}
// Basic companion uses only its own hand and public actions, never opponents' concealed tiles.
export function botStep(g,seat) {
 if(g.phase==='ended')return;
 const p=g.players[seat];
 if(g.phase==='react') {
  if(seat===g.pending.source||g.pending.responses[seat])return;
  if(canWin(g,seat,g.pending.source)){respond(g,seat,'hu');return;}
  const t=g.pending.tile,n=counts(p.hand)[t]||0;
  if(reactionOptions(g,seat).includes('ming')){respond(g,seat,'ming');return;}
  if(reactionOptions(g,seat).includes('peng')){
   const h=[...p.hand];h.splice(h.indexOf(t),1);h.splice(h.indexOf(t),1);
   const after={hand:h,melds:[...p.melds,{kind:'peng',tile:t}],liang:false};
   const best=chooseDiscard(after,null);
   if(best.d<distance(p.hand,p.melds)){respond(g,seat,'peng');return;}
  }
  respond(g,seat,'pass');return;
 }
 if(g.turn!==seat)return;
 if(canWin(g,seat)){finish(g,[seat]);return;}
 const option=selfKongOptions(g,seat)[0];if(option){kong(g,option.tile,option.kind);return;}
 const best=chooseDiscard(p,g.drawTile,discardPolicy(g,seat).allowed,g,seat);discard(g,best.index,best.reveal);
}
export function kong(g,tile,kind) {
 if(g.phase!=='discard'||!g.wall.length)throw Error('当前不能杠');
 const p=g.players[g.turn];
 if(p.melds.some(m=>m.kind==='peng'&&m.tile===tile&&m.supplementForbidden)&&kind==='bu')throw Error('这组牌已放弃杠，不能再补杠');
 if(!selfKongOptions(g).some(o=>o.tile===tile&&o.kind===kind))throw Error('当前不能杠：须有当次机会、不改变亮倒听口且不向亮倒对手送胡');
 const chain=g.gangChain+1;
 if(kind==='bu'){
  g.pending={kind:'robKong',tile,source:g.turn,gangCount:chain,responses:{}};g.phase='react';
  g.log.unshift(names[g.seats[g.turn]]+'申请补杠'+tileName(tile));autoPass(g);return;
 }
 completeSelfKong(g,tile,kind,chain);
}
function completeSelfKong(g,tile,kind,chain){
 const p=g.players[g.turn];
 const n=counts(p.hand)[tile]||0;
 if(kind==='an') {if(n!==4)throw Error('暗杠需4张'); for(let i=0;i<4;i++)p.hand.splice(p.hand.indexOf(tile),1);p.melds.push({kind,tile});}
 else {const m=p.melds.find(m=>m.kind==='peng'&&m.tile===tile);if(!m||!n)throw Error('不能补杠');if(m.supplementForbidden)throw Error('这组牌已选择碰并放弃杠，不能再补杠');p.hand.splice(p.hand.indexOf(tile),1);m.kind='bu';}
 p.buOpportunities=(p.buOpportunities||[]).filter(t=>t!==tile);
 for(let a=0;a<3;a++)if(a!==g.turn)g.kongs.push({from:a,to:g.turn,amount:(kind==='an'?2:1)*g.config.base*2**(chain-1),why:(kind==='an'?'暗杠 ':'补杠 ')+tileName(tile)+` · 连续第${chain}杠`});
 g.gangChain=chain;g.log.unshift(names[g.seats[g.turn]]+(kind==='an'?'暗杠':'补杠')+tileName(tile));draw(g,g.turn,true);
}
