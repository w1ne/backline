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

/** Inverse of {@link chordName}: parses a name it produced back into a {@link Chord}.
 *  Returns null for anything else (unknown root, unknown suffix, garbage), so callers
 *  can ignore unrecognized values from an external source safely. */
export function parseChordName(name: string): Chord | null {
  const rootIndex = [...NAMES.keys()]
    .filter(i => name.startsWith(NAMES[i]))
    .sort((a, b) => NAMES[b].length - NAMES[a].length)[0];
  if (rootIndex === undefined) return null;
  const suffix = name.slice(NAMES[rootIndex].length);
  const quality = QUALITIES.find(q => SUFFIX[q] === suffix);
  if (quality === undefined) return null;
  return { root: rootIndex, quality };
}

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
export function pitchClassWeights(notes: TimedNote[], now: number, windowSec: number, fade = true): number[] {
  const w = new Array(12).fill(0);
  for (const n of notes) {
    const age = now - n.t;
    if (age < 0 || age >= windowSec) continue;
    const decay = fade ? 1 - age / windowSec : 1;
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
  /** last chord chosen by the melody harmonizer, kept for its hysteresis */
  private melody: Chord | null = null;

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
  /**
   * `mode` 'melody' says the notes came from a single voice (the mic pitch tracker), so the
   * triad templates are never consulted; 'auto' lets a played chord with three real tones win.
   */
  tick(nowSec: number, key: Key | null, mode: 'auto' | 'melody' = 'auto'): Chord | null {
    const w = pitchClassWeights(this.notes, nowSec, this.windowSec);
    // A single voice never fills a triad template: a lone E scores the same against Am, C
    // and Em, and two notes a fifth apart read as a sus4 at 0.8 confidence. Only a window
    // with three pitch classes that each carry real weight is a chord somebody played; a
    // sparser one is a line, harmonized within the key over the last full bar.
    const total = w.reduce((a, b) => a + b, 0);
    const voiced = w.filter(v => v >= total * TEMPLATE_MIN_SHARE).length;
    if (mode === 'melody' || voiced < 3) {
      if (!key) return null;
      // flat over the bar: the root a singer opens the bar on must count as much as the last note
      // a bar and a half of fading memory: long enough to hold the root a singer opened on,
      // short enough that the previous bar's chord has faded by the second half of this one
      const wm = pitchClassWeights(this.notes, nowSec, this.windowSec * MELODY_WINDOW_MUL);
      const held = this.melody ?? (this.current && { root: this.current.root, quality: this.current.quality });
      this.melody = harmonizeMelody(wm, key, held);
      return this.melody;
    }
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
    if (!key) return null;
    // A single voice never fills a triad template, so harmonize the melody instead.
    this.melody = harmonizeMelody(w, key, this.melody);
    return this.melody;
  }

  reset(): void {
    this.notes = [];
    this.current = null;
    this.melody = null;
  }
}

/** A pitch class must carry this share of the window's energy to count as a chord tone somebody played. */
export const TEMPLATE_MIN_SHARE = 0.1;

/** Harmonizer memory as a multiple of the chord window (two beats). */
const MELODY_WINDOW_MUL = 1.5;

/** A rival must cover this much more of the sung energy than the held chord to replace it. */
const MELODY_SWITCH_MARGIN = 0.15;
/** Below this coverage no diatonic triad explains the melody; the held chord (or tonic) stays. */
const MELODY_MIN_COVERAGE = 0.5;

/** The six diatonic triads of `key` the band may sit on, tonic first, then by harmonic weight. */
export function diatonicTriads(key: Key): Chord[] {
  const scale = scaleOf(key);
  const order = key.mode === 'major' ? [0, 4, 3, 5, 1, 2] : [0, 4, 5, 3, 6, 2];
  return order.map(deg => {
    const root = scale[deg];
    const third = mod12(scale[(deg + 2) % 7] - root);
    return { root, quality: third === 4 ? 'maj' : 'min' } as Chord;
  });
}

/**
 * Harmonizes a single sung line: of the key's diatonic triads, the one whose tones carry the
 * most of the pitch-class energy in the window. The held chord keeps its place unless a rival
 * covers clearly more, and ties fall to the tonic, so a lone note that fits three chords does
 * not make the band lurch. Nothing sung yet: the tonic.
 */
export function harmonizeMelody(weights: number[], key: Key, held: Chord | null): Chord {
  const total = weights.reduce((a, b) => a + b, 0);
  const candidates = diatonicTriads(key);
  const tonic = candidates[0];
  if (total <= 0) return held ?? tonic;
  const coverage = (c: Chord) => chordTones(c).reduce((a, pc) => a + weights[pc], 0) / total;
  // Two sung notes G and B are a G chord before they are an E minor: when more than one
  // pitch class is present, a triad whose root was actually sung wins an otherwise equal tie.
  const rootSung = weights.filter(v => v > 0).length >= 2 ? (c: Chord) => (weights[c.root] > 0 ? 1e-6 : 0) : () => 0;
  let best = tonic, bestCov = coverage(tonic), bestScore = bestCov + rootSung(tonic);
  for (const c of candidates) {
    const cov = coverage(c), score = cov + rootSung(c);
    if (score > bestScore + 1e-9) { best = c; bestCov = cov; bestScore = score; }
  }
  if (bestCov < MELODY_MIN_COVERAGE) return held ?? tonic;
  if (held && !sameChord(held, best) && bestCov - coverage(held) < MELODY_SWITCH_MARGIN) return held;
  return best;
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
