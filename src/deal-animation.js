export function animateOpeningHand(g,view,done){
 const tiles=[...document.querySelectorAll('.hand-dock .hand .tile')],original=tiles.map(t=>t.querySelector('img').src);
 const dealt=g.players[view].dealHand;
 const batches=g.opening?.batches||[];let index=0;
 tiles.forEach(t=>{t.style.opacity='0';});
 batches.forEach((batch,step)=>{if(batch.seat!==view)return;for(let i=0;i<batch.count;i++){
  const n=index++,tile=tiles[n];if(!tile)continue;
  if(dealt?.[n]&&dealt[n]!=='?')tile.querySelector('img').src=`assets/${dealt[n]}.svg`;
  tile.style.opacity='1';tile.animate([{opacity:0,transform:'translateY(-100px) scale(.6)'},{opacity:1,transform:'none'}],{duration:240,delay:600+step*100,fill:'backwards'});
 }});
 if(!batches.length)tiles.forEach(t=>t.style.opacity='1');
 setTimeout(()=>tiles.forEach((t,i)=>{if(!t.isConnected)return;t.querySelector('img').src=original[i];t.animate([{transform:'translateY(-12px)'},{transform:'none'}],{duration:350,delay:i*15});}),2000);
 return setTimeout(done,2800);
}
