import {mkdirSync,mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {save} from '../../ai/tile-q/collect.mjs';
import {run as trainFixture} from '../../ai/strong-pool/study.mjs';
import {verify as verifyTraining} from '../../ai/strong-pool/verify-stream.mjs';
import {run as confirmFixture} from '../../ai/strong-confirm/study.mjs';
import {verify as verifyConfirmation} from '../../ai/strong-confirm/verify.mjs';
import {diagnose} from '../../ai/strong-confirm/diagnose.mjs';
import {run as guardFixture} from '../../ai/outs-guard/study.mjs';
import {verify as verifyGuard} from '../../ai/outs-guard/verify.mjs';
import {run as distillFixture} from '../../ai/outs-distill/study.mjs';
import {verify as verifyDistill} from '../../ai/outs-distill/verify.mjs';
import {run as anchorFixture} from '../../ai/outs-anchor/study.mjs';
import {verify as verifyAnchor} from '../../ai/outs-anchor/verify.mjs';
import {run as durationFixture} from '../../ai/outs-duration/study.mjs';
import {verify as verifyDuration} from '../../ai/outs-duration/verify.mjs';
import {run as componentFixture} from '../../ai/decision-components/study.mjs';
import {verify as verifyComponent} from '../../ai/decision-components/verify.mjs';
import {diagnose as diagnoseComponent} from '../../ai/decision-components/diagnose.mjs';
import {run as discoveryFixture} from '../../ai/hu-kong/study.mjs';
import {verify as verifyDiscovery} from '../../ai/hu-kong/verify.mjs';
import {run as replicate} from '../../ai/hu-kong-confirm/study.mjs';
import {verify as verifyReplication} from '../../ai/hu-kong-confirm/verify.mjs';
export async function buildParent(){
  mkdirSync('.tmp/paired-tile-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/paired-tile-tests/run-')),
    training=resolve(root,'training'),confirmation=resolve(root,'confirmation'),guard=resolve(root,'guard'),distill=resolve(root,'distill'),anchor=resolve(root,'anchor'),duration=resolve(root,'duration'),component=resolve(root,'components'),discovery=resolve(root,'discovery'),out=resolve(root,'replication');
  await trainFixture({out:training,trainingHands:12,validationHands:12,trainingSessionHands:1,sessionHands:1,workers:2,evaluationGroups:1,bootstrapSamples:30,
    bcEpochs:1,offlineEpochs:1,network:{channels:4,blocks:1,globalSize:8,localSize:8,useTiles:true}});await verifyTraining({out:training});
  await confirmFixture({out:confirmation,previous:training,evaluationGroups:1,bootstrapSamples:30,workers:2});await verifyConfirmation({out:confirmation});diagnose({out:confirmation});
  await guardFixture({out:guard,previous:confirmation,groupsPerPair:1,bootstrapSamples:30,workers:2});await verifyGuard({out:guard});
  await distillFixture({out:distill,previous:guard,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDistill({out:distill});
  await anchorFixture({out:anchor,previous:distill,trainingHands:36,validationHands:18,epochs:1,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyAnchor({out:anchor});
  await durationFixture({out:duration,previous:anchor,epochs:2,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30});await verifyDuration({out:duration});
  await componentFixture({out:component,previous:duration,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:128});await verifyComponent({out:component});await diagnoseComponent({out:component});
  await discoveryFixture({out:discovery,previous:component,groupsPerPair:1,sessionHands:1,workers:2,bootstrapSamples:30,cacheCapacity:128});await verifyDiscovery({out:discovery});
await replicate({out,discovery});await verifyReplication({out});return out;
}
