// Presentation derives tiers from settled, capped scores; never changes scoring.
const extras=new Set(['亮倒','对亮','杠上开花','杠上杠','杠上炮','海底自摸','海底放炮']);
export function winPlan(result,names=[]){
 const cards=(result?.winners||[]).map(w=>{
  const paid=Object.entries(result.scores?.[w]||{}).filter(([payer,s])=>+payer!==w&&(result.source===null||+payer===result.source)&&s?.legal&&!s.warning);
  const cap=Number(result.config?.cap)||Infinity;
  const multiplier=paid.reduce((n,[,s])=>Math.max(n,Math.min(Number(s.raw)||0,cap)),0);
  const all=[...new Set(paid.flatMap(([,s])=>(s.factors||[]).map(f=>f.name)).filter(Boolean))];
  const main=all.filter(n=>!extras.has(n));
  const patterns=(main.length?main:all.length?all:['普通胡']).slice(0,3);
  const tier=multiplier>=32?32:multiplier>=16?16:multiplier>=8?8:multiplier>=4?4:0;
  return {seat:w,name:names[result.seats?.[w]]||`玩家${w+1}`,multiplier,tier,patterns};
 });
 const cues=[];if(cards.length>1)cues.push('一炮多响');
 for(const c of cards)cues.push(result.source===null?'自摸':'胡了',...c.patterns);
 return {cards,cues,tier:Math.max(0,...cards.map(c=>c.tier))};
}
export function createResultGate(storage){
 let primed=false;const seen=new Set();
 try{for(const id of JSON.parse(storage?.getItem('kwx-seen-wins-v1')||'[]'))seen.add(id);}catch{}
 const remember=id=>{seen.add(id);while(seen.size>256)seen.delete(seen.values().next().value);try{storage?.setItem('kwx-seen-wins-v1',JSON.stringify([...seen]));}catch{}};
 return {observe(g){const id=g.phase==='ended'?g.result?.id:null;if(!primed){primed=true;if(id)remember(id);return false;}if(!id||seen.has(id))return false;remember(id);return true;},reset(){primed=false;}};
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createWinEffects({document:doc,storage,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now,reduced=()=>false,say=()=>{},stop=()=>{},names=[]}){
 const gate=createResultGate(storage);let active=null,timer=null,lastPhase=null,lastId=null;
 const clear=()=>{if(timer!==null)clearTimer(timer);timer=null;doc.querySelector('.win-celebration')?.remove();active=null;};
 const mount=()=>{
  if(!active)return;const host=doc.querySelector('.round-sheet');if(!host){clear();return;}
  let el=doc.querySelector('.win-celebration');if(el)return;
  el=doc.createElement('div');el.className='win-celebration win-tier-'+active.plan.tier;el.dataset.resultId=active.id;el.style.setProperty('--elapsed',`-${Math.max(0,now()-active.start)}ms`);el.setAttribute('aria-hidden','true');
  el.innerHTML=active.plan.cards.map(c=>`<div class="win-card tier-${c.tier}">${c.tier>=4?'<b class="hu-seal">胡</b>':''}<div><small>${esc(c.name)} · ${c.multiplier}倍</small><strong>${esc(c.patterns.join(' · '))}</strong></div>${c.tier>=8?'<i class="win-ring"></i>':''}${!reduced()&&c.tier>=16?Array.from({length:c.tier>=32?16:8},(_,i)=>`<i class="win-spark" style="--angle:${i*360/(c.tier>=32?16:8)}deg;--reach:${c.tier>=32?95:65}px"></i>`).join(''):''}</div>`).join('');host.prepend(el);
 };
 return {update(g){
  if(lastPhase==='ended'&&(g.phase!=='ended'||g.result?.id!==lastId)){clear();stop();}
  lastPhase=g.phase;lastId=g.result?.id;
  const fresh=gate.observe(g);
  if(fresh&&g.result.winners?.length){clear();const plan=winPlan(g.result,names);active={id:g.result.id,plan,start:now()};mount();timer=setTimer(clear,reduced()?1600:2400);try{Promise.resolve(say(plan.cues)).catch(()=>{});}catch{}}
  else {if(fresh){try{Promise.resolve(say(['流局'])).catch(()=>{});}catch{}}mount();}
 },clear(){clear();stop();},reset(){clear();stop();lastPhase=null;lastId=null;gate.reset();}};
}
