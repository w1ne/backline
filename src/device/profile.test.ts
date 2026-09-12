import { describe, expect, it } from 'vitest';
import { Store } from '../ui/state';
import { applyDeviceProfile } from './profile';

describe('deployment profiles', () => {
  it('keeps the public web defaults unchanged', () => {
    const store = new Store();
    const before = structuredClone(store.state);
    applyDeviceProfile(store, 'web');
    expect(store.state).toEqual(before);
  });
  it('boots the Pi with offline synthesis and physical main audio', () => {
    const store = new Store();
    store.update({ morphOut: 'stale-device', micMuted: true, micIn: 'stale-mic' });
    applyDeviceProfile(store, 'lydia');
    expect(store.state.engine).toBe('amt');
    expect(store.state.sound).toBe('grand');
    expect(store.state.morphOut).toBeNull();
    expect(store.state.micIn).toBeNull();
    expect(store.state.micMuted).toBe(false);
    expect(new Set(Object.values(store.state.routing))).toEqual(new Set(['main']));
    expect(store.state.enabled).toMatchObject({ drums: true, bass: true, keys: true, lead: false });
  });
});
