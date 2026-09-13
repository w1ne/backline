import { describe, it, expect } from 'vitest';
import { mod12, NOTE_NAMES, pcDistance, centsBetween, hzToMidi, keyName } from './pitchClass';

describe('pitchClass', () => {
  it('mod12 folds negatives and overflow into 0..11', () => {
    expect(mod12(-1)).toBe(11);
    expect(mod12(12)).toBe(0);
    expect(mod12(-13)).toBe(11);
    expect(mod12(7)).toBe(7);
  });

  it('pcDistance is the shorter way round the circle', () => {
    expect(pcDistance(0, 11)).toBe(1);
    expect(pcDistance(0, 6)).toBe(6);
    expect(pcDistance(2, 9)).toBe(5);
    expect(pcDistance(60, 67)).toBe(5);
  });

  it('centsBetween measures an octave as 1200 cents, signed', () => {
    expect(centsBetween(880, 440)).toBeCloseTo(1200, 6);
    expect(centsBetween(440, 880)).toBeCloseTo(-1200, 6);
  });

  it('hzToMidi is fractional so callers keep the cents', () => {
    expect(hzToMidi(440)).toBe(69);
    expect(hzToMidi(261.63)).toBeCloseTo(60, 2);
    expect(hzToMidi(466.16)).toBeCloseTo(70, 2);
  });

  it('names every pitch class and both key spellings', () => {
    expect(NOTE_NAMES).toHaveLength(12);
    expect(NOTE_NAMES[0]).toBe('C');
    expect(NOTE_NAMES[11]).toBe('B');
    expect(keyName({ root: 9, mode: 'minor' })).toBe('A min');
    expect(keyName({ root: 0, mode: 'major' })).toBe('C maj');
    expect(keyName({ root: 9, mode: 'minor' }, true)).toBe('A minor');
    expect(keyName({ root: 13, mode: 'major' }, true)).toBe('C# major');
  });
});
