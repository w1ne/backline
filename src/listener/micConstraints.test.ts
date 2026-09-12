import { describe, it, expect } from 'vitest';
import { micConstraints } from './micConstraints';

describe('micConstraints', () => {
  it('turns the echo canceller on for a phone, where the band plays out of the same box as the mic', () => {
    const c = micConstraints(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15') as Record<string, unknown>;
    expect(c.echoCancellation).toBe(false);
    expect(c.noiseSuppression).toBe(false);
  });
  it('keeps raw audio on a laptop and pins the chosen device', () => {
    const c = micConstraints('abc', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/128') as Record<string, unknown>;
    expect(c.echoCancellation).toBe(false);
    expect(c.deviceId).toEqual({ exact: 'abc' });
  });
});
