// Read-only continuation aid. Recorded stages are not process-liveness checks.
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const matches=(path,expected)=>existsSync(path)&&sha(path)===expected;
const read=path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};
const runs=[
  ['wall-average','ai-runs/wall-average-20261023','docs/reports/wall-average-2026-10-23'],
  ['confidence-gate','ai-runs/confidence-gate-20261023','docs/reports/confidence-gate-2026-10-23'],
];
const result=[];
for(const [id,out,report]of runs){
  const state=read('.tmp/'+id+'-evidence-status.json'),summary=read(resolve(out,'summary.json')),verification=read(resolve(out,'verification.json')),checksums=read(resolve(report,'checksums.json'));
  const audited=!!(summary&&verification&&verification.summarySha256===sha(resolve(out,'summary.json'))&&verification.planSha256===sha(resolve(out,'plan.json'))&&verification.allGroupsRecomputedWithoutScoreCache&&Object.entries(verification.sourceMap).every(([path,expected])=>matches(path,expected))&&Object.values(summary.models).every(m=>matches(m.path,m.sha256))),
    artifacts=read(resolve(report,'artifacts.json')),publicationVerified=!!(checksums&&artifacts&&checksums.every(r=>matches(resolve(report,r.path),r.sha256))&&artifacts.every(r=>matches(resolve(r.path),r.sha256)));
  const auditPath=resolve(out,'.audit'),files=existsSync(auditPath)?readdirSync(auditPath):[],dataParts=files.filter(n=>n.startsWith('data-')&&n.endsWith('.result.json')).length,
    gameGroups=files.filter(n=>n.startsWith('pair-')&&n.endsWith('.result.json')).length;
  let guidance='保留现有输出，等待当前任务；不要重复启动同一路径。';
  if(state?.stage==='failed')guidance='检查状态中的错误及原始日志；先修复失败阶段，不要删除数据、重抽种子或盲目重跑。';
  else if(state?.stage==='complete')guidance=audited&&publicationVerified?'审计和报告校验完成，可阅读归档结果。':'状态与文件证据不一致，需要核对，不能视为完成。';
  else if(state?.stage==='waiting-for-parent-evidence')guidance='等待父实验完整审计和归档，之后本地任务按已冻结方案自动继续。';
  result.push({id,recordedStage:state?.stage??'unavailable',stageUpdatedAt:state?.at??null,error:state?.error??null,
    actualStudyGames:summary?.games??null,studyOutcomes:summary?.outcomes??null,uncachedAuditVerified:audited,publicationChecksumsVerified:publicationVerified,
    writtenDataAuditParts:dataParts,writtenGameAuditGroups:gameGroups,guidance,
    report:publicationVerified?resolve(report,'实验结果.md'):null});
}
process.stdout.write(JSON.stringify({at:new Date().toISOString(),readOnly:true,stagesAreRecordedSnapshots:true,runs:result},null,2)+'\n');
