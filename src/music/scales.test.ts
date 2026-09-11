import { describe, it, expect } from 'vitest';
import { degreeToMidi, keyName, scaleOf } from './scales';
describe('scales', () => {
  it('A minor scale', () => { expect(scaleOf({ root: 9, mode: 'minor' })).toEqual([9, 11, 0, 2, 4, 5, 7]); });
  it('degreeToMidi wraps', () => {
    const c = { root: 0, mode: 'major' as const };
    expect(degreeToMidi(c, 0, 4)).toBe(60);
    expect(degreeToMidi(c, 7, 4)).toBe(72);
    expect(degreeToMidi(c, -1, 4)).toBe(59);
  });
  it('names', () => { expect(keyName({ root: 9, mode: 'minor' })).toBe('A min'); });
});
