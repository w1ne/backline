import { describe, it, expect } from 'vitest';
import type { Genre, Instrument, Pattern, NoteEvent } from '../types';
import { INSTRUMENTS } from '../types';
import { mulberry32 } from '../rng';
import { scaleOf } from '../music/scales';
const DRUMS = new Set([36, 38, 42, 46, 49]);
const run = (p: Pattern, creativity: number, seed: number, bars = 8): NoteEvent[][] =>
  Array.from({ length: bars }, (_, bar) => p.nextBar({ bar, key: { root: 7, mode: 'major' }, creativity, rng: mulberry32(seed + bar) }));
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
            else expect(scaleOf({ root: 7, mode: 'major' })).toContain(e.note % 12);
          }
        }
      });
      it(`${inst}: deterministic at creativity 0`, () => { expect(run(bank[inst], 0, 5)).toEqual(run(bank[inst], 0, 5)); });
    }
    it('creativity 1 changes at least one instrument', () => {
      expect(INSTRUMENTS.some(i => JSON.stringify(run(bank[i], 0, 3)) !== JSON.stringify(run(bank[i], 1, 3)))).toBe(true);
    });
  });
}
