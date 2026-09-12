import { describe, it, expect } from 'vitest';
import { TapTempo } from './tapTempo';

describe('TapTempo', () => {
  it('returns null before 3 taps', () => {
    const t = new TapTempo();
    expect(t.push(0)).toBeNull();
    expect(t.push(0.5)).toBeNull();
  });

  it('returns bpm and downbeat after 3 taps at a steady interval', () => {
    const t = new TapTempo();
    t.push(0);
    t.push(0.5);
    const r = t.push(1.0);
    expect(r).not.toBeNull();
    expect(r!.bpm).toBeCloseTo(120, 0);
    expect(r!.downbeat).toBe(1.0);
  });

  it('is tolerant to +-15% jitter', () => {
    const t = new TapTempo();
    // target 100 bpm -> 0.6s interval, jittered +-15%
    t.push(0);
    t.push(0.6 * 1.14);
    const r = t.push(0.6 * 1.14 + 0.6 * 0.87);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bpm - 100)).toBeLessThan(20);
  });

  it('rejects taps more than 2s apart as a restart', () => {
    const t = new TapTempo();
    t.push(0);
    t.push(0.5);
    t.push(1.0);
    // huge gap: restart
    expect(t.push(5.0)).toBeNull();
    expect(t.push(5.5)).toBeNull();
    const r = t.push(6.0);
    expect(r).not.toBeNull();
    expect(r!.bpm).toBeCloseTo(120, 0);
  });

  it('uses the median interval, ignoring one outlier tap', () => {
    const t = new TapTempo();
    t.push(0);
    t.push(0.5);
    t.push(1.0);
    const r = t.push(1.52); // one slightly-off tap among steady 0.5s taps
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bpm - 120)).toBeLessThan(5);
  });

  it('reset clears accumulated taps', () => {
    const t = new TapTempo();
    t.push(0);
    t.push(0.5);
    t.push(1.0);
    t.reset();
    expect(t.push(10)).toBeNull();
    expect(t.push(10.5)).toBeNull();
  });
});
