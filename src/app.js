import {createIcons,RotateCcw,Settings,ArrowRight,Eye,Play,ChevronRight,FlaskConical,BookOpen,Download,Table2,History,RefreshCw} from 'lucide';
import {TYPES,names,tileName,parseHand,evaluate,amount,waits,counts,sorted,newGame,discard,respond,kong,finish,canWin,drawSettlement} from './engine.js';
import {loadLocalGame} from './local-state.js';
import {rulesHTML} from './rules.js';
import {botStep,autoPass,selfKongOptions} from './engine.js';
import {Menu,X,Pause,Maximize,Volume2,VolumeX} from 'lucide';
import {gameTable} from './game-table.js';
import {mountScene,resizeScene} from './table-scene.js';
import {animateOpeningHand} from './deal-animation.js';
import {mountTableExperience,resetTableExperience} from './table-experience.js';
import {discardPreviews} from './hand-preview.js';
import {resultHTML,roundTime,historyHTML} from './settlement.js';
import {createSession,everyoneReady,sessionRounds,sessionComplete,sessionTotals} from './session.js';
let session,dealTimer,dealing=false;
let botTimer, botsPaused=false,liangMode=false;
const icons={RotateCcw,Settings,ArrowRight,Eye,Play,ChevronRight,FlaskConical,BookOpen,Download,Table2,History,RefreshCw,Menu,X,Pause,Maximize,Volume2,VolumeX};
let soundOn=localStorage.getItem('kwx-sound')==='on',audioContext;
function clickSound(){if(!soundOn)return;try{audioContext??=new AudioContext();audioContext.resume();const o=audioContext.createOscillator(),v=audioContext.createGain();o.type='triangle';o.frequency.setValueAtTime(620,audioContext.currentTime);o.frequency.exponentialRampToValueAtTime(180,audioContext.currentTime+.045);v.gain.setValueAtTime(.09,audioContext.currentTime);v.gain.exponentialRampToValueAtTime(.001,audioContext.currentTime+.065);o.connect(v);v.connect(audioContext.destination);o.start();o.stop(audioContext.currentTime+.07);}catch{}}
const restored=loadLocalGame(localStorage);let game=restored.game,migrated=restored.migrated;
try{session=JSON.parse(localStorage.getItem('kwx-session-v1'));}catch{}
if(migrated)session=null;
session??=createSession(game.config.mode,16,game.history.length);
try{const savedNames=JSON.parse(localStorage.getItem('kwx-player-names'));if(Array.isArray(savedNames))savedNames.slice(0,3).forEach((n,i)=>{if(typeof n==='string'&&n.trim())names[i]=n.trim().slice(0,12);});}catch{}
let tab='table',view=game.turn,selected=-1,showAll=false,undo=[],editor=false;
let lab={hand:'p123456789s123z77',melds:[],winTile:'z7',liang:true,otherLiang:false,self:true,gang:0,sea:false};
const presets=[
 ['普通胡 + 亮倒','p123456789s123z77',[], 'z7',true],
 ['卡五星','p12346s123789z77',[],'p5',false],
 ['清一色碰碰胡','p11122233344455',[],'p5',false],
 ['七对','p112233s445566z77',[],'z7',false],
 ['豪七对','p111122s334455z77',[],'z7',false],
 ['双豪七对','p11112222s3344z77',[],'z7',false],
 ['明四归','p123s456789z77',[{kind:'peng',tile:'p1'}],'p1',false],
 ['暗四归','p111123s456789z77',[],'p1',false],
 ['小三元','p123s456z55666777',[],'s6',false],
 ['大三元','p123s55z555666777',[],'s5',false],
 ['全求人','s55',[{kind:'peng',tile:'p1'},{kind:'peng',tile:'p3'},{kind:'peng',tile:'s7'},{kind:'peng',tile:'z7'}],'s5',false],
];
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
const ico=n=>`<i data-lucide="${n}"></i>`;
const tile=(t,cls='',attrs='')=>`<button class="tile ${cls}" aria-label="${tileName(t)}" title="${tileName(t)}" ${attrs}><img src="assets/${t}.svg" alt="${tileName(t)}" draggable="false"></button>`;
const capText=()=>'16倍封顶';
function notify(s){const el=document.querySelector('#toast');el.textContent=s;el.classList.add('visible');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>el.classList.remove('visible'),3300);}
function save(){if(!restored.writable)return;localStorage.setItem('kwx-lab-v1',JSON.stringify(game));localStorage.setItem('kwx-session-v1',JSON.stringify(session));}
function lobbyHTML(){return `<section class="session-screen"><h1>好友卡五星</h1><h2>准备入桌</h2><label>局数 <select id="round-limit">${[16,24,32].map(n=>`<option ${session.limit===n?'selected':''}>${n}</option>`).join('')}</select></label><p>${game.config.mode==='bots'?'单人练习 · 两位电脑陪打':'本机同屏试牌 · 非联机房间'}</p><div class="ready-seats">${Array.from({length:3},(_,i)=>`<div class="ready-player"><img src="assets/avatar-${i}.png" alt=""><label>昵称<input data-player-name="${i}" maxlength="12" value="${esc(names[i])}" ${session.ready[i]?'disabled':''}></label><button data-ready="${i}" ${game.config.mode==='bots'&&i>0?'disabled':''}>${session.ready[i]?'已准备':'准备'}</button></div>`).join('')}</div><button data-action="start-session" ${everyoneReady(session)?'':'disabled'}>开始对局</button><button data-action="settings">${ico('settings')} 桌子设置</button></section>`;}
function matchHTML(){const rounds=sessionRounds(session,game.history),totals=sessionTotals(session,game.history);return `<section class="session-screen"><h1>整场结算</h1><h2>${rounds.length} / ${session.limit} 局</h2><div class="match-totals">${totals.slice(0,3).map((v,i)=>`<p>${names[i]} <strong>${v>0?'+':''}${v} 分</strong></p>`).join('')}</div><button data-action="new-session">再开一桌</button><button data-action="export">导出流水</button>${historyHTML(rounds)}</section>`;}
function animateDeal(){
 clearTimeout(botTimer);dealing=true;render();
 document.querySelector('.current-status').textContent='发牌中';
 dealTimer=animateOpeningHand(game,view,()=>{dealing=false;render();});
}
function act(fn){const before=structuredClone(game);try{fn();undo.push(before);if(undo.length>40)undo.shift();selected=-1;liangMode=false;view=game.phase==='react'?nextResponder():game.turn;save();render();}catch(e){game=before;notify(e.message);}}
function nextResponder(){return [0,1,2].find(i=>i!==game.pending?.source&&!game.pending?.responses[i])??game.turn;}
function meldHTML(m){return `<span class="meld" title="${{peng:'碰',ming:'明杠',an:'暗杠',bu:'补杠'}[m.kind]}">${Array(m.kind==='peng'?3:4).fill(0).map(()=>tile(m.tile,'tiny','disabled')).join('')}<small>${{peng:'碰',ming:'明',an:'暗',bu:'补'}[m.kind]}</small></span>`;}
function settings(){return `<dialog id="settings"><form id="setup"><h2>开一桌</h2><label>参与方式<select name="mode"><option value="three" ${game.config.mode==='three'?'selected':''}>三人固定对局</option></select></label><label>底分<input name="base" type="number" min="1" max="100" value="${game.config.base}" required></label><p>固定16倍封顶 · 三人固定座位</p><div class="notice">新开一桌将重置当前牌局和累计积分，已结算流水保留。仅娱乐积分。</div><div class="dialog-actions"><button type="button" data-action="close">取消</button><button class="primary">开始新桌</button></div></form></dialog>`;}
function labPage(){
 let score=null,error='',hand=[];try{hand=parseHand(lab.hand);score=evaluate(hand,lab.melds,lab);}catch(e){error=e.message;}
 const need=14-lab.melds.length*3;
 return `<div class="page-heading"><div><span class="eyebrow">RULE LAB</span><h2>牌型验算</h2></div><span class="badge">底分 ${game.config.base} · ${capText()}</span></div><div class="lab-layout"><section><div class="preset-grid">${presets.map((p,i)=>`<button data-preset="${i}">${p[0]}</button>`).join('')}</div><form id="lab-form"><label>手牌牌谱<input name="hand" value="${esc(lab.hand)}" autocomplete="off" spellcheck="false"></label><div class="lab-hand">${hand.map(t=>tile(t,'','disabled')).join('')}</div><div class="meld-row">${lab.melds.map(meldHTML).join('')}</div><div class="fields"><label>胡牌张<select name="winTile">${TYPES.map(t=>`<option value="${t}" ${lab.winTile===t?'selected':''}>${tileName(t)}</option>`).join('')}</select></label><label>胡牌方式<select name="self"><option value="true" ${lab.self?'selected':''}>自摸</option><option value="false" ${!lab.self?'selected':''}>点炮</option></select></label><label>杠后自摸<select name="gang">${[0,1,2,3,4].map(n=>`<option value="${n}" ${lab.gang===n?'selected':''}>${n?'连续第'+n+'杠（×'+2**n+'）':'无'}</option>`).join('')}</select></label></div><div class="checks"><label><input type="checkbox" name="liang" ${lab.liang?'checked':''}>胡牌者亮倒</label><label><input type="checkbox" name="otherLiang" ${lab.otherLiang?'checked':''}>付款者亮倒</label><label><input type="checkbox" name="sea" ${lab.sea?'checked':''}>海底</label></div><div class="actions"><button class="primary">重新验算</button><button type="button" data-action="fixture" ${!score||score.warning||lab.otherLiang||lab.gang||lab.sea?'disabled':''}>载入试牌桌 ${ico('play')}</button></div></form>${error?`<p class="error">${esc(error)}</p>`:''}${hand.length!==need?`<p class="error">当前${hand.length}张，当前副露需要${need}张完整手牌。</p>`:''}<div class="notation"><h3>牌谱</h3><p>p：筒，s：条，z5：白板，z6：发财，z7：红中。指定手牌包含胡牌张；副露随预设载入。</p></div></section><aside class="calculation"><h3>结算分解</h3>${score?`${score.factors.map(f=>`<div class="factor"><span>${f.name}</span><b>×${f.n}</b></div>`).join('')}<div class="formula">${score.factors.map(f=>f.n).join(' × ')} = ${score.raw}倍</div><dl><dt>原始倍数</dt><dd>${score.raw}</dd><dt>封顶后</dt><dd>${Math.min(score.raw,game.config.cap||Infinity)}</dd></dl><div class="big-score">${score.legal&&!score.warning?amount(score.raw,game.config):0}<span>分 / 付款者</span></div><p class="${score.legal?'muted':'error'}">${score.warning||(!score.legal?'未达到起胡条件；点胡至少2倍，普通自摸允许1倍。':lab.self?'此处计算对当前付款条件的一家赔付，两家分别核算亮倒状态。':'点炮仅放炮者支付。')}</p>`:'<div class="empty-state">不是有效胡牌牌型</div>'}</aside></div><section class="draw-lab"><h2>流局结算用例</h2><div class="preset-grid"><button data-draw="mixed">有人听 · 有人未听</button><button data-draw="all">全听 · 一人亮倒</button><button data-draw="none">三家都未听</button></div><div id="draw-output"></div></section>`;
}
function rulesPage(){return rulesHTML();}
function historyPage(){return `<div class="page-heading"><div><h2>每局流水</h2><small class="muted">共 ${game.history.length} 局 · 保存在当前浏览器</small></div><button data-action="export">${ico('download')} 导出</button></div>${game.history.length?game.history.map(h=>`<details class="history-round"><summary><strong>第 ${h.round} 局 · ${h.winners?.length?h.winners.map(w=>names[h.seats[w]]).join('、')+'胡牌':'流局'}</strong><time>${roundTime(h)}</time><span>${h.delta.map((v,i)=>`${names[h.seats[i]]} ${v>0?'+':''}${v}`).join(' / ')}</span></summary>${resultHTML(h,h.seats)}</details>`).join(''):'<div class="empty-state">尚未结算牌局</div>'}`;}
function render(){
 if(game.phase!=='discard'||game.turn!==view||game.players[view].liang)liangMode=false;
 document.body.classList.toggle('playing',tab==='table');
 document.querySelector('#app').innerHTML=(tab==='table'?gameTable(game,view,selected,showAll,botsPaused,undo.length,tile,ico,resultHTML,liangMode):`<header class="main-header"><div class="brand"><span>伍</span><h1>好友卡五星</h1></div><button data-nav="table">${ico('arrow-right')} 返回牌桌</button></header><nav class="nav">${[['lab','flask-conical','牌型验算'],['history','history','战绩'],['rules','book-open','规则']].map(([v,i,t])=>`<button data-nav="${v}" class="${tab===v?'active':''}">${ico(i)}${t}</button>`).join('')}</nav><main>${tab==='lab'?labPage():tab==='rules'?rulesPage():historyPage()}</main>`)+settings();
 if(tab==='table'&&(!session.started||sessionComplete(session,game.history))){document.querySelector('#app').innerHTML=(!session.started?lobbyHTML():matchHTML())+settings();}
 else if(tab==='table'){layoutArena();mountScene(document.querySelector('#scene-host'),game,view,showAll);document.querySelector('[data-action="sound"]').innerHTML=ico(soundOn?'volume-2':'volume-x');document.querySelector('.game-title small').textContent=`第 ${game.round} / ${session.limit} 局`;}
 bind();if(tab==='table'&&document.querySelector('#arena'))mountTableExperience(game,ico,{history:sessionRounds(session,game.history)});else resetTableExperience();createIcons({icons});
}
function layoutArena(){const el=document.querySelector('#arena');if(!el)return;const portrait=innerHeight>innerWidth,w=portrait?innerHeight:innerWidth,h=portrait?innerWidth:innerHeight;const scale=h/720,width=Math.max(1100,w/scale);el.style.width=width+'px';el.style.transform=`translate(-50%,-50%) rotate(${portrait?90:0}deg) scale(${Math.min(scale,w/width)})`;resizeScene();}
window.addEventListener('resize',layoutArena);
function bind(){
 document.querySelectorAll('[data-player-name]').forEach(input=>input.onchange=()=>{const i=+input.dataset.playerName,n=input.value.trim().replace(/[&<>"']/g,'').slice(0,12);names[i]=n||'玩家'+(i+1);localStorage.setItem('kwx-player-names',JSON.stringify(names));input.value=names[i];});
 document.querySelectorAll('[data-ready]').forEach(b=>b.onclick=()=>{const i=+b.dataset.ready;session.ready[i]=!session.ready[i];save();render();});
 document.querySelector('#round-limit')?.addEventListener('change',e=>{session.limit=+e.target.value;save();});
 document.querySelector('#game-menu')?.addEventListener('close',()=>{if(tab==='table')render();});
 if(game.config.mode==='bots'){
  document.querySelectorAll('[data-seat]').forEach(b=>{if(+b.dataset.seat!==0)b.disabled=true;});
  document.querySelectorAll('.seat-tab').forEach((b,i)=>{if(i>0){b.title='电脑陪打';b.querySelector('small').append(' · 电脑');}});
  const tools=document.querySelector('.tools');
  if(tools){const b=document.createElement('button');b.textContent=botsPaused?'继续电脑':'暂停电脑';b.onclick=()=>{botsPaused=!botsPaused;render();};tools.prepend(b);}
  const top=document.querySelector('.table-top > div');if(top)top.innerHTML='<span class="live-dot"></span> 单人练习 · 两位电脑 <span class="muted">第 '+game.round+' 局</span>';
  document.querySelector('[data-action="active"]')?.remove();
 }
 const modes=document.querySelector('select[name="mode"]');
 const option=new Option('单人练习 · 两位电脑陪打','bots',game.config.mode==='bots',game.config.mode==='bots');modes.prepend(option);
 document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{tab=b.dataset.nav;selected=-1;liangMode=false;render();});
 document.querySelectorAll('[data-seat]').forEach(b=>b.onclick=()=>{view=+b.dataset.seat;selected=-1;liangMode=false;render();});
 document.querySelectorAll('[data-tile-index]').forEach(b=>{
  b.onclick=()=>{if(dealing)return;selected=+b.dataset.tileIndex;render();};
  b.oncontextmenu=e=>{
   e.preventDefault();
   if(dealing||!session.started||sessionComplete(session,game.history)||game.phase!=='discard'||game.turn!==view)return;
   if(b.dataset.discardAllowed!=='true'){notify('这张牌当前不能出');return;}
   act(()=>discard(game,+b.dataset.tileIndex));
  };
 });
 document.querySelector('#all-hands')?.addEventListener('change',e=>{showAll=e.target.checked;render();});
 document.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>act(()=>respond(game,view,b.dataset.choice)));
 document.querySelectorAll('[data-kong-tile]').forEach(b=>b.onclick=()=>{if(dealing||game.turn!==view||game.phase!=='discard')return;act(()=>kong(game,b.dataset.kongTile,b.dataset.kongKind));});
 document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{const [,hand,melds,winTile,liang]=presets[+b.dataset.preset];lab={hand,melds:structuredClone(melds),winTile,liang,otherLiang:false,self:true,gang:0,sea:false};if(hand.length&&hand==='p12346s123789z77')lab.hand+='p5';render();});
 document.querySelectorAll('[data-draw]').forEach(b=>b.onclick=()=>drawExample(b.dataset.draw));
 document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>action(b.dataset.action));
 document.querySelector('#setup').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);const base=+f.get('base');if(!Number.isInteger(base)||base<1||base>100)return;act(()=>{game=newGame({base,cap:16,mode:f.get('mode')},{history:game.history});session=createSession(game.config.mode,session.limit,game.history.length);});};
 const lf=document.querySelector('#lab-form');if(lf)lf.onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);lab={...lab,hand:f.get('hand').trim(),winTile:f.get('winTile'),liang:f.has('liang'),otherLiang:f.has('otherLiang'),self:f.get('self')==='true',gang:+f.get('gang'),sea:f.has('sea')};render();};
 clearTimeout(botTimer);
 if(!session.started||sessionComplete(session,game.history)||dealing){document.querySelectorAll('[data-tile-index], [data-choice], .game-actions button').forEach(b=>b.disabled=true);return;}
 if(tab==='table'&&game.phase==='ended'){botTimer=setTimeout(()=>action('next'),3800);return;}
 if(tab==='table'&&game.phase==='discard'&&game.turn===view&&game.players[view].liang&&!canWin(game,view)&&!selfKongOptions(game,view).length){
  botTimer=setTimeout(()=>act(()=>discard(game,game.players[view].hand.lastIndexOf(game.drawTile))),650);
  return;
 }
 if(game.config.mode==='bots'&&!botsPaused&&tab==='table'&&game.phase!=='ended'){
  const seat=game.phase==='react'?[1,2].find(i=>i!==game.pending.source&&!game.pending.responses[i]):game.turn>0?game.turn:undefined;
  if(seat!==undefined)botTimer=setTimeout(()=>act(()=>botStep(game,seat)),650);
 }
}
function action(a){
 if(a==='new-session'){session=createSession(game.config.mode,session.limit,game.history.length);tab='table';save();render();return;}
 if(a==='start-session'){if(!everyoneReady(session))return;game=newGame(game.config,{history:game.history});session.started=true;undo=[];save();animateDeal();return;}
 if(dealing)return;
 if(a==='liang-cancel'){liangMode=false;render();return;}
 if(a==='pass-kong'){act(()=>discard(game,game.players[view].hand.lastIndexOf(game.drawTile)));return;}
 if(a==='liang'){
  if(game.phase!=='discard'||game.turn!==view||game.players[view].liang)return;
  const choices=discardPreviews(game,view).filter(x=>x.allowed&&x.ready.length);
  if(!choices.length){notify('当前没有可亮倒的出牌');return;}
  liangMode=true;if(!choices.some(x=>x.index===selected))selected=choices[0].index;render();return;
 }

 if(a==='menu'){clearTimeout(botTimer);return document.querySelector('#game-menu').showModal();}
 if(a==='menu-close'){document.querySelector('#game-menu').close();render();return;}
 if(a==='pause'){botsPaused=!botsPaused;render();return;}
 if(a==='sound'){soundOn=!soundOn;localStorage.setItem('kwx-sound',soundOn?'on':'off');clickSound();render();return;}
 if(a==='fullscreen'){if(document.fullscreenElement)document.exitFullscreen?.();else document.documentElement.requestFullscreen?.().catch(()=>notify('浏览器不支持全屏，可横屏游玩'));return;}
 if(a==='settings')return document.querySelector('#settings').showModal();
 if(a==='close')return document.querySelector('#settings').close();
 if(a==='undo'){if(undo.length){game=undo.pop();view=game.turn;selected=-1;save();render();}return;}
 if(a==='active'){view=game.turn;selected=-1;render();return;}
 if(a==='export'){const blob=new Blob([JSON.stringify({version:'0.1',config:game.config,history:game.history,current:game},null,2)],{type:'application/json'});const u=URL.createObjectURL(blob);const link=document.createElement('a');link.href=u;link.download='kawuxing-session.json';link.click();setTimeout(()=>URL.revokeObjectURL(u),1000);return;}
 if(a==='fixture'){try{loadFixture();}catch(e){notify(e.message);}return;}
 act(()=>{
  if(a==='discard'||a==='liang-confirm'){if(a==='liang-confirm'&&!liangMode)throw Error('请先选择亮倒');discard(game,selected,a==='liang-confirm');}
  if(a==='win'){if(!canWin(game,game.turn))throw Error('当前不能自摸');finish(game,[game.turn]);}
  if(a==='kong'){const t=game.players[game.turn].hand[selected];kong(game,t,(counts(game.players[game.turn].hand)[t]===4)?'an':'bu');}
  if(a==='next'){if(sessionComplete(session,game.history))return;const r=game.result;if(!r)throw Error('尚未结束');game=newGame(game.config,{...r.next,round:game.round+1,totals:game.totals,history:game.history});}
 });
 if(a==='next'&&!sessionComplete(session,game.history))animateDeal();
}
function loadFixture(){
 if(!lab.self)throw Error('点炮牌型请在验算页测试；载入牌桌目前只支持自摸预设');
 const hand=parseHand(lab.hand);if(!hand.includes(lab.winTile))throw Error('胡牌张必须存在于手牌中');
 const consumed=[...hand,...lab.melds.flatMap(m=>Array(m.kind==='peng'?3:4).fill(m.tile))];
 if(Object.values(counts(consumed)).some(n=>n>4))throw Error('手牌加副露有牌超过4张');
 act(()=>{
  const config=game.config;game=newGame(config,{history:game.history});const wall=TYPES.flatMap(t=>Array(4).fill(t));for(const t of consumed)wall.splice(wall.indexOf(t),1);
  game.turn=0;game.dealer=0;const pl=game.players[0];pl.hand=[...hand];pl.hand.splice(pl.hand.indexOf(lab.winTile),1);pl.hand=sorted(pl.hand);pl.hand.push(lab.winTile);pl.melds=structuredClone(lab.melds);pl.liang=lab.liang;
  for(let i=1;i<3;i++)game.players[i].hand=wall.splice(0,13);
  game.wall=wall;game.drawTile=lab.winTile;game.log=['指定牌型试局：'+lab.hand];tab='table';
 });
}
function drawExample(which){
 const ready=parseHand('p111s222333444z7'), unready=parseHand('p13579s13579z567');
 const players=[0,1,2].map(i=>({hand:which==='none'||which==='mixed'&&i>0?unready:ready,melds:[],liang:which==='all'?i===0:true}));
 const r=drawSettlement(players,[{from:1,to:0,amount:game.config.base*2}],game.config);
 document.querySelector('#draw-output').innerHTML=`<p class="muted">独立算分用例：甲预记一笔明杠2倍底分；每家听牌状态使用独立样本，不是同一副发牌。</p>${resultHTML({...r,winners:[]},[0,1,2])}`;
}
const renderPage=render;
render=function(){if(session.started&&!dealing&&!sessionComplete(session,game.history))autoPass(game);if(game.config.mode==='bots')view=0;else if(game.phase==='react')view=nextResponder();save();renderPage();};
render();
if(!restored.writable)notify('旧存档无法读取或备份，本次暂不保存，原存档未被覆盖。请先导出备份并检查浏览器存储。');
