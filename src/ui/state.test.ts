import { describe, it, expect } from 'vitest';
import { Store } from './state';

describe('Store', () => {
  it('defaults to power off with both sources off, no setup screen', () => {
    const s = new Store();
    expect(s.state.power).toBe('off');
    expect(s.state.sources).toEqual({ mic: 'off', midi: 'off' });
    expect((s.state as unknown as { screen?: unknown }).screen).toBeUndefined();
  });

  it('defaults to note-following cloud accompaniment', () => {
    const s = new Store();
    expect(s.state.engine).toBe('acestep');
  });

  it('notifies subscribers with merged state', () => {
    const s = new Store();
    const seen: number[] = [];
    s.subscribe(st => seen.push(st.creativity));
    s.update({ creativity: 0.7 });
    expect(seen).toEqual([0.7]);
    expect(s.state.genre).toBe('lofi');
  });

  it('unsubscribe stops notifications', () => {
    const s = new Store();
    const seen: number[] = [];
    const unsub = s.subscribe(st => seen.push(st.bar));
    unsub();
    s.update({ bar: 5 });
    expect(seen).toEqual([]);
  });

  it('toggle reads live store state so mute/unmute/mute-another all agree with the engine', () => {
    // Regression test for a bug where `toggle` closed over the AppState snapshot
    // `s` captured at subscribe-time: once an instrument was muted, `s.enabled`
    // was frozen there forever, so it could never be unmuted, and toggling a
    // different instrument would "resurrect" the muted one in the UI while the
    // engine (correctly, per its own last setEnabled call) kept it muted.
    const store = new Store();
    store.update({ enabled: { drums:true, bass:false, keys:false, lead:false } });
    const engineEnabled: Record<string, boolean> = { drums: true, bass: false, keys: false, lead: false };
    const setEnabledCalls: { i: string; on: boolean }[] = [];
    const fakeEngine = {
      setEnabled(i: string, on: boolean) {
        engineEnabled[i] = on;
        setEnabledCalls.push({ i, on });
      },
    };

    // Mirrors main.ts's toggle(): must read store.state at call time, not a
    // stale snapshot captured when the subscription callback last fired.
    function toggle(i: 'drums' | 'bass' | 'keys' | 'lead') {
      const on = !store.state.enabled[i];
      fakeEngine.setEnabled(i, on);
      store.update({ enabled: { ...store.state.enabled, [i]: on } });
    }

    // start (drums on, per defaults)
    expect(store.state.enabled.drums).toBe(true);

    // mute drums
    toggle('drums');
    expect(store.state.enabled.drums).toBe(false);
    expect(engineEnabled.drums).toBe(false);

    // unmute drums
    toggle('drums');
    expect(store.state.enabled.drums).toBe(true);
    expect(engineEnabled.drums).toBe(true);

    // add bass — must not resurrect drums or otherwise disagree with the engine
    toggle('bass');
    expect(store.state.enabled).toEqual(engineEnabled);
    expect(setEnabledCalls).toEqual([
      { i: 'drums', on: false },
      { i: 'drums', on: true },
      { i: 'bass', on: true },
    ]);
  });
});
