import {readFileSync} from 'node:fs';
import {sha256} from '../provenance.mjs';
import {SCHEMA,LENGTH,POSITIONS,CHANNELS,CONTEXT_SIZE,encodePublic,unpack,legalActionIds,decodeAction} from './encoding.mjs';
import {assertSources} from './sources.mjs';
export const MODEL_VERSION='kwx-tile-dueling-q-1';
const valid=new Set(POSITIONS);
export class TileQ {
  constructor(data){
    if(data.version!==MODEL_VERSION||JSON.stringify(data.schema)!==JSON.stringify(SCHEMA))throw Error('Incompatible tile-Q model');
    this.data=data;this.config=data.config;
    const c=this.config;
    if(typeof c.useTiles!=='boolean'||![c.channels,c.blocks,c.globalSize,c.localSize].every(n=>Number.isInteger(n)&&n>0&&n<1025))throw Error('Invalid Q dimensions');
    const expected={};const conv=(name,out,ins)=>{expected[`${name}.weight`]=[out,ins,3];expected[`${name}.bias`]=[out];};
    const linear=(name,out,ins)=>{expected[`${name}.weight`]=[out,ins];expected[`${name}.bias`]=[out];};
    conv('stem',c.channels,CHANNELS);
    for(let i=0;i<c.blocks;i++){conv(`blocks.${i}.a`,c.channels,c.channels);conv(`blocks.${i}.b`,c.channels,c.channels);}
    linear('globalLayer',c.globalSize,2*c.channels+CONTEXT_SIZE);linear('localLayer',c.localSize,c.channels+c.globalSize+SCHEMA.candidateSize);
    linear('actionHead',1,c.localSize);linear('valueHead',1,c.globalSize);linear('rankHead',3,c.globalSize);
    if(Object.keys(data.weights).sort().join()!==Object.keys(expected).sort().join())throw Error('Q weight keys differ');
    this.weights={};
    for(const [name,shape]of Object.entries(expected)){
      const p=data.weights[name];if(JSON.stringify(p.shape)!==JSON.stringify(shape)||p.values.length!==shape.reduce((a,b)=>a*b,1)||p.values.some(v=>!Number.isFinite(v)))throw Error(`Invalid Q weight: ${name}`);
      this.weights[name]=Float64Array.from(p.values);
    }
  }
  linear(name,x,relu=false){
    const w=this.weights[`${name}.weight`],b=this.weights[`${name}.bias`],out=new Float64Array(b.length);
    for(let j=0;j<b.length;j++){let v=b[j];for(let i=0;i<x.length;i++)v+=w[j*x.length+i]*x[i];out[j]=relu?Math.max(0,v):v;}return out;
  }
  conv(name,x,ins,outs,relu=false){
    const w=this.weights[`${name}.weight`],b=this.weights[`${name}.bias`],result=new Float64Array(outs*LENGTH);
    for(let o=0;o<outs;o++)for(const pos of POSITIONS){
      let v=b[o];for(let i=0;i<ins;i++)for(let k=0;k<3;k++){
        const p=pos+k-1;if(p>=0&&p<LENGTH)v+=w[(o*ins+i)*3+k]*x[i*LENGTH+p];
      }result[o*LENGTH+pos]=relu?Math.max(0,v):v;
    }return result;
  }
  forward(encoded,legalIds){
    if(!legalIds.length||new Set(legalIds).size!==legalIds.length||legalIds.some(i=>!Number.isInteger(i)||i<0||i>=88))throw Error('Invalid Q mask');
    const c=this.config,C=c.channels,input=unpack(encoded);let x=c.useTiles?this.conv('stem',input,CHANNELS,C,true):new Float64Array(C*LENGTH);
    for(let n=0;c.useTiles&&n<c.blocks;n++){
      const a=this.conv(`blocks.${n}.a`,x,C,C,true),b=this.conv(`blocks.${n}.b`,a,C,C);
      for(let i=0;i<x.length;i++)x[i]=Math.max(0,x[i]+b[i]);
    }
    const pooled=[];
    for(let j=0;j<C;j++)pooled.push(POSITIONS.reduce((s,p)=>s+x[j*LENGTH+p],0)/21);
    for(let j=0;j<C;j++)pooled.push(Math.max(...POSITIONS.map(p=>x[j*LENGTH+p])));
    const global=this.linear('globalLayer',[...pooled,...encoded.context],true),advantage=new Float64Array(88);
    const candidates=new Map(encoded.candidates.map(c=>[c.id,c.values]));
    for(const id of legalIds){
      const values=candidates.get(id);
      if(!values||values.length!==SCHEMA.candidateSize||values.some(v=>!Number.isFinite(v)))throw Error('Invalid action features');
      const local=[...Array.from({length:C},(_,j)=>id<84?x[j*LENGTH+POSITIONS[id%21]]:0),...global,...values];
      advantage[id]=this.linear('actionHead',this.linear('localLayer',local,true))[0];
    }
    const value=this.linear('valueHead',global)[0],mean=legalIds.reduce((s,i)=>s+advantage[i],0)/legalIds.length;
    const q=Array(88).fill(-Infinity);for(const i of legalIds){q[i]=value+advantage[i]-mean;if(!Number.isFinite(q[i]))throw Error('Nonfinite Q');}
    return {q,value,rankLogits:Array.from(this.linear('rankHead',global))};
  }
  select(o,legal,rng=null,epsilon=0){
    if(legal.length===1)return legal[0];
    if(epsilon<0||epsilon>1)throw Error('Invalid epsilon');
    if(epsilon&&rng&&rng(0x100000000)/0x100000000<epsilon)return legal[rng(legal.length)];
    const ids=legalActionIds(legal),{q}=this.forward(encodePublic(o,legal),ids);
    let best=ids[0];for(const id of ids)if(q[id]>q[best])best=id;return decodeAction(best,legal);
  }
}
export function loadQ(path){const bytes=readFileSync(path),data=JSON.parse(bytes);assertSources(data.sources);return {model:new TileQ(data),sha256:sha256(bytes),data};}
export const qFactory=model=>()=> (o,legal)=>model.select(o,legal);
