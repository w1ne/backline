import { describe, it, expect } from 'vitest';
import { outputLatencyMs } from './outputLatency';

describe('outputLatencyMs', () => {
  it('reads outputLatency in seconds and converts to ms', () => {
    expect(outputLatencyMs({ outputLatency: 0.045 })).toBeCloseTo(45, 6);
  });

  it('falls back to baseLatency when outputLatency is missing', () => {
    expect(outputLatencyMs({ baseLatency: 0.01 })).toBeCloseTo(10, 6);
  });

  it('falls back to 0 when neither is reported', () => {
    expect(outputLatencyMs({})).toBe(0);
  });

  it('prefers outputLatency over baseLatency when both are present', () => {
    expect(outputLatencyMs({ outputLatency: 0.08, baseLatency: 0.01 })).toBeCloseTo(80, 6);
  });

  it('treats a negative value as unreported', () => {
    expect(outputLatencyMs({ outputLatency: -1 })).toBe(0);
  });
});
