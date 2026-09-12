// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MorphBus, setSinkSupported } from './morphBus';
import { loadDeviceId, MORPH_SINK_KEY } from './devices';

/** Just enough AudioContext for the bus: a gain and a MediaStream destination. */
function fakeContext() {
  const dest = { stream: { id: 'morph-stream' } };
  return {
    createGain: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createMediaStreamDestination: () => dest,
  } as unknown as AudioContext;
}

const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;

afterEach(() => {
  delete proto.setSinkId;
  document.querySelectorAll('[data-morph-out]').forEach(el => el.remove());
});

describe('setSinkSupported', () => {
  it('is false where setSinkId is missing (Firefox, Safari, jsdom)', () => {
    expect(setSinkSupported()).toBe(false);
  });

  it('is true once the browser exposes setSinkId (Chrome, Edge)', () => {
    proto.setSinkId = () => Promise.resolve();
    expect(setSinkSupported()).toBe(true);
  });
});

describe('MorphBus', () => {
  beforeEach(() => localStorage.clear());

  it('renders into a hidden autoplaying audio element carrying the stream', () => {
    const bus = new MorphBus(fakeContext());
    const el = document.querySelector<HTMLAudioElement>('[data-morph-out]')!;
    expect(el).toBe(bus.element);
    expect(el.autoplay).toBe(true);
    expect(el.srcObject).toBe(bus.stream);
    bus.dispose();
    expect(document.querySelector('[data-morph-out]')).toBeNull();
  });

  it('refuses to pick a device where setSinkId is unsupported, instead of silently doing nothing', async () => {
    const bus = new MorphBus(fakeContext());
    await expect(bus.setSink('out1')).rejects.toThrow(/not supported/i);
    expect(bus.deviceId).toBeNull();
  });

  it('points the element at the chosen device and remembers it', async () => {
    const setSinkId = vi.fn(() => Promise.resolve());
    proto.setSinkId = setSinkId;
    const bus = new MorphBus(fakeContext());
    await bus.setSink('out2');
    expect(setSinkId).toHaveBeenCalledWith('out2');
    expect(bus.deviceId).toBe('out2');
    expect(loadDeviceId(MORPH_SINK_KEY)).toBe('out2');
  });

  it('sends null back to the system default', async () => {
    const setSinkId = vi.fn(() => Promise.resolve());
    proto.setSinkId = setSinkId;
    const bus = new MorphBus(fakeContext());
    await bus.setSink(null);
    expect(setSinkId).toHaveBeenCalledWith('');
  });
});
