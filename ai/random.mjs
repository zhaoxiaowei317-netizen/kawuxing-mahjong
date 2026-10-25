import {createHash} from 'node:crypto';

// Evaluation only. Production dealing continues to use the engine's secure RNG.
export function deriveSeed(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function seededRandom(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  const uint32 = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return (t ^ t >>> 14) >>> 0;
  };
  return max => {
    if (!Number.isInteger(max) || max < 1 || max > 0x100000000) throw Error('Invalid RNG range');
    const limit = 0x100000000 - 0x100000000 % max;
    let value;
    do { value = uint32(); } while (value >= limit);
    return value % max;
  };
}
