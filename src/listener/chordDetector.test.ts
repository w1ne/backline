import { describe, it, expect } from 'vitest';
import {
  ChordDetector,
  bestChord,
  chordDegreeToMidi,
  chordName,
  chordScale,
  pitchClassWeights,
  chordTones,
  scoreChord,
  tonicTriad,
} from './chordDetector';
import type { Chord, Key } from '../types';
import { degreeToMidi } from '../music/scales';

const C_MAJOR: Key = { root: 0, mode: 'major' };
const A_MINOR: Key = { root: 9, mode: 'minor' };

/** 120 bpm: a beat is 0.5 s, so the detector's two-beat window is 1 s. */
const WINDOW = 1;
const STEP = 0.25;

/** Feeds `pitches` as a repeating arpeggio at `STEP` apart, starting at `from`. */
function play(det: ChordDetector, pitches: number[], from: number, count: number): number {
  let t = from;
  for (let i = 0; i < count; i++) {
    det.addNote(pitches[i % pitches.length], t);
    t += STEP;
  }
  return t;
}

const make = (): ChordDetector => {
  const d = new ChordDetector();
  d.windowSec = WINDOW;
  return d;
};

describe('pitchClassWeights', () => {
  it('fades notes out over the window and drops them past its edge', () => {
    const w = pitchClassWeights([{ midi: 60, t: 0 }, { midi: 62, t: 0.5 }, { midi: 64, t: -1 }], 1, WINDOW);
    expect(w[0]).toBeCloseTo(0, 5); // exactly one window old: gone
    expect(w[2]).toBeCloseTo(0.5, 5);
    expect(w[4]).toBe(0); // before the window entirely
  });

  it('weights bass notes higher — the bass note names the chord', () => {
    const low = pitchClassWeights([{ midi: 36, t: 0 }], 0, WINDOW);
    const high = pitchClassWeights([{ midi: 72, t: 0 }], 0, WINDOW);
    expect(low[0]).toBeCloseTo(high[0] * 1.5, 5);
  });
});

describe('scoreChord / bestChord', () => {
  const weightsOf = (pcs: number[]): number[] => {
    const w = new Array(12).fill(0);
    for (const pc of pcs) w[pc] = 1;
    return w;
  };

  it('C-E-G reads as C major, not as a seventh chord with a note missing', () => {
    const best = bestChord(weightsOf([0, 4, 7]));
    expect(best.root).toBe(0);
    expect(best.quality).toBe('maj');
    expect(best.confidence).toBeGreaterThan(0.9);
    expect(scoreChord(weightsOf([0, 4, 7]), { root: 0, quality: 'maj7' })).toBeLessThan(best.confidence);
  });

  it('A-C-E reads as A minor', () => {
    const best = bestChord(weightsOf([9, 0, 4]));
    expect(chordName(best)).toBe('Am');
  });

  it('G-B-D-F reads as G7', () => {
    const best = bestChord(weightsOf([7, 11, 2, 5]));
    expect(chordName(best)).toBe('G7');
  });

  it('every pitch class at once is confidently nothing', () => {
    expect(bestChord(new Array(12).fill(1)).confidence).toBeLessThan(0.55);
  });
});

describe('ChordDetector', () => {
  it('settles on the chord being arpeggiated', () => {
    const d = make();
    const t = play(d, [60, 64, 67], 0, 8);
    expect(chordName(d.tick(t, C_MAJOR)!)).toBe('C');
  });

  it('falls back to the key tonic triad before anything has settled', () => {
    const d = make();
    expect(d.tick(0, A_MINOR)).toEqual({ root: 9, quality: 'min' });
    expect(d.tick(0, null)).toBeNull();
  });

  it('holds the previous chord through noise', () => {
    const d = make();
    let t = play(d, [60, 64, 67], 0, 8);
    expect(chordName(d.tick(t, C_MAJOR)!)).toBe('C');
    // Every pitch class, evenly: nothing scores high enough to unseat the incumbent.
    for (let i = 0; i < 12; i++) d.addNote(60 + i, t + i * 0.05);
    t += 0.6;
    expect(chordName(d.tick(t, C_MAJOR)!)).toBe('C');
  });

  it('follows C then F then G, one chord per bar, without flickering between them', () => {
    const d = make();
    const seen: string[] = [];
    let t = 0;
    // Each bar is 8 eighth notes at 120 bpm; the app ticks on the bar and the half bar.
    for (const triad of [[60, 64, 67], [65, 69, 72], [67, 71, 74]]) {
      for (let half = 0; half < 2; half++) {
        t = play(d, triad, t, 4);
        seen.push(chordName(d.tick(t, C_MAJOR)!));
      }
    }
    expect(seen).toEqual(['C', 'C', 'F', 'F', 'G', 'G']);
  });
});

