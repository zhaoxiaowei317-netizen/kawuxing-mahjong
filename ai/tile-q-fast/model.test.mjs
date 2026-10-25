import test from 'node:test';
import assert from 'node:assert/strict';
import {TileQ} from '../tile-q/model.mjs';
import {FastTileQ} from './model.mjs';
import {SCHEMA,CHANNELS,LENGTH,POSITIONS,encodePublic,legalActionIds} from '../tile-q/encoding.mjs';
import {seededRandom} from '../random.mjs';
import {MahjongEnvironment} from '../environment.mjs';

function fixture({channels=4,blocks=2,useTiles=true}={}){
  const rng=seededRandom('unrolled-conv-test'),weights={},config={channels,blocks,globalSize:8,localSize:8,useTiles};
  const put=(name,shape)=>{weights[name]={shape,values:Array.from({length:shape.reduce((n,x)=>n*x,1)},()=>((rng(2001)-1000)/1000)*.15)};};
  const conv=(name,ins,outs)=>{put(name+'.weight',[outs,ins,3]);put(name+'.bias',[outs]);},linear=(name,ins,outs)=>{put(name+'.weight',[outs,ins]);put(name+'.bias',[outs]);};
  conv('stem',CHANNELS,channels);for(let n=0;n<blocks;n++){conv(`blocks.${n}.a`,channels,channels);conv(`blocks.${n}.b`,channels,channels);}
  linear('globalLayer',channels*2+SCHEMA.contextSize,8);linear('localLayer',channels+8+SCHEMA.candidateSize,8);linear('actionHead',8,1);linear('valueHead',8,1);linear('rankHead',8,3);
  return {version:'kwx-tile-dueling-q-1',schema:SCHEMA,config,weights};
}
test('unrolled convolution matches every reference bit at boundaries, separators, signs and ReLU',()=>{
  for(const channels of [1,4,12]){const data=fixture({channels}),a=new TileQ(data),b=new FastTileQ(data),rng=seededRandom('signed-conv-input');
    for(const [name,ins,outs]of [['stem',CHANNELS,channels],['blocks.0.a',channels,channels]])for(const relu of [false,true]){
      const x=Float64Array.from({length:ins*LENGTH},()=>rng(5)===0?-0:(rng(2001)-1000)/700);assert.deepEqual(b.conv(name,x,ins,outs,relu),a.conv(name,x,ins,outs,relu));
      const out=b.conv(name,x,ins,outs,relu);for(let o=0;o<outs;o++)for(let p=0;p<LENGTH;p++)if(!POSITIONS.includes(p))assert.equal(out[o*LENGTH+p],0);
    }
  }
});
test('complete fast forward and decisions equal reference for public observations and disabled tiles',()=>{
  for(const useTiles of [true,false]){const data=fixture({useTiles}),a=new TileQ(data),b=new FastTileQ(data);
    for(let seed=0;seed<24;seed++){const env=new MahjongEnvironment({seed:'fast-forward-'+seed}),legal=env.legalActions(),o=env.observation(),encoded=encodePublic(o,legal),ids=legalActionIds(legal);
      assert.deepEqual(b.forward(encoded,ids),a.forward(encoded,ids));assert.deepEqual(b.select(o,legal),a.select(o,legal));
      assert.throws(()=>b.forward(encoded,[ids[0],ids[0]]));assert.throws(()=>b.forward(encoded,[]));
    }
  }
});
