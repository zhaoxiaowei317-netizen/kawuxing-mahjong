import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SCHEMA,extractFeatures} from './features.mjs';
import {sha256} from '../provenance.mjs';
export const MODEL_VERSION='kwx-ridge-public-gain-gate-1';
export class GainGate{
  constructor(data){assert.equal(data.version,MODEL_VERSION);assert.deepEqual(data.schema,SCHEMA);const n=SCHEMA.names.length;
    for(const key of ['mean','scale','weights'])assert.ok(Array.isArray(data[key])&&data[key].length===n&&data[key].every(Number.isFinite));
    assert.ok(data.scale.every(x=>x>0));assert.ok(Number.isFinite(data.intercept));this.data=data;this.constant=data.weights.every(x=>x===0);
  }
  predict(features){const d=this.data;assert.equal(features.length,d.weights.length);assert.ok(features.every(Number.isFinite));if(this.constant)return d.intercept;let result=d.intercept;
    for(let i=0;i<features.length;i++)result+=d.weights[i]*((features[i]-d.mean[i])/d.scale[i]);assert.ok(Number.isFinite(result));return result;
  }
  predictRoot(root,teachers){return this.predict(extractFeatures(root,teachers));}
  constantChoice(){return this.constant?this.data.intercept>0?'alternative':'baseline':null;}
}
export function loadGate(path){const bytes=readFileSync(path),data=JSON.parse(bytes);return {model:new GainGate(data),data,sha256:sha256(bytes)};}
