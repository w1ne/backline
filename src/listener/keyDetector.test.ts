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

describe('KeyDetector early lock for a singer', () => {
  it('locks A minor from five clearly minor notes', () => { expect(play([57, 60, 64, 57, 62]).key).toEqual({ root: 9, mode: 'minor' }); });
  it('stays undecided on five ambiguous notes', () => { expect(play([60, 62, 60, 62, 60]).key).toBeNull(); });
});

describe('KeyDetector coverage acceptance for a sung line', () => {
  // A singer's weight is how long each pitch is held (addSustain); the onsets only count
  // toward the minimum-evidence gate.
  const sing = (held: [number, number][]) => {
    const d = new KeyDetector();
    for (const [midi, sec] of held) { d.addNote(midi, 0); d.addSustain(midi, sec); }
    return d;
  };
  // A F G B A, the tonic held longest: everything inside A minor and the margin over the
  // runner-up is clear, but the Krumhansl correlation is only 0.51 (no C or E yet).
  const aMinor: [number, number][] = [[69, 0.5], [77, 0.3], [79, 0.6], [71, 0.5], [69, 0.4]];
  it('locks from two seconds of a melody that sits inside one scale, before the correlation would', () => {
    expect(sing(aMinor).key).toEqual({ root: 9, mode: 'minor' });
  });
  it('does not lock on under two seconds of sung evidence', () => {
    expect(sing(aMinor.map(([m, s]) => [m, s * 0.7])).key).toBeNull();
  });
  it('does not lock when a fifth of the held time is off the scale', () => {
    expect(sing([...aMinor, [68, 0.6]]).key).toBeNull();
  });
  it('does not lock when the runner-up key is as good (A major vs A minor around a G#)', () => {
    expect(sing([[69, 0.5], [68, 0.4], [69, 0.5], [71, 0.5], [69, 0.4]]).key).toBeNull();
  });
});

describe('KeyDetector holds a key once accepted', () => {
  it('keeps the key when later notes dilute the evidence below the acceptance rule', () => {
    const d = new KeyDetector();
    [60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60].forEach(n => d.addNote(n));
    expect(d.key).toEqual({ root: 0, mode: 'major' });
    [61, 63, 66, 68, 70, 61, 63, 66].forEach(n => d.addNote(n)); // chromatic wandering
    expect(d.key).toEqual({ root: 0, mode: 'major' });
  });
  it('moves to a new key when that key is accepted in turn', () => {
    const d = new KeyDetector();
    [60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60].forEach(n => d.addNote(n));
    expect(d.key).toEqual({ root: 0, mode: 'major' });
    for (let i = 0; i < 6; i++) [66, 68, 70, 71, 73, 75, 77, 78].forEach(n => d.addNote(n, 3)); // F# major, loud and long
    expect(d.key).toEqual({ root: 6, mode: 'major' });
  });
  it('reset clears the held key', () => {
    const d = new KeyDetector();
    [60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60].forEach(n => d.addNote(n));
    d.reset();
    expect(d.key).toBeNull();
  });
});

describe('KeyDetector.fits', () => {
  const sing = (held: [number, number][]) => {
    const d = new KeyDetector();
    for (const [midi, sec] of held) { d.addNote(midi, 0); d.addSustain(midi, sec); }
    return d;
  };
  it('is false with no key, true once a key is accepted, false again when the singer leaves the scale', () => {
    const d = sing([[69, 0.5], [77, 0.3], [79, 0.6], [71, 0.5], [69, 0.4]]);
    expect(d.fits).toBe(false); // nothing read yet
    expect(d.key).toEqual({ root: 9, mode: 'minor' });
    expect(d.fits).toBe(true);
    for (let i = 0; i < 2; i++) { d.addNote(68, 0); d.addSustain(68, 0.4); d.addNote(73, 0); d.addSustain(73, 0.4); }
    expect(d.key).toEqual({ root: 9, mode: 'minor' }); // still held for the band
    expect(d.fits).toBe(false); // but not worth snapping to
  });
});
