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
