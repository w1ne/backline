import { describe, it, expect } from 'vitest';
import { KeyDetector } from './keyDetector';
const play = (notes: number[]) => { const d = new KeyDetector(); notes.forEach(n => d.addNote(n)); return d; };
describe('KeyDetector', () => {
  it('is null before enough notes', () => { expect(play([60, 62, 64]).key).toBeNull(); });
  it('C major scale → C major', () => {
    expect(play([60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60]).key).toEqual({ root: 0, mode: 'major' });
  });
  it('A minor with emphasized A and E → A minor', () => {
    expect(play([57, 57, 64, 64, 60, 62, 57, 65, 64, 57, 59, 57]).key).toEqual({ root: 9, mode: 'minor' });
  });
  it('G major riff → G major', () => {
    expect(play([55, 59, 62, 55, 66, 67, 62, 59, 55, 57, 59, 55]).key).toEqual({ root: 7, mode: 'major' });
  });
});
