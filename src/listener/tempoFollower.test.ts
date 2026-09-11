import { describe, it, expect } from 'vitest';
import { TempoFollower } from './tempoFollower';

const feed = (f: TempoFollower, bpm: number, n: number, start: number) => {
  let bpmOut = 0;
  for (let i = 0; i < n; i++) bpmOut = f.push(start + (i * 60) / bpm);
  return bpmOut;
};

describe('TempoFollower', () => {
  it('holds when player holds', () => {
    const f = new TempoFollower(100);
    expect(feed(f, 100, 16, 0)).toBeCloseTo(100, 0);
  });

  it('drifts toward a faster player, at most 8% per update', () => {
    const f = new TempoFollower(100);
    feed(f, 100, 8, 0);
    const b = feed(f, 130, 8, 5);
    expect(b).toBeGreaterThan(100);
    expect(b).toBeLessThanOrEqual(130);
  });

  it('never jumps more than 8% in one push', () => {
    const f = new TempoFollower(100);
    feed(f, 100, 8, 0);
    let prev = 100;
    for (let i = 0; i < 8; i++) {
      const b = f.push(5 + (i * 60) / 160);
      expect(Math.abs(b - prev) / prev).toBeLessThanOrEqual(0.0801);
      prev = b;
    }
  });
});
