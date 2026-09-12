import { describe, it, expect } from 'vitest';
import type { Chord, Key } from '../types';
import { colorChord } from './chordColor';

const CMAJ: Key = { root: 0, mode: 'major' };
const AMIN: Key = { root: 9, mode: 'minor' };

const c = (root: number, quality: Chord['quality']): Chord => ({ root, quality });

describe('colorChord', () => {
  describe('rock', () => {
    it('is identity for every diatonic chord', () => {
      expect(colorChord(c(0, 'maj'), 'rock', CMAJ)).toEqual(c(0, 'maj'));
      expect(colorChord(c(2, 'min'), 'rock', CMAJ)).toEqual(c(2, 'min'));
      expect(colorChord(c(9, 'min'), 'rock', AMIN)).toEqual(c(9, 'min'));
    });
  });

  describe('jazz', () => {
    it('gives I and IV maj7', () => {
      expect(colorChord(c(0, 'maj'), 'jazz', CMAJ)).toEqual(c(0, 'maj7')); // I
      expect(colorChord(c(5, 'maj'), 'jazz', CMAJ)).toEqual(c(5, 'maj7')); // IV
    });
    it('gives ii, iii, vi min7', () => {
      expect(colorChord(c(2, 'min'), 'jazz', CMAJ)).toEqual(c(2, 'min7')); // ii
      expect(colorChord(c(4, 'min'), 'jazz', CMAJ)).toEqual(c(4, 'min7')); // iii
      expect(colorChord(c(9, 'min'), 'jazz', CMAJ)).toEqual(c(9, 'min7')); // vi
    });
    it('gives V dom7', () => {
      expect(colorChord(c(7, 'maj'), 'jazz', CMAJ)).toEqual(c(7, 'dom7')); // V
    });
    it('works the same way relative to a minor key', () => {
      expect(colorChord(c(9, 'min'), 'jazz', AMIN)).toEqual(c(9, 'min7')); // i of A minor
      expect(colorChord(c(0, 'maj'), 'jazz', AMIN)).toEqual(c(0, 'maj7')); // III of A minor -> functions like a "IV-slot"? see below
    });
  });

  describe('lofi', () => {
    it('gives every major diatonic triad a maj7 and every minor one a min7', () => {
      expect(colorChord(c(0, 'maj'), 'lofi', CMAJ)).toEqual(c(0, 'maj7'));
      expect(colorChord(c(2, 'min'), 'lofi', CMAJ)).toEqual(c(2, 'min7'));
      expect(colorChord(c(4, 'min'), 'lofi', CMAJ)).toEqual(c(4, 'min7'));
      expect(colorChord(c(5, 'maj'), 'lofi', CMAJ)).toEqual(c(5, 'maj7'));
      expect(colorChord(c(7, 'maj'), 'lofi', CMAJ)).toEqual(c(7, 'maj7'));
      expect(colorChord(c(9, 'min'), 'lofi', CMAJ)).toEqual(c(9, 'min7'));
    });
    it('works in a minor key too', () => {
      expect(colorChord(c(9, 'min'), 'lofi', AMIN)).toEqual(c(9, 'min7'));
      expect(colorChord(c(0, 'maj'), 'lofi', AMIN)).toEqual(c(0, 'maj7'));
    });
  });

  describe('funk', () => {
    it('keeps a minor tonic minor: Am in A minor becomes Am7, never A7', () => {
      expect(colorChord(c(9, 'min'), 'funk', { root: 9, mode: 'minor' })).toEqual(c(9, 'min7'));
    });
    it('gives I and IV dom7', () => {
      expect(colorChord(c(0, 'maj'), 'funk', CMAJ)).toEqual(c(0, 'dom7')); // I
      expect(colorChord(c(5, 'maj'), 'funk', CMAJ)).toEqual(c(5, 'dom7')); // IV
    });
    it('gives minor chords min7', () => {
      expect(colorChord(c(2, 'min'), 'funk', CMAJ)).toEqual(c(2, 'min7'));
      expect(colorChord(c(9, 'min'), 'funk', CMAJ)).toEqual(c(9, 'min7'));
    });
  });

  describe('non-diatonic chords', () => {
    it('are left unchanged in every genre', () => {
      const outside = c(1, 'maj'); // Db major, not diatonic to C major
      expect(colorChord(outside, 'jazz', CMAJ)).toEqual(outside);
      expect(colorChord(outside, 'lofi', CMAJ)).toEqual(outside);
      expect(colorChord(outside, 'funk', CMAJ)).toEqual(outside);
      expect(colorChord(outside, 'rock', CMAJ)).toEqual(outside);
    });
  });

  describe("source: 'mic'", () => {
    it('leaves every genre as a plain triad, even where the genre would otherwise color it', () => {
      for (const genre of ['lofi', 'funk', 'rock', 'jazz'] as const) {
        expect(colorChord(c(0, 'maj'), genre, CMAJ, 'mic')).toEqual(c(0, 'maj')); // I
        expect(colorChord(c(2, 'min'), genre, CMAJ, 'mic')).toEqual(c(2, 'min')); // ii
        expect(colorChord(c(7, 'maj'), genre, CMAJ, 'mic')).toEqual(c(7, 'maj')); // V, dom7 in jazz/funk otherwise
      }
    });
    it("is unaffected when source is 'midi' or omitted", () => {
      expect(colorChord(c(0, 'maj'), 'lofi', CMAJ, 'midi')).toEqual(c(0, 'maj7'));
      expect(colorChord(c(0, 'maj'), 'lofi', CMAJ)).toEqual(c(0, 'maj7'));
    });
  });

  describe('only produces qualities from the ChordQuality union', () => {
    const ALLOWED = new Set(['maj', 'min', 'dom7', 'min7', 'maj7', 'sus4', 'dim']);
    it('across every diatonic degree, key and genre', () => {
      for (const key of [CMAJ, AMIN]) {
        const scale = key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
        for (const genre of ['lofi', 'funk', 'rock', 'jazz'] as const) {
          for (const pc of scale) {
            for (const quality of ['maj', 'min', 'dim'] as const) {
              const out = colorChord(c((key.root + pc) % 12, quality), genre, key);
              expect(ALLOWED.has(out.quality)).toBe(true);
            }
          }
        }
      }
    });
  });
});
