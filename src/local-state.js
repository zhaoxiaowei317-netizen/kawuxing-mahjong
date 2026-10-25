import {newGame,RULES_VERSION} from './engine.js';

// Back up an old live state before allowing the new version to write its key.
export function loadLocalGame(storage){
 try{
  const raw=storage.getItem('kwx-lab-v1'),saved=JSON.parse(raw||'null');
  if(saved?.players&&saved.config?.rulesVersion===RULES_VERSION)return {game:saved,migrated:false,writable:true};
  if(saved?.players){
   storage.setItem('kwx-lab-legacy-v1',raw);
   return {game:newGame(saved.config,{history:saved.history||[]}),migrated:true,writable:true};
  }
  return {game:newGame(),migrated:false,writable:true};
 }catch{
  // A failed backup or unreadable store must never lead to overwriting the original.
  return {game:newGame(),migrated:true,writable:false};
 }
}
