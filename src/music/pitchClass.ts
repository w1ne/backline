import type { Key } from '../types';

/** Folds any integer (negative, above 11, a MIDI note) onto a pitch class 0..11. */
export const mod12 = (n: number): number => ((n % 12) + 12) % 12;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Semitone distance between two pitch classes, folded to the shorter way round (0-6). */
export const pcDistance = (a: number, b: number): number => {
  const d = Math.abs(mod12(a) - mod12(b));
  return Math.min(d, 12 - d);
};

/** Signed distance in cents from frequency `b` up to `a`. */
export const centsBetween = (a: number, b: number): number => 1200 * Math.log2(a / b);

/** Fractional MIDI note number of a frequency (69 = A4); round it or keep the cents. */
export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

/** "C maj" / "A min" for the panel; `long` gives the "C major" / "A minor" spelling the
 *  generation services expect. */
export const keyName = (k: Key, long = false): string =>
  `${NOTE_NAMES[mod12(k.root)]} ${k.mode === 'major' ? (long ? 'major' : 'maj') : long ? 'minor' : 'min'}`;
