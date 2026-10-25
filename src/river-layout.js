// Three separate discard lanes. No tile is dropped when a river grows.
// At most 45 discards can remain among the 84 tiles after three 13-tile hands.
export function riverLayout(count,side){
 const columns=side===0?6:Math.max(6,Math.ceil(count/3));
 const scale=side===0?1.18:Math.min(1.18,7.0/(columns*.67));
 const along=.655*scale+.035,across=.89*scale+.04;
 return Array.from({length:count},(_,i)=>{
  const col=i%columns,row=Math.floor(i/columns);
  return side===0?{x:(col-2.5)*.78,z:3.0-row*1.04,rot:0,scale}
   :{x:side*(3.1+row*across),z:-.6+(col-(columns-1)/2)*along,rot:side<0?Math.PI/2:-Math.PI/2,scale};
 });
}
