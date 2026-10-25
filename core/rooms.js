import {randomBytes} from 'node:crypto';
import {newGame,discard,respond,kong,finish,canWin,autoPass,names,revealedWaits,reservedKongTiles,selfKongOptions,nextSeats,RULES_VERSION} from './engine.js';
const fail=(message)=>{throw Error(message);};
export class Rooms {
 constructor(snapshot=[]){this.rooms=new Map(snapshot);for(const r of this.rooms.values()){
  r.size=3;r.cap=16;r.members.forEach(m=>{m.active??=true;m.pendingInactive??=false;});
  if(r.members.length>3||r.game&&r.game.config.rulesVersion!==RULES_VERSION){r.closed=true;r.closedReason='本桌使用旧版规则，已保留历史战绩。请新建三人固定对局。';}
 }}
 create(input={}){
  if(input.joinKey){for(const r of this.rooms.values()){const m=r.members[0];if(m?.joinKey===input.joinKey)return {code:r.code,token:m.token,...this.view(r,m.token)};}}
  const size=3,limit=Number(input.limit||16),cap=16;
  if(![16,24,32].includes(limit))fail('房间设置无效');
  let code;do{code=String(randomBytes(4).readUInt32BE()%900000+100000);}while(this.rooms.has(code));
  const room={code,size,limit,cap,version:0,members:[],game:null,nextReady:[],updated:Date.now(),autoAt:0};this.rooms.set(code,room);
  return this.join(code,input);
 }
 join(code,input){
  const r=this.rooms.get(code);if(!r)fail('房间不存在');
  if(input.token){this.member(r,input.token);return {code,token:input.token,...this.view(r,input.token)};}
  const joinKey=typeof input.joinKey==='string'&&/^[a-zA-Z0-9-]{20,80}$/.test(input.joinKey)?input.joinKey:null;
  const existing=joinKey&&r.members.find(m=>m.joinKey===joinKey);if(existing)return {code,token:existing.token,...this.view(r,existing.token)};
  if(r.closed||r.game?.history.length>=r.limit||r.members.length>=3)fail('房间已结束或已满三人');
  const name=String(input.name||'').trim().replace(/[&<>"']/g,'').slice(0,12);if(!name)fail('请输入昵称');
  const token=randomBytes(32).toString('hex');r.members.push({name,token,joinKey,ready:false,active:input.active!==false,pendingInactive:false});r.version++;r.updated=Date.now();return {code,token,...this.view(r,token)};
 }
 eligible(r){return r.members.flatMap((m,i)=>m.active&&m.ready?[i]:[]);}
 applyPending(r){let changed=false;if(r.game?.phase==='ended')for(const m of r.members)if(m.pendingInactive){m.pendingInactive=false;changed=true;}return changed;}
 advance(r){
  const eligible=this.eligible(r),g=r.game;if(eligible.length<3||r.closed||g&&g.history.length>=r.limit)return false;
  if(g&&g.phase!=='ended')return false;
  let next;
  if(g){
   next=nextSeats(g.seats,null,g.result.winners,g.result.source,g.dealer);
   next={...next,round:g.round+1,totals:g.totals,history:g.history};
  }else next={seats:[0,1,2],bench:null};
  const config={base:g?.config.base||1,cap:16,mode:'three'};
  r.game=newGame(config,next);r.members.forEach(m=>m.pendingInactive=false);r.nextReady=[];r.autoAt=Date.now()+2800;return true;
 }
 member(r,token){const id=r.members.findIndex(m=>m.token===token);if(id<0)fail('入桌凭证无效，请重新加入');return id;}
 leave(code,token){
  const r=this.rooms.get(code);if(!r)fail('房间不存在');const id=this.member(r,token);
  if(!r.game){r.members.splice(id,1);r.members.forEach(m=>m.ready=false);if(!r.members.length)this.rooms.delete(code);}
  else if(!r.closed){r.closed=true;r.closedReason=`${r.members[id].name}退出了房间，本桌已结束，未完成的本局不计分。`;r.nextReady=[];}
  r.version++;r.updated=Date.now();return {left:true,...(r.game?{snapshot:this.view(r,token)}:{})};
 }
 view(r,token){
  const id=this.member(r,token);let game=null,seat=-1;
  if(r.game){game=structuredClone(r.game);seat=game.seats.indexOf(id);game.wall=Array(game.wall.length).fill('?');
   game.players.forEach((p,i)=>{
    if(game.phase!=='ended'&&i!==seat){
     if(p.liang){p.publicWaits=revealedWaits(r.game,i).map(w=>({tile:w.tile}));const hidden=reservedKongTiles(r.game.players[i]);p.hand=p.hand.map(t=>hidden.includes(t)?'?':t);}
     else p.hand=Array(p.hand.length).fill('?');
    }
    if(i!==seat){delete p.dealHand;delete p.liangKongTiles;delete p.liangWaits;delete p.buOpportunities;delete p.passedHu;delete p.passedPeng;p.melds.forEach(m=>delete m.supplementForbidden);}
   });
   if(game.phase!=='ended'&&(seat<0||game.turn!==seat&&!game.players[game.turn].liang))game.drawTile=null;
   if(seat>=0&&game.turn!==seat&&reservedKongTiles(r.game.players[game.turn]).includes(game.drawTile))game.drawTile=null;
   if(game.pending)game.pending.responses=Object.fromEntries(Object.entries(game.pending.responses).map(([k,v])=>[k,+k===seat?v:'pass']));
  }
  return {code:r.code,version:r.version,size:r.size,limit:r.limit,cap:r.cap,id,seat,members:r.members.map((m,i)=>({name:m.name,ready:m.ready,active:m.active!==false,pendingInactive:!!m.pendingInactive&&r.game?.phase!=='ended',currentSeat:r.game?.seats.indexOf(i)??-1})),eligibleCount:this.eligible(r).length,waitingForPlayers:(!r.game||r.game.phase==='ended')&&this.eligible(r).length<3,game,nextReady:r.nextReady,closed:!!r.closed,closedReason:r.closedReason,complete:!!r.game&&r.game.history.length>=r.limit};
 }
 action(code,token,input){
  const r=this.rooms.get(code);if(!r)fail('房间不存在');const id=this.member(r,token);
  if(r.closed)fail('房间已结束，请返回大厅重新建房');
  if(input.type==='resume'&&r.members[id].active&&r.members[id].ready&&!r.members[id].pendingInactive)return this.view(r,token);
  if(input.type==='participation'&&typeof input.active==='boolean'&&r.members[id].active===input.active)return this.view(r,token);
  if(input.type==='ready'&&typeof input.ready==='boolean'&&r.members[id].ready===input.ready)return this.view(r,token);
  if(input.version!==r.version)fail('牌局已更新，请刷新后重试');
  const before=structuredClone(r);
  try{
   r.members.forEach((m,i)=>names[i]=m.name);
   if(input.type==='resume'){
    Object.assign(r.members[id],{active:true,ready:true,pendingInactive:false});
    if((!r.game||r.game.phase==='ended')&&Date.now()>=r.autoAt)this.advance(r);
   }else if(input.type==='participation'){
    if(typeof input.active!=='boolean')fail('参与状态无效');
    r.members[id].active=input.active;
    r.members[id].pendingInactive=!input.active&&!!r.game&&r.game.phase!=='ended'&&r.game.seats.includes(id);
    if((!r.game||r.game.phase==='ended')&&Date.now()>=r.autoAt)this.advance(r);
   }else if(input.type==='ready'){
    if(!r.members[id].active)fail('已挂起，请先恢复参与');
    if(r.game?.phase!=='ended'&&r.game?.seats.includes(id))fail('本局已经在场');
    r.members[id].ready=typeof input.ready==='boolean'?input.ready:!r.members[id].ready;
    if((!r.game||r.game.phase==='ended')&&Date.now()>=r.autoAt)this.advance(r);
   }else if(input.type==='next'&&r.game?.phase==='ended'&&r.game.history.length<r.limit){
    if(!r.members[id].active||r.game.seats.indexOf(id)<0)fail('当前仅观战，不能操作牌局');
    if(!this.advance(r))fail('等待至少三名参与者准备');
   }else{
    const g=r.game;if(!g||g.phase==='ended'||Date.now()<r.autoAt)fail('当前不能操作');const seat=g.seats.indexOf(id);if(seat<0)fail('当前正在候场');
    if(input.type==='respond'){respond(g,seat,input.choice);}
    else{if(g.turn!==seat||g.phase!=='discard')fail('尚未轮到你');
     if(input.type==='discard')discard(g,Number(input.index),!!input.reveal);
     else if(input.type==='kong')kong(g,input.tile,input.kind);
     else if(input.type==='win'){if(!canWin(g,seat))fail('当前不能自摸');finish(g,[seat]);}
     else fail('操作无效');}
    autoPass(g);r.autoAt=Date.now()+(g.phase==='ended'?3800:650);
   }
   this.applyPending(r);r.version++;r.updated=Date.now();return this.view(r,token);
  }catch(e){this.rooms.set(code,before);throw e;}
 }
 tick(){let changed=false;for(const r of this.rooms.values()){
  if(!r.game&&Date.now()-r.updated>86400000){this.rooms.delete(r.code);changed=true;continue;}
  const g=r.game;if(r.closed||!g||Date.now()<r.autoAt)continue;
  if(g.phase==='ended'&&g.history.length<r.limit){const settled=this.applyPending(r),advanced=this.advance(r);if(settled||advanced){r.version++;r.updated=Date.now();changed=true;}continue;}
  if(g.phase!=='discard')continue;
  r.members.forEach((m,i)=>names[i]=m.name);
  if(g.players[g.turn].liang&&!canWin(g,g.turn)&&!selfKongOptions(g).length){discard(g,g.players[g.turn].hand.lastIndexOf(g.drawTile));autoPass(g);r.version++;r.updated=Date.now();r.autoAt=Date.now()+(g.phase==='ended'?3800:650);changed=true;}
 }return changed;}
}
