export const WALL_SIDES=[11,10,11,10];
const uint32=()=>crypto.getRandomValues(new Uint32Array(1))[0];
export function roundId(){
 const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
 const s=Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');
 return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export function randomBelow(max,source=uint32){
 if(!Number.isInteger(max)||max<1||max>0x100000000)throw Error('Invalid random range');
 const limit=0x100000000-(0x100000000%max);let value;
 do{value=source();}while(value>=limit);
 return value%max;
}
export function shuffleTiles(tiles,random=randomBelow){
 const result=[...tiles];for(let i=result.length-1;i>0;i--){const j=random(i+1);[result[i],result[j]]=[result[j],result[i]];}return result;
}
// Seat 0 faces south, seat 1 east, seat 2 west; north is the empty fourth wall.
export const SEAT_SIDE=[0,1,3];
export function dealWall(tiles,dealer,random=randomBelow){
 const shuffled=shuffleTiles(tiles,random),dice=[random(6)+1,random(6)+1],sum=dice[0]+dice[1];
 const side=(SEAT_SIDE[dealer]+sum-1)%4;
 // Count stacks along the chosen wall, continuing around the corner if necessary.
 const startStack=(WALL_SIDES.slice(0,side).reduce((a,b)=>a+b,0)+sum)%42;
 const cut=startStack*2,ordered=[...shuffled.slice(cut),...shuffled.slice(0,cut)];
 const hands=[[],[],[]],batches=[];let taken=0;
 const take=(seat,count)=>{hands[seat].push(...ordered.slice(taken,taken+count));batches.push({seat,count});taken+=count;};
 for(let round=0;round<3;round++)for(let i=0;i<3;i++)take((dealer+i)%3,4);
 for(let i=0;i<3;i++)take((dealer+i)%3,1);
 take(dealer,1);
 // Normal draws retain the existing pop convention; supplements use shift.
 return {hands,wall:ordered.slice(taken).reverse(),opening:{dice,side,startStack,sides:[...WALL_SIDES],batches},wallState:{front:taken,back:0}};
}
