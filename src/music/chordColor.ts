import type { Chord, Genre, Key } from '../types';
import { scaleOf } from './scales';

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

/** Scale-degree index (0-6) of `chord`'s root within `key`, or -1 when it isn't diatonic. */
function diatonicDegree(chord: Chord, key: Key): number {
  return scaleOf(key).findIndex(pc => pc === mod12(chord.root));
}

const TONIC_SUBDOMINANT = new Set([0, 3]); // I / IV (or i / iv)
const MEDIANT_SUBMEDIANT = new Set([1, 2, 5]); // ii / iii / vi (or ii° / III / VI)
const DOMINANT = 4; // V (or v)

/**
 * Upgrades a plain detected triad to a genre-appropriate color while staying diatonic to
 * `key`. Non-diatonic chords (a secondary dominant borrowed from outside the key, say) are
 * passed through unchanged in every genre -- there is no "diatonic color" for a chord that
 * isn't diatonic to begin with.
 */
export function colorChord(chord: Chord, genre: Genre, key: Key): Chord {
  if (genre === 'rock') return chord;
  const degree = diatonicDegree(chord, key);
  if (degree === -1) return chord;

  if (genre === 'lofi') {
    if (chord.quality === 'min') return { ...chord, quality: 'min7' };
    if (chord.quality === 'maj') return { ...chord, quality: 'maj7' };
    return chord;
  }

  if (genre === 'jazz') {
    if (degree === DOMINANT) return { ...chord, quality: 'dom7' };
    if (TONIC_SUBDOMINANT.has(degree)) {
      if (chord.quality === 'maj') return { ...chord, quality: 'maj7' };
      if (chord.quality === 'min') return { ...chord, quality: 'min7' };
      return chord;
    }
    if (MEDIANT_SUBMEDIANT.has(degree)) {
      if (chord.quality === 'min') return { ...chord, quality: 'min7' };
      if (chord.quality === 'maj') return { ...chord, quality: 'maj7' };
      return chord;
    }
    return chord;
  }

  // funk: dom7 on I and IV (the chords the horn-section hits land on); minor diatonic chords
  // get a min7 for a bit of pocket color; leave V and the rest as detected -- a plain dominant
  // V already reads as the funk "one" when it lands there, and over-coloring every chord
  // starts to sound more like lounge jazz than funk.
  if (genre === 'funk') {
    // only a major I/IV takes the dominant seventh; a minor tonic (Am in A minor) stays minor
    if (TONIC_SUBDOMINANT.has(degree) && chord.quality === 'maj') return { ...chord, quality: 'dom7' };
    if (chord.quality === 'min') return { ...chord, quality: 'min7' };
    return chord;
  }

  return chord;
}
