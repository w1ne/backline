import { describe, it, expect } from 'vitest';
import { humanize } from './bandleader';
import { mulberry32 } from '../rng';
import { DRUM } from '../types';
import type { NoteEvent } from '../types';

const spb = 0.5; // 120bpm

describe('humanize', () => {
  it('jitters kick/snare within ±4ms and every other note within ±8ms', () => {
    const events: NoteEvent[] = [
      { time: 0, note: DRUM.kick, duration: 0.25, velocity: 0.9 },
      { time: 1, note: DRUM.snare, duration: 0.25, velocity: 0.9 },
      { time: 2, note: DRUM.hat, duration: 0.1, velocity: 0.9 },
    ];
    const rng = mulberry32(42);
    const out = humanize('drums', events, spb, rng);
    const msOffset = (i: number) => (out[i].time - events[i].time) * spb * 1000;
    expect(Math.abs(msOffset(0))).toBeLessThanOrEqual(4);
    expect(Math.abs(msOffset(1))).toBeLessThanOrEqual(4);
    expect(Math.abs(msOffset(2))).toBeLessThanOrEqual(8);
  });

  it('varies velocity by at most ±10% and clamps to [0, 1]', () => {
    const events: NoteEvent[] = [{ time: 0, note: 60, duration: 1, velocity: 0.9 }];
    const rng = mulberry32(1);
    const out = humanize('keys', events, spb, rng);
    expect(out[0].velocity).toBeGreaterThanOrEqual(0.9 * 0.9 - 1e-9);
    expect(out[0].velocity).toBeLessThanOrEqual(0.9 * 1.1 + 1e-9);

    const loud: NoteEvent[] = [{ time: 0, note: 60, duration: 1, velocity: 1 }];
    const clamped = humanize('keys', loud, spb, mulberry32(2));
    expect(clamped[0].velocity).toBeLessThanOrEqual(1);
  });

  it('is deterministic for a given seed', () => {
    const events: NoteEvent[] = [
      { time: 0, note: 60, duration: 1, velocity: 0.7 },
      { time: 1, note: 64, duration: 1, velocity: 0.8 },
    ];
    const a = humanize('bass', events, spb, mulberry32(99));
    const b = humanize('bass', events, spb, mulberry32(99));
    expect(a).toEqual(b);
  });

  it('never produces a negative time', () => {
    const events: NoteEvent[] = [{ time: 0, note: DRUM.kick, duration: 0.25, velocity: 0.9 }];
    // Try many seeds; jitter can only push a beat-0 kick negative if it isn't clamped.
    for (let seed = 0; seed < 200; seed++) {
      const out = humanize('drums', events, spb, mulberry32(seed));
      expect(out[0].time).toBeGreaterThanOrEqual(0);
    }
  });
});
