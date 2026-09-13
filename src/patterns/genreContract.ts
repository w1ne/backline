import { describe, it, expect } from 'vitest';
import type { Chord, Dynamics, Genre, Instrument, Pattern, NoteEvent } from '../types';
import { INSTRUMENTS } from '../types';
import { mulberry32 } from '../rng';
import { scaleOf } from '../music/scales';
import { chordTones } from '../music/chords';
const DRUMS = new Set([36, 38, 42, 46, 49]);
const KEY = { root: 7, mode: 'major' as const };
/**
 * The contract's baseline player: playing, but leaving room. `space: true` is deliberate —
 * the lead is an answering voice and is silent by design while the player is talking, so
 * "at least one event per bar" can only be asserted against a bar the lead is invited into.
 * The complementary case (silent lead when there is no space) is its own test below.
 */
const OPEN: Dynamics = { intensity: 0.5, space: true, fillDue: false, silenceBeats: 2 };
const BUSY: Dynamics = { intensity: 0.9, space: false, fillDue: false, silenceBeats: 0 };
const run = (p: Pattern, creativity: number, seed: number, bars = 8, chord?: Chord, dynamics: Dynamics = OPEN): NoteEvent[][] =>
  Array.from({ length: bars }, (_, bar) => p.nextBar({ bar, key: KEY, chord, creativity, rng: mulberry32(seed + bar), dynamics }));
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
    it('the lead sits out while the player is playing', () => {
      expect(run(bank.lead, 0, 1, 4, undefined, BUSY).every(bar => bar.length === 0)).toBe(true);
      expect(run(bank.lead, 0, 1, 4, undefined, OPEN).every(bar => bar.length > 0)).toBe(true);
    });
    it('drums, bass and keys keep playing while the player is busy', () => {
      for (const inst of ['drums', 'bass', 'keys'] as const)
        for (const bar of run(bank[inst], 0, 1, 4, undefined, BUSY)) expect(bar.length).toBeGreaterThan(0);
    });
    it('plays softer when the player is idle than when they dig in', () => {
      const idle: Dynamics = { intensity: 0, space: true, fillDue: false, silenceBeats: 4 };
      const loud: Dynamics = { intensity: 1, space: true, fillDue: false, silenceBeats: 2 };
      const peak = (d: Dynamics) => Math.max(...run(bank.drums, 0, 1, 4, undefined, d).flat().map(e => e.velocity));
      expect(peak(idle)).toBeLessThan(peak(loud));
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
