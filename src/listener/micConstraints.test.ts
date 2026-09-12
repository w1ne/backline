import { describe, it, expect } from 'vitest';
import { micConstraints } from './micConstraints';

describe('micConstraints', () => {
  it('turns the echo canceller on on an iPhone, where the band plays out of the same box as the mic', () => {
    const c = micConstraints(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15') as Record<string, unknown>;
    expect(c.echoCancellation).toBe(true);
    expect(c.noiseSuppression).toBe(false);
  });
  it('keeps the echo canceller off on Android, where Chrome would put the phone into call mode and silence the band', () => {
    const c = micConstraints(null, 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36') as Record<string, unknown>;
    expect(c.echoCancellation).toBe(false);
  });
  it('keeps raw audio on a laptop and pins the chosen device', () => {
    const c = micConstraints('abc', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/128') as Record<string, unknown>;
    expect(c.echoCancellation).toBe(false);
    expect(c.deviceId).toEqual({ exact: 'abc' });
  });
});
