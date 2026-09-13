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
const TONIC = 0; // I / i
const SUPERTONIC = 1; // ii / ii°

/**
 * Upgrades a plain detected triad to a genre-appropriate color while staying diatonic to
 * `key`. Non-diatonic chords (a secondary dominant borrowed from outside the key, say) are
 * passed through unchanged in every genre -- there is no "diatonic color" for a chord that
 * isn't diatonic to begin with.
 *
 * When `source` is 'mic' the chord was inferred from a singer, not played on a keyboard: the
 * seventh (or extension) that colors it in every genre is exactly what lands a semitone or
 * tritone from whatever the singer is holding, so a mic-sourced chord is left as a plain
 * triad regardless of genre.
 */
export function colorChord(chord: Chord, genre: Genre, key: Key, source?: 'midi' | 'mic'): Chord {
  if (source === 'mic') return chord;
  if (genre === 'rock') return chord;
  const degree = diatonicDegree(chord, key);
  if (degree === -1) return chord;

  // lofi leans on 9th color throughout -- a plain 7th reads as too "clean" for the aesthetic.
  if (genre === 'lofi') {
    if (chord.quality === 'min') return { ...chord, quality: 'min9' };
    if (chord.quality === 'maj') return { ...chord, quality: 'maj9' };
    return chord;
  }

  if (genre === 'jazz') {
    if (degree === DOMINANT) return { ...chord, quality: 'dom9' };
    // the tonic is where a major chord gets to just sit -- maj6 ("landing"), not maj7
    // (maj7's leading-tone tension wants to keep moving, which fights a I chord's job).
    if (degree === TONIC) {
      if (chord.quality === 'maj') return { ...chord, quality: 'maj6' };
      if (chord.quality === 'min') return { ...chord, quality: 'min7' };
      return chord;
    }
    // ii is almost always the front half of a ii-V; min9 is the standard comping color there.
    if (degree === SUPERTONIC) {
      if (chord.quality === 'min') return { ...chord, quality: 'min9' };
      if (chord.quality === 'maj') return { ...chord, quality: 'maj7' };
      return chord;
    }
    if (TONIC_SUBDOMINANT.has(degree) || MEDIANT_SUBMEDIANT.has(degree)) {
      if (chord.quality === 'maj') return { ...chord, quality: 'maj7' };
      if (chord.quality === 'min') return { ...chord, quality: 'min7' };
      return chord;
    }
    return chord;
  }

  // funk: dom7 on I and IV (the chords the horn-section hits land on); minor diatonic chords
  // get a min7 for a bit of pocket color; leave V and the rest as detected -- a plain dominant
  // V already reads as the funk "one" when it lands there, and over-coloring every chord
  // starts to sound more like lounge jazz than funk.
  if (genre === 'funk') {
    // the tonic vamp is where funk actually stacks color (P-Funk/Meters-style dom9 on the
    // "one"); IV stays a plain dom7, the horn-hit chord, so it doesn't fight the tonic for
    // richness.
    if (degree === TONIC && chord.quality === 'maj') return { ...chord, quality: 'dom9' };
    // only a major I/IV takes the dominant seventh; a minor tonic (Am in A minor) stays minor
    if (TONIC_SUBDOMINANT.has(degree) && chord.quality === 'maj') return { ...chord, quality: 'dom7' };
    if (chord.quality === 'min') return { ...chord, quality: 'min7' };
    return chord;
  }

  return chord;
}
