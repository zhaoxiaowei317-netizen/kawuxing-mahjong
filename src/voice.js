const makeCues=(file,names,spans)=>Object.fromEntries(names.map((name,i)=>[name,{file,start:spans[i][0],duration:spans[i][1]-spans[i][0]}]));

export const VOICE_CUES={
 ...makeCues('tiles-p.mp3',['p1','p2','p3','p4','p5','p6','p7','p8','p9'],[[.11,.87],[1.23,1.96],[2.32,3.08],[3.43,4.18],[4.57,5.21],[5.57,6.30],[6.63,7.35],[7.68,8.35],[8.71,9.46]]),
 ...makeCues('tiles-sz.mp3',['s1','s2','s3','s4','s5','s6','s7','s8','s9','z7','z6','z5'],[[.09,.79],[1.16,1.83],[2.23,2.95],[3.30,4.04],[4.40,5.04],[5.40,6.08],[6.44,7.18],[7.53,8.24],[8.59,9.32],[9.71,10.42],[10.84,11.53],[11.89,12.51]]),
 ...makeCues('actions.mp3',['碰','杠','明杠','暗杠','补杠','过','亮倒','胡了','点炮','自摸','流局','查叫'],[[.08,.60],[.94,1.35],[1.70,2.36],[2.72,3.34],[3.70,4.32],[4.67,5.11],[5.50,6.22],[6.59,7.20],[7.54,8.22],[8.59,9.28],[9.61,10.39],[10.77,11.42]]),
 ...makeCues('patterns.mp3',['普通胡','卡五星','碰碰胡','清一色','七对','豪七对','双豪七对','明四归','暗四归','小三元','大三元','全求人','杠上开花','杠上杠','杠上炮','海底自摸','海底放炮','一炮多响'],[[.10,.95],[1.33,2.35],[2.70,3.55],[3.89,4.77],[5.14,6.08],[6.45,7.46],[7.83,9.08],[9.45,10.39],[10.77,11.66],[12.06,13.00],[13.36,14.30],[14.66,15.64],[15.99,16.99],[17.32,18.15],[18.50,19.34],[19.74,20.87],[21.24,22.16],[22.52,23.53]])
};
VOICE_CUES['对亮']=VOICE_CUES['亮倒'];

const files=new Map();
let context,queueAt=0,generation=0,chain=Promise.resolve();
const activeSources=new Set();
const enabled=()=>localStorage.getItem('kwx-sound')!=='off';

async function load(file){
 if(files.has(file))return files.get(file);
 const promise=fetch(`assets/voice/${file}`).then(r=>{if(!r.ok)throw Error(`voice ${r.status}`);return r.arrayBuffer();}).then(data=>context.decodeAudioData(data));
 files.set(file,promise);
 try{return await promise;}catch(e){files.delete(file);throw e;}
}

export function unlockVoice(){
 if(!enabled())return;
 try{context??=new AudioContext();if(context.state==='suspended')context.resume().catch(()=>{});for(const cue of new Set(Object.values(VOICE_CUES).map(x=>x.file)))load(cue).catch(()=>{});}catch{}
}

export function speak(key,{delay=0,queue=true}={}){
 const version=generation;
 const schedule=async()=>{const cue=VOICE_CUES[key];if(!cue||!enabled()||version!==generation)return;
  try{unlockVoice();const buffer=await load(cue.file);if(!enabled()||version!==generation||!context||context.state!=='running')return;
   const when=queue?Math.max(context.currentTime+delay,queueAt):context.currentTime+delay;
   const source=context.createBufferSource(),gain=context.createGain();source.buffer=buffer;gain.gain.value=.92;source.connect(gain);gain.connect(context.destination);activeSources.add(source);source.onended=()=>activeSources.delete(source);source.start(when,cue.start,cue.duration);queueAt=when+cue.duration+.08;
  }catch{}
 };
 chain=chain.then(schedule,schedule);return chain;
}
export async function speakSequence(keys){const version=generation;for(const key of keys){if(version!==generation||!enabled())break;await speak(key);}}
export function resetVoiceQueue(){generation++;chain=Promise.resolve();for(const source of activeSources){try{source.stop();}catch{}}activeSources.clear();queueAt=context?.currentTime||0;}
