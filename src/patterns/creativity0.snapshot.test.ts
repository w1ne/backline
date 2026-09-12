import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../rng';
import type { BarContext, Dynamics } from '../types';
import { INSTRUMENTS, GENRES } from '../types';
import { PATTERNS } from './index';

// Locks in today's fixed-pattern output at creativity 0, captured BEFORE per-genre rhythmic
// variation (alternative templates) was added. Any change here at creativity 0 is a
// regression: creativity 0 must stay bit-for-bit identical to the original patterns.
const KEY = { root: 7, mode: 'major' as const };
const DYN: Dynamics = { intensity: 0.5, space: true, fillDue: false, silenceBeats: 2 };

const run = (bar: number, seed: number): BarContext => ({
  bar, key: KEY, creativity: 0, rng: mulberry32(seed + bar), dynamics: DYN,
});

describe('creativity 0 baseline (must never drift)', () => {
  for (const genre of GENRES) {
    it(`${genre}: 8 bars, all instruments`, () => {
      const bank = PATTERNS[genre];
      const out = Object.fromEntries(INSTRUMENTS.map(inst => [
        inst,
        Array.from({ length: 8 }, (_, bar) => bank[inst].nextBar(run(bar, 1))),
      ]));
      expect(out).toMatchSnapshot();
    });
  }
});
