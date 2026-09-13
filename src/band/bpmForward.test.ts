import { describe, it, expect } from 'vitest';
import { forwardBpm } from './bpmForward';

describe('forwardBpm', () => {
  it('forwards the first value regardless of step', () => {
    expect(forwardBpm(undefined, 100, 2)).toBe(true);
  });

  it('does not forward a change smaller than step', () => {
    expect(forwardBpm(100, 101, 2)).toBe(false);
  });

  it('forwards a change at or above step', () => {
    expect(forwardBpm(100, 102, 2)).toBe(true);
    expect(forwardBpm(100, 103, 2)).toBe(true);
  });

  it('is symmetric for slowing down', () => {
    expect(forwardBpm(100, 97, 2)).toBe(true);
    expect(forwardBpm(100, 99, 2)).toBe(false);
  });
});

import { SustainedBpmFollower } from './bpmForward';

describe('SustainedBpmFollower', () => {
  it('follows the first tempo at once, then only a change that holds for the sustain window', () => {
    const f = new SustainedBpmFollower(4, 8000, 3);
    expect(f.observe(undefined, 100, 0)).toBe(100);
    expect(f.observe(100, 101, 1000)).toBeUndefined();          // jitter under step
    expect(f.observe(100, 112, 2000)).toBeUndefined();          // new tempo appears
    expect(f.observe(100, 113, 6000)).toBeUndefined();          // still within tolerance, not long enough
    expect(f.observe(100, 112, 10500)).toBe(112);               // held 8.5 s: follow
  });

  it('a wandering estimate never counts as sustained', () => {
    const f = new SustainedBpmFollower(4, 8000, 3);
    expect(f.observe(100, 112, 0)).toBeUndefined();
    expect(f.observe(100, 120, 3000)).toBeUndefined();          // jumped: restart the clock
    expect(f.observe(100, 121, 9000)).toBeUndefined();          // only 6 s since the jump
    expect(f.observe(100, 100, 9500)).toBeUndefined();          // back home: candidate dropped
    expect(f.observe(100, 121, 12000)).toBeUndefined();
  });
});
