import { describe, it, expect } from 'vitest';
import type { Chord, Genre, Instrument, Pattern, NoteEvent } from '../types';
import { INSTRUMENTS } from '../types';
import { mulberry32 } from '../rng';
import { scaleOf } from '../music/scales';
import { chordTones } from '../listener/chordDetector';
const DRUMS = new Set([36, 38, 42, 46, 49]);
const KEY = { root: 7, mode: 'major' as const };
const run = (p: Pattern, creativity: number, seed: number, bars = 8, chord?: Chord): NoteEvent[][] =>
  Array.from({ length: bars }, (_, bar) => p.nextBar({ bar, key: KEY, chord, creativity, rng: mulberry32(seed + bar) }));
export function genreContract(name: Genre, bank: Record<Instrument, Pattern>) {
  describe(`${name} patterns`, () => {
    for (const inst of INSTRUMENTS) {
      it(`${inst}: valid events, at least one per bar`, () => {
        for (const bar of run(bank[inst], 0, 1)) {
          expect(bar.length).toBeGreaterThan(0);
          for (const e of bar) {
            expect(e.time).toBeGreaterThanOrEqual(0); expect(e.time).toBeLessThan(4);
            expect(e.duration).toBeGreaterThan(0); expect(e.velocity).toBeGreaterThan(0); expect(e.velocity).toBeLessThanOrEqual(1);
            if (inst === 'drums') expect(DRUMS.has(e.note)).toBe(true);
            else expect(scaleOf(KEY)).toContain(e.note % 12);
          }
        }
      });
      it(`${inst}: deterministic at creativity 0`, () => { expect(run(bank[inst], 0, 5)).toEqual(run(bank[inst], 0, 5)); });
      // Following the player can take the band outside the key — a secondary dominant is the
      // usual case. Chord tones are then in bounds; everything else must still be in key.
      it(`${inst}: in key or in chord when following a chord outside the key`, () => {
        const chord: Chord = { root: 2, quality: 'dom7' }; // D7 in G major: F# is not in key
        const allowed = new Set([...scaleOf(KEY), ...chordTones(chord)]);
        for (const bar of run(bank[inst], 0, 1, 8, chord))
          for (const e of bar) if (inst !== 'drums') expect([...allowed]).toContain(e.note % 12);
      });
    }
    it('creativity 1 changes at least one instrument', () => {
      expect(INSTRUMENTS.some(i => JSON.stringify(run(bank[i], 0, 3)) !== JSON.stringify(run(bank[i], 1, 3)))).toBe(true);
    });
    it('bass and keys move with the chord', () => {
      for (const inst of ['bass', 'keys'] as const) {
        const onTonic = run(bank[inst], 0, 1, 1, { root: 7, quality: 'maj' })[0].map(e => e.note);
        const onFour = run(bank[inst], 0, 1, 1, { root: 0, quality: 'maj' })[0].map(e => e.note);
        expect(onFour).not.toEqual(onTonic);
      }
    });
  });
}
