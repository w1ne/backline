import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../rng';
import type { BarContext, Dynamics } from '../types';
import { DRUM } from '../types';
import { lofi } from './lofi';

const KEY = { root: 0, mode: 'major' as const };
const ctx = (creativity: number, dynamics: Dynamics, bar = 0, seed = 5): BarContext =>
  ({ bar, key: KEY, creativity, rng: mulberry32(seed + bar), dynamics });

describe('dynamics-driven behavior wired through a genre bank', () => {
  it('low intensity thins the kick to beats 1 and 3', () => {
    const dyn: Dynamics = { intensity: 0.1, space: false, fillDue: false, silenceBeats: 4 };
    for (let bar = 0; bar < 10; bar++) {
      const kicks = lofi.drums.nextBar(ctx(0.5, dyn, bar)).filter(e => e.note === DRUM.kick);
      for (const k of kicks) expect(k.time === 0 || k.time === 2).toBe(true);
    }
  });

  it('high intensity can add ghost snares', () => {
    const dyn: Dynamics = { intensity: 0.95, space: false, fillDue: false, silenceBeats: 0 };
    const ghostFound = Array.from({ length: 20 }, (_, bar) => lofi.drums.nextBar(ctx(0.5, dyn, bar)))
      .some(bar => bar.some(e => e.note === DRUM.snare && e.velocity <= 0.35));
    expect(ghostFound).toBe(true);
  });

  it('space lets keys answer with a short phrase beyond the written comping', () => {
    const dyn: Dynamics = { intensity: 0.5, space: true, fillDue: false, silenceBeats: 3 };
    const extra = Array.from({ length: 20 }, (_, bar) => lofi.keys.nextBar(ctx(1, dyn, bar)))
      .some(bar => bar.some(e => e.time >= 2.25 && e.time < 3 && e.velocity === 0.5));
    expect(extra).toBe(true);
  });
});
