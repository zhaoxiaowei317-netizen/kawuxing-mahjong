import {riverLayout} from './river-layout.js';
import * as THREE from 'three';
import {WALL_SIDES,SEAT_SIDE} from './wall.js';
import {reservedKongTiles} from './engine.js';
let renderer, scene, camera, tiles, host, frame, marker;
let flight=null,lastKey=null,eventStart=-Infinity;
let wallPieces=[],openingKey=null,openingStart=-Infinity,currentWallState=null;
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const mats=new Map();
// Real bevelled geometry: each tile has a porcelain body and a separate jade cap.
function roundedBox(w,h,d,r=.06){
 const shape=new THREE.Shape(),x=-w/2,y=-h/2;
 shape.moveTo(x+r,y);shape.lineTo(x+w-r,y);shape.quadraticCurveTo(x+w,y,x+w,y+r);
 shape.lineTo(x+w,y+h-r);shape.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
 shape.lineTo(x+r,y+h);shape.quadraticCurveTo(x,y+h,x,y+h-r);
 shape.lineTo(x,y+r);shape.quadraticCurveTo(x,y,x+r,y);
 const bevel=Math.min(r/2,d/5);
 const g=new THREE.ExtrudeGeometry(shape,{depth:d-2*bevel,steps:1,bevelEnabled:true,bevelSegments:3,bevelSize:bevel,bevelThickness:bevel,curveSegments:6});
 g.translate(0,0,-d/2+bevel);g.computeVertexNormals();return g;
}
function flatBox(w,h,d,r){const g=roundedBox(w,d,h,r);g.rotateX(-Math.PI/2);return g;}
const box=flatBox(.60,.24,.84,.055);
const wallBack=flatBox(.59,.09,.83,.055);
const face=new THREE.PlaneGeometry(.535,.76);
// Concealed hands are separate porcelain pieces, with an inset resin back.
// Their bevel-expanded width stays below the existing .67 hand pitch.
const standing=roundedBox(.54,.89,.38,.05);
const backSeat=roundedBox(.55,.88,.055,.05),back=roundedBox(.50,.83,.10,.055);
const handPorcelain=new THREE.MeshPhysicalMaterial({color:0xe8e7d8,roughness:.4,metalness:0,clearcoat:.25,clearcoatRoughness:.3});
const backSeam=new THREE.MeshStandardMaterial({color:0xb4cec0,roughness:.4,metalness:0});
const handJade=new THREE.MeshPhysicalMaterial({color:0x0b7147,emissive:0x166c49,emissiveIntensity:.24,roughness:.34,metalness:0,clearcoat:.65,clearcoatRoughness:.27});
const ivory=new THREE.MeshStandardMaterial({color:0xfffef7,roughness:.27,metalness:0});
const jade=new THREE.MeshStandardMaterial({color:0x006b32,roughness:.24,metalness:.02});
const loader=new THREE.TextureLoader();
function cloth(leather=false){
 const c=document.createElement('canvas');c.width=c.height=512;const x=c.getContext('2d');
 x.fillStyle=leather?'#294d72':'#4b9fc1';x.fillRect(0,0,512,512);
 let seed=413;const random=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
 for(let i=0;i<22000;i++){
  const px=random()*512,py=random()*512;
  x.strokeStyle=leather?(i%2?'#65738936':'#01051065'):(i%2?'#bddafc13':'#071c361c');
  x.lineWidth=leather?.6:.45;x.beginPath();x.moveTo(px,py);x.lineTo(px+(leather?random()*5:2),py+(leather?random()*4:-2));x.stroke();
 }
 const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(leather?9:5,leather?9:5);t.colorSpace=THREE.SRGBColorSpace;return t;
}
function mesh(geo,material,x,y,z,parent=scene){const m=new THREE.Mesh(geo,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function init(){
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.setClearColor(0x294c72);renderer.outputColorSpace=THREE.SRGBColorSpace;
 renderer.domElement.setAttribute('aria-label','三维麻将牌桌');
 scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(42,16/9,.1,100);camera.position.set(0,16,14);camera.lookAt(0,0,1.6);
 renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
 scene.add(new THREE.HemisphereLight(0xf0faff,0x527c92,2.6));
 const light=new THREE.DirectionalLight(0xfff6e3,1.65);light.position.set(-9,18,-3);light.castShadow=true;light.shadow.mapSize.set(2048,2048);Object.assign(light.shadow.camera,{left:-14,right:14,top:13,bottom:-13,near:1,far:45});light.shadow.bias=-.0003;light.shadow.normalBias=.025;light.shadow.radius=4;scene.add(light);
 scene.add(new THREE.AmbientLight(0xffffff,.55));
 const rim=new THREE.MeshStandardMaterial({color:0xb7c0cc,map:cloth(true),roughness:.82});
 mesh(flatBox(23.3,.65,18,.5),rim,0,-.58,0);
 mesh(flatBox(21.5,.14,16.25,.35),new THREE.MeshStandardMaterial({map:cloth(),roughness:.94}),0,-.19,0);
 // Inset seams follow the same physical table plane as every tile.
 const seams=new THREE.MeshStandardMaterial({color:0x397f9b,roughness:1});
 for(const x of [-7.2,7.2]){
  for(const edge of [-.34,.34])mesh(new THREE.BoxGeometry(.019,.008,9.8),seams,x+edge,-.108,-.2);
  for(const z of [-5.1,4.7])mesh(new THREE.BoxGeometry(.68,.008,.019),seams,x,-.108,z);
 }
 for(const z of [-6.1,5.5]){
  for(const edge of [-.23,.23])mesh(new THREE.BoxGeometry(12,.008,.019),seams,0,-.108,z+edge);
  for(const x of [-6,6])mesh(new THREE.BoxGeometry(.019,.008,.46),seams,x,-.108,z);
 }
 tiles=new THREE.Group();scene.add(tiles);
 marker=mesh(new THREE.ConeGeometry(.18,.38,4),new THREE.MeshStandardMaterial({color:0xffcd57,emissive:0xb9670d,emissiveIntensity:.35}),0,1,0);marker.visible=false;
 marker.rotation.z=Math.PI;
 const animate=time=>{frame=requestAnimationFrame(animate);if(!host?.isConnected)return;
  if(currentWallState){const elapsed=time-openingStart;let front=currentWallState.front;
   if(elapsed<2000&&currentWallState.front===40&&currentWallState.back===0){front=0;for(let i=0;i<13;i++)if(elapsed>=600+i*100)front+=i<9?4:1;}
   for(const piece of wallPieces){piece.visible=piece.userData.order>=front&&piece.userData.order<84-currentWallState.back;piece.position.y=elapsed<500?Math.max(0,1-elapsed/500)*.8:0;}
  }
  if(flight){const u=Math.min(1,(time-eventStart)/520),e=1-Math.pow(1-u,3);flight.group.position.lerpVectors(flight.from,flight.to,e);flight.group.position.y+=Math.sin(Math.PI*u)*1.35;flight.group.rotation.x=(1-e)*-.75;flight.group.scale.setScalar(1+(1-e)*.55);renderer.domElement.dataset.flight=u<1?'moving':'landed';if(u===1)flight=null;}
  if(marker.visible){marker.position.y=.86+(reduced()?0:Math.sin(time*.006)*.07);marker.rotation.y=reduced()?0:time*.001;}
  renderer.render(scene,camera);
 };frame=requestAnimationFrame(animate);
}
function tile(t,x,z,rotation=0,hidden=false){
 const group=new THREE.Group();group.position.set(x,0,z);group.rotation.y=rotation;tiles.add(group);
 if(hidden){
  // Compensate perspective convergence equally for each concealed tile in a row.
  group.rotateX(.28);
  mesh(standing,handPorcelain,0,.355,0,group);
  mesh(backSeat,backSeam,0,.355,.181,group);
  mesh(back,handJade,0,.355,.203,group);
 }
 else{
  mesh(wallBack,jade,0,-.055,0,group);mesh(box,ivory,0,.10,0,group);
  if(t==='?'){mesh(wallBack,jade,0,.225,0,group);return group;}
  if(!mats.has(t)){const map=loader.load('assets/'+t+'.svg');map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=renderer.capabilities.getMaxAnisotropy();mats.set(t,new THREE.MeshBasicMaterial({map,transparent:true,depthWrite:false}));}
  const plane=mesh(face,mats.get(t),0,.229,0,group);plane.rotation.x=-Math.PI/2;
 }
 return group;
}
export function mountScene(element,g,view,showAll){
 host=element;
 try{if(!renderer)init();}catch(e){element.classList.add('scene-fallback');element.textContent='当前设备未能启用三维牌桌，手牌与操作仍可使用。';return;}
 element.append(renderer.domElement);
 tiles.clear();marker.visible=false;flight=null;
 wallPieces=[];currentWallState=g.wallState||null;
 if(g.opening&&g.wallState){
  const key=JSON.stringify([g.round,g.opening.dice,g.opening.startStack,g.seats]);
  if(key!==openingKey){openingKey=key;openingStart=g.wall.length===44?performance.now():-Infinity;}
  let stack=0;
  for(let side=0;side<4;side++)for(let i=0;i<WALL_SIDES[side];i++,stack++){
   const relative=(side-SEAT_SIDE[view]+4)%4,offset=(i-(WALL_SIDES[side]-1)/2)*.65;
   const x=relative===0?offset:relative===1?6.4:relative===2?-offset:-6.4;
   const z=relative===0?4.9:relative===1?-offset:relative===2?-5.5:offset;
   for(let layer=0;layer<2;layer++){
    const group=new THREE.Group();group.position.set(x,0,z);group.rotation.y=relative%2?Math.PI/2:0;tiles.add(group);
    mesh(box,ivory,0,.03+layer*.31,0,group);mesh(wallBack,jade,0,.18+layer*.31,0,group);
    group.userData.order=(stack*2+(1-layer)-g.opening.startStack*2+84)%84;
    // Preserve horizontal placement when animating the initial wall rise.
    wallPieces.push(group);
   }
  }
  element.dataset.wallRemaining=String(g.wall.length);
 }
 const last=g.lastDiscard,key=last?`${g.round}:${last.serial}:${last.seat}:${last.tile}`:null;
 const fresh=lastKey!==null&&key!==lastKey;
 if(fresh)eventStart=performance.now();
 lastKey=key||'empty';renderer.domElement.dataset.marker='none';renderer.domElement.dataset.flight='landed';
 const left=(view+2)%3,right=(view+1)%3;
 for(const [seat,x,rot]of [[left,-8.3,Math.PI/2],[right,8.3,-Math.PI/2]]){
  const p=g.players[seat],covered=showAll?[]:reservedKongTiles(p),hidden=!(p.liang||showAll),pitch=hidden?.61:.67;p.hand.forEach((t,i)=>tile(t==='?'||covered.includes(t)?'?':t,x,(i-(p.hand.length-1)/2)*pitch,rot,hidden));
  const meldSpan=p.melds.reduce((sum,m)=>sum+(m.kind==='peng'?3:4)*.64+.32,0);
  const meldScale=Math.min(1,8.1/Math.max(1,meldSpan));let meldOffset=-4;
  p.melds.forEach(m=>{const count=m.kind==='peng'?3:4;for(let k=0;k<count;k++)tile(m.kind==='an'&&k===0?'?':m.tile,x+(x<0?1:-1),meldOffset+k*.64*meldScale,rot).scale.setScalar(meldScale);meldOffset+=(count*.64+.32)*meldScale;});
 }
 for(const [seat,side]of [[view,0],[left,-1],[right,1]]){
  const p=g.players[seat],positions=riverLayout(p.river.length,side);p.river.forEach((t,i)=>{
   const {x,z,rot,scale}=positions[i];
   const group=tile(t,x,z,rot);
   group.scale.setScalar(scale);
   const latest=last?last.seat===seat&&last.index===i&&last.tile===t:g.phase==='react'&&g.pending.source===seat&&i===p.river.length-1;
   if(latest){marker.visible=true;marker.position.set(x,.9,z);renderer.domElement.dataset.marker=`${seat}:${i}:${t}`;
    if(!reduced()&&(fresh||performance.now()-eventStart<520)){flight={group,to:new THREE.Vector3(x,0,z),from:new THREE.Vector3(side?side*8.4:((last?.handIndex??6)-6)*.6,.5,side?-.8:6)};group.position.copy(flight.from);renderer.domElement.dataset.flight='moving';}
   }
  });
 }
 resizeScene();
}
export function resizeScene(){if(!renderer||!host?.isConnected)return;const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;
 // Account for the arena's CSS scale, including portrait rotation, before rasterizing.
 const arena=host.closest('.arena'),matrix=new DOMMatrix(getComputedStyle(arena||host).transform),scale=Math.hypot(matrix.a,matrix.b)||1;
 // Modest supersampling smooths diagonal 3D edges without forcing every device to 4K.
 // Budget is expressed in real drawing-buffer pixels, after the arena transform.
 const compact=Math.min(innerWidth,innerHeight)<=600;
 const pixelBudget=compact?4000000:8000000;
 const targetDpr=Math.max(1.5,Math.min(devicePixelRatio*1.25,3));
 const ratio=Math.min(4,Math.max(1,targetDpr*scale),Math.sqrt(pixelBudget/(w*h)));
 renderer.setPixelRatio(ratio);renderer.setSize(w,h,false);renderer.domElement.style.width='100%';renderer.domElement.style.height='100%';renderer.setViewport(0,0,w,h);renderer.setScissorTest(false);camera.aspect=w/h;camera.position.set(0,camera.aspect<1.7?18:16,camera.aspect<1.7?16:14);camera.lookAt(0,0,1.6);camera.updateProjectionMatrix();renderer.render(scene,camera);}
