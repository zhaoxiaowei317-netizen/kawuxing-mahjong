import {TileQ as ReferenceTileQ,loadQ as referenceLoad} from '../tile-q/model.mjs';
import {LENGTH,POSITIONS} from '../tile-q/encoding.mjs';

export const BACKEND_VERSION='kwx-tile-q-unrolled-convolution-1';

// Same arithmetic order as the frozen reference. Only the three-tap loop and
// its repeated boundary tests are unrolled. No quantization, cache, new weights,
// skipped zero products, or policy change. Never used by frozen experiments.
export class FastTileQ extends ReferenceTileQ{
  conv(name,x,ins,outs,relu=false){
    const w=this.weights[`${name}.weight`],b=this.weights[`${name}.bias`],result=new Float64Array(outs*LENGTH);
    for(let o=0;o<outs;o++)for(const pos of POSITIONS){
      let v=b[o],wi=o*ins*3;
      if(pos===0){
        for(let i=0,xi=0;i<ins;i++,xi+=LENGTH,wi+=3){v+=w[wi+1]*x[xi];v+=w[wi+2]*x[xi+1];}
      }else if(pos===LENGTH-1){
        for(let i=0,xi=pos;i<ins;i++,xi+=LENGTH,wi+=3){v+=w[wi]*x[xi-1];v+=w[wi+1]*x[xi];}
      }else{
        for(let i=0,xi=pos;i<ins;i++,xi+=LENGTH,wi+=3){v+=w[wi]*x[xi-1];v+=w[wi+1]*x[xi];v+=w[wi+2]*x[xi+1];}
      }
      result[o*LENGTH+pos]=relu?Math.max(0,v):v;
    }
    return result;
  }
}

export function loadFastQ(path){const {data,sha256}=referenceLoad(path);return {model:new FastTileQ(data),data,sha256,backend:BACKEND_VERSION};}
