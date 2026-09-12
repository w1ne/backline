import { describe, it, expect } from 'vitest';
import { monitorAllowed } from './monitorSafety';

const LAPTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/128';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID_PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36';

describe('monitorAllowed', () => {
  it('never allows monitoring on an iPhone, opt-in or not — the mic sits on the same speaker', () => {
    expect(monitorAllowed({ userAgent: IPHONE_UA, optedIn: true, outputDeviceId: 'headphones-1' })).toBe(false);
    expect(monitorAllowed({ userAgent: IPHONE_UA, optedIn: true, outputDeviceId: null })).toBe(false);
  });

  it('never allows monitoring on an Android phone either', () => {
    expect(monitorAllowed({ userAgent: ANDROID_PHONE_UA, optedIn: true, outputDeviceId: 'x' })).toBe(false);
  });

  it('on a laptop with no opt-in and no chosen output, stays off (default is unknown, could be speakers)', () => {
    expect(monitorAllowed({ userAgent: LAPTOP_UA, optedIn: false, outputDeviceId: null })).toBe(false);
  });

  it('on a laptop, an explicit opt-in is enough even with the default output', () => {
    expect(monitorAllowed({ userAgent: LAPTOP_UA, optedIn: true, outputDeviceId: null })).toBe(true);
  });

  it('on a laptop, choosing a real output device is enough even without opting in', () => {
    expect(monitorAllowed({ userAgent: LAPTOP_UA, optedIn: false, outputDeviceId: 'headphones-1' })).toBe(true);
  });
});
