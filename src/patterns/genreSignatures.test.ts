import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../rng';
import { scaleOf } from '../music/scales';
import type { BarContext, Dynamics, Genre, Instrument, NoteEvent } from '../types';
import { INSTRUMENTS, GENRES, DRUM } from '../types';
import { PATTERNS } from './index';

/**
 * What the creativity-0 output has to keep, stated as properties rather than a frozen event
 * list: every bar fits in four beats with velocities in (0, 1], pitched parts stay in key, and
 * each genre still sounds like itself — no two genres collapse onto the same part. A musical
 * improvement to a base pattern passes; a genre losing its identity does not.
 */
const KEY = { root: 7, mode: 'major' as const };
const DYN: Dynamics = { intensity: 0.5, space: true, fillDue: false, silenceBeats: 2 };
const DRUMS = new Set<number>(Object.values(DRUM));
const BARS = 8;

const ctx = (bar: number, seed: number): BarContext => ({ bar, key: KEY, creativity: 0, rng: mulberry32(seed + bar), dynamics: DYN });
const bars = (genre: Genre, inst: Instrument, seed = 1): NoteEvent[][] =>
  Array.from({ length: BARS }, (_, bar) => PATTERNS[genre][inst].nextBar(ctx(bar, seed)));

describe('creativity 0 contract', () => {
  for (const inst of INSTRUMENTS) {
    it(`${inst}: every genre stays inside the bar, in range and in key`, () => {
      for (const genre of GENRES)
        for (const bar of bars(genre, inst)) {
          expect(bar.length).toBeGreaterThan(0);
          for (const e of bar) {
            expect(e.time).toBeGreaterThanOrEqual(0);
            expect(e.time + e.duration).toBeLessThanOrEqual(4 + 1e-9);
            expect(e.velocity).toBeGreaterThan(0);
            expect(e.velocity).toBeLessThanOrEqual(1);
            if (inst === 'drums') expect(DRUMS.has(e.note)).toBe(true);
            else expect(scaleOf(KEY)).toContain(e.note % 12);
          }
        }
    });

    it(`${inst}: the four genres are four different parts`, () => {
      const signatures = GENRES.map(genre => JSON.stringify(bars(genre, inst)));
      expect(new Set(signatures).size).toBe(GENRES.length);
    });

    it(`${inst}: deterministic for a given seed`, () => {
      for (const genre of GENRES) expect(bars(genre, inst, 5)).toEqual(bars(genre, inst, 5));
    });
  }
});
