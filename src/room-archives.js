export const ARCHIVE_KEY='kwx-room-archives-v1';
export function loadArchives(storage){
 const data=JSON.parse(storage.getItem(ARCHIVE_KEY)||'[]');
 return Array.isArray(data)?data:[];
}
export function archiveRoom(storage,state,endpoint=''){
 if(!state?.game?.history?.length)return;
 const history=state.game.history,first=history.at(-1);
 const id=endpoint+'|'+state.code+'|'+(first.id||first.endedAt||'legacy');
 const records=loadArchives(storage),previous=records.find(r=>r.id===id);
 if(previous&&previous.history.length===history.length&&previous.closed===!!state.closed)return;
 const record={id,code:state.code,names:state.members.map(m=>m.name),totals:[...state.game.totals],history:structuredClone(history),closed:!!state.closed,updatedAt:new Date().toISOString()};
 storage.setItem(ARCHIVE_KEY,JSON.stringify([record,...records.filter(r=>r.id!==id)]));
}
