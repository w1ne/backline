import type { Chord, ChordQuality, Key } from '../types';
import { scaleOf } from '../music/scales';

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

const QUALITIES = Object.keys(QUALITY_TONES) as ChordQuality[];

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  dom7: '7',
  min7: 'm7',
  maj7: 'maj7',
  sus4: 'sus4',
  dim: 'dim',
};

/** Notes at or below this MIDI number count 1.5x — the bass note names the chord. */
const BASS_MAX_MIDI = 55; // G3
const BASS_BOOST = 1.5;
/** Weight of non-chord-tone energy subtracted from the template correlation. */
const OFF_CHORD_PENALTY = 0.5;
/** Below this a reading is never adopted. */
export const MIN_CONFIDENCE = 0.55;
/** A challenger must beat the incumbent by this much… */
export const SWITCH_MARGIN = 0.1;
/** …unless the incumbent itself has fallen below this. */
export const HOLD_FLOOR = 0.4;

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

export const chordName = (c: Chord): string => NAMES[mod12(c.root)] + SUFFIX[c.quality];

export const chordTones = (c: Chord): number[] => QUALITY_TONES[c.quality].map(t => mod12(c.root + t));

/** The chord the band falls back to when nothing is being played: the key's tonic triad. */
export const tonicTriad = (k: Key): Chord => ({ root: k.root, quality: k.mode === 'major' ? 'maj' : 'min' });

export interface TimedNote {
  midi: number;
  t: number;
  weight?: number;
}

/**
 * Pitch-class energy over the last `windowSec` seconds ending at `now`.
 * Older notes fade linearly to zero at the edge of the window; bass notes count for more.
 */
export function pitchClassWeights(notes: TimedNote[], now: number, windowSec: number): number[] {
  const w = new Array(12).fill(0);
  for (const n of notes) {
    const age = now - n.t;
    if (age < 0 || age >= windowSec) continue;
    const decay = 1 - age / windowSec;
    const boost = n.midi <= BASS_MAX_MIDI ? BASS_BOOST : 1;
    w[mod12(n.midi)] += (n.weight ?? 1) * decay * boost;
  }
  return w;
}

export interface ChordReading extends Chord {
  confidence: number;
}

/**
 * Cosine similarity between the pitch-class weights and a 0/1 chord template, minus the
 * share of the energy that lands on non-chord tones. Cosine (rather than a plain dot
 * product) is what stops a four-note template from automatically outscoring the triad it
 * contains: C-E-G reads as C, not as Cmaj7 with a missing seventh.
 */
export function scoreChord(weights: number[], chord: Chord): number {
  const tones = chordTones(chord);
  const inChord = new Set(tones);
  let dot = 0;
  let normW = 0;
  let total = 0;
  let off = 0;
  for (let pc = 0; pc < 12; pc++) {
    const v = weights[pc];
    if (v <= 0) continue;
    total += v;
    normW += v * v;
    if (inChord.has(pc)) dot += v;
    else off += v;
  }
  if (!total) return 0;
  const cos = dot / (Math.sqrt(normW) * Math.sqrt(tones.length));
  return Math.max(0, cos - OFF_CHORD_PENALTY * (off / total));
}

/** Best-scoring of the 84 templates (7 qualities x 12 roots). */
export function bestChord(weights: number[]): ChordReading {
  let best: ChordReading = { root: 0, quality: 'maj', confidence: 0 };
  for (let root = 0; root < 12; root++) {
    for (const quality of QUALITIES) {
      const confidence = scoreChord(weights, { root, quality });
      if (confidence > best.confidence) best = { root, quality, confidence };
    }
  }
  return best;
}

export const sameChord = (a: Chord | null, b: Chord | null): boolean =>
  a === b || (!!a && !!b && a.root === b.root && a.quality === b.quality);

/**
 * Rolling chord estimate over the notes the player just played.
 *
 * Notes go in as they happen (`addNote`); the chord is only *re-decided* when the app clock
 * calls `tick()` — every half bar — so the band hears one stable chord per half bar rather
 * than a new guess per note. Hysteresis keeps a settled chord in place unless a challenger
 * clearly beats it, which is what stops the flicker between a triad and its relatives.
 */
export class ChordDetector {
  /** Sliding window; the app sets this to two beats of the current tempo. */
  windowSec = 1;
  private notes: TimedNote[] = [];
  private current: ChordReading | null = null;

  addNote(midi: number, timeSec: number, weight = 1): void {
    if (midi < 0) return;
    this.notes.push({ midi, t: timeSec, weight });
    // Keep a little more than the window so a tick that lands slightly late still sees it.
    const cutoff = timeSec - this.windowSec * 2;
    if (this.notes.length > 64) this.notes = this.notes.filter(n => n.t >= cutoff);
  }

  /** The chord as last decided, before any key fallback. */
  get reading(): ChordReading | null {
    return this.current;
  }

  /**
   * Re-decides the chord from the current window. Returns the chord the band should play:
   * the detected one, or the key's tonic triad while nothing convincing is being played.
   */
  tick(nowSec: number, key: Key | null): Chord | null {
    const w = pitchClassWeights(this.notes, nowSec, this.windowSec);
    const best = bestChord(w);
    const held = this.current ? scoreChord(w, this.current) : 0;

    if (!this.current) {
      if (best.confidence >= MIN_CONFIDENCE) this.current = best;
    } else if (sameChord(best, this.current)) {
      this.current = { ...this.current, confidence: best.confidence };
    } else if (
      best.confidence >= MIN_CONFIDENCE &&
      (best.confidence - held >= SWITCH_MARGIN || held < HOLD_FLOOR)
    ) {
      this.current = best;
    }

    if (this.current) return { root: this.current.root, quality: this.current.quality };
    return key ? tonicTriad(key) : null;
  }

  reset(): void {
    this.notes = [];
    this.current = null;
  }
}

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
