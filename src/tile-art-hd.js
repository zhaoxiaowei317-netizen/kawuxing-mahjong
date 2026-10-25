// Vector masters shared by every tile presentation.
import {ZHONG,FA} from './honor-glyphs.js';
const G='#124d2c',R='#bd1824',K='#171918',P='#f8f5e9';
function ring(x,y,r,c){return `<g fill="${c}"><circle cx="${x}" cy="${y}" r="${r}"/><circle cx="${x}" cy="${y}" r="${r*.73}" fill="${P}"/><circle cx="${x}" cy="${y}" r="${r*.57}"/><circle cx="${x}" cy="${y}" r="${r*.34}" fill="${P}"/><circle cx="${x}" cy="${y}" r="${r*.19}"/></g>`;}
function circles(n){
 if(n===1){let petals='';for(let i=0;i<12;i++)petals+=`<ellipse cx="48" cy="42" rx="4" ry="7" transform="rotate(${i*30} 48 66)" fill="${P}"/>`;return `<circle cx="48" cy="66" r="39" fill="${G}"/><circle cx="48" cy="66" r="35" fill="none" stroke="${P}" stroke-width="2"/>${petals}<circle cx="48" cy="66" r="22" fill="${P}"/><circle cx="48" cy="66" r="18" fill="${R}"/>`+[[42,60],[54,60],[42,72],[54,72]].map(([x,y])=>`<ellipse cx="${x}" cy="${y}" rx="4" ry="5" fill="${P}"/>`).join('');}
 const a={2:[[48,34,K],[48,98,G]],3:[[25,28,G],[48,66,R],[71,104,K]],4:[[26,35,G],[70,35,G],[26,97,G],[70,97,G]],5:[[25,29,G],[71,29,G],[48,66,R],[25,103,G],[71,103,G]],6:[[26,25,G],[70,25,G],[26,66,R],[70,66,R],[26,107,R],[70,107,R]],7:[[18,22,G],[48,33,G],[78,44,G],[26,77,R],[70,77,R],[26,108,R],[70,108,R]],8:[...Array(4)].flatMap((_,i)=>[[29,20+i*31,K],[67,20+i*31,K]]),9:[...Array(3)].flatMap((_,i)=>[19,48,77].map(x=>[x,26+i*40,[K,R,G][i]]))};
 return a[n].map(([x,y,c])=>ring(x,y,n===2?22:n===3?18:n===9?13:n===8?15:n===7?14:17,c)).join('');
}
function bamboo(x,y,h=40,c=G){return `<g fill="${c}"><rect x="${x-5}" y="${y-h/2}" width="10" height="${h}" rx="5"/>${[-.36,0,.36].map(v=>`<ellipse cx="${x}" cy="${y+h*v}" rx="8" ry="${h*.14}"/>`).join('')}<path d="M${x} ${y-h*.39}v${h*.78}" stroke="${P}" stroke-width="1.8" stroke-linecap="round"/></g>`;}
function bird(){return `<g fill="none" stroke="${G}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M24 27L65 14M31 21L33 12 43 20M36 31Q23 39 33 58L55 59Q66 44 53 29M30 33L19 40 30 42M59 32Q77 27 67 46L60 54M28 49L20 47 27 64 35 55 40 64 46 55 51 65 59 54 65 62M30 64L48 119 37 70M43 69L61 118 51 68M28 70L12 93M48 75L69 91M13 76L78 70M27 63L25 78M58 62L61 74"/><circle cx="42" cy="39" r="12" fill="${P}"/><circle cx="43" cy="37" r="4" fill="${R}" stroke="none"/><circle cx="12" cy="75" r="5"/><circle cx="79" cy="69" r="5"/></g>`;}
function sticks(n){
 if(n===1)return bird();
 if(n===2)return bamboo(48,34,44,K)+bamboo(48,99,44);
 if(n===3)return bamboo(48,31,40)+bamboo(27,99,42)+bamboo(69,99,42);
 if(n===4)return [27,69].flatMap(x=>[34,99].map(y=>bamboo(x,y,44))).join('');
 if(n===5)return [25,71].flatMap(x=>[31,101].map(y=>bamboo(x,y,43))).join('')+bamboo(48,66,42,R);
 if(n===6)return [23,48,73].flatMap(x=>[34,99].map(y=>bamboo(x,y,44))).join('');
 if(n===7)return bamboo(48,23,29,R)+[23,48,73].flatMap(x=>[66,108].map(y=>bamboo(x,y,29))).join('');
 if(n===8)return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${['M19 17V48L48 26 77 48V17','M19 115V84L48 106 77 84V115'].map(d=>`<path d="${d}" stroke="${G}" stroke-width="12"/><path d="${d}" stroke="${P}" stroke-width="2"/>`).join('')}</g>`;
 return [23,48,73].flatMap(x=>[25,66,107].map(y=>bamboo(x,y,29,x===48?R:G))).join('');
}
function honor(n){
 if(n===5)return `<g fill="none" stroke="${K}" stroke-linejoin="round"><rect x="18" y="13" width="60" height="106" rx="3" stroke-width="5"/><rect x="24" y="19" width="48" height="94" stroke-width="2.5"/><path d="M24 36L40 19M56 19L72 36M24 96L40 113M56 113L72 96" stroke-width="3"/></g>`;
 return `<path fill="${n===7?R:G}" d="${n===7?ZHONG:FA}"/>`;
}
export function tileArtwork(t){const n=+t[1];return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1096" viewBox="0 0 96 137.14"><g transform="translate(0 2.57)">${t[0]==='p'?circles(n):t[0]==='s'?sticks(n):honor(n)}</g></svg>`;}
