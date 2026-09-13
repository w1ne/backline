import type { Key } from '../types';
export { keyName } from './pitchClass';

export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const MINOR = [0, 2, 3, 5, 7, 8, 10];
export const PENTA_MAJOR = [0, 2, 4, 7, 9];
export const PENTA_MINOR = [0, 3, 5, 7, 10];

export const scaleOf = (k: Key): number[] => (k.mode === 'major' ? MAJOR : MINOR).map(s => (s + k.root) % 12);
export const pentaOf = (k: Key): number[] => (k.mode === 'major' ? PENTA_MAJOR : PENTA_MINOR).map(s => (s + k.root) % 12);

export function degreeToMidi(k: Key, degree: number, octave: number): number {
  const steps = k.mode === 'major' ? MAJOR : MINOR;
  const oct = Math.floor(degree / 7);
  const d = ((degree % 7) + 7) % 7;
  return 12 * (octave + 1 + oct) + k.root + steps[d];
}
