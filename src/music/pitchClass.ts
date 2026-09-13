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

/** Whether `mode`'s tonic triad -- and its closest fit for anything that only knows
 *  major/minor -- is major-family (Mixolydian shares the major scale's 1-3-5) or
 *  minor-family (Dorian shares the minor's). */
export const MODE_FAMILY: Record<Key['mode'], 'major' | 'minor'> = { major: 'major', mixolydian: 'major', minor: 'minor', dorian: 'minor' };

const SHORT_MODE_LABEL: Record<Key['mode'], string> = { major: 'maj', minor: 'min', dorian: 'dor', mixolydian: 'mix' };

/** "C maj" / "A min" / "C dor" / "C mix" for the panel; `long` gives the "C major" / "A minor"
 *  spelling the generation services expect -- those only know major/minor, so a modal key
 *  collapses to its family (Dorian -> minor, Mixolydian -> major) rather than sending a mode
 *  word they can't parse. */
export const keyName = (k: Key, long = false): string =>
  `${NOTE_NAMES[mod12(k.root)]} ${long ? (MODE_FAMILY[k.mode] === 'major' ? 'major' : 'minor') : SHORT_MODE_LABEL[k.mode]}`;
