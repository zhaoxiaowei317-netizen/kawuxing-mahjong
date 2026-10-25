import {TYPES, counts, RULES_VERSION} from '../../src/engine.js';
import {OBSERVATION_VERSION} from '../environment.mjs';
import {encodeCandidates,FEATURE_SIZE as CANDIDATE_SIZE} from '../action-scorer/features.mjs';
export {actionId, legalActionIds, decodeAction} from '../training/encoding.mjs';

export const ENCODING_VERSION='kwx-tile-q-public-1';
export const POSITIONS=Object.freeze([0,1,2,3,4,5,6,7,8,11,12,13,14,15,16,17,18,19,22,25,28]);
export const LENGTH=29;
const tileIndex=new Map(TYPES.map((t,i)=>[t,i]));
const planes=[];
const plane=(name,scale=1)=>planes.push({name,scale});
for(let n=1;n<=4;n++)plane(`own.count>=${n}`);
plane('own.draw');
for(let n=1;n<=4;n++)plane(`visible.count>=${n}`);
for(let r=0;r<3;r++){
  for(let n=1;n<=4;n++)plane(`p${r}.revealed>=${n}`);
  plane(`p${r}.riverCount`,4);
  for(const kind of ['peng','ming','an','bu'])plane(`p${r}.meld.${kind}`);
  plane(`p${r}.waits`);
  for(let copy=0;copy<4;copy++)plane(`p${r}.riverOrder.${copy}`,48);
}
for(const flag of ['passedHu','passedPeng','buOpportunities','reservedKongTiles','supplementForbidden'])plane(`own.${flag}`);
for(let copy=0;copy<4;copy++)plane(`own.order.${copy}`,14);
plane('type.suited');plane('type.honor');plane('type.rank',9);plane('pending.tile');plane('last.tile');
export const PLANE_SCHEMA=Object.freeze(planes.map(Object.freeze));
export const CHANNELS=planes.length;
export const CONTEXT_NAMES=Object.freeze([
  ...[0,1,2].flatMap(r=>[`p${r}.liang`,`p${r}.size`,`p${r}.hidden`,`p${r}.riverSize`,`p${r}.meldSize`,`p${r}.total`,`p${r}.kongNet`]),
  'wall','gangChain','round',...[0,1,2].map(i=>`dealer.${i}`),...[0,1,2].map(i=>`turn.${i}`),
  'phase.discard','phase.react',...[0,1,2].map(i=>`pending.source.${i}`),'pending.discard','pending.robKong',
  'pending.gangShot','pending.gangCount',...[0,1,2].map(i=>`last.source.${i}`),
]);
export const CONTEXT_SIZE=CONTEXT_NAMES.length;
export const SCHEMA=Object.freeze({version:ENCODING_VERSION,tiles:TYPES,positions:POSITIONS,length:LENGTH,
  channels:CHANNELS,planes:PLANE_SCHEMA,contextNames:CONTEXT_NAMES,contextSize:CONTEXT_SIZE,actions:88,candidateSize:CANDIDATE_SIZE});