describe('chordScale', () => {
  it('is the plain key scale for the key\'s own tonic triad', () => {
    for (const key of [C_MAJOR, A_MINOR, { root: 2, mode: 'minor' } as Key]) {
      const sc = chordScale(key, tonicTriad(key));
      const plain = Array.from({ length: 7 }, (_, d) => degreeToMidi(key, d, 3) - degreeToMidi(key, 0, 3));
      expect(sc).toEqual(plain);
    }
  });

  it('borrows passing tones from the key for a chord built on another degree', () => {
    // F major inside C major is Lydian: root, 9, third, #11, fifth, 13, major seventh.
    expect(chordScale(C_MAJOR, { root: 5, quality: 'maj' })).toEqual([0, 2, 4, 6, 7, 9, 11]);
  });

  it('keeps a secondary dominant\'s own third and leaves the rest in key', () => {
    // D7 in C major: F# is the only note outside the key.
    const sc = chordScale(C_MAJOR, { root: 2, quality: 'dom7' });
    expect(sc).toEqual([0, 2, 4, 5, 7, 9, 10]);
  });
});

describe('chordDegreeToMidi', () => {
  it('matches the key-relative mapping when the chord is the key tonic', () => {
    for (const degree of [0, 2, 3, 4, 6, 7]) {
      expect(chordDegreeToMidi(A_MINOR, tonicTriad(A_MINOR), degree, 2)).toBe(degreeToMidi(A_MINOR, degree, 2));
    }
  });

  it('moves the root with the chord', () => {
    const f: Chord = { root: 5, quality: 'maj' };
    expect(chordDegreeToMidi(C_MAJOR, f, 0, 2)).toBe(41); // F2
    expect(chordDegreeToMidi(C_MAJOR, f, 2, 2)).toBe(45); // A2, the chord's third
    expect(chordDegreeToMidi(C_MAJOR, f, 4, 2)).toBe(48); // C3, the chord's fifth
  });
});

describe('chordName', () => {
  it('names every quality', () => {
    expect(['maj', 'min', 'dom7', 'min7', 'maj7', 'sus4', 'dim'].map(q => chordName({ root: 9, quality: q } as Chord)))
      .toEqual(['A', 'Am', 'A7', 'Am7', 'Amaj7', 'Asus4', 'Adim']);
  });
});

describe('chordScale degenerate gaps', () => {
  it('never leaves the key for a chord whose tones the key already contains', () => {
    const inKey = new Set([0, 2, 4, 5, 7, 9, 11]);
    for (const quality of ['maj', 'min', 'dom7', 'min7', 'maj7', 'sus4', 'dim'] as const) {
      for (let root = 0; root < 12; root++) {
        const chord: Chord = { root, quality };
        const own = new Set(chordTones(chord));
        for (const s of chordScale(C_MAJOR, chord)) {
          const pc = (root + s) % 12;
          expect(inKey.has(pc) || own.has(pc), `${chordName(chord)} degree ${s} -> ${pc}`).toBe(true);
        }
      }
    }
  });
});

describe('ChordDetector melody harmonizer (single voice)', () => {
  const Am: Key = { root: 9, mode: 'minor' };
  it('harmonizes two sung notes with the diatonic triad that holds both', () => {
    const d = new ChordDetector();
    d.windowSec = 1.33;
    d.addNote(67, 0.2, 0.8); // G
    d.addNote(71, 0.8, 0.8); // B
    expect(d.tick(1.3, Am)).toEqual({ root: 7, quality: 'maj' }); // G major
  });
  it('holds the current chord when the next note still fits it', () => {
    const d = new ChordDetector();
    d.windowSec = 1.33;
    d.addNote(57, 0.2, 0.8); d.addNote(60, 0.8, 0.8); // A C → Am
    expect(d.tick(1.3, Am)).toEqual({ root: 9, quality: 'min' });
    d.addNote(64, 1.5, 0.8); // E fits Am (and C) → stay on Am
    expect(d.tick(2.6, Am)).toEqual({ root: 9, quality: 'min' });
  });
  it('sits on the tonic while nothing has been sung', () => {
    const d = new ChordDetector();
    expect(d.tick(1, Am)).toEqual({ root: 9, quality: 'min' });
  });
  it('prefers the tonic over a rival that covers a lone sung note equally well', () => {
    const d = new ChordDetector();
    d.windowSec = 1.33;
    d.addNote(64, 0.5, 0.8); // E alone: Am, C and Em all hold it
    expect(d.tick(1.3, Am)).toEqual({ root: 9, quality: 'min' });
  });
});

describe('ChordDetector melody mode', () => {
  it('never uses the triad templates on a sung line, even when three pitch classes linger', () => {
    const Am: Key = { root: 9, mode: 'minor' };
    const d = new ChordDetector();
    d.windowSec = 1.33;
    d.addNote(69, 0.0, 0.8); // A, tail of the previous bar
    d.addNote(60, 0.7, 0.8); d.addNote(64, 1.3, 0.8); d.addNote(67, 1.9, 0.8); // C E G
    expect(d.tick(2.0, Am, 'melody')).toEqual({ root: 0, quality: 'maj' });
  });
});
