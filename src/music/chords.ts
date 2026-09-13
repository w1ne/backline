import type { Chord, ChordQuality, Key } from '../types';
import { scaleOf } from './scales';
import { mod12, NOTE_NAMES } from './pitchClass';

/** Semitone offsets from the chord root, per quality. */
export const QUALITY_TONES: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
};

export const QUALITIES = Object.keys(QUALITY_TONES) as ChordQuality[];

const SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  dom7: '7',
  min7: 'm7',
  maj7: 'maj7',
  sus4: 'sus4',
  dim: 'dim',
};

export const chordName = (c: Chord): string => NOTE_NAMES[mod12(c.root)] + SUFFIX[c.quality];

export const chordTones = (c: Chord): number[] => QUALITY_TONES[c.quality].map(t => mod12(c.root + t));

/** Inverse of {@link chordName}: parses a name it produced back into a {@link Chord}.
 *  Returns null for anything else (unknown root, unknown suffix, garbage), so callers
 *  can ignore unrecognized values from an external source safely. */
export function parseChordName(name: string): Chord | null {
  const rootIndex = [...NOTE_NAMES.keys()]
    .filter(i => name.startsWith(NOTE_NAMES[i]))
    .sort((a, b) => NOTE_NAMES[b].length - NOTE_NAMES[a].length)[0];
  if (rootIndex === undefined) return null;
  const suffix = name.slice(NOTE_NAMES[rootIndex].length);
  const quality = QUALITIES.find(q => SUFFIX[q] === suffix);
  if (quality === undefined) return null;
  return { root: rootIndex, quality };
}

/** The chord the band falls back to when nothing is being played: the key's tonic triad. */
export const tonicTriad = (k: Key): Chord => ({ root: k.root, quality: k.mode === 'major' ? 'maj' : 'min' });

/**
 * The seven scale degrees the patterns play over `chord`, as semitone offsets from the chord
 * root. Degrees 0/2/4/6 are chord tones; 1/3/5 are passing tones borrowed from the key, so a
 * line over a chord stays diatonic wherever the chord itself allows it. For a diatonic triad
 * in its own key this reproduces the plain key scale exactly.
 */
export function chordScale(key: Key, chord: Chord): number[] {
  const tones = QUALITY_TONES[chord.quality];
  const rel = new Set(scaleOf(key).map(pc => mod12(pc - chord.root)));
  // Passing tones must come from the key. When the gap between two chord tones holds no key
  // tone at all — a sus4's fourth-to-fifth, a dim's tritone-to-seventh — fall back to the
  // chord tone below rather than inventing a chromatic note the band has no business playing.
  const up = (lo: number, hi: number): number => {
    for (let s = lo + 1; s < hi; s++) if (rel.has(s)) return s;
    return lo;
  };
  const down = (hi: number, lo: number, fallback: number): number => {
    for (let s = hi - 1; s > lo; s--) if (rel.has(s)) return s;
    return fallback;
  };
  const third = tones[1];
  const fifth = tones[2];
  const seventh = tones[3] ?? down(12, fifth, third >= 4 ? 11 : 10);
  return [0, up(0, third), third, up(third, fifth), fifth, up(fifth, seventh), seventh];
}

/** `degreeToMidi`, but the degrees are read off the chord instead of off the key. */
export function chordDegreeToMidi(key: Key, chord: Chord, degree: number, octave: number): number {
  const sc = chordScale(key, chord);
  const oct = Math.floor(degree / 7);
  const i = ((degree % 7) + 7) % 7;
  return 12 * (octave + 1 + oct) + chord.root + sc[i];
}
