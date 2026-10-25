// Original traditional-style artwork, shared by hand tiles and the 3D table textures.
import {ZHONG,FA} from './honor-glyphs.js';
const G='#07512f',R='#b51d27',K='#171c25';
function ring(x,y,r,color){return `<g fill="none" stroke="${color}"><circle cx="${x}" cy="${y}" r="${r}" stroke-width="3.8"/><circle cx="${x}" cy="${y}" r="${r-5}" stroke-width="2.4"/><circle cx="${x}" cy="${y}" r="${Math.max(1.4,r-9)}" stroke-width="2"/></g>`;}
function bamboo(x,y,h=27,color=G){return `<g transform="translate(${x} ${y})" fill="${color}"><path d="M0 ${-h/2}C-11 ${-h/2-5}-12 ${-h/2+11}-6 ${-h/2+14}C-12 -4-11 3-6 7C-12 ${h/2-5}-10 ${h/2+5} 0 ${h/2}C10 ${h/2+5} 12 ${h/2-5} 6 7C11 3 12-4 6 ${-h/2+14}C12 ${-h/2+11} 11 ${-h/2-5} 0 ${-h/2}Z"/><path d="M0 ${-h/2+2}V${h/2-2}" stroke="#eef2df" stroke-width="1.6"/></g>`;}
function circles(n){
 if(n===1)return ring(48,66,32,G)+ring(48,66,16,R);
 const rows={2:[[48,35,K],[48,96,G]],3:[[24,29,G],[48,66,R],[72,103,G]],4:[[26,34,K],[70,34,K],[26,98,G],[70,98,G]],5:[[25,28,G],[71,28,K],[48,66,R],[25,104,K],[71,104,G]],6:[[26,25,G],[70,25,G],[26,65,R],[70,65,R],[26,105,R],[70,105,R]],7:[[20,21,G],[48,31,G],[76,41,G],[26,73,R],[70,73,R],[26,109,R],[70,109,R]],8:[[26,19,K],[70,19,K],[26,50,K],[70,50,K],[26,82,K],[70,82,K],[26,113,K],[70,113,K]],9:[[19,26,K],[48,26,K],[77,26,K],[19,66,R],[48,66,R],[77,66,R],[19,106,G],[48,106,G],[77,106,G]]};
 return rows[n].map(([x,y,c])=>ring(x,y,n===9?12:n===8?12.5:15,c)).join('');
}
function sparrow(){return `<g stroke="${G}" stroke-linecap="round" stroke-linejoin="round">
 <path d="M35 20Q34 12 38 11Q44 18 58 13" fill="none" stroke="${R}" stroke-width="3.4"/>
 <path d="M36 27Q44 20 55 25Q66 28 64 41L60 53Q55 60 57 74L69 105Q55 97 49 79L43 57Q32 52 31 42Q26 36 33 33Z" fill="${G}" stroke-width="1.5"/>
 <path d="M41 52Q36 70 47 96L54 118Q42 110 35 86Q29 66 33 51" fill="none" stroke-width="3"/>
 <path d="M47 58Q43 77 52 96L61 116Q50 110 44 92Q38 76 40 61Z" fill="${R}" stroke="none"/>
 <path d="M51 61Q49 74 55 86M55 62L56 70" fill="none" stroke="#f8f7ea" stroke-width="2"/>
 <circle cx="45" cy="35" r="9.4" fill="#f8f7ea" stroke-width="2.7"/><circle cx="46" cy="34" r="3.4" fill="${G}" stroke="none"/>
 <path d="M32 37L22 40 32 44M62 34Q72 29 69 41L64 49M32 46Q25 45 27 53L33 58M60 50Q70 44 69 55L61 63" fill="none" stroke-width="3"/>
 <path d="M29 59L21 65 24 72 17 73 13 67 10 78 28 75M59 71L79 73 79 63M69 71L70 64M34 62L30 75M57 59L60 74" fill="none" stroke-width="3"/>
 <path d="M32 77L82 75M18 81L34 78" fill="none" stroke-width="2.3"/>
 </g>`;}

function sticks(n){
 if(n===1)return sparrow();
 if(n===2)return bamboo(48,35,46)+bamboo(48,98,46);
 if(n===3)return bamboo(48,30,32)+bamboo(28,94,40)+bamboo(68,94,40);
 if(n===4)return [28,68].flatMap(x=>[34,98].map(y=>bamboo(x,y,40))).join('');
 if(n===5)return [25,71].flatMap(x=>[29,103].map(y=>bamboo(x,y,33))).join('')+bamboo(48,66,32,R);
 if(n===6)return [26,70].flatMap(x=>[25,66,107].map(y=>bamboo(x,y,28))).join('');
 if(n===7)return bamboo(48,21,24,R)+[26,70].flatMap(x=>[55,83,112].map(y=>bamboo(x,y,20))).join('');
 if(n===8)return [35,97].flatMap((y,row)=>[20,38,58,76].map((x,i)=>`<g transform="rotate(${[0,-38,38,0][i]*(row?-1:1)} ${x} ${y})">${bamboo(x,y,i===0||i===3?38:30,G)}</g>`)).join('');
 return [22,48,74].flatMap(x=>[25,66,107].map(y=>bamboo(x,y,28,x===48?R:G))).join('');
}
function honor(n){
 if(n===5)return `<g fill="none" stroke="${K}" stroke-linejoin="round">
 <rect x="12" y="12" width="72" height="108" rx="10" stroke-width="5.5"/>
 <rect x="19" y="19" width="58" height="94" rx="6" stroke-width="2.8"/>
 <path d="M22 39Q32 37 32 23H64Q64 37 74 39V93Q64 95 64 109H32Q32 95 22 93Z" stroke-width="2.4"/>
 </g>`;
 return `<path fill="${n===7?R:G}" stroke="${n===7?R:G}" stroke-width="${n===7?0.8:1.2}" stroke-linejoin="round" d="${n===7?ZHONG:FA}"/>`;
}
export function tileArtwork(t){const n=+t[1],body=t[0]==='p'?circles(n):t[0]==='s'?sticks(n):honor(n);return `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="528" viewBox="0 0 96 132">${body}</svg>`;}
