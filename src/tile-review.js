import {mountScene,resizeScene} from './table-scene.js';
const groups={p:Array.from({length:9},(_,i)=>'p'+(i+1)),s:Array.from({length:9},(_,i)=>'s'+(i+1)),z:['z7','z6','z5']};
const title={p:'筒子：一筒至九筒',s:'条子：幺鸡至九条',z:'字牌：红中、发财、白板'};
const all=[...groups.p,...groups.s,...groups.z];
window.review=function(key='p'){
 Object.assign(document.querySelector('#app').style,{maxWidth:'none',width:'100%',height:'100%',margin:'0',padding:'0'});
 const list=groups[key];
 document.querySelector('#app').innerHTML=`<div class="arena" id="arena"><div id="scene-host"></div><div class="review-toolbar"><b>${title[key]}</b><nav>${Object.keys(groups).map(k=>`<button data-group="${k}">${title[k].split('：')[0]}</button>`).join('')}</nav><span>桌面展示全部21种牌，底部切换手牌</span></div><div class="hand-dock"><div class="hand">${list.map(t=>`<button class="tile" title="${t}"><img src="assets/${t}.svg"></button>`).join('')}</div></div></div>`;
 document.querySelectorAll('[data-group]').forEach(b=>b.onclick=()=>window.review(b.dataset.group));
 const g={round:1,phase:'discard',players:[0,1,2].map((id)=>({hand:Array(13).fill('?'),melds:[],river:all.slice(id*7,id*7+7),liang:false}))};
 const arena=document.querySelector('.arena');arena.style.width='1280px';arena.style.transform=`translate(-50%,-50%) scale(${Math.min(innerWidth/1280,innerHeight/720)})`;
 mountScene(document.querySelector('#scene-host'),g,0,false);resizeScene();
};
window.addEventListener('resize',()=>window.review(document.querySelector('[data-active]')?.dataset.active||'p'));
window.review();
