import {createIcons,Menu,X,Settings,RotateCcw,BookOpen,History,FlaskConical,Download,ArrowRight,Volume2,Maximize,LogOut} from 'lucide';
import {rulesHTML} from './rules.js';
import {names,tileName} from './engine.js';
import {gameTable} from './game-table.js';
import {mountScene,resizeScene} from './table-scene.js';
import {animateOpeningHand} from './deal-animation.js';
import {resultHTML,historyHTML,totalsHTML} from './settlement.js';
import {archiveRoom,loadArchives} from './room-archives.js';
import {mountTableExperience,resetTableExperience} from './table-experience.js';
const icons={Menu,X,Settings,RotateCcw,BookOpen,History,FlaskConical,Download,ArrowRight,Volume2,Maximize,LogOut};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ico=n=>`<i data-lucide="${n}"></i>`;
const tile=(t,cls='',attrs='')=>t==='?'?`<button class="tile face-down ${cls}" ${attrs} aria-label="暗牌"><span aria-hidden="true">◆</span></button>`:`<button class="tile ${cls}" ${attrs}><img src="assets/${t}.svg" alt="${esc(tileName(t))}"></button>`;
let credentials;try{credentials=JSON.parse(localStorage.getItem('kwx-online'));}catch{}
let state,selected=-1,liang=false,busy=false,shownRound=0,animating=false,polling=false,watchSeat=0;
let endpoint=localStorage.getItem('kwx-server')||'';
let disconnected=false,retryAt=0,failures=0,connectionMessage='';
let archiveWarning=false;
function saveArchive(snapshot=state){try{archiveRoom(localStorage,snapshot,endpoint);}catch{if(!archiveWarning){archiveWarning=true;notice('浏览器战绩保存失败，请导出备份，勿清除浏览器数据。');}}}
function archivedPage(){
 let records=[];try{records=loadArchives(localStorage);}catch{notice('历史战绩读取失败');}
 document.querySelector('#app').innerHTML=`<section class="session-screen archive-screen"><h1>历史战绩</h1><button data-home>返回大厅</button><button data-backup>导出战绩</button>${records.map(r=>`<section class="archived-room"><h2>房间 ${esc(r.code)} · ${r.history.length}局</h2>${totalsHTML(r.totals,r.names)}${historyHTML(r.history,r.names)}</section>`).join('')||'<p>暂无已保存的战绩</p>'}</section>`;
 document.querySelectorAll('.ledger-link').forEach(b=>b.remove());
 document.querySelector('[data-home]').onclick=home;
 document.querySelector('[data-backup]').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(records,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='kawuxing-history.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
}
function connectionUI(message=''){
 document.querySelector('#connection-status')?.remove();
 if(!credentials||!disconnected)return;
 const box=document.createElement('div');box.id='connection-status';box.setAttribute('role','status');
 const label=document.createElement('span');label.textContent=message||connectionMessage||'连接中断，正在自动重连…';box.append(label);
 const button=document.createElement('button');button.textContent='立即重连';button.onclick=()=>{retryAt=0;refresh();};box.append(button);document.body.append(box);
 if(/不存在|失效/.test(connectionMessage)){const back=document.createElement('button');back.textContent='返回大厅';back.onclick=()=>{credentials=null;state=null;localStorage.removeItem('kwx-online');connectionRestored();resetTableExperience();document.body.classList.remove('playing');home();};box.append(back);}
}
function connectionFailed(e){disconnected=true;failures++;retryAt=Date.now()+Math.min(10000,1000*2**Math.min(failures-1,4));connectionMessage=e.message.includes('房间不存在')?'原房间已不存在，服务器可能已清空房间数据。':e.message.includes('凭证无效')?'原入桌凭证失效，无法恢复座位。':'连接中断，正在自动重连，座位凭证已保留…';connectionUI();}
function connectionRestored(){disconnected=false;failures=0;retryAt=0;connectionMessage='';connectionUI();}
async function leaveRoom(){
 if(busy||!credentials)return;
 if(state?.game&&!state.closed&&!state.complete&&!confirm('退出会结束整桌游戏，其他玩家也会停止本桌；已经结算的分数保留，未完成的本局不计分。确定退出？'))return;
 busy=true;try{const result=await api('/api/leave',{code:credentials.code});saveArchive(result.snapshot||state);credentials=null;state=null;selected=-1;liang=false;shownRound=0;animating=false;watchSeat=0;localStorage.removeItem('kwx-online');connectionRestored();resetTableExperience();document.body.classList.remove('playing');home();}catch(e){notice(e.message);}finally{busy=false;}
}
function notice(s){document.querySelector('#toast').textContent=s;document.querySelector('#toast').classList.add('visible');setTimeout(()=>document.querySelector('#toast').classList.remove('visible'),4000);}
async function api(path,body){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const res=await fetch(endpoint+path,{signal:controller.signal,cache:'no-store',method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(credentials?{Authorization:'Bearer '+credentials.token}:{})},body:body?JSON.stringify(body):undefined});const data=await res.json();if(!res.ok)throw Error(data.error||'连接失败');return data;}catch(e){if(e.name==='AbortError')throw Error('连接超时');throw e;}finally{clearTimeout(timer);}}
function home(){document.querySelector('#app').innerHTML=`<section class="session-screen"><h1>好友卡五星</h1><h2>好友联机</h2><form id="entry"><label>昵称<input name="name" maxlength="12" required></label><p class="room-capacity">三人固定对局 · 三人准备后开局 · 固定16倍封顶</p><label>局数<select name="limit"><option>16</option><option>24</option><option>32</option></select></label><label>房间号<input name="code" inputmode="numeric" maxlength="6"></label><label>服务器地址<input name="endpoint" type="url" placeholder="同一服务器打开时留空" value="${esc(endpoint)}"></label><button name="join" value="create">建房</button><button name="join" value="join">加入</button></form></section>`;
 document.querySelector('.session-screen').insertAdjacentHTML('beforeend','<button data-archives>历史战绩</button>');document.querySelector('[data-archives]').onclick=archivedPage;
 document.querySelector('#entry').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;try{const f=new FormData(e.target),value=String(f.get('endpoint')).trim();if(value&&!/^https?:\/\//.test(value))throw Error('服务器地址无效');endpoint=value.replace(/\/$/,'');localStorage.setItem('kwx-server',endpoint);credentials=null;const input=Object.fromEntries(f),scope=JSON.stringify([endpoint,e.submitter.value,input.code,input.name]);let attempt;try{attempt=JSON.parse(localStorage.getItem('kwx-join-attempt'));}catch{}if(attempt?.scope!==scope){attempt={scope,key:crypto.randomUUID()};localStorage.setItem('kwx-join-attempt',JSON.stringify(attempt));}input.joinKey=attempt.key;input.active=input.spectate!=='on';const data=await api(e.submitter.value==='create'?'/api/create':'/api/join',input);localStorage.removeItem('kwx-join-attempt');credentials={code:data.code,token:data.token};localStorage.setItem('kwx-online',JSON.stringify(credentials));state=data;render();}catch(e){notice(e.message);}finally{busy=false;}};
}
function layout(){const el=document.querySelector('#arena');if(!el)return;const portrait=innerHeight>innerWidth,w=portrait?innerHeight:innerWidth,h=portrait?innerWidth:innerHeight,scale=h/720,width=Math.max(1100,w/scale);el.style.width=width+'px';el.style.transform=`translate(-50%,-50%) rotate(${portrait?90:0}deg) scale(${Math.min(scale,w/width)})`;resizeScene();}
window.addEventListener('resize',layout);
function participationLabel(){const m=state.members[state.id];return m.pendingInactive?'本局后下场':m.active===false?'已挂起':state.waitingForPlayers?'等待三人准备':state.seat>=0?'本局参与':state.game?(m.ready?'等待恢复参与':'本局观战 · 待准备'):'等待参与';}
function participationControls(){const m=state.members[state.id],canReady=state.seat<0||!state.game||state.game.phase==='ended';return `<section class="participation-controls"><strong>${participationLabel()}</strong><p>在场时挂起，本局正常结算后下场，仍由本人完成本局。历史结算保留。</p><button data-participation>${m.pendingInactive?'撤销本局后挂起':m.active===false?'恢复参与':state.game&&state.game.phase!=='ended'&&state.seat>=0?'本局后挂起':'挂起观战'}</button>${m.active!==false&&canReady?`<button data-ready>${m.ready?'取消准备':'准备参与后续牌局'}</button>`:''}</section>`;}
function bindParticipation(){document.querySelectorAll('[data-resume-game]').forEach(b=>b.addEventListener('click',()=>send({type:'resume'})));document.querySelector('[data-participation]')?.addEventListener('click',()=>send({type:'participation',active:state.members[state.id].active===false}));document.querySelector('[data-ready]')?.addEventListener('click',()=>send({type:'ready',ready:!state.members[state.id].ready}));}
function render(){if(!state)return home();saveArchive();state.members.forEach((m,i)=>names[i]=m.name);const g=state.game;document.body.classList.toggle('playing',!!g&&!state.complete&&!state.closed);
 if(state.closed){resetTableExperience();document.querySelector('#app').innerHTML=`<section class="session-screen"><h1>本桌已结束</h1><p>${esc(state.closedReason||'房间已关闭')}</p>${g?totalsHTML(g.totals,state.members.map(m=>m.name)):''}<button data-exit>返回大厅</button>${historyHTML(g?.history||[])}</section>`;document.querySelectorAll('.ledger-link').forEach(b=>b.remove());document.querySelector('[data-exit]').onclick=leaveRoom;return;}
 if(!g){document.querySelector('#app').innerHTML=`<section class="session-screen"><h1>房间 ${state.code}</h1><h2>${state.limit}局 · 三人固定对局 · 16倍封顶</h2><p>已有 ${state.eligibleCount||0} 人准备参与，满3人即可开始。挂起者无需准备。</p><div class="ready-seats">${Array.from({length:3},(_,i)=>`<div class="ready-player"><img src="assets/avatar-${i}.png" alt=""><strong>${esc(state.members[i]?.name||'等待加入')}</strong><span>${state.members[i]?state.members[i].active===false?'已挂起 · 观战':state.members[i].ready?'已准备参与':'未准备':'空位'}</span></div>`).join('')}</div>${participationControls()}<button data-exit>退出</button></section>`;}

 else if(state.complete){resetTableExperience();document.querySelector('#app').innerHTML=`<section class="session-screen"><h1>整场结算 · ${state.code}</h1>${totalsHTML(g.totals,state.members.map(m=>m.name))}${historyHTML(g.history)}<button data-exit>返回大厅</button></section>`;document.querySelectorAll('.ledger-link').forEach(b=>b.remove());}
 else{
  const spectator=state.seat<0,view=spectator?watchSeat:state.seat,revealedViewer=!spectator&&g.players[view].liang;
  document.querySelector('#app').innerHTML=gameTable(g,view,selected,spectator,false,false,tile,ico,resultHTML,liang);layout();mountScene(document.querySelector('#scene-host'),g,view,false);
  if(spectator){document.querySelector('#arena').insertAdjacentHTML('beforeend',`<nav class="spectator-switch" aria-label="观战视角">${g.players.map((p,i)=>`<button data-watch="${i}" aria-pressed="${view===i}">${esc(names[p.id])}</button>`).join('')}</nav>`);document.querySelectorAll('[data-watch]').forEach(b=>b.onclick=()=>{watchSeat=+b.dataset.watch;selected=-1;liang=false;render();});document.querySelector('.current-status').textContent=participationLabel()+' · '+names[g.players[view].id];document.querySelectorAll('.game-actions button, [data-choice], [data-tile-index]').forEach(b=>b.disabled=true);}
  document.querySelector('.game-title small').textContent=`房间 ${state.code} · ${g.round}/${state.limit}局`;
  document.querySelectorAll('[data-seat]').forEach(b=>b.disabled=true);
  document.querySelectorAll('[data-tile-index]').forEach(b=>{b.onclick=()=>{if(animating||spectator)return;selected=+b.dataset.tileIndex;render();};b.oncontextmenu=e=>{e.preventDefault();if(animating||spectator||g.phase!=='discard'||g.turn!==state.seat)return;const index=+b.dataset.tileIndex;if(b.dataset.discardAllowed!=='true'){notice('这张牌当前不能出');return;}send({type:'discard',index,reveal:false});};});
  document.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>send({type:'respond',choice:b.dataset.choice}));
  document.querySelectorAll('[data-kong-tile]').forEach(b=>b.onclick=()=>send({type:'kong',tile:b.dataset.kongTile,kind:b.dataset.kongKind}));
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.action;if(a==='discard'||a==='liang-confirm')send({type:'discard',index:selected,reveal:a==='liang-confirm'});else if(a==='win')send({type:'win'});else if(a==='next')send({type:'next'});else if(a==='liang'){liang=true;render();}else if(a==='liang-cancel'){liang=false;render();}else if(a==='menu')document.querySelector('#game-menu').showModal();else if(a==='menu-close')document.querySelector('#game-menu').close();else if(a==='fullscreen')document.documentElement.requestFullscreen?.();});
  document.querySelectorAll('[data-nav]:not([data-nav="history"]):not([data-nav="rules"]), [data-action="settings"], [data-action="undo"], [data-action="export"], .reveal-option').forEach(b=>b.remove());
  document.querySelector('[data-action="pass-kong"]')?.addEventListener('click',()=>send({type:'discard',index:g.players[state.seat].hand.lastIndexOf(g.drawTile)}));
  mountTableExperience(g,ico,{exit:leaveRoom});
  document.querySelector('[data-nav="rules"]')?.addEventListener('click',()=>{const d=document.createElement('dialog');d.className='rules-dialog';d.innerHTML=rulesHTML()+'<form method="dialog"><button>关闭</button></form>';document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();});
  document.querySelector('#game-menu .menu-heading').insertAdjacentHTML('afterend',participationControls());
  document.querySelector('.game-title small').textContent+=' · '+participationLabel();
  if(g.phase==='ended'){const forecast=document.querySelector('.round-sheet .next-dealer');if(forecast)forecast.textContent=state.waitingForPlayers?'下一局：等待三名参与者准备':'下一局按当前参与状态安排，按已确认轮庄规则安排，三人座位固定';}
  if(g.phase==='ended')document.querySelectorAll('[data-action="next"]').forEach(b=>{b.textContent=state.waitingForPlayers?'等待三名参与者准备':'下一局即将自动开始';b.disabled=true;});
  if(shownRound!==g.round){shownRound=g.round;if(g.phase!=='ended'&&!spectator&&g.wall.length===44&&g.players.every(p=>!p.river.length&&!p.melds.length)){animating=true;document.querySelectorAll('.game-actions button').forEach(b=>b.disabled=true);animateOpeningHand(g,view,()=>{animating=false;render();});}}
 }
 const member=state.members[state.id];if(!state.closed&&!state.complete&&(member.active===false||(!member.ready&&(state.seat<0||!g||g.phase==='ended')))){document.querySelector('#app').insertAdjacentHTML('beforeend',`<aside class="resume-game-control"><button data-resume-game>${member.active===false?'恢复游戏':'准备游戏'}</button><span>${member.pendingInactive?'取消本局后挂起，继续参与后续牌局':'恢复参与并准备；满三人后开始下一局'}</span></aside>`);}
 bindParticipation();createIcons({icons});document.querySelector('[data-exit]')?.addEventListener('click',leaveRoom);
}
async function send(body){if(busy||animating||disconnected)return;busy=true;let failed=false;try{state=await api('/api/action',{...body,code:credentials.code,version:state.version});selected=-1;liang=false;connectionRestored();render();}catch(e){failed=true;notice(e.message);}finally{busy=false;}if(failed){retryAt=0;await refresh();}}
async function refresh(){if(!credentials||polling||busy||Date.now()<retryAt)return;polling=true;const current=credentials;try{const next=await api('/api/room?code='+current.code);if(credentials!==current)return;const recovered=disconnected;connectionRestored();if(!state||next.version>state.version||(recovered&&next.version===state.version)){state=next;selected=-1;liang=false;if(!animating)render();}}catch(e){if(credentials===current)connectionFailed(e);}finally{polling=false;}}
window.addEventListener('online',()=>{retryAt=0;refresh();});
window.addEventListener('offline',()=>connectionFailed(Error('网络离线')));
document.addEventListener('visibilitychange',()=>{if(!document.hidden){retryAt=0;refresh();}});
window.addEventListener('pageshow',()=>{retryAt=0;refresh();});
if(credentials){document.querySelector('#app').innerHTML='<section class="session-screen"><h1>正在返回原房间</h1></section>';disconnected=true;connectionUI('正在恢复房间 '+credentials.code+'…');refresh();}else home();setInterval(refresh,900);
