import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../rng';
import type { BarContext, Dynamics } from '../types';
import { GENRES } from '../types';
import { PATTERNS } from './index';

const KEY = { root: 7, mode: 'major' as const };
const DYN: Dynamics = { intensity: 0.5, space: true, fillDue: false, silenceBeats: 2 };
const ctx = (bar: number, creativity: number, seed: number): BarContext => ({ bar, key: KEY, creativity, rng: mulberry32(seed + bar), dynamics: DYN });

describe('per-genre rhythmic templates', () => {
  for (const genre of GENRES) {
    it(`${genre}: creativity 1 uses more than one drum/bass signature over 32 bars`, () => {
      const bank = PATTERNS[genre];
      const drumSigs = new Set<string>(), bassSigs = new Set<string>();
      for (let bar = 0; bar < 32; bar++) {
        drumSigs.add(JSON.stringify(bank.drums.nextBar(ctx(bar, 1, bar * 11))));
        bassSigs.add(JSON.stringify(bank.bass.nextBar(ctx(bar, 1, bar * 11))));
      }
      expect(drumSigs.size).toBeGreaterThan(1);
      expect(bassSigs.size).toBeGreaterThan(1);
    });
  }
});
