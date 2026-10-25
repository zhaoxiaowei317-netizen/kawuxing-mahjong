// Post-hoc rule/behavior description only; this file is not a policy or selector.
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {save} from '../tile-q/collect.mjs';
import {check,hash,read} from './study.mjs';
export async function explain(out){
  out=resolve(out);const p=read(resolve(out,'plan.json')),s=read(resolve(out,'summary.json'));check(p);assert.ok(s.sealed);
  const r=read(resolve(out,'sealed/report.json')),path=resolve(out,'sealed/replays.jsonl.gz');assert.equal(hash(path),r.artifacts.replays.sha256);
  const sides=Object.fromEntries(['candidate','incumbent'].map(side=>[side,{hands:0,dealIns:0,dealInsWhileRevealed:0,dealInsWhileConcealed:0,
    wins:0,selfDraws:0,discardWins:0,score:0,huScore:0,kongScore:0,drawScore:0}]));
  for await(const line of createInterface({input:createReadStream(path).pipe(createGunzip()),crlfDelay:Infinity})){
    if(!line)continue;const e=JSON.parse(line),result=e.replay.result,a=sides[e.arm],seat=e.roles.indexOf('C');
    const won=result.winners.includes(seat),deal=result.winners.length>0&&result.source===seat;
    const kong=result.kongs.reduce((sum,k)=>sum+(k.to===seat?k.amount:0)-(k.from===seat?k.amount:0),0);
    a.hands++;a.dealIns+=Number(deal);if(deal)a[result.players[seat].liang?'dealInsWhileRevealed':'dealInsWhileConcealed']++;
    a.wins+=Number(won);a.selfDraws+=Number(won&&result.source===null);a.discardWins+=Number(won&&result.source!==null);
    a.score+=result.delta[seat];a.kongScore+=kong;a[result.winners.length?'huScore':'drawScore']+=result.delta[seat]-kong;
  }
  for(const side of Object.keys(sides)){
    const a=sides[side];assert.equal(a.dealIns,a.dealInsWhileRevealed+a.dealInsWhileConcealed);assert.equal(a.wins,a.selfDraws+a.discardWins);
    for(const key of ['hands','dealIns','wins','selfDraws','score','huScore','kongScore','drawScore'])assert.equal(a[key],r.records.reduce((sum,row)=>sum+row[side][key],0));
  }
  const explanation={createdAt:new Date().toISOString(),kind:'Post-hoc descriptive rule consistency check; not an additional confirmatory hypothesis test',
    rules:{document:'docs/孝感卡五星正式规则.md',documentSha256:hash('docs/孝感卡五星正式规则.md'),engineSha256:hash('src/engine.js'),
      concealed:'An unrevealed player with a safe discard must avoid publicly revealed opponent waits.',
      revealed:'A revealed player normally must discard the drawn tile, even if it is dangerous.'},
    inference:'Remaining concealed retains discard flexibility and avoidance of public waits under these rules. This is consistent with the observed reduction in deal-ins, but this count does not identify the exact mediated share of the total score effect or prove never revealing is universally optimal.',
    sourceSha256:hash(fileURLToPath(import.meta.url)),replaysSha256:hash(path),sides};
  save(resolve(out,'rule-explanation.json'),explanation);return explanation;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))explain(process.argv[2]).then(r=>console.log(JSON.stringify(r.sides))).catch(e=>{console.error(e);process.exitCode=1;});
