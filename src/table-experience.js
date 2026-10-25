import {createWinEffects} from './win-effects.js';
import {names} from './engine.js';
import {resultHTML,historyHTML} from './settlement.js';
import {speak,speakSequence,unlockVoice,resetVoiceQueue} from './voice.js';
let audio,lastDiscard=null,lastRound=null,lastResult=null,lastMelds=null,lastLiang=null,historyOpen=false;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enabled=()=>localStorage.getItem('kwx-sound')!=='off';
function unlock(){try{audio??=new AudioContext();if(audio.state==='suspended')audio.resume().catch(()=>{});unlockVoice();}catch{}}
document.addEventListener('pointerdown',unlock,{passive:true});
function clack(){if(!enabled()||!audio||audio.state!=='running')return;
 const now=audio.currentTime;for(const [delay,freq,gain] of [[0,850,.10],[.025,340,.06]]){const o=audio.createOscillator(),v=audio.createGain();o.type='triangle';o.frequency.setValueAtTime(freq,now+delay);o.frequency.exponentialRampToValueAtTime(freq*.45,now+delay+.055);v.gain.setValueAtTime(gain,now+delay);v.gain.exponentialRampToValueAtTime(.001,now+delay+.07);o.connect(v);v.connect(audio.destination);o.start(now+delay);o.stop(now+delay+.08);}}

let effectStorage;try{effectStorage=sessionStorage;}catch{}
const winEffects=createWinEffects({document,storage:effectStorage,names,stop:resetVoiceQueue,reduced:()=>matchMedia('(prefers-reduced-motion: reduce)').matches,say:cues=>{resetVoiceQueue();return speakSequence(cues);}});
document.addEventListener('click',e=>{if(e.target.closest('[data-action="next"],[data-action="menu"],[data-room-exit],[data-ledger],[data-nav]')){winEffects.clear();resetVoiceQueue();}},true);

export function resetTableExperience(){winEffects.reset();lastDiscard=null;lastResult=null;lastRound=null;lastMelds=null;lastLiang=null;historyOpen=false;resetVoiceQueue();document.querySelector('.win-celebration')?.remove();document.querySelector('#live-ledger')?.remove();}
export function winnerCards(result){return (result.winners||[]).map(w=>{
 const score=Object.entries(result.scores?.[w]||{}).find(([payer])=>result.source===null||+payer===result.source)?.[1];
 const factors=score?.factors||[];
 const patterns=factors.filter(f=>!['亮倒','杠上开花','海底','杠上杠'].some(s=>f.name.includes(s))).map(f=>f.name);
 return {name:names[result.seats[w]],patterns:patterns.length?patterns.join(' · '):'胡牌',details:factors.map(f=>`${f.name} ×${f.n}`).join(' · '),method:result.source===null?'自摸':'胡牌'};
});}
export function mountTableExperience(g,ico,{exit,history=g.history}={}){
 const arena=document.querySelector('#arena');if(!arena)return;
 const tools=document.createElement('div');tools.className='table-quick-tools';tools.innerHTML=`<button class="hud-icon" data-ledger title="每局流水" aria-label="流水">${ico('history')}</button>${exit?`<button class="hud-icon" data-room-exit title="退出房间" aria-label="退出房间">${ico('log-out')}</button>`:''}`;arena.append(tools);
 const existing=document.querySelector('#live-ledger'),expanded=new Set([...existing?.querySelectorAll('.history-round[open]')||[]].map(el=>el.dataset.roundId)),scroll=existing?.scrollTop||0;if(existing){historyOpen=existing.open;existing.remove();}
 const dialog=document.createElement('dialog');dialog.id='live-ledger';dialog.innerHTML=`<div class="ledger-heading"><h2>每局流水</h2><button data-ledger-close aria-label="关闭流水">${ico('x')}</button></div>${history?.length?historyHTML(history):'<p>暂无已结算的对局。</p>'}`;
 dialog.querySelectorAll('.ledger-link').forEach(b=>b.remove());dialog.querySelectorAll('.history-round').forEach(el=>el.open=expanded.has(el.dataset.roundId));document.body.append(dialog);
 const open=()=>{historyOpen=true;if(!dialog.open)dialog.showModal();};tools.querySelector('[data-ledger]').onclick=open;
 dialog.querySelector('[data-ledger-close]').onclick=()=>dialog.close();dialog.onclose=()=>{historyOpen=false;};if(historyOpen){dialog.showModal();dialog.scrollTop=scroll;}
 tools.querySelector('[data-room-exit]')?.addEventListener('click',exit);
 document.querySelectorAll('[data-nav="history"]').forEach(b=>b.onclick=open);
 const sound=document.querySelector('[data-action="sound"]');if(sound){tools.append(sound);sound.setAttribute('aria-label',enabled()?'关闭出牌声音':'开启出牌声音');sound.title=sound.getAttribute('aria-label');sound.setAttribute('aria-pressed',String(enabled()));sound.onclick=()=>{localStorage.setItem('kwx-sound',enabled()?'off':'on');if(!enabled())resetVoiceQueue();sound.setAttribute('aria-pressed',String(enabled()));sound.title=enabled()?'关闭出牌声音':'开启出牌声音';sound.setAttribute('aria-label',sound.title);unlock();};}
 const key=g.lastDiscard?JSON.stringify([g.round,g.lastDiscard.serial,g.lastDiscard.seat,g.lastDiscard.index,g.lastDiscard.tile]):null;
 const melds=g.players.map(p=>p.melds.map(m=>`${m.kind}:${m.tile}`).join(',')).join('|'),liang=g.players.map(p=>p.liang?'1':'0').join('');
 if(lastRound===g.round){
  if(key&&key!==lastDiscard){clack();speak(g.lastDiscard.tile,{delay:.1});}
  if(lastMelds&&melds!==lastMelds){for(let i=0;i<g.players.length;i++){const before=(lastMelds.split('|')[i]||'').split(',').filter(Boolean),after=g.players[i].melds;if(after.length>before.length){const kind=after.at(-1).kind;speak(kind==='peng'?'碰':kind==='an'?'暗杠':kind==='bu'?'补杠':'明杠');break;}}}
  if(lastLiang&&liang!==lastLiang){const old=lastLiang.split('');if(g.players.some((p,i)=>p.liang&&old[i]!=='1'))speak('亮倒');}
 }
 lastDiscard=key;lastMelds=melds;lastLiang=liang;lastRound=g.round;
 winEffects.update(g);
}
