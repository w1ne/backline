import type { Key } from '../types';

export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const MINOR = [0, 2, 3, 5, 7, 8, 10];
export const DORIAN = [0, 2, 3, 5, 7, 9, 10];
export const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10];
export const PENTA_MAJOR = [0, 2, 4, 7, 9];
export const PENTA_MINOR = [0, 3, 5, 7, 10];

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Steps of each mode, root-relative. Explicit per-mode lookup rather than a major/minor
 *  ternary, so adding a mode can't silently fall through to the wrong scale. */
const STEPS: Record<Key['mode'], number[]> = { major: MAJOR, minor: MINOR, dorian: DORIAN, mixolydian: MIXOLYDIAN };
/** Dorian/Mixolydian reuse the minor/major pentatonic — their b3/b7 already match, and a
 *  modal-specific pentatonic isn't distinguishable at this app's level of use. */
const PENTA: Record<Key['mode'], number[]> = { major: PENTA_MAJOR, minor: PENTA_MINOR, dorian: PENTA_MINOR, mixolydian: PENTA_MAJOR };
const MODE_LABEL: Record<Key['mode'], string> = { major: 'maj', minor: 'min', dorian: 'dor', mixolydian: 'mix' };

export const scaleOf = (k: Key): number[] => STEPS[k.mode].map(s => (s + k.root) % 12);
export const pentaOf = (k: Key): number[] => PENTA[k.mode].map(s => (s + k.root) % 12);

export function degreeToMidi(k: Key, degree: number, octave: number): number {
  const steps = STEPS[k.mode];
  const oct = Math.floor(degree / 7);
  const d = ((degree % 7) + 7) % 7;
  return 12 * (octave + 1 + oct) + k.root + steps[d];
}

export const keyName = (k: Key): string => `${NAMES[k.root]} ${MODE_LABEL[k.mode]}`;
