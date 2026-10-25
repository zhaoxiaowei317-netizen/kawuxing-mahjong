import {names as defaultNames,tileName,sorted} from './engine.js';

const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const signed=v=>(v>0?'+':'')+v;
const face=(t,win=false)=>`<span class="settle-tile ${win?'winning-tile':''}"><img src="assets/${t}.svg" alt="${tileName(t)}">${win?'<b>胡</b>':''}</span>`;
export const roundTime=r=>r.endedAt?new Date(r.endedAt).toLocaleString('zh-CN',{hour12:false}):'早期记录';

export function roundSummaryHTML(r,names=defaultNames){return `<strong>第 ${r.round} 局 · ${r.winners?.length?r.winners.map(w=>esc(names[r.seats[w]])).join('、')+(r.source===null?'自摸':'胡牌'):'流局查叫'}</strong><span class="round-summary-scores">${r.delta.map((v,i)=>`<span class="${v>0?'positive':v<0?'negative':''}">${esc(names[r.seats[i]])} ${signed(v)}分</span>`).join('')}</span>`;}
export function historyHTML(history,names=defaultNames){return history.map(r=>`<details class="history-round" data-round-id="${esc(r.id||r.round)}"><summary>${roundSummaryHTML(r,names)}</summary>${resultHTML(r,r.seats,names)}</details>`).join('');}
export function totalsHTML(totals,names=defaultNames){return `<div class="match-totals">${names.map((name,i)=>`<p>${esc(name)} <strong class="${totals[i]>=0?'positive':'negative'}">${signed(totals[i]||0)}分</strong></p>`).join('')}</div>`;}
export function resultHTML(r,seats,names=defaultNames){
 const winners=r.winners||[],isWin=winners.length>0;
 const title=isWin?winners.map(w=>names[seats[w]]).join('、')+(r.source===null?'自摸':'胡牌'):'流局查叫';
 const hands=r.players?`<div class="settled-hands">${r.players.map((p,i)=>{
  const won=winners.includes(i),hand=sorted(p.hand);
  if(won&&r.source===null){const index=hand.lastIndexOf(r.winTile);if(index>=0)hand.splice(index,1);}
  const status=won?(r.source===null?'自摸':'接炮胡'):r.source===i?'放炮':!isWin?(r.ready?.[i]?.length?'已听牌':'未听牌'):'未胡';
  const scoreDescriptions=won?[...new Set(Object.entries(r.scores?.[i]||{}).filter(([payer])=>r.source===null||+payer===r.source).map(([,s])=>s.factors.map(f=>`${f.name}×${f.n}`).join(' · ')))]:[];
  return `<article class="settled-player ${won?'is-winner':''}" data-settled-seat="${i}"><div class="settled-player-heading"><strong>${names[seats[i]]}</strong><span>${status}${p.liang?' · 亮倒':''}</span><b class="${r.delta[i]>=0?'positive':'negative'}">${signed(r.delta[i])}分</b></div><div class="settled-tiles">${p.melds.map(m=>`<span class="settled-meld">${Array(m.kind==='peng'?3:4).fill(m.tile).map(t=>face(t)).join('')}<small>${({peng:'碰',ming:'明杠',an:'暗杠',bu:'补杠'})[m.kind]}</small></span>`).join('')}<span class="settled-concealed">${hand.map(t=>face(t)).join('')}</span>${won?face(r.winTile,true):''}</div>${scoreDescriptions.length?`<div class="settled-patterns">${scoreDescriptions.map(esc).join('<br>')}</div>`:''}${!isWin&&r.ready?.[i]?.length?`<div class="settled-patterns">听：${r.ready[i].map(tileName).join('、')}</div>`:''}</article>`;
 }).join('')}</div>`:'<p class="legacy-record">此条早期记录未保存手牌快照，仅保留分数流水。</p>';
 const paid=i=>r.lines.filter(l=>l.from===i).reduce((s,l)=>s+l.amount,0);
 const received=i=>r.lines.filter(l=>l.to===i).reduce((s,l)=>s+l.amount,0);
 return `<section class="result detailed-result"><div class="result-title"><h2>${title}</h2><span class="badge">${winners.length>1?'一炮多响':isWin?'本局结算':r.keepKongs?'保留杠分':'取消杠分'}</span></div><div class="settlement-meta">${r.round?'第 '+r.round+' 局 · ':''}${roundTime(r)}${r.config?` · 底分 ${r.config.base} · ${r.config.cap?r.config.cap+'倍封顶':'无封顶'}`:''}</div><div class="score-grid">${r.delta.map((v,i)=>`<div><span>${names[seats[i]]}</span><strong class="${v>=0?'positive':'negative'}">${signed(v)}</strong><small>收入 ${received(i)} / 支出 ${paid(i)}</small></div>`).join('')}</div>${hands}<details class="round-ledger" open><summary>本局积分流水 · ${r.lines.length}笔</summary>${r.lines.map((l,i)=>`<div class="settlement-line"><span><small class="ledger-number">${i+1}</small>${names[seats[l.from]]} → ${names[seats[l.to]]}<small>${esc(l.why)}</small></span><b>${l.amount}分</b></div>`).join('')||'<p>无积分转移</p>'}${!isWin&&!r.keepKongs&&r.kongs?.length?'<p class="cancelled-kongs">本局预记杠分已取消，不计入收支。</p>':''}</details>${r.actions?.length?`<details class="round-actions"><summary>出牌记录 · ${r.actions.length}条</summary><ol>${r.actions.map(a=>`<li>${esc(a)}</li>`).join('')}</ol></details>`:''}${r.next?`<p class="next-dealer">下一局庄家：${names[r.next.seats[r.next.dealer]]}${r.next.bench!==null?' · 候场：'+names[r.next.bench]:''}</p>`:''}<button class="ledger-link" data-nav="history">查看每局流水</button></section>`;
}