export function kongNet(o,seat=o.seat){return o.kongs.reduce((s,k)=>s+(k.to===seat?k.amount:0)-(k.from===seat?k.amount:0),0);}
export function encodePublic(o,legal){
  if(o.version!==OBSERVATION_VERSION||o.rulesVersion!==RULES_VERSION||o.config.cap!==16)throw Error('Incompatible public observation');
  const p=o.players[o.seat], tiles=new Uint8Array(CHANNELS*LENGTH),context=[];
  let channel=0;
  const put=values=>{
    if(values.length!==21)throw Error('Invalid tile plane');
    for(let i=0;i<21;i++){
      const v=values[i];if(!Number.isInteger(v)||v<0||v>255)throw Error('Invalid byte feature');
      tiles[channel*LENGTH+POSITIONS[i]]=v;
    }channel++;
  };
  const countPlanes=values=>{for(let n=1;n<=4;n++)put(TYPES.map(t=>Number((values[t]||0)>=n)));};
  const membership=values=>{const set=new Set(values);put(TYPES.map(t=>Number(set.has(t))));};
  const order=values=>{
    if(values.length>48)throw Error('River exceeds history capacity');
    for(let copy=0;copy<4;copy++)put(TYPES.map(t=>{let seen=0;return values.findIndex(x=>x===t&&seen++===copy)+1;}));
  };
  countPlanes(counts(p.hand));membership(o.drawTile?[o.drawTile]:[]);countPlanes(o.visibleCounts);
  for(let r=0;r<3;r++){
    const q=o.players[(o.seat+r)%3];
    // Whitelist: an injected opponent hand is deliberately ignored.
    const revealed=r===0?(q.liang?q.hand.filter(t=>!p.reservedKongTiles.includes(t)):[]):q.revealedTiles;
    countPlanes(counts(revealed));const riverCounts=counts(q.river);put(TYPES.map(t=>riverCounts[t]||0));
    for(const kind of ['peng','ming','an','bu'])membership(q.melds.filter(m=>m.kind===kind).map(m=>m.tile));
    membership(q.publicWaits);order(q.river);
    context.push(Number(q.liang),q.handSize/14,(r===0?q.handSize-revealed.length:q.hiddenTileCount)/14,
      q.river.length/48,q.melds.length/4,Math.asinh(o.totals[q.seat]/o.config.base)/Math.asinh(100),
      Math.asinh(kongNet(o,q.seat)/o.config.base)/Math.asinh(100));
  }
  for(const flag of ['passedHu','passedPeng','buOpportunities','reservedKongTiles'])membership(p[flag]);
  membership(p.melds.filter(m=>m.supplementForbidden).map(m=>m.tile));order(p.hand);
  put(TYPES.map(t=>Number(t[0]!=='z')));put(TYPES.map(t=>Number(t[0]==='z')));
  put(TYPES.map(t=>t[0]==='z'?0:Number(t[1])));membership(o.pending?[o.pending.tile]:[]);membership(o.lastDiscard?[o.lastDiscard.tile]:[]);
  const relative=s=>(s-o.seat+3)%3,hot=s=>[0,1,2].map(i=>Number(s!==null&&s!==undefined&&relative(s)===i));
  context.push(o.wallCount/44,o.gangChain/16,o.round/16,...hot(o.dealer),...hot(o.turn),
    Number(o.phase==='discard'),Number(o.phase==='react'),...hot(o.pending?.source),
    Number(o.pending?.kind==='discard'),Number(o.pending?.kind==='robKong'),
    (o.pending?.gangShot||0)/16,(o.pending?.gangCount||0)/16,...hot(o.lastDiscard?.seat));
  if(channel!==CHANNELS||context.length!==CONTEXT_SIZE||context.some(v=>!Number.isFinite(v)))throw Error('Invalid tile-Q features');
  const candidates=encodeCandidates(o,legal).candidates.map(c=>({id:c.id,values:c.values.map(v=>v===0?0:v)}));
  return {tiles:Buffer.from(tiles).toString('base64'),context:context.map(v=>v===0?0:v),candidates};
}
export function unpack(encoded){
  const raw=Buffer.from(encoded.tiles,'base64');
  if(raw.length!==CHANNELS*LENGTH||encoded.context.length!==CONTEXT_SIZE||encoded.context.some(x=>!Number.isFinite(x)))throw Error('Malformed tile-Q input');
  const result=new Float64Array(raw.length);
  const positions=new Set(POSITIONS);
  for(let c=0;c<CHANNELS;c++)for(let i=0;i<LENGTH;i++){
    if(!positions.has(i)&&raw[c*LENGTH+i]!==0)throw Error('Nonzero suit separator');
    result[c*LENGTH+i]=raw[c*LENGTH+i]/PLANE_SCHEMA[c].scale;
  }
  return result;
}
