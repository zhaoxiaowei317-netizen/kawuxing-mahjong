// GENERATED import-only mirror of ai/policies/h0.mjs; see build.mjs.
// H0 snapshot, 2026-10-17. Preserve the current companion's decisions.
// Rule helpers remain canonical and their source hashes are pinned in manifest.json.
import {TYPES, counts, waits, distance} from './geometry.mjs';

function chooseDiscard(p, drawTile, allowed=null, context=null) {
  if (p.liang) return {index:p.hand.lastIndexOf(drawTile), reveal:false};
  const withGame = Boolean(context);
  const vis = withGame ? context.visibleCounts : null;
  const selfOwned = !withGame ? counts([...p.hand, ...p.melds.flatMap(m => Array(m.kind === 'peng' ? 3 : 4).fill(m.tile))]) : null;
  const rem = t => Math.max(0, 4 - ((withGame ? vis[t] : selfOwned[t]) || 0));
  const options = [];
  for (let index = 0; index < p.hand.length; index++) {
    if (allowed && !allowed.includes(index)) continue;
    if (p.hand.indexOf(p.hand[index]) !== index) continue;
    const h = p.hand.filter((_, i) => i !== index), ready = waits(h, p.melds, true), d = distance(h, p.melds);
    let outs = 0;
    for (const t of TYPES) if (rem(t) > 0 && distance([...h, t], p.melds) < d) outs += rem(t);
    const readyOuts = ready.reduce((s, w) => s + rem(w.tile), 0);
    const maxRaw = ready.reduce((m, w) => Math.max(m, w.score?.raw || 0), 0);
    let shouldReveal = false;
    if (ready.length > 0) {
      const condA = readyOuts >= 2;
      const condB = !context || context.wallCount >= 10;
      const oppLiang = Boolean(context && context.players.some((op, i) => i !== context.seat && op.liang));
      const condC = !oppLiang || readyOuts >= 4 || (maxRaw >= 4 && readyOuts >= 2);
      shouldReveal = condA && condB && condC;
    }
    options.push({index, reveal:shouldReveal, d, outs, ready:ready.length, readyOuts, maxRaw});
  }
  return options.sort((a, b) => Number(b.reveal) - Number(a.reveal) || a.d - b.d ||
    (b.readyOuts || 0) - (a.readyOuts || 0) || b.outs - a.outs || b.ready - a.ready)[0];
}

export const id = 'H0';
export function selectAction(observation, legalActions) {
  const o = observation, p = o.players[o.seat];
  const find = type => legalActions.find(a => a.type === type);
  if (find('hu')) return find('hu');
  if (o.phase === 'react') {
    if (find('ming')) return find('ming');
    if (find('peng')) {
      const h = [...p.hand], t = o.pending.tile;
      h.splice(h.indexOf(t), 1); h.splice(h.indexOf(t), 1);
      const after = {hand:h, melds:[...p.melds, {kind:'peng', tile:t}], liang:false};
      if (chooseDiscard(after, null).d < distance(p.hand, p.melds)) return find('peng');
    }
    return find('pass');
  }
  if (find('kong')) return find('kong');
  const permitted = new Set(legalActions.filter(a => a.type === 'discard').map(a => a.tile));
  const allowed = p.hand.map((_, i) => i).filter(i => permitted.has(p.hand[i]));
  const best = chooseDiscard(p, o.drawTile, allowed, o), tile = p.hand[best.index];
  return legalActions.find(a => a.type === 'discard' && a.tile === tile && a.reveal === best.reveal);
}
