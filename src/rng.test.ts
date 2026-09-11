import { describe, it, expect } from 'vitest';
import { mulberry32 } from './rng';
describe('mulberry32', () => {
  it('is deterministic and in [0,1)', () => {
    const a = mulberry32(42), b = mulberry32(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true);
  });
});
